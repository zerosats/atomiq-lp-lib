import {Express, Request, Response} from "express";
import {ToBtcLxSwapAbs, ToBtcLxSwapState} from "./ToBtcLxSwapAbs";
import {MultichainData, SwapHandlerType} from "../../SwapHandler";
import {ISwapPrice} from "../../../prices/ISwapPrice";
import {
    BigIntBufferUtils,
    ChainSwapType,
    ClaimEvent,
    InitializeEvent,
    RefundEvent,
    SwapCommitStateType,
    SwapData
} from "@atomiqlabs/base";
import {expressHandlerWrapper, getAbortController, HEX_REGEX, isDefinedRuntimeError} from "../../../utils/Utils";
import {IIntermediaryStorage} from "../../../storage/IIntermediaryStorage";
import {randomBytes} from "crypto";
import {serverParamDecoder} from "../../../utils/paramcoders/server/ServerParamDecoder";
import {IParamReader} from "../../../utils/paramcoders/IParamReader";
import {FieldTypeEnum, verifySchema} from "../../../utils/paramcoders/SchemaVerifier";
import {ServerParamEncoder} from "../../../utils/paramcoders/server/ServerParamEncoder";
import {ToBtcBaseConfig, ToBtcBaseSwapHandler} from "../ToBtcBaseSwapHandler";
import {PluginManager} from "../../../plugins/PluginManager";
import {ILxWallet, LxStatecoin, LxStatecoinStatus} from "../../../wallets/ILxWallet";

export type ToBtcLxConfig = ToBtcBaseConfig & {
    minSendCltv: bigint,
    /** Bounds the settleLatchedTransfer poll that waits for the client to claim the coin. */
    settleTimeoutMs?: number,
    settlePollIntervalMs?: number
};

/**
 * The client names the coin (statechainId), the output amount, or both. The LP
 * selects a CONFIRMED inventory coin: exact-output only, since a statecoin is
 * indivisible. At least one of statechainId / amount must be present.
 */
export type ToBtcLxRequestType = {
    statechainId?: string,
    amount?: bigint,
    toAddress: string,
    expiryTimestamp: bigint,
    token: string,
    offerer: string
};

/**
 * Swap handler paying out a Mercury statecoin (LX rail) against an on-chain HTLC.
 *
 * Mirror of ToBtcLnAbs with the payment rail swapped from ILightningWallet to
 * ILxWallet. Control is inverted: the latch is sender-controlled, so the LP mints
 * the payment hash via createLatchedTransfer BEFORE quoting and binds it to the
 * escrow claim hash, rather than reading it from a client-supplied invoice. The
 * SE releases the preimage once the client claims the coin, which is what makes
 * the swap atomic. Escrow claim/refund and signing are identical to ToBtcLn.
 */
export class ToBtcLxAbs extends ToBtcBaseSwapHandler<ToBtcLxSwapAbs, ToBtcLxSwapState> {
    readonly type = SwapHandlerType.TO_BTCLX;
    readonly swapType = ChainSwapType.HTLC;
    readonly inflightSwapStates = new Set([ToBtcLxSwapState.COMMITED, ToBtcLxSwapState.PAID]);

    activeSubscriptions: Set<string> = new Set<string>();

    readonly config: ToBtcLxConfig & {minTsSendCltv: bigint};

    readonly lx: ILxWallet;

    constructor(
        storageDirectory: IIntermediaryStorage<ToBtcLxSwapAbs>,
        path: string,
        chainData: MultichainData,
        lx: ILxWallet,
        swapPricing: ISwapPrice,
        config: ToBtcLxConfig
    ) {
        super(storageDirectory, path, chainData, swapPricing, config);
        this.lx = lx;
        const anyConfig = config as any;
        anyConfig.minTsSendCltv = config.gracePeriod + (config.bitcoinBlocktime * config.minSendCltv * config.safetyFactor);
        this.config = anyConfig;
        this.config.settleTimeoutMs ??= 30 * 60 * 1000;
        this.config.settlePollIntervalMs ??= 5 * 1000;
    }

