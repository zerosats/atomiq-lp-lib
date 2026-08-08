import {
    Command,
    createCommand,
    cmdStringParser,
    cmdNumberParser,
    cmdBigIntParser
} from "@atomiqlabs/server-base";
import { SERejected } from "@zerosats/ml-core";
import type { StatecoinSummary } from "@zerosats/ml-core";
import { LxStatecoinStatus } from "../ILxWallet";
import type {
    ILxWallet,
    LxStatecoin,
    LxDepositInit,
    LxDeposit,
    LxDepositToken,
    LxLatchedTransferInit,
    LxLatchedTransfer,
    LxLatchSettleResult,
    LxLatchSettleOptions,
    LxWaitOptions,
    LxTransferInit,
    LxTransferStatus,
    LxReceiveAddress,
    LxReceiveResult,
    LxBalanceResponse,
    LxBroadcastResult
} from "../ILxWallet";
import { getLogger } from "../../utils/Utils";
import { LxClient, type LxClientConfig } from "./LxClient";
import { LxPoller } from "./LxPoller";

const logger = getLogger("LxWallet: ");

// Ceilings on a stall, not service-level expectations: both waits are for a
// state that can stop advancing permanently (a replaced funding transaction, a
// receiver that never claims), so a caller with its own deadline passes it in.
const DEFAULT_DEPOSIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;

// AbortSignal.any/timeout are not in the @types/node this package pins, so the
// composition is explicit. Returns the signal plus a dispose that clears the
// timer and detaches the listener, so a resolved wait leaves nothing behind.
const withTimeout = (timeoutMs: number, signal?: AbortSignal): {signal: AbortSignal, dispose: () => void} => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timed out after " + timeoutMs + "ms")), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason ?? new Error("Aborted"));
    if (signal != null) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
    };
};

// sats fit well under 2^53 (21e14 max), but Number(bigint) truncates silently, so
// reject out-of-range amounts at the ml-core boundary rather than corrupt them.
const satsToNumber = (v: bigint): number => {
    if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount out of safe range: " + v.toString());
    return Number(v);
};

// An explicit fee rate is passed to the SDK as given. The two SDK paths disagree
// on 0: withdraw uses a supplied rate verbatim (and its signing funnel rejects a
// non-positive one), while broadcastBackup still reads 0 as "use the estimate".
// Refuse it here so both directions behave the same, and so the old accident of
// 0 silently meaning "estimate" cannot come back. undefined stays undefined: that
// is how a caller asks for the estimate.
const checkFeeRate = (feeRate?: number): number | undefined => {
    if (feeRate == null) return undefined;
    if (!Number.isFinite(feeRate) || feeRate <= 0) {
        throw new Error("feeRate must be a finite number greater than 0; got " + feeRate);
    }
    return feeRate;
};

const toLxStatecoin = (c: StatecoinSummary): LxStatecoin => ({
    statechainId: c.statechain_id,
    utxoTxid: c.utxo_txid,
    utxoVout: c.utxo_vout,
    amount: c.amount == null ? null : BigInt(c.amount),
    status: c.status as unknown as LxStatecoinStatus,
    address: c.address,
    depositAddress: c.aggregated_address,
    locktime: c.locktime,
    duplicateIndex: c.duplicate_index
});

export type LxWalletConfig = LxClientConfig & {
    pollIntervalMs?: number;
};

/**
 * ILxWallet over @zerosats/ml-core: composes the protocol client (LxClient) with
 * an observe-only poller. The LP is the statecoin sender for latched transfers,
 * so createLatchedTransfer mints the SE payment hash and settleLatchedTransfer
 * reveals the preimage. See ILxWallet for the direction asymmetry this implies.
 */
export class LxWallet implements ILxWallet {

    private readonly lxClient: LxClient;
    private readonly pollIntervalMs: number;
    // Built in init(), once the protocol client is live.
    private poller: LxPoller | null = null;

    constructor(config: LxWalletConfig) {
        this.lxClient = new LxClient(config);
        this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    }

