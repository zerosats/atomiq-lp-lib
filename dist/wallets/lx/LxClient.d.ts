import type { MercuryClient, Wallet } from "@zerosats/ml-core";
import { LxNetwork, LxConnectionStatus } from "../ILxWallet";
import { NodeStorageAdapter } from "./NodeStorageAdapter";
export type LxClientConfig = {
    statechainEntity: string;
    esploraServer: string;
    network: LxNetwork;
    walletName: string;
    storageDir: string;
    mnemonic?: string;
    allowInsecureHttp?: boolean;
    feeRateTolerance?: number;
    maxFeeRate?: number;
    confirmationTarget?: number;
    requestTimeoutMs?: number | null;
    walletLockWaitMs?: number | null;
    probeTimeoutMs?: number;
    watchdogIntervalMs?: number;
    initProbeAttempts?: number;
    initProbeDelayMs?: number;
};
/**
 * Owns the @zerosats/ml-core MercuryClient for the LX rail: config, the Node
 * storage adapter, and the one-time idempotent wallet bootstrap. Everything that
 * moves coins goes through the exposed client's wallet/settlement namespaces.
 */
export declare class LxClient {
    readonly config: LxClientConfig;
    readonly storage: NodeStorageAdapter;
    private mercury;
    status: LxConnectionStatus;
    private watchdog;
    private watchdogInFlight;
    private lastTipHeight;
    constructor(config: LxClientConfig);
    isReady(): boolean;
    getStatus(): string;
    getStatusInfo(): Promise<Record<string, string>>;
    private probeGet;
    private probe;
    private startWatchdog;
    stop(): void;
    /** The underlying protocol client. Throws until init() has completed. */
    get client(): MercuryClient;
    /** The stored wallet, or null before bootstrap. Used to read the mnemonic for identity derivation. */
    getWallet(): Promise<Wallet | null>;
    init(): Promise<void>;
}