    protected async processPastSwap(swap: ToBtcLxSwapAbs): Promise<void> {
        const {swapContract} = this.getChain(swap.chainIdentifier);

        if (swap.state === ToBtcLxSwapState.SAVED) {
            const isSignatureExpired = await swapContract.isInitAuthorizationExpired(swap.data, swap);
            if(isSignatureExpired) {
                const isCommitted = await swapContract.isCommited(swap.data);
                if(!isCommitted) {
                    this.swapLogger.info(swap, "processPastSwap(state=SAVED): authorization expired & swap not committed, cancelling latch, statechainId: "+swap.statechainId);
                    await this.cancelLatch(swap);
                    await this.removeSwapData(swap, ToBtcLxSwapState.CANCELED);
                    return;
                } else {
                    await swap.setState(ToBtcLxSwapState.COMMITED);
                    await this.saveSwapData(swap);
                }
            }
        }

        if (swap.state === ToBtcLxSwapState.COMMITED || swap.state === ToBtcLxSwapState.PAID) {
            await this.processInitialized(swap);
        }

        if (swap.state === ToBtcLxSwapState.NON_PAYABLE) {
            if(await swapContract.isExpired(swap.data.getOfferer(), swap.data)) {
                this.swapLogger.info(swap, "processPastSwap(state=NON_PAYABLE): swap expired, removing swap data, statechainId: "+swap.statechainId);
                await this.removeSwapData(swap);
            }
        }
    }

    protected async processPastSwaps() {
        const queriedData = await this.storageManager.query([
            {
                key: "state",
                value: [
                    ToBtcLxSwapState.SAVED,
                    ToBtcLxSwapState.COMMITED,
                    ToBtcLxSwapState.PAID,
                    ToBtcLxSwapState.NON_PAYABLE
                ]
            }
        ]);

        for(let {obj: swap} of queriedData) {
            await this.processPastSwap(swap);
        }
    }

    /**
     * Cancels the sender-controlled latch so the coin is not left stranded when a
     * swap fails before the client claims it.
     */
    private async cancelLatch(swap: ToBtcLxSwapAbs): Promise<void> {
        try {
            await this.lx.cancelLatchedTransfer(swap.batchId);
        } catch (e) {
            this.swapLogger.error(swap, "cancelLatch(): error cancelling latch, batchId: "+swap.batchId, e);
        }
    }

    /**
     * Tries to claim the escrow with the revealed preimage. Identical to ToBtcLn.
     */
    private async tryClaimSwap(swap: ToBtcLxSwapAbs): Promise<boolean> {
        if(swap.secret==null) throw new Error("Invalid swap state, needs latch preimage!");

        const {swapContract, signer} = this.getChain(swap.chainIdentifier);

        const isCommited = await swapContract.isCommited(swap.data);
        if(!isCommited) {
            const status = await swapContract.getCommitStatus(signer.getAddress(), swap.data);
            if(status?.type===SwapCommitStateType.PAID) {
                swap.txIds ??= {};
                swap.txIds.claim = await status.getClaimTxId();
                await this.removeSwapData(swap, ToBtcLxSwapState.CLAIMED);
                return true;
            } else if(status?.type===SwapCommitStateType.EXPIRED) {
                swap.txIds ??= {};
                swap.txIds.refund = status.getRefundTxId==null ? null : await status.getRefundTxId();
                await this.removeSwapData(swap, ToBtcLxSwapState.REFUNDED);
            }
            this.swapLogger.warn(swap, "tryClaimSwap(): escrow no longer exists, status: "+status+" statechainId: "+swap.statechainId);
            return false;
        }

        const unlock: () => boolean = swap.lock(swapContract.claimWithSecretTimeout);
        if(unlock==null) return false;

        try {
            const success = await swapContract.claimWithSecret(signer, swap.data, swap.secret, false, false, {
                waitForConfirmation: true
            });
            this.swapLogger.info(swap, "tryClaimSwap(): swap claimed, statechainId: "+swap.statechainId);
            if(swap.metadata!=null) swap.metadata.times.txClaimed = Date.now();
            unlock();
            return true;
        } catch (e) {
            this.swapLogger.error(swap, "tryClaimSwap(): error claiming swap, statechainId: "+swap.statechainId, e);
            return false;
        }
    }

