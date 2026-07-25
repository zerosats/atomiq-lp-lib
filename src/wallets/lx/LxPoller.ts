import type { MercuryClient, StatecoinSummary } from "@zerosats/ml-core";
import { getLogger, LoggerType } from "../../utils/Utils";

type Waiter = {
    predicate: (coin: StatecoinSummary) => boolean;
    resolve: (coin: StatecoinSummary) => void;
    reject: (err: any) => void;
    onAbort?: () => void;
};

/**
 * Observe-only polling loop over @zerosats/ml-core, which has no events. Each
 * tick claims pending incoming transfers and lists coins, then resolves any
 * registered waiter whose coin matches.
 *
 * Never signs in the background. The core splits observe (transferReceive is a
 * key-update on the SE, no signature slot at stake) from advance (wallet.sync,
 * which mints and signs backup txs). This loop calls only the observing side.
 */
export class LxPoller {

    private readonly client: MercuryClient;
    private readonly walletName: string;
    private readonly intervalMs: number;
    private readonly logger: LoggerType;

    private running: boolean = false;
    private timer: NodeJS.Timeout | null = null;
    // Waiters keyed by statechainId; a coin may be watched by several callers.
    private readonly waiters: Map<string, Set<Waiter>> = new Map();

    constructor(client: MercuryClient, walletName: string, intervalMs: number = 5000, logger: LoggerType = getLogger("LxPoller: ")) {
        this.client = client;
        this.walletName = walletName;
        this.intervalMs = intervalMs;
        this.logger = logger;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.scheduleNext(0);
    }

    stop(): void {
        this.running = false;
        if (this.timer != null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private scheduleNext(delay: number): void {
        if (!this.running) return;
        this.timer = setTimeout(() => {
            this.tick()
                .catch((e) => this.logger.error("tick failed, retrying next interval: ", e))
                .finally(() => this.scheduleNext(this.intervalMs));
        }, delay);
    }

    private async tick(): Promise<void> {
        if (this.waiters.size === 0) return;

        // Claim incoming transfers first: a watched coin may arrive via a transfer
        // and only become listable after the claim. Per-message failures are
        // collected in the result, not thrown.
        try {
            await this.client.wallet.transferReceive(this.walletName);
        } catch (e) {
            // observe-only: a failed claim is retried next tick, but log it so a
            // persistent failure (SE down, auth) is not silent.
            this.logger.warn("transferReceive failed this tick: ", e);
        }

        const coins = await this.client.wallet.list(this.walletName);
        for (const coin of coins) {
            if (coin.statechain_id == null) continue;
            const set = this.waiters.get(coin.statechain_id);
            if (set == null) continue;
            for (const waiter of Array.from(set)) {
                if (waiter.predicate(coin)) {
                    this.unregister(coin.statechain_id, waiter);
                    waiter.resolve(coin);
                }
            }
        }
    }

    private unregister(statechainId: string, waiter: Waiter): void {
        waiter.onAbort?.();
        const set = this.waiters.get(statechainId);
        if (set == null) return;
        set.delete(waiter);
        if (set.size === 0) this.waiters.delete(statechainId);
    }

    /**
     * Resolve once the loop observes a coin under `statechainId` satisfying
     * `predicate`. Rejects if `abortSignal` fires. Registering wakes the loop on
     * its next scheduled tick, not immediately.
     */
    waitForCoin(statechainId: string, predicate: (coin: StatecoinSummary) => boolean, abortSignal?: AbortSignal): Promise<StatecoinSummary> {
        return new Promise<StatecoinSummary>((resolve, reject) => {
            if (abortSignal?.aborted) return reject(abortSignal.reason ?? new Error("Aborted"));

            const waiter: Waiter = { predicate, resolve, reject };
            if (abortSignal != null) {
                const onAbort = () => {
                    this.unregister(statechainId, waiter);
                    reject(abortSignal.reason ?? new Error("Aborted"));
                };
                waiter.onAbort = () => abortSignal.removeEventListener("abort", onAbort);
                abortSignal.addEventListener("abort", onAbort, { once: true });
            }

            let set = this.waiters.get(statechainId);
            if (set == null) {
                set = new Set<Waiter>();
                this.waiters.set(statechainId, set);
            }
            set.add(waiter);
        });
    }

}
