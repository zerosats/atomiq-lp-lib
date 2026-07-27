"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwapHandler = exports.SwapHandlerType = void 0;
const PluginManager_1 = require("../plugins/PluginManager");
const Utils_1 = require("../utils/Utils");
var SwapHandlerType;
(function (SwapHandlerType) {
    SwapHandlerType["TO_BTC"] = "TO_BTC";
    SwapHandlerType["FROM_BTC"] = "FROM_BTC";
    SwapHandlerType["TO_BTCLN"] = "TO_BTCLN";
    SwapHandlerType["FROM_BTCLN"] = "FROM_BTCLN";
    SwapHandlerType["FROM_BTCLN_TRUSTED"] = "FROM_BTCLN_TRUSTED";
    SwapHandlerType["FROM_BTC_TRUSTED"] = "FROM_BTC_TRUSTED";
    SwapHandlerType["FROM_BTC_SPV"] = "FROM_BTC_SPV";
    SwapHandlerType["FROM_BTCLN_AUTO"] = "FROM_BTCLN_AUTO";
    SwapHandlerType["TO_BTCLX"] = "TO_BTCLX";
})(SwapHandlerType = exports.SwapHandlerType || (exports.SwapHandlerType = {}));
/**
 * An abstract class defining a singular swap service
 */
