"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LxWallet = void 0;
const server_base_1 = require("@atomiqlabs/server-base");
const ml_core_1 = require("@zerosats/ml-core");
const ILxWallet_1 = require("../ILxWallet");
const Utils_1 = require("../../utils/Utils");
const LxClient_1 = require("./LxClient");
const LxPoller_1 = require("./LxPoller");
const logger = (0, Utils_1.getLogger)("LxWallet: ");
// sats fit well under 2^53 (21e14 max), but Number(bigint) truncates silently, so
// reject out-of-range amounts at the ml-core boundary rather than corrupt them.
const satsToNumber = (v) => {
    if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("amount out of safe range: " + v.toString());
    return Number(v);
};
const toLxStatecoin = (c) => ({
    statechainId: c.statechain_id,
    utxoTxid: c.utxo_txid,
    utxoVout: c.utxo_vout,
    amount: c.amount == null ? null : BigInt(c.amount),
    status: c.status,
    address: c.address,
    depositAddress: c.aggregated_address,
    locktime: c.locktime,
    duplicateIndex: c.duplicate_index
});
/**
 * ILxWallet over @zerosats/ml-core: composes the protocol client (LxClient) with
 * an observe-only poller. The LP is the statecoin sender for latched transfers,
 * so createLatchedTransfer mints the SE payment hash and settleLatchedTransfer
 * reveals the preimage. See ILxWallet for the direction asymmetry this implies.
 */
