"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToBtcLxAbs = void 0;
const ToBtcLxSwapAbs_1 = require("./ToBtcLxSwapAbs");
const SwapHandler_1 = require("../../SwapHandler");
const base_1 = require("@atomiqlabs/base");
const Utils_1 = require("../../../utils/Utils");
const crypto_1 = require("crypto");
const ServerParamDecoder_1 = require("../../../utils/paramcoders/server/ServerParamDecoder");
const SchemaVerifier_1 = require("../../../utils/paramcoders/SchemaVerifier");
const ToBtcBaseSwapHandler_1 = require("../ToBtcBaseSwapHandler");
const PluginManager_1 = require("../../../plugins/PluginManager");
const ILxWallet_1 = require("../../../wallets/ILxWallet");
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
class ToBtcLxAbs extends ToBtcBaseSwapHandler_1.ToBtcBaseSwapHandler {
    constructor(storageDirectory, path, chainData, lx, swapPricing, config) {
        var _a, _b;
        super(storageDirectory, path, chainData, swapPricing, config);
        this.type = SwapHandler_1.SwapHandlerType.TO_BTCLX;
        this.swapType = base_1.ChainSwapType.HTLC;
        this.inflightSwapStates = new Set([ToBtcLxSwapAbs_1.ToBtcLxSwapState.COMMITED, ToBtcLxSwapAbs_1.ToBtcLxSwapState.PAID]);
        this.activeSubscriptions = new Set();
        this.lx = lx;
        const anyConfig = config;
        anyConfig.minTsSendCltv = config.gracePeriod + (config.bitcoinBlocktime * config.minSendCltv * config.safetyFactor);
        this.config = anyConfig;
        (_a = this.config).settleTimeoutMs ?? (_a.settleTimeoutMs = 30 * 60 * 1000);
        (_b = this.config).settlePollIntervalMs ?? (_b.settlePollIntervalMs = 5 * 1000);
    }
    async processPastSwap(swap) {
        const { swapContract } = this.getChain(swap.chainIdentifier);
        if (swap.state === ToBtcLxSwapAbs_1.ToBtcLxSwapState.SAVED) {
            const isSignatureExpired = await swapContract.isInitAuthorizationExpired(swap.data, swap);
            if (isSignatureExpired) {
                const isCommitted = await swapContract.isCommited(swap.data);
                if (!isCommitted) {
                    this.swapLogger.info(swap, "processPastSwap(state=SAVED): authorization expired & swap not committed, cancelling latch, statechainId: " + swap.statechainId);
                    await this.cancelLatch(swap);
                    await this.removeSwapData(swap, ToBtcLxSwapAbs_1.ToBtcLxSwapState.CANCELED);
                    return;
                }
                else {
                    await swap.setState(ToBtcLxSwapAbs_1.ToBtcLxSwapState.COMMITED);
                    await this.saveSwapData(swap);
                }
            }
        }
        if (swap.state === ToBtcLxSwapAbs_1.ToBtcLxSwapState.COMMITED || swap.state === ToBtcLxSwapAbs_1.ToBtcLxSwapState.PAID) {
            await this.processInitialized(swap);
        }
        if (swap.state === ToBtcLxSwapAbs_1.ToBtcLxSwapState.NON_PAYABLE) {
            if (await swapContract.isExpired(swap.data.getOfferer(), swap.data)) {
                this.swapLogger.info(swap, "processPastSwap(state=NON_PAYABLE): swap expired, removing swap data, statechainId: " + swap.statechainId);
                await this.removeSwapData(swap);
            }
        }
    }
    async processPastSwaps() {
        const queriedData = await this.storageManager.query([
            {
                key: "state",
                value: [
                    ToBtcLxSwapAbs_1.ToBtcLxSwapState.SAVED,
                    ToBtcLxSwapAbs_1.ToBtcLxSwapState.COMMITED,
                    ToBtcLxSwapAbs_1.ToBtcLxSwapState.PAID,
                    ToBtcLxSwapAbs_1.ToBtcLxSwapState.NON_PAYABLE
                ]
            }
        ]);
        for (let { obj: swap } of queriedData) {
            await this.processPastSwap(swap);
        }
    }
    /**
     * Cancels the sender-controlled latch so the coin is not left stranded when a
     * swap fails before the client claims it.
     */
    async cancelLatch(swap) {
        try {
            await this.lx.cancelLatchedTransfer(swap.batchId);
        }
        catch (e) {
            this.swapLogger.error(swap, "cancelLatch(): error cancelling latch, batchId: " + swap.batchId, e);
        }
    }
    /**
     * Tries to claim the escrow with the revealed preimage. Identical to ToBtcLn.
     */
    async tryClaimSwap(swap) {
        if (swap.secret == null)
            throw new Error("Invalid swap state, needs latch preimage!");
        const { swapContract, signer } = this.getChain(swap.chainIdentifier);
        const isCommited = await swapContract.isCommited(swap.data);
        if (!isCommited) {
            const status = await swapContract.getCommitStatus(signer.getAddress(), swap.data);
            if (status?.type === base_1.SwapCommitStateType.PAID) {
                swap.txIds ?? (swap.txIds = {});
                swap.txIds.claim = await status.getClaimTxId();
                await this.removeSwapData(swap, ToBtcLxSwapAbs_1.ToBtcLxSwapState.CLAIMED);
                return true;
            }
            else if (status?.type === base_1.SwapCommitStateType.EXPIRED) {
                swap.txIds ?? (swap.txIds = {});
                swap.txIds.refund = status.getRefundTxId == null ? null : await status.getRefundTxId();
                await this.removeSwapData(swap, ToBtcLxSwapAbs_1.ToBtcLxSwapState.REFUNDED);
            }
            this.swapLogger.warn(swap, "tryClaimSwap(): escrow no longer exists, status: " + status + " statechainId: " + swap.statechainId);
            return false;
        }
        const unlock = swap.lock(swapContract.claimWithSecretTimeout);
        if (unlock == null)
            return false;
        try {
            const success = await swapContract.claimWithSecret(signer, swap.data, swap.secret, false, false, {
                waitForConfirmation: true
            });
            this.swapLogger.info(swap, "tryClaimSwap(): swap claimed, statechainId: " + swap.statechainId);
            if (swap.metadata != null)
                swap.metadata.times.txClaimed = Date.now();
            unlock();
            return true;
        }
        catch (e) {
            this.swapLogger.error(swap, "tryClaimSwap(): error claiming swap, statechainId: " + swap.statechainId, e);
            return false;
        }
    }
    /**
     * Settles the latch: long-polls settleLatchedTransfer until the client claims
     * the coin and the SE releases the preimage, then claims the escrow with it.
     * This replaces the sendLightningPayment + subscribeToPayment pair in ToBtcLn:
     * the latch has a single awaitable result instead of a pending/confirmed poll.
     */
    subscribeToSettle(swap) {
        const key = swap.batchId;
        if (this.activeSubscriptions.has(key))
            return false;
        this.lx.settleLatchedTransfer(swap.batchId, {
            timeoutMs: this.config.settleTimeoutMs,
            pollIntervalMs: this.config.settlePollIntervalMs
        }).then(async (result) => {
            swap.secret = result.preimage;
            await swap.setState(ToBtcLxSwapAbs_1.ToBtcLxSwapState.PAID);
            await this.saveSwapData(swap);
            const success = await this.tryClaimSwap(swap);
            if (success)
                this.swapLogger.info(swap, "subscribeToSettle(): swap claimed, statechainId: " + swap.statechainId);
        }).catch(async (e) => {
            this.swapLogger.error(swap, "subscribeToSettle(): settle failed, marking non-payable, statechainId: " + swap.statechainId, e);
            if (swap.metadata != null)
                swap.metadata.payError = e;
            await swap.setState(ToBtcLxSwapAbs_1.ToBtcLxSwapState.NON_PAYABLE);
            await this.saveSwapData(swap);
        }).finally(() => {
            this.activeSubscriptions.delete(key);
        });
        this.activeSubscriptions.add(key);
        return true;
    }
    async processInitialized(swap) {
        if (swap.state === ToBtcLxSwapAbs_1.ToBtcLxSwapState.PAID) {
            const success = await this.tryClaimSwap(swap);
            if (success)
                this.swapLogger.info(swap, "processInitialized(): swap claimed, statechainId: " + swap.statechainId);
            return;
        }
        if (swap.state === ToBtcLxSwapAbs_1.ToBtcLxSwapState.SAVED) {
            try {
                this.checkTooManyInflightSwaps();
            }
            catch (e) {
                if ((0, Utils_1.isDefinedRuntimeError)(e)) {
                    if (swap.metadata != null)
                        swap.metadata.payError = e;
                    await swap.setState(ToBtcLxSwapAbs_1.ToBtcLxSwapState.NON_PAYABLE);
                    await this.saveSwapData(swap);
                    return;
                }
                else
                    throw e;
            }
            await swap.setState(ToBtcLxSwapAbs_1.ToBtcLxSwapState.COMMITED);
            await this.saveSwapData(swap);
        }
        if (swap.state === ToBtcLxSwapAbs_1.ToBtcLxSwapState.COMMITED) {
            swap.payInitiated = true;
            await this.saveSwapData(swap);
            this.subscribeToSettle(swap);
        }
    }
    async processInitializeEvent(chainIdentifier, swap, event) {
        this.swapLogger.info(swap, "SC: InitializeEvent: swap initialized by the client, statechainId: " + swap.statechainId);
        if (swap.state !== ToBtcLxSwapAbs_1.ToBtcLxSwapState.SAVED)
            return;
        await this.processInitialized(swap);
    }
    async processClaimEvent(chainIdentifier, swap, event) {
        this.swapLogger.info(swap, "SC: ClaimEvent: swap claimed to us, statechainId: " + swap.statechainId);
        await this.removeSwapData(swap, ToBtcLxSwapAbs_1.ToBtcLxSwapState.CLAIMED);
    }
    async processRefundEvent(chainIdentifier, swap, event) {
        this.swapLogger.info(swap, "SC: RefundEvent: swap refunded back to the client, cancelling latch, statechainId: " + swap.statechainId);
        await this.cancelLatch(swap);
        await this.removeSwapData(swap, ToBtcLxSwapAbs_1.ToBtcLxSwapState.REFUNDED);
    }
    /**
     * Picks a CONFIRMED inventory coin for the payout. Exact-output only: a
     * statecoin is indivisible, so amount (when given) must match a coin exactly.
     * At least one of statechainId / amount must be supplied.
     */
    async selectInventoryCoin(statechainId, amount) {
        if (statechainId == null && amount == null)
            throw { code: 20031, msg: "Specify statechainId or amount" };
        const available = (await this.lx.listCoins()).filter(c => c.status === ILxWallet_1.LxStatecoinStatus.CONFIRMED && c.statechainId != null && c.amount != null);
        let picked;
        if (statechainId != null) {
            picked = available.find(c => c.statechainId === statechainId);
            if (picked == null)
                throw { code: 20032, msg: "Statecoin unknown or not CONFIRMED" };
            if (amount != null && picked.amount !== amount)
                throw { code: 20033, msg: "Statecoin amount mismatch" };
        }
        else {
            picked = available.find(c => c.amount === amount);
            if (picked == null)
                throw { code: 20034, msg: "No CONFIRMED inventory coin matches the requested amount" };
        }
        return picked;
    }
    startRestServer(restServer) {
        restServer.use(this.path + "/payStatecoin", (0, ServerParamDecoder_1.serverParamDecoder)(10 * 1000));
        restServer.post(this.path + "/payStatecoin", (0, Utils_1.expressHandlerWrapper)(async (req, res) => {
            const metadata = { request: {}, times: {} };
            metadata.times.requestReceived = Date.now();
            const chainIdentifier = req.query.chain;
            const { swapContract, signer, chainInterface } = this.getChain(chainIdentifier);
            const parsedBody = await req.paramReader.getParams({
                statechainId: SchemaVerifier_1.FieldTypeEnum.StringOptional,
                amount: SchemaVerifier_1.FieldTypeEnum.BigIntOptional,
                toAddress: SchemaVerifier_1.FieldTypeEnum.String,
                expiryTimestamp: SchemaVerifier_1.FieldTypeEnum.BigInt,
                token: (val) => val != null &&
                    typeof (val) === "string" &&
                    this.isTokenSupported(chainIdentifier, val) ? val : null,
                offerer: (val) => val != null &&
                    typeof (val) === "string" &&
                    chainInterface.isValidAddress(val, true) ? val : null
            });
            if (parsedBody == null)
                throw { code: 20100, msg: "Invalid request body" };
            metadata.request = parsedBody;
            const responseStream = res.responseStream;
            const abortController = (0, Utils_1.getAbortController)(responseStream);
            this.checkTooManyInflightSwaps();
            await this.checkVaultInitialized(chainIdentifier, parsedBody.token);
            // Whole-coin amount comes from the selected LP inventory coin, not from
            // the request body: a statecoin is indivisible, so the swap is always
            // exact-output.
            const coin = await this.selectInventoryCoin(parsedBody.statechainId, parsedBody.amount);
            const amount = coin.amount;
            const request = { chainIdentifier, raw: req, parsed: parsedBody, metadata };
            const requestedAmount = { input: false, amount, token: parsedBody.token };
            const fees = await this.AmountAssertions.preCheckToBtcAmounts(this.type, request, requestedAmount);
            metadata.times.requestChecked = Date.now();
            const { pricePrefetchPromise, signDataPrefetchPromise } = this.getToBtcPrefetches(chainIdentifier, parsedBody.token, responseStream, abortController);
            // No BTC miner fee: the statecoin payout is off-chain (latch settle), so
            // the network fee is zero and only the swap fee applies.
            const { totalInToken, swapFee, swapFeeInToken, networkFee, networkFeeInToken } = await this.AmountAssertions.checkToBtcAmount(this.type, request, { ...requestedAmount, pricePrefetch: pricePrefetchPromise }, fees, async () => ({ networkFee: 0n }), abortController.signal);
            metadata.times.priceCalculated = Date.now();
            // Sender-controlled latch: mint the payment hash FIRST, then bind it to
            // the escrow claim hash. This is the inversion vs ToBtcLn.
            const latched = await this.lx.createLatchedTransfer({
                statechainId: coin.statechainId,
                toAddress: parsedBody.toAddress
            });
            metadata.times.latchCreated = Date.now();
            const sequence = base_1.BigIntBufferUtils.fromBuffer((0, crypto_1.randomBytes)(8));
            const claimHash = swapContract.getHashForHtlc(Buffer.from(latched.paymentHash, "hex"));
            const payObject = await swapContract.createSwapData(base_1.ChainSwapType.HTLC, parsedBody.offerer, signer.getAddress(), parsedBody.token, totalInToken, claimHash.toString("hex"), sequence, parsedBody.expiryTimestamp, true, false, 0n, 0n);
            abortController.signal.throwIfAborted();
            metadata.times.swapCreated = Date.now();
            const sigData = await this.getToBtcSignatureData(chainIdentifier, payObject, req, abortController.signal, signDataPrefetchPromise);
            metadata.times.swapSigned = Date.now();
            const createdSwap = new ToBtcLxSwapAbs_1.ToBtcLxSwapAbs(chainIdentifier, latched.paymentHash, coin.statechainId, parsedBody.toAddress, latched.batchId, amount, swapFee, swapFeeInToken, networkFee, networkFeeInToken);
            createdSwap.data = payObject;
            createdSwap.metadata = metadata;
            createdSwap.prefix = sigData.prefix;
            createdSwap.timeout = sigData.timeout;
            createdSwap.signature = sigData.signature;
            createdSwap.feeRate = sigData.feeRate;
            await this.saveSwapData(createdSwap);
            this.swapLogger.info(createdSwap, "REST: /payStatecoin: created swap, statechainId: " + parsedBody.statechainId + " toAddress: " + parsedBody.toAddress);
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
        const getRefundAuthorization = (0, Utils_1.expressHandlerWrapper)(async (req, res) => {
            const parsedBody = (0, SchemaVerifier_1.verifySchema)({ ...req.body, ...req.query }, {
                paymentHash: (val) => val != null &&
                    typeof (val) === "string" &&
                    val.length === 64 &&
                    Utils_1.HEX_REGEX.test(val) ? val : null,
                sequence: SchemaVerifier_1.FieldTypeEnum.BigInt
            });
            if (parsedBody == null)
                throw { code: 20100, msg: "Invalid request body/query (paymentHash/sequence)" };
            this.checkSequence(parsedBody.sequence);
            let data = await this.storageManager.getData(parsedBody.paymentHash, parsedBody.sequence);
            if (data == null) {
                for (let chainId in this.chains.chains) {
                    const _data = this.getSwapByEscrowHash(chainId, parsedBody.paymentHash);
                    if (_data != null && _data.getSequence() === parsedBody.sequence) {
                        data = _data;
                        break;
                    }
                }
            }
            if (data == null)
                throw { _httpStatus: 200, code: 20007, msg: "Swap not found" };
            const { signer, swapContract } = this.getChain(data.chainIdentifier);
            if (await swapContract.isExpired(signer.getAddress(), data.data))
                throw {
                    _httpStatus: 200,
                    code: 20010,
                    msg: "Swap expired"
                };
            if (data.state === ToBtcLxSwapAbs_1.ToBtcLxSwapState.NON_PAYABLE) {
                const refundSigData = await swapContract.getRefundSignature(signer, data.data, this.config.refundAuthorizationTimeout);
                //Double check the state after the promise result
                if (data.state !== ToBtcLxSwapAbs_1.ToBtcLxSwapState.NON_PAYABLE)
                    throw { code: 20005, msg: "Not committed" };
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
            if (data.secret != null) {
                res.status(200).json({
                    code: 20006,
                    msg: "Already paid",
                    data: { secret: data.secret }
                });
                return;
            }
            res.status(200).json({
                code: 20008,
                msg: "Settlement in-flight"
            });
        });
        restServer.post(this.path + '/getRefundAuthorization', getRefundAuthorization);
        restServer.get(this.path + '/getRefundAuthorization', getRefundAuthorization);
        this.logger.info("started at path: ", this.path);
    }
    async init() {
        await this.loadData(ToBtcLxSwapAbs_1.ToBtcLxSwapAbs);
        this.subscribeToEvents();
        await PluginManager_1.PluginManager.serviceInitialize(this);
    }
    getInfoData() {
        return {
            minCltv: Number(this.config.minSendCltv),
            minTimestampCltv: Number(this.config.minTsSendCltv)
        };
    }
}
exports.ToBtcLxAbs = ToBtcLxAbs;