class SwapHandler {
    constructor(storageDirectory, path, chainsData, swapPricing) {
        this.inflightSwaps = new Set();
        this.logger = (0, Utils_1.getLogger)(() => "SwapHandler(" + this.type + "): ");
        this.swapLogger = {
            debug: (swap, msg, ...args) => this.logger.debug(swap.getIdentifier() + ": " + msg, ...args),
            info: (swap, msg, ...args) => this.logger.info(swap.getIdentifier() + ": " + msg, ...args),
            warn: (swap, msg, ...args) => this.logger.warn(swap.getIdentifier() + ": " + msg, ...args),
            error: (swap, msg, ...args) => this.logger.error(swap.getIdentifier() + ": " + msg, ...args)
        };
        this.storageManager = storageDirectory;
        this.chains = chainsData;
        this.path = path;
        this.swapPricing = swapPricing;
        this.allowedTokens = {};
        for (let chainId in chainsData.chains) {
            this.allowedTokens[chainId] = new Set(chainsData.chains[chainId].allowedTokens);
        }
    }
    getChain(identifier) {
        if (this.chains.chains[identifier] == null)
            throw {
                code: 20200,
                msg: "Invalid chain specified!"
            };
        return this.chains.chains[identifier];
    }
    /**
     * Starts the watchdog checking past swaps for expiry or claim eligibility.
     */
    async startWatchdog() {
        let rerun;
        rerun = async () => {
            await this.processPastSwaps().catch(e => this.logger.error("startWatchdog(): Error when processing past swaps: ", e));
            setTimeout(rerun, this.config.swapCheckInterval);
        };
        await rerun();
    }
    async loadData(ctor) {
        await this.storageManager.loadData(ctor);
        //Check if all swaps contain a valid amount
        for (let { obj: swap, hash, sequence } of await this.storageManager.query([])) {
            if (hash !== swap.getIdentifierHash() || sequence !== (swap.getSequence() ?? 0n)) {
                this.swapLogger.info(swap, "loadData(): Swap storage key or sequence mismatch, fixing," +
                    " old hash: " + hash + " new hash: " + swap.getIdentifierHash() +
                    " old seq: " + sequence.toString(10) + " new seq: " + (swap.getSequence() ?? 0n).toString(10));
                await this.storageManager.removeData(hash, sequence);
                await this.storageManager.saveData(swap.getIdentifierHash(), swap.getSequence(), swap);
            }
            if (this.inflightSwapStates.has(swap.state))
                this.inflightSwaps.add(swap.getIdentifier());
        }
    }
    /**
     * Remove swap data
     *
     * @param swap
     * @param ultimateState set the ultimate state of the swap before removing
     */
    async removeSwapData(swap, ultimateState) {
        if (this.inflightSwaps.delete(swap.getIdentifier()))
            this.logger.debug("removeSwapData(): Removing in-flight swap, current in-flight swaps: " + this.inflightSwaps.size);
        if (ultimateState != null)
            await swap.setState(ultimateState);
        if (swap != null)
            await PluginManager_1.PluginManager.swapRemove(swap);
        this.swapLogger.debug(swap, "removeSwapData(): removing swap final state: " + swap.state);
        await this.storageManager.removeData(swap.getIdentifierHash(), swap.getSequence());
    }
    async saveSwapData(swap) {
        const identifier = swap.getIdentifier();
        if (this.inflightSwapStates.has(swap.state)) {
            if (!this.inflightSwaps.has(identifier)) {
                this.inflightSwaps.add(identifier);
                this.logger.debug("saveSwapData(): Adding in-flight swap, current in-flight swaps: " + this.inflightSwaps.size);
            }
        }
        else {
            if (this.inflightSwaps.delete(identifier))
                this.logger.debug("saveSwapData(): Removing in-flight swap, current in-flight swaps: " + this.inflightSwaps.size);
        }
        await this.storageManager.saveData(swap.getIdentifierHash(), swap.getSequence(), swap);
    }
    /**
     * Pre-fetches native balance to further check if we have enough reserve in a native token
     *
     * @param chainIdentifier
     * @param abortController
     * @protected
     */
    prefetchNativeBalanceIfNeeded(chainIdentifier, abortController) {
        const minNativeTokenReserve = this.config.minNativeBalances?.[chainIdentifier] ?? 0n;
        if (minNativeTokenReserve === 0n)
            return null;
        const { chainInterface, signer } = this.getChain(chainIdentifier);
        return chainInterface.getBalance(signer.getAddress(), chainInterface.getNativeCurrencyAddress()).catch(e => {
            this.logger.error("getBalancePrefetch(): balancePrefetch error: ", e);
            abortController.abort(e);
            return null;
        });
    }
    /**
     * Checks if we have enough native balance to facilitate swaps
     *
     * @param chainIdentifier
     * @param balancePrefetch
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if there are not enough funds in the vault
     */
    async checkNativeBalance(chainIdentifier, balancePrefetch, signal) {
        if (signal != null)
            signal.throwIfAborted();
        const minNativeTokenReserve = this.config.minNativeBalances?.[chainIdentifier] ?? 0n;
        if (minNativeTokenReserve === 0n)
            return;
        const balance = await balancePrefetch;
        if (signal != null)
            signal.throwIfAborted();
        if (balance == null) {
            throw new Error("Failed to fetch native token balance!");
        }
        if (balance < minNativeTokenReserve) {
            throw {
                code: 20012,
                msg: "LP ran out of native token to cover gas fees"
            };
        }
    }
    /**
     * Checks whether there are too many swaps in-flight currently
     * @private
     */
    checkTooManyInflightSwaps() {
        if (this.config.maxInflightSwaps == null)
            return;
        if (this.inflightSwaps.size >= this.config.maxInflightSwaps)
            throw {
                code: 20013,
                msg: "LP has too many in-flight swaps, retry later!"
            };
    }
    /**
     * Checks if we have enough balance of the token in the swap vault
     *
     * @param totalInToken
     * @param balancePrefetch
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if there are not enough funds in the vault
     */
    async checkBalance(totalInToken, balancePrefetch, signal) {
        const balance = await balancePrefetch;
        if (signal != null)
            signal.throwIfAborted();
        if (balance == null || balance < totalInToken) {
            throw {
                code: 20002,
                msg: "Not enough liquidity"
            };
        }
    }
    /**
     * Checks if the sequence number is between 0-2^64
     *
     * @param sequence
     * @throws {DefinedRuntimeError} will throw an error if sequence number is out of bounds
     */
    checkSequence(sequence) {
        if (sequence < 0n || sequence >= 2n ** 64n) {
            throw {
                code: 20060,
                msg: "Invalid sequence"
            };
        }
    }
    /**
     * Checks whether a given token is supported on a specified chain
     *
     * @param chainId
     * @param token
     * @protected
     */
    isTokenSupported(chainId, token) {
        const chainTokens = this.allowedTokens[chainId];
        if (chainTokens == null)
            return false;
        return chainTokens.has(token);
    }
    getInfo() {
        const chainTokens = {};
        for (let chainId in this.allowedTokens) {
            chainTokens[chainId] = Array.from(this.allowedTokens[chainId]);
        }
        return {
            swapFeePPM: Number(this.config.feePPM),
            swapBaseFee: Number(this.config.baseFee),
            min: Number(this.config.min),
            max: Number(this.config.max),
            data: this.getInfoData(),
            chainTokens
        };
    }
    getInitAuthorizationTimeout(chainIdentifier) {
        return this.config.initAuthorizationTimeouts?.[chainIdentifier] ?? this.config.initAuthorizationTimeout;
    }
}
exports.SwapHandler = SwapHandler;