class LxWallet {
    constructor(config) {
        // Built in init(), once the protocol client is live.
        this.poller = null;
        this.lxClient = new LxClient_1.LxClient(config);
        this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    }
    get name() {
        return this.lxClient.config.walletName;
    }
    requirePoller() {
        if (this.poller == null)
            throw new Error("LX wallet not initialized, call init() first");
        return this.poller;
    }
    async init() {
        // Idempotent: a second init must not spawn a second poller whose timer
        // chain would then be unreachable by stop().
        if (this.poller != null)
            return;
        await this.lxClient.init();
        this.poller = new LxPoller_1.LxPoller(this.lxClient.client, this.name, this.pollIntervalMs);
        this.poller.start();
    }
    stop() {
        this.poller?.stop();
        this.poller = null;
        this.lxClient.stop();
    }
    isReady() {
        return this.lxClient.isReady();
    }
    getStatus() {
        return this.lxClient.getStatus();
    }
    getStatusInfo() {
        return this.lxClient.getStatusInfo();
    }
    async getLxBalance() {
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
    async getIdentityPublicKey() {
        throw new Error("getIdentityPublicKey not implemented: no wallet-level identity key in Mercury (Q9)");
    }
    async newDepositToken() {
        const t = await this.lxClient.client.wallet.newToken();
        if (t.deposit_address == null)
            throw new Error("SE returned a token without a deposit address");
        return {
            tokenId: t.token_id,
            depositAddress: t.deposit_address,
            fee: BigInt(t.fee),
            confirmationTarget: t.confirmation_target
        };
    }
    async createDeposit(init) {
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
    async getCoin(statechainId) {
        const coins = await this.lxClient.client.wallet.list(this.name);
        const coin = coins.find((c) => c.statechain_id === statechainId);
        return coin == null ? null : toLxStatecoin(coin);
    }
    async listCoins() {
        const coins = await this.lxClient.client.wallet.list(this.name);
        return coins.map(toLxStatecoin);
    }
    /**
     * Wait for a deposit to reach CONFIRMED. Runs a foreground poll that advances
     * the coin with wallet.sync (which mints and signs the backup tx). This is a
     * caller-driven signing step, distinct from the background poller, which never
     * signs.
     */
    async waitForDeposit(statechainId, abortSignal) {
        for (;;) {
            if (abortSignal?.aborted)
                throw abortSignal.reason ?? new Error("Aborted");
            // sync advances funded deposits (mints backup tx), then lists.
            await this.lxClient.client.wallet.sync(this.name);
            const coin = await this.getCoin(statechainId);
            if (coin != null && coin.status === ILxWallet_1.LxStatecoinStatus.CONFIRMED)
                return coin;
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
    async createLatchedTransfer(init) {
        const { hash, batchId } = await this.lxClient.client.settlement.paymentHash(this.name, init.statechainId);
        // Persist batchId -> statechainId BEFORE the irreversible transferSend, so a
        // crash after the coin leaves can still be settled (the SE offers no
        // batchId -> statechainId lookup).
        await this.lxClient.storage.latchPut(batchId, init.statechainId);
        await this.lxClient.client.wallet.transferSend(this.name, init.statechainId, init.toAddress, { batchId });
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
    async settleLatchedTransfer(batchId, opts = {}) {
        const statechainId = await this.lxClient.storage.latchGet(batchId);
        if (statechainId == null)
            throw new Error("Unknown batchId: " + batchId);
        // Clears the sender half (locked2). Idempotent, safe to call once up front.
        await this.lxClient.client.settlement.confirmInvoice(this.name, statechainId);
        const pollMs = opts.pollIntervalMs ?? 3000;
        const deadline = opts.timeoutMs == null ? null : Date.now() + opts.timeoutMs;
        for (;;) {
            if (opts.abortSignal?.aborted)
                throw opts.abortSignal.reason ?? new Error("Aborted");
            try {
                const { preimage } = await this.lxClient.client.settlement.retrievePreImage(this.name, statechainId, batchId);
                await this.lxClient.storage.latchDelete(batchId);
                return { preimage };
            }
            catch (e) {
                // 404 = still locked (receiver has not claimed yet): keep polling.
                // Any other error is real and propagates.
                if (!(e instanceof ml_core_1.SERejected) || e.status !== 404)
                    throw e;
                if (deadline != null && Date.now() >= deadline)
                    throw new Error("settleLatchedTransfer timed out waiting for the receiver to claim");
                await new Promise((r) => setTimeout(r, pollMs));
            }
        }
    }
    async cancelLatchedTransfer(batchId) {
        // Mercury has no protocol-level latch cancel: once transferSend fires, the
        // coin is claimable by the receiver. The lock on re-transferring it back
        // releases only at the SE batch timeout (config.batch_timeout), after which
        // the sender can re-transfer to itself; unilateral exit is the last resort.
        // This call only drops the local batchId mapping.
        await this.lxClient.storage.latchDelete(batchId);
        logger.warn("cancelLatchedTransfer: no protocol cancel; dropped local mapping for batch " + batchId);
    }
    async send(init) {
        await this.lxClient.client.wallet.transferSend(this.name, init.statechainId, init.toAddress);
        const coin = await this.getCoin(init.statechainId);
        return { statechainId: init.statechainId, status: coin?.status ?? ILxWallet_1.LxStatecoinStatus.IN_TRANSFER };
    }
    async getTransfer(statechainId) {
        const coin = await this.getCoin(statechainId);
        return coin == null ? null : { statechainId, status: coin.status };
    }
    async waitForTransfer(statechainId, abortSignal) {
        const coin = await this.requirePoller().waitForCoin(statechainId, (c) => c.status === ILxWallet_1.LxStatecoinStatus.TRANSFERRED, abortSignal);
        return { statechainId, status: coin.status };
    }
    async newReceiveAddress(generateBatchId = false) {
        // batchId is only minted when asked (batch-locked / atomic receive); a
        // plain receive leaves it undefined.
        const res = await this.lxClient.client.wallet.newTransferAddress(this.name, generateBatchId);
        return { transferAddress: res.transfer_receive, batchId: res.batch_id };
    }
    async receiveTransfers() {
        const r = await this.lxClient.client.wallet.transferReceive(this.name);
        return {
            isBatchLocked: r.isThereBatchLocked,
            receivedStatechainIds: r.receivedStatechainIds,
            issues: r.issues.map((i) => ({
                operation: i.operation,
                statechainId: i.statechainId,
                message: i.cause?.message ?? String(i.cause)
            }))
        };
    }
    async withdraw(statechainId, toAddress, feeRate) {
        const op = await this.lxClient.client.wallet.withdraw(this.name, statechainId, toAddress, { feeRate });
        if (op.reference == null)
            throw new Error("Withdraw did not return a broadcast txid");
        return op.reference;
    }
    async forceExit(statechainId, toAddress, feeRate) {
        const res = await this.lxClient.client.wallet.broadcastBackup(this.name, statechainId, toAddress, { feeRate });
        return { backupTxid: res.backupTx, cpfpTxid: res.cpfpTx };
    }
    getCommands() {
        return [
            (0, server_base_1.createCommand)("lxdeposit", "Create an on-chain deposit address funding a new statecoin", {
                args: {
                    amount: { base: true, description: "Statecoin amount in sats", parser: (0, server_base_1.cmdBigIntParser)(1n) }
                },
                parser: async (args, sendLine) => {
                    if (!this.isReady())
                        throw new Error("LX wallet not ready yet, monitor with 'status'");
                    // On a paid-token SE the operator must fund the token first;
                    // mint it, print the fee address, then poll until the SE
                    // confirms it and can issue the statecoin deposit address.
                    const token = await this.newDepositToken();
                    if (token.fee > 0n) {
                        sendLine("Pay token fee " + token.fee.toString() + " sats to " + token.depositAddress +
                            " and confirm " + token.confirmationTarget + " block(s); waiting...");
                    }
                    let deposit = null;
                    for (let i = 0; i < 60; i++) {
                        try {
                            deposit = await this.createDeposit({ amount: args.amount, tokenId: token.tokenId });
                            break;
                        }
                        catch (e) {
                            const body = e instanceof ml_core_1.SERejected ? JSON.stringify(e.body) : String(e);
                            if (!body.includes("not confirmed") && !body.includes("Token"))
                                throw e;
                            await new Promise((r) => setTimeout(r, 3000));
                        }
                    }
                    if (deposit == null)
                        throw new Error("deposit token was not confirmed in time");
                    sendLine("Send " + deposit.amount.toString() + " sats to: " + deposit.depositAddress);
                    return deposit;
                }
            }),
            (0, server_base_1.createCommand)("lxsync", "Advance funded deposits (mint and sign backup txs), then list coins", {
                args: {},
                parser: async (args, sendLine) => {
                    if (!this.isReady())
                        throw new Error("LX wallet not ready yet, monitor with 'status'");
                    await this.lxClient.client.wallet.sync(this.name);
                    const coins = await this.lxClient.client.wallet.list(this.name);
                    for (const c of coins) {
                        sendLine((c.statechain_id ?? "?") + "  " + c.status + "  " + (c.amount ?? "?") + " sats");
                    }
                    return coins.map(toLxStatecoin);
                }
            }),
            (0, server_base_1.createCommand)("lxwithdraw", "Withdraw a statecoin on-chain to a BTC address", {
                args: {
                    statechainId: { base: true, description: "Statechain id of the coin", parser: (0, server_base_1.cmdStringParser)() },
                    address: { base: true, description: "Destination BTC address", parser: (0, server_base_1.cmdStringParser)() },
                    feeRate: { base: false, description: "Fee rate (sats/vB)", parser: (0, server_base_1.cmdNumberParser)(false, 1, undefined, true) }
                },
                parser: async (args, sendLine) => {
                    if (!this.isReady())
                        throw new Error("LX wallet not ready yet, monitor with 'status'");
                    const txid = await this.withdraw(args.statechainId, args.address, args.feeRate ?? undefined);
                    sendLine("Withdraw broadcast: " + txid);
                    return { txid };
                }
            }),
            (0, server_base_1.createCommand)("lxforceexit", "Unilateral exit: broadcast the backup tx and its CPFP child", {
                args: {
                    statechainId: { base: true, description: "Statechain id of the coin", parser: (0, server_base_1.cmdStringParser)() },
                    address: { base: true, description: "Destination BTC address", parser: (0, server_base_1.cmdStringParser)() },
                    feeRate: { base: false, description: "Fee rate (sats/vB)", parser: (0, server_base_1.cmdNumberParser)(false, 1, undefined, true) }
                },
                parser: async (args, sendLine) => {
                    if (!this.isReady())
                        throw new Error("LX wallet not ready yet, monitor with 'status'");
                    const res = await this.forceExit(args.statechainId, args.address, args.feeRate ?? undefined);
                    sendLine("Backup tx: " + res.backupTxid);
                    sendLine("CPFP tx: " + res.cpfpTxid);
                    return res;
                }
            }),
            (0, server_base_1.createCommand)("lxlistcoins", "List the LX wallet's statecoins", {
                args: {},
                parser: async (args, sendLine) => {
                    if (!this.isReady())
                        throw new Error("LX wallet not ready yet, monitor with 'status'");
                    const coins = await this.lxClient.client.wallet.list(this.name);
                    for (const c of coins) {
                        sendLine((c.statechain_id ?? "?") + "  " + c.status + "  " + (c.amount ?? "?") + " sats");
                    }
                    return coins.map(toLxStatecoin);
                }
            })
        ];
    }
}
exports.LxWallet = LxWallet;
