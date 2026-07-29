"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeStorageAdapter = void 0;
const fs = require("fs/promises");
const path = require("path");
const emptyStore = () => ({ wallets: {}, backups: {}, latch: {} });
// The store holds the wallet mnemonic and every coin's user_privkey/auth_privkey
// in the clear, so keep it owner-only rather than the 0644/0777 the defaults give.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/**
 * Node filesystem StorageAdapter for @zerosats/ml-core. The SDK default is
 * browser localStorage, unusable in an LP node, so an explicit adapter is
 * mandatory (passed as overrides.storage to createMercuryClient).
 *
 * Two ml-core invariants (see StorageAdapter docs): absence is a value (missing
 * wallet -> null, no backups -> []), a throw means the store itself failed; and a
 * write is all or nothing. Durability is met by writing a temp file and renaming
 * over the target: a truncate-then-write loses the mnemonic on a mid-write crash.
 * One instance per backend is the ownership boundary, so the LP node must share a
 * single instance per store dir.
 */
class NodeStorageAdapter {
    constructor(storageDir, fileName = "lx-store.json") {
        this.cache = null;
        // Serializes read-modify-writes so concurrent upserts cannot lose each other.
        this.writeQueue = Promise.resolve();
        this.filePath = path.join(storageDir, fileName);
    }
    async load() {
        if (this.cache != null)
            return this.cache;
        try {
            const raw = await fs.readFile(this.filePath, "utf8");
            // A store created before FILE_MODE existed keeps its old permissions
            // until the next write, so tighten it on open. Best effort: a foreign
            // owner (the file survived a container UID change) must not fail boot.
            await fs.chmod(this.filePath, FILE_MODE).catch(() => undefined);
            const parsed = JSON.parse(raw);
            // Normalize: a store written before `latch` existed lacks the field.
            this.cache = {
                wallets: parsed.wallets ?? {},
                backups: parsed.backups ?? {},
                latch: parsed.latch ?? {}
            };
        }
        catch (e) {
            if (e?.code === "ENOENT") {
                this.cache = emptyStore();
            }
            else {
                throw e;
            }
        }
        return this.cache;
    }
    async persist(store) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: DIR_MODE });
        const tmp = this.filePath + "." + process.pid + "." + Date.now() + ".tmp";
        // The mode rides on the temp file: rename preserves it, so the target is
        // never briefly world-readable.
        await fs.writeFile(tmp, JSON.stringify(store), { encoding: "utf8", mode: FILE_MODE });
        await fs.rename(tmp, this.filePath);
    }
    // Runs the mutator against a COPY and swaps the cache in only after the rename
    // lands, serialized against every other write. A failed persist must not leave
    // the cache reporting a record that never reached disk (the all-or-nothing
    // contract: a reader must never observe a write that a crash would lose, and a
    // falsely-present wallet carries an unpersisted mnemonic).
    enqueue(mutator) {
        const run = this.writeQueue.then(async () => {
            const base = await this.load();
            const next = structuredClone(base);
            mutator(next);
            await this.persist(next);
            this.cache = next;
        });
        // Keep the chain alive on failure so a rejected write does not wedge it.
        this.writeQueue = run.catch(() => undefined);
        return run;
    }
    async getWallet(walletName) {
        const store = await this.load();
        return store.wallets[walletName] ?? null;
    }
    putWallet(wallet) {
        return this.enqueue((store) => {
            store.wallets[wallet.name] = wallet;
        });
    }
    async getBackupTransactions(walletName, statechainId) {
        const store = await this.load();
        return store.backups[walletName]?.[statechainId] ?? [];
    }
    putBackupTransactions(walletName, statechainId, backupTransactions) {
        return this.enqueue((store) => {
            var _a;
            ((_a = store.backups)[walletName] ?? (_a[walletName] = {}))[statechainId] = backupTransactions;
        });
    }
    // Latch batchId -> statechainId persistence (beyond the ml-core StorageAdapter
    // contract; specific to the sender-controlled latch, see Store.latch).
    async latchGet(batchId) {
        const store = await this.load();
        return store.latch[batchId] ?? null;
    }
    latchPut(batchId, statechainId) {
        return this.enqueue((store) => {
            store.latch[batchId] = statechainId;
        });
    }
    latchDelete(batchId) {
        return this.enqueue((store) => {
            delete store.latch[batchId];
        });
    }
}
exports.NodeStorageAdapter = NodeStorageAdapter;