    private get name(): string {
        return this.lxClient.config.walletName;
    }

    private requirePoller(): LxPoller {
        if (this.poller == null) throw new Error("LX wallet not initialized, call init() first");
        return this.poller;
    }

    async init(): Promise<void> {
        // Idempotent: a second init must not spawn a second poller whose timer
        // chain would then be unreachable by stop().
        if (this.poller != null) return;
        await this.lxClient.init();
        this.poller = new LxPoller(this.lxClient.client, this.name, this.pollIntervalMs);
        this.poller.start();
    }

    stop(): void {
        this.poller?.stop();
        this.poller = null;
        this.lxClient.stop();
    }

    isReady(): boolean {
        return this.lxClient.isReady();
    }

    getStatus(): string {
        return this.lxClient.getStatus();
    }

    getStatusInfo(): Promise<Record<string, string>> {
        return this.lxClient.getStatusInfo();
    }

    async getLxBalance(): Promise<LxBalanceResponse> {
        const b = await this.lxClient.client.wallet.balance(this.name);
        return {
            confirmed: BigInt(b.confirmed),
            pending: BigInt(b.pending),
            total: BigInt(b.total)
        };
    }

    // Mercury has no wallet-level identity key (each coin carries its own
    // auth_pubkey). Whether to derive a stable one from the mnemonic, and on what
    // path, is open (Q9). Not needed for deposit/send/withdraw, so left unresolved.
    async getIdentityPublicKey(): Promise<string> {
        throw new Error("getIdentityPublicKey not implemented: no wallet-level identity key in Mercury (Q9)");
    }

    async newDepositToken(): Promise<LxDepositToken> {
        const t = await this.lxClient.client.wallet.newToken();
        if (t.deposit_address == null) throw new Error("SE returned a token without a deposit address");
        return {
            tokenId: t.token_id,
            depositAddress: t.deposit_address,
            fee: BigInt(t.fee),
            confirmationTarget: t.confirmation_target
        };
    }

    async createDeposit(init: LxDepositInit): Promise<LxDeposit> {
        const tokenId = init.tokenId ?? (await this.lxClient.client.wallet.newToken()).token_id;
        const res = await this.lxClient.client.wallet.depositAddress(this.name, tokenId, satsToNumber(init.amount));
        if (res.deposit_address == null || res.statechain_id == null) {
            throw new Error("SE returned an incomplete deposit address");
        }
        return {
            depositAddress: res.deposit_address,
            statechainId: res.statechain_id,
            amount: init.amount
        };
    }

    async getCoin(statechainId: string): Promise<LxStatecoin | null> {
        const coins = await this.lxClient.client.wallet.list(this.name);
        const coin = coins.find((c) => c.statechain_id === statechainId);
        return coin == null ? null : toLxStatecoin(coin);
    }

    async listCoins(): Promise<LxStatecoin[]> {
        const coins = await this.lxClient.client.wallet.list(this.name);
        return coins.map(toLxStatecoin);
    }

