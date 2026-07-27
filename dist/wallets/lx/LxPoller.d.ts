import type { MercuryClient, StatecoinSummary } from "@zerosats/ml-core";
import { LoggerType } from "../../utils/Utils";
/**
 * Observe-only polling loop over @zerosats/ml-core, which has no events. Each
 * tick claims pending incoming transfers and lists coins, then resolves any
 * registered waiter whose coin matches.
 *
 * Never signs in the background. The core splits observe (transferReceive is a
 * key-update on the SE, no signature slot at stake) from advance (wallet.sync,
 * which mints and signs backup txs). This loop calls only the observing side.
 */
export declare class LxPoller {
    private readonly client;
    private readonly walletName;
    private readonly intervalMs;
    private readonly logger;
    private running;
    private timer;
    private readonly waiters;
    constructor(client: MercuryClient, walletName: string, intervalMs?: number, logger?: LoggerType);
    start(): void;
    stop(): void;
    private scheduleNext;
    private tick;
    private unregister;
    /**
     * Resolve once the loop observes a coin under `statechainId` satisfying
     * `predicate`. Rejects if `abortSignal` fires. Registering wakes the loop on
     * its next scheduled tick, not immediately.
     */
    waitForCoin(statechainId: string, predicate: (coin: StatecoinSummary) => boolean, abortSignal?: AbortSignal): Promise<StatecoinSummary>;
}
