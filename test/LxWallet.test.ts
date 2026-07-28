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
        transferSend: vi.fn().mockResolvedValue(undefined),
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
            .mockRejectedValueOnce(new SERejected("locked", 404))
            .mockRejectedValueOnce(new SERejected("locked", 404))
            .mockResolvedValue({ preimage: "P" });
        const w = makeWallet(fake);

        expect(await w.settleLatchedTransfer("B", { pollIntervalMs: 1 })).toEqual({ preimage: "P" });
        expect(fake.client.settlement.retrievePreImage).toHaveBeenCalledTimes(3);
    });

    it("times out if the receiver never claims", async () => {
        const fake = makeFakeClient();
        fake.storage.latchGet.mockResolvedValue("SC");
        fake.client.settlement.retrievePreImage.mockRejectedValue(new SERejected("locked", 404));
        const w = makeWallet(fake);

        await expect(w.settleLatchedTransfer("B", { pollIntervalMs: 1, timeoutMs: 5 })).rejects.toThrow("timed out");
    });

    it("propagates a non-404 SE error instead of polling", async () => {
        const fake = makeFakeClient();
        fake.storage.latchGet.mockResolvedValue("SC");
        fake.client.settlement.retrievePreImage.mockRejectedValue(new SERejected("boom", 500));
        const w = makeWallet(fake);

        await expect(w.settleLatchedTransfer("B", { pollIntervalMs: 1 })).rejects.toThrow("boom");
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
        fake.client.wallet.balance.mockResolvedValue({ confirmed: "100", pending: "5", total: "105" });
        expect(await makeWallet(fake).getLxBalance()).toEqual({ confirmed: 100n, pending: 5n, total: 105n });
    });

    it("listCoins maps a StatecoinSummary to the LP-facing LxStatecoin", async () => {
        const fake = makeFakeClient();
        fake.client.wallet.list.mockResolvedValue([{
            statechain_id: "SC", utxo_txid: "tx", utxo_vout: 0, amount: "1000",
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

    it("createDeposit rejects an amount beyond the JS safe-integer range", async () => {
        const fake = makeFakeClient();
        const w = makeWallet(fake);
        const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
        // A tokenId is supplied so the guard, not a missing token, is what trips.
        await expect(w.createDeposit({ amount: huge, tokenId: "t" })).rejects.toThrow("out of safe range");
        expect(fake.client.wallet.depositAddress).not.toHaveBeenCalled();
    });
});