    /**
     * Wait for a deposit to reach CONFIRMED. Runs a foreground poll that advances
     * the coin with wallet.sync (which mints and signs the backup tx). This is a
     * caller-driven signing step, distinct from the background poller, which never
     * signs.
     *
     * Bounded, and it must be: sync fails closed on a coin whose funding outpoint
     * the chain no longer carries (a fee-bumped or evicted funding transaction),
     * skipping it rather than spending a signature slot on a backup that can never
     * confirm. That coin never reaches CONFIRMED, so the timeout is the only exit.
     * Status changes are logged, so a stall is diagnosable from the node log
     * instead of presenting as a coin that never appears in inventory.
     */
    async waitForDeposit(statechainId: string, opts: LxWaitOptions = {}): Promise<LxStatecoin> {
        const pollMs = opts.pollIntervalMs ?? this.pollIntervalMs;
        const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_DEPOSIT_TIMEOUT_MS);
        let lastStatus: string | null = null;
        for (;;) {
            if (opts.abortSignal?.aborted) throw opts.abortSignal.reason ?? new Error("Aborted");
            // sync advances funded deposits (mints backup tx), then lists.
            await this.lxClient.client.wallet.sync(this.name);
            const coin = await this.getCoin(statechainId);
            const status = coin?.status ?? "absent";
            if (status !== lastStatus) {
                logger.info("waitForDeposit: " + statechainId + " is " + status);
                lastStatus = status;
            }
            if (coin != null && coin.status === LxStatecoinStatus.CONFIRMED) return coin;
            if (Date.now() >= deadline) {
                throw new Error("waitForDeposit timed out for " + statechainId + ", last status: " + status);
            }
            await new Promise((r) => setTimeout(r, pollMs));
        }
    }

    async createLatchedTransfer(init: LxLatchedTransferInit): Promise<LxLatchedTransfer> {
        const { hash, batchId } = await this.lxClient.client.settlement.paymentHash(this.name, init.statechainId);
        // Persist batchId -> statechainId BEFORE the irreversible transferSend, so a
        // crash after the coin leaves can still be settled (the SE offers no
        // batchId -> statechainId lookup).
        await this.lxClient.storage.latchPut(batchId, init.statechainId);
        const sent = await this.lxClient.client.wallet.transferSend(this.name, init.statechainId, init.toAddress, { batchId });
        // The send is the irreversible step, so record what it spent: the receipt
        // names the SE signature slots used and the locktime the unilateral exit
        // moved to. Diagnostic only, and optional so an older ml-core (the range
        // admits one without receipts) does not fault the latch path.
        const receipt = (sent as any)?.receipt;
        if (receipt != null) {
            logger.info("createLatchedTransfer: sent " + init.statechainId +
                " batch " + batchId +
                " signatures " + receipt.signing?.signaturesProduced +
                " locktime " + receipt.backup?.previousLocktime + " -> " + receipt.backup?.newLocktime);
        }
        return { batchId, paymentHash: hash, statechainId: init.statechainId };
    }

    /**
     * Reveal the latch preimage. NOT a one-shot: confirmInvoice clears only the
     * sender half of the lock, and the SE releases the preimage only once the
     * RECEIVER has claimed the coin (clearing the other half). Until then the SE
     * answers 404, so this polls until the preimage is available or the deadline /
     * abort fires. That wait IS the atomicity guarantee: the sender gets the
     * preimage only after the coin is delivered.
     */
    async settleLatchedTransfer(batchId: string, opts: LxLatchSettleOptions = {}): Promise<LxLatchSettleResult> {
        const statechainId = await this.lxClient.storage.latchGet(batchId);
        if (statechainId == null) throw new Error("Unknown batchId: " + batchId);

        // Clears the sender half (locked2). Idempotent, safe to call once up front.
        await this.lxClient.client.settlement.confirmInvoice(this.name, statechainId);

        const pollMs = opts.pollIntervalMs ?? 3000;
        const deadline = opts.timeoutMs == null ? null : Date.now() + opts.timeoutMs;
        for (;;) {
            if (opts.abortSignal?.aborted) throw opts.abortSignal.reason ?? new Error("Aborted");
            try {
                const { preimage } = await this.lxClient.client.settlement.retrievePreImage(this.name, statechainId, batchId);
                await this.lxClient.storage.latchDelete(batchId);
                return { preimage };
            } catch (e) {
                // 404 = still locked (receiver has not claimed yet): keep polling.
                // Any other error is real and propagates.
                if (!(e instanceof SERejected) || e.status !== 404) throw e;
                if (deadline != null && Date.now() >= deadline) throw new Error("settleLatchedTransfer timed out waiting for the receiver to claim");
                await new Promise((r) => setTimeout(r, pollMs));
            }
        }
    }

    async cancelLatchedTransfer(batchId: string): Promise<void> {
        // Mercury has no protocol-level latch cancel: once transferSend fires, the
        // coin is claimable by the receiver. The lock on re-transferring it back
        // releases only at the SE batch timeout (config.batch_timeout), after which
        // the sender can re-transfer to itself; unilateral exit is the last resort.
        // This call only drops the local batchId mapping.
        await this.lxClient.storage.latchDelete(batchId);
        logger.warn("cancelLatchedTransfer: no protocol cancel; dropped local mapping for batch " + batchId);
    }

    async send(init: LxTransferInit): Promise<LxTransferStatus> {
        await this.lxClient.client.wallet.transferSend(this.name, init.statechainId, init.toAddress);
        const coin = await this.getCoin(init.statechainId);
        return { statechainId: init.statechainId, status: coin?.status ?? LxStatecoinStatus.IN_TRANSFER };
    }

    async getTransfer(statechainId: string): Promise<LxTransferStatus | null> {
        const coin = await this.getCoin(statechainId);
        return coin == null ? null : { statechainId, status: coin.status };
    }

    /**
     * Wait until the receiver has claimed the coin (TRANSFERRED). Bounded for the
     * same reason as waitForDeposit: a receiver that never claims never moves the
     * status. opts.pollIntervalMs is not honoured here; the cadence belongs to the
     * shared background poller (LxWalletConfig.pollIntervalMs), and re-timing it
     * per call would re-time it for every other waiter too.
     */
    async waitForTransfer(statechainId: string, opts: LxWaitOptions = {}): Promise<LxTransferStatus> {
        const bounded = withTimeout(opts.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS, opts.abortSignal);
        try {
            const coin = await this.requirePoller().waitForCoin(
                statechainId,
                (c) => (c.status as unknown as LxStatecoinStatus) === LxStatecoinStatus.TRANSFERRED,
                bounded.signal
            );
            return { statechainId, status: coin.status as unknown as LxStatecoinStatus };
        } finally {
            bounded.dispose();
        }
    }

    async newReceiveAddress(generateBatchId = false): Promise<LxReceiveAddress> {
        // batchId is only minted when asked (batch-locked / atomic receive); a
        // plain receive leaves it undefined.
        const res = await this.lxClient.client.wallet.newTransferAddress(this.name, generateBatchId);
        return { transferAddress: res.transfer_receive, batchId: res.batch_id };
    }

    async receiveTransfers(): Promise<LxReceiveResult> {
        const r = await this.lxClient.client.wallet.transferReceive(this.name);
        return {
            isBatchLocked: r.isThereBatchLocked,
            receivedStatechainIds: r.receivedStatechainIds,
            issues: r.issues.map((i) => ({
                operation: i.operation,
                statechainId: i.statechainId,
                message: (i.cause as any)?.message ?? String(i.cause)
            }))
        };
    }

    async withdraw(statechainId: string, toAddress: string, feeRate?: number): Promise<string> {
        const op = await this.lxClient.client.wallet.withdraw(this.name, statechainId, toAddress, { feeRate: checkFeeRate(feeRate) });
        if (op.reference == null) throw new Error("Withdraw did not return a broadcast txid");
        return op.reference;
    }

    async forceExit(statechainId: string, toAddress: string, feeRate?: number): Promise<LxBroadcastResult> {
        const res = await this.lxClient.client.wallet.broadcastBackup(this.name, statechainId, toAddress, { feeRate: checkFeeRate(feeRate) });
        return { backupTxid: res.backupTx, cpfpTxid: res.cpfpTx };
    }

    getCommands(): Command<any>[] {
        return [
            createCommand(
                "lxdeposit",
                "Create an on-chain deposit address funding a new statecoin",
                {
                    args: {
                        amount: { base: true, description: "Statecoin amount in sats", parser: cmdBigIntParser(1n) }
                    },
                    parser: async (args, sendLine): Promise<any> => {
                        if (!this.isReady()) throw new Error("LX wallet not ready yet, monitor with 'status'");
                        // On a paid-token SE the operator must fund the token first;
                        // mint it, print the fee address, then poll until the SE
                        // confirms it and can issue the statecoin deposit address.
                        const token = await this.newDepositToken();
                        if (token.fee > 0n) {
                            sendLine("Pay token fee " + token.fee.toString() + " sats to " + token.depositAddress +
                                " and confirm " + token.confirmationTarget + " block(s); waiting...");
                        }
                        let deposit: LxDeposit | null = null;
                        for (let i = 0; i < 60; i++) {
                            try {
                                deposit = await this.createDeposit({ amount: args.amount, tokenId: token.tokenId });
                                break;
                            } catch (e) {
                                const body = e instanceof SERejected ? JSON.stringify(e.body) : String(e);
                                if (!body.includes("not confirmed") && !body.includes("Token")) throw e;
                                await new Promise((r) => setTimeout(r, 3000));
                            }
                        }
                        if (deposit == null) throw new Error("deposit token was not confirmed in time");
                        sendLine("Send " + deposit.amount.toString() + " sats to: " + deposit.depositAddress);
                        return deposit;
                    }
                }
            ),
            createCommand(
                "lxsync",
                "Advance funded deposits (mint and sign backup txs), then list coins",
                {
                    args: {},
                    parser: async (args, sendLine): Promise<any> => {
                        if (!this.isReady()) throw new Error("LX wallet not ready yet, monitor with 'status'");
                        await this.lxClient.client.wallet.sync(this.name);
                        const coins = await this.lxClient.client.wallet.list(this.name);
                        for (const c of coins) {
                            sendLine((c.statechain_id ?? "?") + "  " + c.status + "  " + (c.amount ?? "?") + " sats");
                        }
                        return coins.map(toLxStatecoin);
                    }
                }
            ),
            createCommand(
                "lxwithdraw",
                "Withdraw a statecoin on-chain to a BTC address",
                {
                    args: {
                        statechainId: { base: true, description: "Statechain id of the coin", parser: cmdStringParser() },
                        address: { base: true, description: "Destination BTC address", parser: cmdStringParser() },
                        feeRate: { base: false, description: "Fee rate (sats/vB)", parser: cmdNumberParser(false, 1, undefined, true) }
                    },
                    parser: async (args, sendLine): Promise<any> => {
                        if (!this.isReady()) throw new Error("LX wallet not ready yet, monitor with 'status'");
                        const txid = await this.withdraw(args.statechainId, args.address, args.feeRate ?? undefined);
                        sendLine("Withdraw broadcast: " + txid);
                        return { txid };
                    }
                }
            ),
            createCommand(
                "lxforceexit",
                "Unilateral exit: broadcast the backup tx and its CPFP child",
                {
                    args: {
                        statechainId: { base: true, description: "Statechain id of the coin", parser: cmdStringParser() },
                        address: { base: true, description: "Destination BTC address", parser: cmdStringParser() },
                        feeRate: { base: false, description: "Fee rate (sats/vB)", parser: cmdNumberParser(false, 1, undefined, true) }
                    },
                    parser: async (args, sendLine): Promise<any> => {
                        if (!this.isReady()) throw new Error("LX wallet not ready yet, monitor with 'status'");
                        const res = await this.forceExit(args.statechainId, args.address, args.feeRate ?? undefined);
                        sendLine("Backup tx: " + res.backupTxid);
                        sendLine("CPFP tx: " + res.cpfpTxid);
                        return res;
                    }
                }
            ),
            createCommand(
                "lxlistcoins",
                "List the LX wallet's statecoins",
                {
                    args: {},
                    parser: async (args, sendLine): Promise<any> => {
                        if (!this.isReady()) throw new Error("LX wallet not ready yet, monitor with 'status'");
                        const coins = await this.lxClient.client.wallet.list(this.name);
                        for (const c of coins) {
                            sendLine((c.statechain_id ?? "?") + "  " + c.status + "  " + (c.amount ?? "?") + " sats");
                        }
                        return coins.map(toLxStatecoin);
                    }
                }
            )
        ];
    }

}
