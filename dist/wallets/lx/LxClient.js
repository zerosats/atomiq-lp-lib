"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LxClient = void 0;
const ml_core_1 = require("@zerosats/ml-core");
const ILxWallet_1 = require("../ILxWallet");
const NodeStorageAdapter_1 = require("./NodeStorageAdapter");
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
class LxClient {
    constructor(config) {
        this.mercury = null;
        this.status = ILxWallet_1.LxConnectionStatus.Offline;
        this.watchdog = null;
        this.watchdogInFlight = false;
        this.lastTipHeight = null;
        this.config = config;
        this.storage = new NodeStorageAdapter_1.NodeStorageAdapter(config.storageDir);
    }
    isReady() {
        return this.status === ILxWallet_1.LxConnectionStatus.Ready;
    }
    getStatus() {
        return this.status;
    }
    async getStatusInfo() {
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
    async probeGet(url) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: ac.signal });
            return res.ok ? res : null;
        }
        catch {
            return null;
        }
        finally {
            clearTimeout(timer);
        }
    }
    // Both the SE (/info/config) and esplora (chain tip) must answer for the rail
    // to be usable: the SE co-signs, esplora confirms deposits/withdrawals.
    async probe() {
        const [se, tip] = await Promise.all([
            this.probeGet(`${this.config.statechainEntity}/info/config`),
            this.probeGet(`${this.config.esploraServer}/api/blocks/tip/height`)
        ]);
        if (tip != null) {
            const h = parseInt(await tip.text(), 10);
            if (!Number.isNaN(h))
                this.lastTipHeight = h;
        }
        return se != null && tip != null;
    }
    startWatchdog() {
        if (this.watchdog != null)
            return;
        this.watchdog = setInterval(() => {
            if (this.watchdogInFlight)
                return;
            this.watchdogInFlight = true;
            this.probe()
                .then((ok) => { this.status = ok ? ILxWallet_1.LxConnectionStatus.Ready : ILxWallet_1.LxConnectionStatus.Disconnected; })
                .catch(() => { this.status = ILxWallet_1.LxConnectionStatus.Disconnected; })
                .finally(() => { this.watchdogInFlight = false; });
        }, this.config.watchdogIntervalMs ?? DEFAULT_WATCHDOG_MS);
        // Do not keep the process alive just for the watchdog.
        this.watchdog.unref?.();
    }
    stop() {
        if (this.watchdog != null) {
            clearInterval(this.watchdog);
            this.watchdog = null;
        }
    }
    /** The underlying protocol client. Throws until init() has completed. */
    get client() {
        if (this.mercury == null)
            throw new Error("LxClient not initialized yet, call init() first");
        return this.mercury;
    }
    /** The stored wallet, or null before bootstrap. Used to read the mnemonic for identity derivation. */
    getWallet() {
        return this.storage.getWallet(this.config.walletName);
    }
    async init() {
        if (this.mercury != null)
            return;
        this.status = ILxWallet_1.LxConnectionStatus.Connecting;
        // Only set optional tuning fields when provided: passing them as undefined
        // would override the SDK's config defaults (withConfigDefaults spreads
        // config over the defaults, and undefined wins the spread).
        const cfg = {
            statechainEntity: this.config.statechainEntity,
            esploraServer: this.config.esploraServer,
            // LxNetwork values equal the ml-core BitcoinNetwork strings; cast at
            // this SDK boundary where the type is a string union, not our enum.
            network: this.config.network
        };
        if (this.config.feeRateTolerance != null)
            cfg.feeRateTolerance = this.config.feeRateTolerance;
        if (this.config.maxFeeRate != null)
            cfg.maxFeeRate = this.config.maxFeeRate;
        if (this.config.confirmationTarget != null)
            cfg.confirmationTarget = this.config.confirmationTarget;
        this.mercury = (0, ml_core_1.createMercuryClient)(cfg, { storage: this.storage });
        // Bounded readiness probe FIRST. wallet.create is not local: it calls
        // esplora (getTipHeight) and the SE (infoConfig), so bootstrapping a new
        // wallet needs both reachable.
        const attempts = this.config.initProbeAttempts ?? DEFAULT_INIT_ATTEMPTS;
        const delay = this.config.initProbeDelayMs ?? DEFAULT_INIT_DELAY_MS;
        let ok = false;
        for (let i = 0; i < attempts; i++) {
            ok = await this.probe();
            if (ok)
                break;
            if (i < attempts - 1)
                await new Promise((r) => setTimeout(r, delay));
        }
        const existing = await this.storage.getWallet(this.config.walletName);
        if (existing == null) {
            // First boot: the wallet must be created, which requires the SE/esplora.
            // Fail loudly rather than come up half-initialized with no wallet.
            if (!ok)
                throw new Error("cannot bootstrap LX wallet: SE/esplora unreachable after " + attempts + " attempts");
            await this.mercury.wallet.create(this.config.walletName, this.config.mnemonic ?? null);
        }
        // Restart with an existing wallet: no create needed, so a dead SE only
        // means not-ready; the watchdog promotes to ready once it recovers.
        this.status = ok ? ILxWallet_1.LxConnectionStatus.Ready : ILxWallet_1.LxConnectionStatus.Disconnected;
        this.startWatchdog();
    }
}
exports.LxClient = LxClient;
