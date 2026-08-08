import { describe, it, expect, vi } from "vitest";
import { SERejected } from "@zerosats/ml-core"; // aliased to the offline stub
import { LxWallet } from "../src/wallets/lx/LxWallet";
import { LxStatecoinStatus } from "../src/wallets/ILxWallet";

// A fake LxClient exposing only the surface LxWallet touches. LxWallet reads
// this.lxClient.{config,client,storage}; we build a wallet without running any
// constructor (Object.create) and drop the fake in, so no wasm / SE / filesystem.
function makeFakeClient() {
    const wallet = {
        balance: vi.fn(),
        list: vi.fn(),
        // transferSend returns a TransferSendResult: an Operation widened with the
        // signing receipt. Mirrored here so the latch path is exercised against the
        // real shape rather than undefined.
        transferSend: vi.fn().mockResolvedValue({
            id: "op", type: "transfer_send", status: "IN_TRANSFER", at: 0,
            receipt: {
                statechainId: "SC",
                batchId: "B",
                fundingOutpoint: { txid: "tx", vout: 0 },
                backup: { previousLocktime: 100, newLocktime: 90, transactionCount: 2 },
                signing: {
                    scheme: "two-party-musig2",
                    serverSignatureCountBefore: 1,
                    signaturesProduced: 1,
                    expectedServerSignatureCountAfter: 2,
                    serverSignatureCountAfterSource: "inferred",
                    localBackupCountBefore: 1,
                    localBackupCountAfter: 2
                }
            }
        }),
        withdraw: vi.fn(),
        broadcastBackup: vi.fn(),
        sync: vi.fn().mockResolvedValue(undefined),
        depositAddress: vi.fn(),
        newToken: vi.fn()
    };
    const settlement = {
        paymentHash: vi.fn(),
        confirmInvoice: vi.fn().mockResolvedValue(undefined),
        retrievePreImage: vi.fn()
    };
    const storage = {
        latchPut: vi.fn().mockResolvedValue(undefined),
        latchGet: vi.fn(),
        latchDelete: vi.fn().mockResolvedValue(undefined)
    };
    return { config: { walletName: "lx-lp" }, client: { wallet, settlement }, storage };
}

function makeWallet(fake: ReturnType<typeof makeFakeClient>): LxWallet {
    const w: LxWallet = Object.create(LxWallet.prototype);
    (w as any).lxClient = fake;
    (w as any).pollIntervalMs = 5000;
    (w as any).poller = null;
    return w;
}

describe("LxWallet.createLatchedTransfer", () => {
    it("persists batchId -> statechainId BEFORE the irreversible transferSend", async () => {
        const fake = makeFakeClient();
        fake.client.settlement.paymentHash.mockResolvedValue({ hash: "H", batchId: "B" });
        const w = makeWallet(fake);

        const res = await w.createLatchedTransfer({ statechainId: "SC", toAddress: "addr" });

        expect(res).toEqual({ batchId: "B", paymentHash: "H", statechainId: "SC" });
        // The invariant: the local mapping must be durable before the coin leaves,
        // so a crash right after transferSend is still settleable.
        const putOrder = fake.storage.latchPut.mock.invocationCallOrder[0];
        const sendOrder = fake.client.wallet.transferSend.mock.invocationCallOrder[0];
        expect(putOrder).toBeLessThan(sendOrder);
        expect(fake.storage.latchPut).toHaveBeenCalledWith("B", "SC");
        expect(fake.client.wallet.transferSend).toHaveBeenCalledWith("lx-lp", "SC", "addr", { batchId: "B" });
    });

    it("keeps the mapping even if transferSend then fails (crash is recoverable)", async () => {
        const fake = makeFakeClient();
        fake.client.settlement.paymentHash.mockResolvedValue({ hash: "H", batchId: "B" });
        fake.client.wallet.transferSend.mockRejectedValue(new Error("boom"));
        const w = makeWallet(fake);

        await expect(w.createLatchedTransfer({ statechainId: "SC", toAddress: "a" })).rejects.toThrow("boom");
        expect(fake.storage.latchPut).toHaveBeenCalledWith("B", "SC");
    });
});