    /**
     * Settles the latch: long-polls settleLatchedTransfer until the client claims
     * the coin and the SE releases the preimage, then claims the escrow with it.
     * This replaces the sendLightningPayment + subscribeToPayment pair in ToBtcLn:
     * the latch has a single awaitable result instead of a pending/confirmed poll.
     */
    private subscribeToSettle(swap: ToBtcLxSwapAbs): boolean {
        const key = swap.batchId;
        if(this.activeSubscriptions.has(key)) return false;

        this.lx.settleLatchedTransfer(swap.batchId, {
            timeoutMs: this.config.settleTimeoutMs,
            pollIntervalMs: this.config.settlePollIntervalMs
        }).then(async result => {
            swap.secret = result.preimage;
            await swap.setState(ToBtcLxSwapState.PAID);
            await this.saveSwapData(swap);
            const success = await this.tryClaimSwap(swap);
            if(success) this.swapLogger.info(swap, "subscribeToSettle(): swap claimed, statechainId: "+swap.statechainId);
        }).catch(async e => {
            this.swapLogger.error(swap, "subscribeToSettle(): settle failed, marking non-payable, statechainId: "+swap.statechainId, e);
            if(swap.metadata!=null) swap.metadata.payError = e;
            await swap.setState(ToBtcLxSwapState.NON_PAYABLE);
            await this.saveSwapData(swap);
        }).finally(() => {
            this.activeSubscriptions.delete(key);
        });

        this.activeSubscriptions.add(key);
        return true;
    }

    private async processInitialized(swap: ToBtcLxSwapAbs) {
        if(swap.state===ToBtcLxSwapState.PAID) {
            const success = await this.tryClaimSwap(swap);
            if(success) this.swapLogger.info(swap, "processInitialized(): swap claimed, statechainId: "+swap.statechainId);
            return;
        }

        if(swap.state===ToBtcLxSwapState.SAVED) {
            try {
                this.checkTooManyInflightSwaps();
            } catch (e) {
                if(isDefinedRuntimeError(e)) {
                    if(swap.metadata!=null) swap.metadata.payError = e;
                    await swap.setState(ToBtcLxSwapState.NON_PAYABLE);
                    await this.saveSwapData(swap);
                    return;
                } else throw e;
            }
            await swap.setState(ToBtcLxSwapState.COMMITED);
            await this.saveSwapData(swap);
        }

        if(swap.state===ToBtcLxSwapState.COMMITED) {
            swap.payInitiated = true;
            await this.saveSwapData(swap);
            this.subscribeToSettle(swap);
        }
    }

    protected async processInitializeEvent(chainIdentifier: string, swap: ToBtcLxSwapAbs, event: InitializeEvent<SwapData>): Promise<void> {
        this.swapLogger.info(swap, "SC: InitializeEvent: swap initialized by the client, statechainId: "+swap.statechainId);
        if(swap.state!==ToBtcLxSwapState.SAVED) return;
        await this.processInitialized(swap);
    }

    protected async processClaimEvent(chainIdentifier: string, swap: ToBtcLxSwapAbs, event: ClaimEvent<SwapData>): Promise<void> {
        this.swapLogger.info(swap, "SC: ClaimEvent: swap claimed to us, statechainId: "+swap.statechainId);
        await this.removeSwapData(swap, ToBtcLxSwapState.CLAIMED);
    }

    protected async processRefundEvent(chainIdentifier: string, swap: ToBtcLxSwapAbs, event: RefundEvent<SwapData>): Promise<void> {
        this.swapLogger.info(swap, "SC: RefundEvent: swap refunded back to the client, cancelling latch, statechainId: "+swap.statechainId);
        await this.cancelLatch(swap);
        await this.removeSwapData(swap, ToBtcLxSwapState.REFUNDED);
    }

    /**
     * Picks a CONFIRMED inventory coin for the payout. Exact-output only: a
     * statecoin is indivisible, so amount (when given) must match a coin exactly.
     * At least one of statechainId / amount must be supplied.
     */
    private async selectInventoryCoin(statechainId?: string, amount?: bigint): Promise<LxStatecoin & {statechainId: string, amount: bigint}> {
        if(statechainId==null && amount==null) throw {code: 20031, msg: "Specify statechainId or amount"};

        const available = (await this.lx.listCoins()).filter(
            c => c.status===LxStatecoinStatus.CONFIRMED && c.statechainId!=null && c.amount!=null
        );

        let picked: LxStatecoin;
        if(statechainId!=null) {
            picked = available.find(c => c.statechainId===statechainId);
            if(picked==null) throw {code: 20032, msg: "Statecoin unknown or not CONFIRMED"};
            if(amount!=null && picked.amount!==amount) throw {code: 20033, msg: "Statecoin amount mismatch"};
        } else {
            picked = available.find(c => c.amount===amount);
            if(picked==null) throw {code: 20034, msg: "No CONFIRMED inventory coin matches the requested amount"};
        }
        return picked as LxStatecoin & {statechainId: string, amount: bigint};
    }

