import { createMercuryClient } from "@zerosats/ml-core";
import type { MercuryClient, Wallet, BitcoinNetwork } from "@zerosats/ml-core";
import { LxNetwork, LxConnectionStatus } from "../ILxWallet";
import { NodeStorageAdapter } from "./NodeStorageAdapter";

export type LxClientConfig = {
    statechainEntity: string;
    esploraServer: string;
    network: LxNetwork;
    walletName: string;
    storageDir: string;
    // Optional: when omitted the SDK generates a fresh mnemonic on first create.
    mnemonic?: string;
    feeRateTolerance?: number;
    maxFeeRate?: number;
    confirmationTarget?: number;
    // Health-probe tuning (ms / count). Defaults below.
    probeTimeoutMs?: number;
    watchdogIntervalMs?: number;
    initProbeAttempts?: number;
    initProbeDelayMs?: number;
};

// wallet.create is not local: it calls esplora (getTipHeight) and the SE
// (infoConfig). Nothing else in the SDK path proves the SE/esplora are reachable
// either, so LxClient probes them explicitly, mirroring how LNDClient gates
// readiness on a live node, so isReady() cannot report ready against a dead SE.
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_WATCHDOG_MS = 30000;
const DEFAULT_INIT_ATTEMPTS = 10;
const DEFAULT_INIT_DELAY_MS = 3000;

/**
 * Owns the @zerosats/ml-core MercuryClient for the LX rail: config, the Node
 * storage adapter, and the one-time idempotent wallet bootstrap. Everything that
 * moves coins goes through the exposed client's wallet/settlement namespaces.
 */
export class LxClient {

    readonly config: LxClientConfig;
    readonly storage: NodeStorageAdapter;
    private mercury: MercuryClient | null = null;
    status: LxConnectionStatus = LxConnectionStatus.Offline;
    private watchdog: NodeJS.Timeout | null = null;
    private watchdogInFlight: boolean = false;
    private lastTipHeight: number | null = null;

    constructor(config: LxClientConfig) {
        this.config = config;
        this.storage = new NodeStorageAdapter(config.storageDir);
    }

    isReady(): boolean {
        return this.status === LxConnectionStatus.Ready;
    }

    getStatus(): string {
        return this.status;
    }

    async getStatusInfo(): Promise<Record<string, string>> {
        // No "Status" key here: callers surface getStatus() separately, so it
        // would render twice in the node status output.
        return {
            "Network": this.config.network,
            "Wallet": this.config.walletName,
            "Statechain entity": this.config.statechainEntity,
            "Chain tip": this.lastTipHeight == null ? "unknown" : String(this.lastTipHeight)
        };
    }

    // GET with a bounded timeout; resolves to the parsed body or null on any fault
    // (non-2xx, network error, timeout). Used only for liveness, never for funds.
    private async probeGet(url: string): Promise<Response | null> {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: ac.signal });
            return res.ok ? res : null;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    // Both the SE (/info/config) and esplora (chain tip) must answer for the rail
    // to be usable: the SE co-signs, esplora confirms deposits/withdrawals.
    private async probe(): Promise<boolean> {
        const [se, tip] = await Promise.all([
            this.probeGet(`${this.config.statechainEntity}/info/config`),
            this.probeGet(`${this.config.esploraServer}/api/blocks/tip/height`)
        ]);
        if (tip != null) {
            const h = parseInt(await tip.text(), 10);
            if (!Number.isNaN(h)) this.lastTipHeight = h;
        }
        return se != null && tip != null;
    }

    private startWatchdog(): void {
        if (this.watchdog != null) return;
        this.watchdog = setInterval(() => {
            if (this.watchdogInFlight) return;
            this.watchdogInFlight = true;
            this.probe()
                .then((ok) => { this.status = ok ? LxConnectionStatus.Ready : LxConnectionStatus.Disconnected; })
                .catch(() => { this.status = LxConnectionStatus.Disconnected; })
                .finally(() => { this.watchdogInFlight = false; });
        }, this.config.watchdogIntervalMs ?? DEFAULT_WATCHDOG_MS);
        // Do not keep the process alive just for the watchdog.
        this.watchdog.unref?.();
    }

    stop(): void {
        if (this.watchdog != null) {
            clearInterval(this.watchdog);
            this.watchdog = null;
        }
    }

    /** The underlying protocol client. Throws until init() has completed. */
    get client(): MercuryClient {
        if (this.mercury == null) throw new Error("LxClient not initialized yet, call init() first");
        return this.mercury;
    }

    /** The stored wallet, or null before bootstrap. Used to read the mnemonic for identity derivation. */
    getWallet(): Promise<Wallet | null> {
        return this.storage.getWallet(this.config.walletName);
    }

    async init(): Promise<void> {
        if (this.mercury != null) return;
        this.status = LxConnectionStatus.Connecting;

        // Only set optional tuning fields when provided: passing them as undefined
        // would override the SDK's config defaults (withConfigDefaults spreads
        // config over the defaults, and undefined wins the spread).
        const cfg: Partial<Parameters<typeof createMercuryClient>[0]> = {
            statechainEntity: this.config.statechainEntity,
            esploraServer: this.config.esploraServer,
            // LxNetwork values equal the ml-core BitcoinNetwork strings; cast at
            // this SDK boundary where the type is a string union, not our enum.
            network: this.config.network as unknown as BitcoinNetwork
        };
        if (this.config.feeRateTolerance != null) cfg.feeRateTolerance = this.config.feeRateTolerance;
        if (this.config.maxFeeRate != null) cfg.maxFeeRate = this.config.maxFeeRate;
        if (this.config.confirmationTarget != null) cfg.confirmationTarget = this.config.confirmationTarget;
        this.mercury = createMercuryClient(cfg, { storage: this.storage });

        // Bounded readiness probe FIRST. wallet.create is not local: it calls
        // esplora (getTipHeight) and the SE (infoConfig), so bootstrapping a new
        // wallet needs both reachable.
        const attempts = this.config.initProbeAttempts ?? DEFAULT_INIT_ATTEMPTS;
        const delay = this.config.initProbeDelayMs ?? DEFAULT_INIT_DELAY_MS;
        let ok = false;
        for (let i = 0; i < attempts; i++) {
            ok = await this.probe();
            if (ok) break;
            if (i < attempts - 1) await new Promise((r) => setTimeout(r, delay));
        }

        const existing = await this.storage.getWallet(this.config.walletName);
        if (existing == null) {
            // First boot: the wallet must be created, which requires the SE/esplora.
            // Fail loudly rather than come up half-initialized with no wallet.
            if (!ok) throw new Error("cannot bootstrap LX wallet: SE/esplora unreachable after " + attempts + " attempts");
            await this.mercury.wallet.create(this.config.walletName, this.config.mnemonic ?? null);
        }
        // Restart with an existing wallet: no create needed, so a dead SE only
        // means not-ready; the watchdog promotes to ready once it recovers.
        this.status = ok ? LxConnectionStatus.Ready : LxConnectionStatus.Disconnected;
        this.startWatchdog();
    }

}