describe("LxWallet.settleLatchedTransfer", () => {
    it("throws on an unknown batchId", async () => {
        const fake = makeFakeClient();
        fake.storage.latchGet.mockResolvedValue(null);
        await expect(makeWallet(fake).settleLatchedTransfer("B")).rejects.toThrow("Unknown batchId");
    });

    it("confirms the sender half, returns the preimage, and clears the mapping", async () => {
        const fake = makeFakeClient();
        fake.storage.latchGet.mockResolvedValue("SC");
        fake.client.settlement.retrievePreImage.mockResolvedValue({ preimage: "P" });
        const w = makeWallet(fake);

        expect(await w.settleLatchedTransfer("B")).toEqual({ preimage: "P" });
        expect(fake.client.settlement.confirmInvoice).toHaveBeenCalledWith("lx-lp", "SC");
        expect(fake.storage.latchDelete).toHaveBeenCalledWith("B");
    });

    it("polls while the SE answers 404 (receiver has not claimed), then resolves", async () => {
        const fake = makeFakeClient();
        fake.storage.latchGet.mockResolvedValue("SC");
        fake.client.settlement.retrievePreImage
            .mockRejectedValueOnce(new SERejected(404, { error: "locked" }))
            .mockRejectedValueOnce(new SERejected(404, { error: "locked" }))
            .mockResolvedValue({ preimage: "P" });
        const w = makeWallet(fake);

        expect(await w.settleLatchedTransfer("B", { pollIntervalMs: 1 })).toEqual({ preimage: "P" });
        expect(fake.client.settlement.retrievePreImage).toHaveBeenCalledTimes(3);
    });

    it("times out if the receiver never claims", async () => {
        const fake = makeFakeClient();
        fake.storage.latchGet.mockResolvedValue("SC");
        fake.client.settlement.retrievePreImage.mockRejectedValue(new SERejected(404, { error: "locked" }));
        const w = makeWallet(fake);

        await expect(w.settleLatchedTransfer("B", { pollIntervalMs: 1, timeoutMs: 5 })).rejects.toThrow("timed out");
    });

    it("propagates a non-404 SE error instead of polling", async () => {
        const fake = makeFakeClient();
        fake.storage.latchGet.mockResolvedValue("SC");
        fake.client.settlement.retrievePreImage.mockRejectedValue(new SERejected(500, { error: "boom" }));
        const w = makeWallet(fake);

        // Only 404 means "still locked"; the poll must not swallow any other status.
        await expect(w.settleLatchedTransfer("B", { pollIntervalMs: 1 })).rejects.toThrow("status 500");
        expect(fake.client.settlement.retrievePreImage).toHaveBeenCalledTimes(1);
    });
});

// The SDK's sync fails closed on a coin whose funding outpoint the chain no
// longer carries: it skips the coin rather than spending a signature slot on a
// backup that can never confirm. Such a coin never reaches CONFIRMED, so an
// unbounded wait here would hang for good.
describe("LxWallet.waitForDeposit", () => {
    const coin = (status: string) => ({
        statechain_id: "SC", utxo_txid: "tx", utxo_vout: 0, amount: 1000,
        status, address: "addr", aggregated_address: "agg", locktime: 100, duplicate_index: 0
    });

    it("returns once the coin reaches CONFIRMED", async () => {
        const fake = makeFakeClient();
        fake.client.wallet.list
            .mockResolvedValueOnce([coin("UNCONFIRMED")])
            .mockResolvedValue([coin("CONFIRMED")]);
        const w = makeWallet(fake);

        const got = await w.waitForDeposit("SC", { pollIntervalMs: 1, timeoutMs: 5000 });
        expect(got.status).toBe(LxStatecoinStatus.CONFIRMED);
        expect(fake.client.wallet.sync).toHaveBeenCalled();
    });

    it("gives up on a coin that never advances, naming its last status", async () => {
        const fake = makeFakeClient();
        fake.client.wallet.list.mockResolvedValue([coin("UNCONFIRMED")]);
        const w = makeWallet(fake);

        await expect(w.waitForDeposit("SC", { pollIntervalMs: 1, timeoutMs: 5 }))
            .rejects.toThrow("timed out for SC, last status: UNCONFIRMED");
    });

    it("honours an abort signal", async () => {
        const fake = makeFakeClient();
        fake.client.wallet.list.mockResolvedValue([coin("UNCONFIRMED")]);
        const ac = new AbortController();
        ac.abort(new Error("caller went away"));

        await expect(makeWallet(fake).waitForDeposit("SC", { abortSignal: ac.signal }))
            .rejects.toThrow("caller went away");
    });
});

