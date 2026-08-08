import type { StorageAdapter, Wallet, BackupTx } from "@zerosats/ml-core";
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
 *
 * Reads and writes copy, matching the reference localStorage adapter, which
 * JSON-parses a fresh object every read. The flows mutate the wallet they were
 * handed and persist once at the end (coin_status sets locktime and rebinds the
 * funding outpoint mid-loop; withdraw sets the coin status), so handing out the
 * cached object let a flow that threw before its putWallet leave the cache
 * carrying state that never reached disk, and let the caller keep mutating the
 * cache after the write returned.
 */
export declare class NodeStorageAdapter implements StorageAdapter {
    private readonly filePath;
    private cache;
    private writeQueue;
    constructor(storageDir: string, fileName?: string);
    private load;
    private persist;
    private enqueue;
    getWallet(walletName: string): Promise<Wallet | null>;
    putWallet(wallet: Wallet): Promise<void>;
    getBackupTransactions(walletName: string, statechainId: string): Promise<BackupTx[]>;
    putBackupTransactions(walletName: string, statechainId: string, backupTransactions: BackupTx[]): Promise<void>;
    latchGet(batchId: string): Promise<string | null>;
    latchPut(batchId: string, statechainId: string): Promise<void>;
    latchDelete(batchId: string): Promise<void>;
}
