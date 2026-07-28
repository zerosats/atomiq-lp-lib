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

    it("serializes concurrent latch writes without losing any", async () => {
        const s = new NodeStorageAdapter(dir);
        await Promise.all([s.latchPut("a", "1"), s.latchPut("b", "2"), s.latchPut("c", "3")]);
        const reopened = new NodeStorageAdapter(dir);
        expect(await reopened.latchGet("a")).toBe("1");
        expect(await reopened.latchGet("b")).toBe("2");
        expect(await reopened.latchGet("c")).toBe("3");
    });

    it("normalizes a store written before the `latch` field existed", async () => {
        await fs.writeFile(path.join(dir, "lx-store.json"), JSON.stringify({ wallets: {}, backups: {} }), "utf8");
        const s = new NodeStorageAdapter(dir);
        expect(await s.latchGet("x")).toBeNull(); // no throw on the missing field
        await s.latchPut("x", "y");
        expect(await s.latchGet("x")).toBe("y");
    });
});
