import { Command } from "@atomiqlabs/server-base";
import type { ILxWallet, LxStatecoin, LxDepositInit, LxDeposit, LxDepositToken, LxLatchedTransferInit, LxLatchedTransfer, LxLatchSettleResult, LxLatchSettleOptions, LxWaitOptions, LxTransferInit, LxTransferStatus, LxReceiveAddress, LxReceiveResult, LxBalanceResponse, LxBroadcastResult } from "../ILxWallet";
import { type LxClientConfig } from "./LxClient";
export type LxWalletConfig = LxClientConfig & {
    pollIntervalMs?: number;
};
/**
 * ILxWallet over @zerosats/ml-core: composes the protocol client (LxClient) with
 * an observe-only poller. The LP is the statecoin sender for latched transfers,
 * so createLatchedTransfer mints the SE payment hash and settleLatchedTransfer
 * reveals the preimage. See ILxWallet for the direction asymmetry this implies.
 */
export declare class LxWallet implements ILxWallet {
    private readonly lxClient;
    private readonly pollIntervalMs;
    private poller;
    constructor(config: LxWalletConfig);
    private get name();
    private requirePoller;
    init(): Promise<void>;
    stop(): void;
    isReady(): boolean;
    getStatus(): string;
    getStatusInfo(): Promise<Record<string, string>>;
    getLxBalance(): Promise<LxBalanceResponse>;
    getIdentityPublicKey(): Promise<string>;
    newDepositToken(): Promise<LxDepositToken>;
    createDeposit(init: LxDepositInit): Promise<LxDeposit>;
    getCoin(statechainId: string): Promise<LxStatecoin | null>;
    listCoins(): Promise<LxStatecoin[]>;
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
    waitForDeposit(statechainId: string, opts?: LxWaitOptions): Promise<LxStatecoin>;
    createLatchedTransfer(init: LxLatchedTransferInit): Promise<LxLatchedTransfer>;
    /**
     * Reveal the latch preimage. NOT a one-shot: confirmInvoice clears only the
     * sender half of the lock, and the SE releases the preimage only once the
     * RECEIVER has claimed the coin (clearing the other half). Until then the SE
     * answers 404, so this polls until the preimage is available or the deadline /
     * abort fires. That wait IS the atomicity guarantee: the sender gets the
     * preimage only after the coin is delivered.
     */
    settleLatchedTransfer(batchId: string, opts?: LxLatchSettleOptions): Promise<LxLatchSettleResult>;
    cancelLatchedTransfer(batchId: string): Promise<void>;
    send(init: LxTransferInit): Promise<LxTransferStatus>;
    getTransfer(statechainId: string): Promise<LxTransferStatus | null>;
    /**
     * Wait until the receiver has claimed the coin (TRANSFERRED). Bounded for the
     * same reason as waitForDeposit: a receiver that never claims never moves the
     * status. opts.pollIntervalMs is not honoured here; the cadence belongs to the
     * shared background poller (LxWalletConfig.pollIntervalMs), and re-timing it
     * per call would re-time it for every other waiter too.
     */
    waitForTransfer(statechainId: string, opts?: LxWaitOptions): Promise<LxTransferStatus>;
    newReceiveAddress(generateBatchId?: boolean): Promise<LxReceiveAddress>;
    receiveTransfers(): Promise<LxReceiveResult>;
    withdraw(statechainId: string, toAddress: string, feeRate?: number): Promise<string>;
    forceExit(statechainId: string, toAddress: string, feeRate?: number): Promise<LxBroadcastResult>;
    getCommands(): Command<any>[];
}
