import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { NodeStorageAdapter } from "../src/wallets/lx/NodeStorageAdapter";

// Real filesystem, temp dir per test. NodeStorageAdapter is pure I/O with no wasm
// or SE dependency, so this exercises the actual persistence, not a mock.
describe("NodeStorageAdapter", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "lxstore-"));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("latch round-trips batchId -> statechainId", async () => {
        const s = new NodeStorageAdapter(dir);
        expect(await s.latchGet("b1")).toBeNull();
        await s.latchPut("b1", "sc1");
        expect(await s.latchGet("b1")).toBe("sc1");
        await s.latchDelete("b1");
        expect(await s.latchGet("b1")).toBeNull();
    });

    it("persists across instances (survives a restart with a cold cache)", async () => {
        await new NodeStorageAdapter(dir).latchPut("b2", "sc2");
        const reopened = new NodeStorageAdapter(dir);
        expect(await reopened.latchGet("b2")).toBe("sc2");
    });

    it("treats absence as a value (null wallet, empty backups)", async () => {
        const s = new NodeStorageAdapter(dir);
        expect(await s.getWallet("nope")).toBeNull();
        expect(await s.getBackupTransactions("nope", "sc")).toEqual([]);
    });

    it("putWallet upserts by name", async () => {
        const s = new NodeStorageAdapter(dir);
        await s.putWallet({ name: "w" } as any);
        expect(await s.getWallet("w")).toEqual({ name: "w" });
        await s.putWallet({ name: "w", extra: "x" } as any);
        expect(await s.getWallet("w")).toEqual({ name: "w", extra: "x" });
    });

    // The SDK flows mutate the wallet they were handed and persist once at the
    // end, so handing out the cached object let a flow that threw before its
    // putWallet leave the cache carrying state that never reached disk.
    it("does not let a caller mutate the cache through a wallet it read", async () => {
        const s = new NodeStorageAdapter(dir);
        await s.putWallet({ name: "w", coins: [{ locktime: null }] } as any);

        const read: any = await s.getWallet("w");
        read.coins[0].locktime = 500; // a flow that then throws before putWallet

        expect((await s.getWallet("w")) as any).toEqual({ name: "w", coins: [{ locktime: null }] });
        expect((await new NodeStorageAdapter(dir).getWallet("w")) as any)
            .toEqual({ name: "w", coins: [{ locktime: null }] });
    });

    it("does not let a caller mutate the cache through a wallet it wrote", async () => {
        const s = new NodeStorageAdapter(dir);
        const wallet: any = { name: "w", coins: [{ locktime: null }] };
        await s.putWallet(wallet);
        wallet.coins[0].locktime = 500; // the flow keeps its reference after the write

        expect((await s.getWallet("w")) as any).toEqual({ name: "w", coins: [{ locktime: null }] });
    });

    it("does not let a caller mutate the cached backup transactions", async () => {
        const s = new NodeStorageAdapter(dir);
        const txs: any = [{ tx_n: 1, tx: "aa" }];
        await s.putBackupTransactions("w", "sc", txs);
        txs.push({ tx_n: 2, tx: "bb" });

        expect(await s.getBackupTransactions("w", "sc")).toEqual([{ tx_n: 1, tx: "aa" }]);
        const read = await s.getBackupTransactions("w", "sc");
        read.push({ tx_n: 3 } as any);
        expect(await s.getBackupTransactions("w", "sc")).toEqual([{ tx_n: 1, tx: "aa" }]);
    });

    it("serializes concurrent latch writes without losing any", async () => {
        const s = new NodeStorageAdapter(dir);
        await Promise.all([s.latchPut("a", "1"), s.latchPut("b", "2"), s.latchPut("c", "3")]);
        const reopened = new NodeStorageAdapter(dir);
        expect(await reopened.latchGet("a")).toBe("1");
        expect(await reopened.latchGet("b")).toBe("2");
        expect(await reopened.latchGet("c")).toBe("3");
    });

    it("keeps the store owner-only (it holds the mnemonic and coin private keys)", async () => {
        const s = new NodeStorageAdapter(dir);
        await s.putWallet({ name: "w" } as any);
        const st = await fs.stat(path.join(dir, "lx-store.json"));
        expect(st.mode & 0o777).toBe(0o600);
    });

    it("tightens the permissions of a store written by an older build", async () => {
        const file = path.join(dir, "lx-store.json");
        await fs.writeFile(file, JSON.stringify({ wallets: {}, backups: {}, latch: {} }), "utf8");
        await fs.chmod(file, 0o644);
        await new NodeStorageAdapter(dir).getWallet("w"); // a read alone must fix it
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    });

    it("creates a missing storage directory owner-only", async () => {
        const nested = path.join(dir, "nested");
        await new NodeStorageAdapter(nested).latchPut("b", "sc");
        expect((await fs.stat(nested)).mode & 0o777).toBe(0o700);
    });

    it("normalizes a store written before the `latch` field existed", async () => {
        await fs.writeFile(path.join(dir, "lx-store.json"), JSON.stringify({ wallets: {}, backups: {} }), "utf8");
        const s = new NodeStorageAdapter(dir);
        expect(await s.latchGet("x")).toBeNull(); // no throw on the missing field
        await s.latchPut("x", "y");
        expect(await s.latchGet("x")).toBe("y");
    });
});