describe("LxWallet.waitForTransfer", () => {
    it("gives up when the receiver never claims", async () => {
        const fake = makeFakeClient();
        const w = makeWallet(fake);
        // A poller whose loop never resolves the waiter: the bound has to come
        // from waitForTransfer itself, not from the poller.
        (w as any).poller = {
            waitForCoin: (_id: string, _p: unknown, signal?: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                })
        };

        await expect(w.waitForTransfer("SC", { timeoutMs: 5 })).rejects.toThrow("timed out after 5ms");
    });

    it("propagates the caller's abort reason, not the timeout's", async () => {
        const fake = makeFakeClient();
        const w = makeWallet(fake);
        (w as any).poller = {
            waitForCoin: (_id: string, _p: unknown, signal?: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                })
        };
        const ac = new AbortController();
        setTimeout(() => ac.abort(new Error("caller went away")), 1);

        await expect(w.waitForTransfer("SC", { abortSignal: ac.signal, timeoutMs: 10_000 }))
            .rejects.toThrow("caller went away");
    });
});

describe("LxWallet mapping and guards", () => {
    it("cancelLatchedTransfer only drops the local mapping (no protocol cancel)", async () => {
        const fake = makeFakeClient();
        await makeWallet(fake).cancelLatchedTransfer("B");
        expect(fake.storage.latchDelete).toHaveBeenCalledWith("B");
    });

    it("getLxBalance converts SE string amounts to bigint", async () => {
        const fake = makeFakeClient();
        // WalletBalance carries numbers, not strings; sats cross to bigint here.
        fake.client.wallet.balance.mockResolvedValue({ confirmed: 100, pending: 5, total: 105 });
        expect(await makeWallet(fake).getLxBalance()).toEqual({ confirmed: 100n, pending: 5n, total: 105n });
    });

    it("listCoins maps a StatecoinSummary to the LP-facing LxStatecoin", async () => {
        const fake = makeFakeClient();
        // StatecoinSummary.amount is a number in the SDK, null until funded.
        fake.client.wallet.list.mockResolvedValue([{
            statechain_id: "SC", utxo_txid: "tx", utxo_vout: 0, amount: 1000,
            status: "CONFIRMED", address: "addr", aggregated_address: "agg",
            locktime: 100, duplicate_index: 0
        }]);
        const coins = await makeWallet(fake).listCoins();
        expect(coins[0]).toEqual({
            statechainId: "SC", utxoTxid: "tx", utxoVout: 0, amount: 1000n,
            status: LxStatecoinStatus.CONFIRMED, address: "addr", depositAddress: "agg",
            locktime: 100, duplicateIndex: 0
        });
    });

    // The SDK's two fee paths disagree on 0: withdraw uses a supplied rate as
    // given (and refuses a non-positive one when it prices the transaction),
    // broadcastBackup still reads 0 as "use the estimate". The guard makes both
    // behave the same here rather than depending on which path is stricter.
    it("withdraw and forceExit refuse a non-positive fee rate before calling the SDK", async () => {
        for (const bad of [0, -1, NaN, Infinity]) {
            const fake = makeFakeClient();
            const w = makeWallet(fake);
            await expect(w.withdraw("SC", "addr", bad)).rejects.toThrow("feeRate must be");
            await expect(w.forceExit("SC", "addr", bad)).rejects.toThrow("feeRate must be");
            expect(fake.client.wallet.withdraw).not.toHaveBeenCalled();
            expect(fake.client.wallet.broadcastBackup).not.toHaveBeenCalled();
        }
    });

    it("passes an omitted fee rate through as undefined (the SDK then estimates)", async () => {
        const fake = makeFakeClient();
        fake.client.wallet.withdraw.mockResolvedValue({ reference: "txid" });
        expect(await makeWallet(fake).withdraw("SC", "addr")).toBe("txid");
        expect(fake.client.wallet.withdraw).toHaveBeenCalledWith("lx-lp", "SC", "addr", { feeRate: undefined });
    });

    it("createDeposit rejects an amount beyond the JS safe-integer range", async () => {
        const fake = makeFakeClient();
        const w = makeWallet(fake);
        const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
        // A tokenId is supplied so the guard, not a missing token, is what trips.
        await expect(w.createDeposit({ amount: huge, tokenId: "t" })).rejects.toThrow("out of safe range");
        expect(fake.client.wallet.depositAddress).not.toHaveBeenCalled();
    });
});