    startRestServer(restServer: Express) {
        restServer.use(this.path+"/payStatecoin", serverParamDecoder(10*1000));
        restServer.post(this.path+"/payStatecoin", expressHandlerWrapper(async (req: Request & {paramReader: IParamReader}, res: Response & {responseStream: ServerParamEncoder}) => {
            const metadata: {request: any, times: {[key: string]: number}} = {request: {}, times: {}};
            metadata.times.requestReceived = Date.now();

            const chainIdentifier = req.query.chain as string;
            const {swapContract, signer, chainInterface} = this.getChain(chainIdentifier);

            const parsedBody: ToBtcLxRequestType = await req.paramReader.getParams({
                statechainId: FieldTypeEnum.StringOptional,
                amount: FieldTypeEnum.BigIntOptional,
                toAddress: FieldTypeEnum.String,
                expiryTimestamp: FieldTypeEnum.BigInt,
                token: (val: string) => val!=null &&
                    typeof(val)==="string" &&
                    this.isTokenSupported(chainIdentifier, val) ? val : null,
                offerer: (val: string) => val!=null &&
                    typeof(val)==="string" &&
                    chainInterface.isValidAddress(val, true) ? val : null
            });
            if (parsedBody==null) throw {code: 20100, msg: "Invalid request body"};
            metadata.request = parsedBody;

            const responseStream = res.responseStream;
            const abortController = getAbortController(responseStream);

            this.checkTooManyInflightSwaps();
            await this.checkVaultInitialized(chainIdentifier, parsedBody.token);

            // Whole-coin amount comes from the selected LP inventory coin, not from
            // the request body: a statecoin is indivisible, so the swap is always
            // exact-output.
            const coin = await this.selectInventoryCoin(parsedBody.statechainId, parsedBody.amount);
            const amount = coin.amount;

            const request = {chainIdentifier, raw: req, parsed: parsedBody, metadata};
            const requestedAmount = {input: false, amount, token: parsedBody.token};

            const fees = await this.AmountAssertions.preCheckToBtcAmounts(this.type, request, requestedAmount);
            metadata.times.requestChecked = Date.now();

            const {pricePrefetchPromise, signDataPrefetchPromise} = this.getToBtcPrefetches(chainIdentifier, parsedBody.token, responseStream, abortController);

            // No BTC miner fee: the statecoin payout is off-chain (latch settle), so
            // the network fee is zero and only the swap fee applies.
            const {totalInToken, swapFee, swapFeeInToken, networkFee, networkFeeInToken} = await this.AmountAssertions.checkToBtcAmount(
                this.type,
                request,
                {...requestedAmount, pricePrefetch: pricePrefetchPromise},
                fees,
                async () => ({networkFee: 0n}),
                abortController.signal
            );
            metadata.times.priceCalculated = Date.now();

            // Sender-controlled latch: mint the payment hash FIRST, then bind it to
            // the escrow claim hash. This is the inversion vs ToBtcLn.
            const latched = await this.lx.createLatchedTransfer({
                statechainId: coin.statechainId,
                toAddress: parsedBody.toAddress
            });
            metadata.times.latchCreated = Date.now();

            const sequence = BigIntBufferUtils.fromBuffer(randomBytes(8));
            const claimHash = swapContract.getHashForHtlc(Buffer.from(latched.paymentHash, "hex"));

            const payObject: SwapData = await swapContract.createSwapData(
                ChainSwapType.HTLC,
                parsedBody.offerer,
                signer.getAddress(),
                parsedBody.token,
                totalInToken,
                claimHash.toString("hex"),
                sequence,
                parsedBody.expiryTimestamp,
                true,
                false,
                0n,
                0n
            );
            abortController.signal.throwIfAborted();
            metadata.times.swapCreated = Date.now();

            const sigData = await this.getToBtcSignatureData(chainIdentifier, payObject, req, abortController.signal, signDataPrefetchPromise);
            metadata.times.swapSigned = Date.now();

            const createdSwap = new ToBtcLxSwapAbs(
                chainIdentifier,
                latched.paymentHash,
                coin.statechainId,
                parsedBody.toAddress,
                latched.batchId,
                amount,
                swapFee,
                swapFeeInToken,
                networkFee,
                networkFeeInToken
            );
            createdSwap.data = payObject;
            createdSwap.metadata = metadata;
            createdSwap.prefix = sigData.prefix;
            createdSwap.timeout = sigData.timeout;
            createdSwap.signature = sigData.signature;
            createdSwap.feeRate = sigData.feeRate;

            await this.saveSwapData(createdSwap);

            this.swapLogger.info(createdSwap, "REST: /payStatecoin: created swap, statechainId: "+parsedBody.statechainId+" toAddress: "+parsedBody.toAddress);

            await responseStream.writeParamsAndEnd({
                code: 20000,
                msg: "Success",
                data: {
                    maxFee: networkFeeInToken.toString(10),
                    swapFee: swapFeeInToken.toString(10),
                    total: totalInToken.toString(10),
                    address: signer.getAddress(),
                    paymentHash: latched.paymentHash,
                    data: payObject.serialize(),
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });
        }));

        // Cooperative refund: hands the client a refund signature when the swap is
        // NON_PAYABLE (settle failed), so it can reclaim the escrow before the
        // timelock. Escrow-side and LN-agnostic, so it mirrors ToBtcLn; the payment
        // status comes from the swap state instead of a wallet getPayment call.
        const getRefundAuthorization = expressHandlerWrapper(async (req, res) => {
            const parsedBody = verifySchema({...req.body, ...req.query}, {
                paymentHash: (val: string) => val!=null &&
                    typeof(val)==="string" &&
                    val.length===64 &&
                    HEX_REGEX.test(val) ? val : null,
                sequence: FieldTypeEnum.BigInt
            });
            if (parsedBody==null) throw {code: 20100, msg: "Invalid request body/query (paymentHash/sequence)"};

            this.checkSequence(parsedBody.sequence);

            let data = await this.storageManager.getData(parsedBody.paymentHash, parsedBody.sequence);
            if(data==null) {
                for(let chainId in this.chains.chains) {
                    const _data = this.getSwapByEscrowHash(chainId, parsedBody.paymentHash);
                    if(_data!=null && _data.getSequence()===parsedBody.sequence) {
                        data = _data;
                        break;
                    }
                }
            }

            if(data==null) throw {_httpStatus: 200, code: 20007, msg: "Swap not found"};

            const {signer, swapContract} = this.getChain(data.chainIdentifier);

            if(await swapContract.isExpired(signer.getAddress(), data.data)) throw {
                _httpStatus: 200,
                code: 20010,
                msg: "Swap expired"
            };

            if(data.state===ToBtcLxSwapState.NON_PAYABLE) {
                const refundSigData = await swapContract.getRefundSignature(signer, data.data, this.config.refundAuthorizationTimeout);

                //Double check the state after the promise result
                if (data.state !== ToBtcLxSwapState.NON_PAYABLE) throw {code: 20005, msg: "Not committed"};

                res.status(200).json({
                    code: 20000,
                    msg: "Success",
                    data: {
                        address: signer.getAddress(),
                        prefix: refundSigData.prefix,
                        timeout: refundSigData.timeout,
                        signature: refundSigData.signature
                    }
                });
                return;
            }

            if(data.secret!=null) {
                res.status(200).json({
                    code: 20006,
                    msg: "Already paid",
                    data: {secret: data.secret}
                });
                return;
            }

            res.status(200).json({
                code: 20008,
                msg: "Settlement in-flight"
            });
        });

        restServer.post(this.path+'/getRefundAuthorization', getRefundAuthorization);
        restServer.get(this.path+'/getRefundAuthorization', getRefundAuthorization);

        this.logger.info("started at path: ", this.path);
    }

    async init() {
        await this.loadData(ToBtcLxSwapAbs);
        this.subscribeToEvents();
        await PluginManager.serviceInitialize(this);
    }

    getInfoData(): any {
        return {
            minCltv: Number(this.config.minSendCltv),
            minTimestampCltv: Number(this.config.minTsSendCltv)
        };
    }

}
