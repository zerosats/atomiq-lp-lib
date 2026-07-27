import {Express, Request} from "express";
import {ISwapPrice} from "../prices/ISwapPrice";
import {
    ChainType
} from "@atomiqlabs/base";
import {SwapHandlerSwap} from "./SwapHandlerSwap";
import {PluginManager} from "../plugins/PluginManager";
import {IIntermediaryStorage} from "../storage/IIntermediaryStorage";
import {IParamReader} from "../utils/paramcoders/IParamReader";
import {getLogger, LoggerType} from "../utils/Utils";

export enum SwapHandlerType {
    TO_BTC = "TO_BTC",
    FROM_BTC = "FROM_BTC",
    TO_BTCLN = "TO_BTCLN",
    FROM_BTCLN = "FROM_BTCLN",
    FROM_BTCLN_TRUSTED = "FROM_BTCLN_TRUSTED",
    FROM_BTC_TRUSTED = "FROM_BTC_TRUSTED",
    FROM_BTC_SPV = "FROM_BTC_SPV",
    FROM_BTCLN_AUTO = "FROM_BTCLN_AUTO",
    TO_BTCLX = "TO_BTCLX"
}

export type SwapHandlerInfoType = {
    swapFeePPM: number,
    swapBaseFee: number,
    min: number,
    max: number,
    chainTokens: {[chainId: string]: string[]};
    data?: any,
};

export type SwapBaseConfig = {
    initAuthorizationTimeout: number,
    initAuthorizationTimeouts?: {
        [chainId: string]: number
    },
    minNativeBalances?: {
        [chainId: string]: bigint
    },
    maxInflightSwaps?: number,
    bitcoinBlocktime: bigint,
    baseFee: bigint,
    feePPM: bigint,
    safetyFactor: bigint,
    swapCheckInterval: number,

    max: bigint,
    min: bigint,

    minMaxOverrides?: {
        [chainIdentifier: string]: {min: bigint, max: bigint}
    }
};

export type MultichainData = {
    chains: {
        [identifier: string]: ChainData
    }
};

export type ChainData<T extends ChainType = ChainType> = {
    signer: T["Signer"],
    swapContract: T["Contract"],
    spvVaultContract: T["SpvVaultContract"],
    chainInterface: T["ChainInterface"],
    chainEvents: T["Events"],
    allowedTokens: string[],
    tokenMultipliers?: {[tokenAddress: string]: bigint},
    allowedDepositTokens?: string[],
    btcRelay?: T["BtcRelay"],
    contractVersion?: string
}

export type RequestData<T> = {
    chainIdentifier: string,
    raw: Request & {paramReader: IParamReader},
    parsed: T,
    metadata: any
};

/**
 * An abstract class defining a singular swap service
 */
export abstract class SwapHandler<V extends SwapHandlerSwap<S> = SwapHandlerSwap, S = any> {

    abstract readonly type: SwapHandlerType;

    readonly storageManager: IIntermediaryStorage<V>;
    readonly path: string;

    readonly chains: MultichainData;
    readonly allowedTokens: {[chainId: string]: Set<string>};
    readonly swapPricing: ISwapPrice;

    abstract readonly inflightSwapStates: Set<S>;
    abstract config: SwapBaseConfig;

    inflightSwaps: Set<string> = new Set();

    logger: LoggerType = getLogger(() => "SwapHandler("+this.type+"): ");

    protected swapLogger = {
        debug: (swap: SwapHandlerSwap, msg: string, ...args: any) => this.logger.debug(swap.getIdentifier()+": "+msg, ...args),
        info: (swap: SwapHandlerSwap, msg: string, ...args: any) => this.logger.info(swap.getIdentifier()+": "+msg, ...args),
        warn: (swap: SwapHandlerSwap, msg: string, ...args: any) => this.logger.warn(swap.getIdentifier()+": "+msg, ...args),
        error: (swap: SwapHandlerSwap, msg: string, ...args: any) => this.logger.error(swap.getIdentifier()+": "+msg, ...args)
    };

    protected constructor(
        storageDirectory: IIntermediaryStorage<V>,
        path: string,
        chainsData: MultichainData,
        swapPricing: ISwapPrice
    ) {
        this.storageManager = storageDirectory;
        this.chains = chainsData;
        this.path = path;
        this.swapPricing = swapPricing;
        this.allowedTokens = {};
        for(let chainId in chainsData.chains) {
            this.allowedTokens[chainId] = new Set<string>(chainsData.chains[chainId].allowedTokens);
        }
    }

    protected getChain(identifier: string): ChainData {
        if(this.chains.chains[identifier]==null)
            throw {
                code: 20200,
                msg: "Invalid chain specified!"
            };
        return this.chains.chains[identifier];
    }

    protected abstract processPastSwaps(): Promise<void>;

    /**
     * Starts the watchdog checking past swaps for expiry or claim eligibility.
     */
    async startWatchdog() {
        let rerun: () => Promise<void>;
        rerun = async () => {
            await this.processPastSwaps().catch( e => this.logger.error("startWatchdog(): Error when processing past swaps: ", e));
            setTimeout(rerun, this.config.swapCheckInterval);
        };
        await rerun();
    }

    /**
     * Initializes swap handler, loads data and subscribes to chain events
     */
    abstract init(): Promise<void>;

    protected async loadData(ctor: new (data: any) => V) {
        await this.storageManager.loadData(ctor);
        //Check if all swaps contain a valid amount
        for(let {obj: swap, hash, sequence} of await this.storageManager.query([])) {
            if(hash!==swap.getIdentifierHash() || sequence !== (swap.getSequence() ?? 0n)) {
                this.swapLogger.info(swap, "loadData(): Swap storage key or sequence mismatch, fixing,"+
                    " old hash: "+hash+" new hash: "+swap.getIdentifierHash()+
                    " old seq: "+sequence.toString(10)+" new seq: "+(swap.getSequence() ?? 0n).toString(10));

                await this.storageManager.removeData(hash, sequence);
                await this.storageManager.saveData(swap.getIdentifierHash(), swap.getSequence(), swap);
            }
            if(this.inflightSwapStates.has(swap.state)) this.inflightSwaps.add(swap.getIdentifier());
        }
    }

    /**
     * Sets up required listeners for the REST server
     *
     * @param restServer
     */
    abstract startRestServer(restServer: Express): void;

    /**
     * Returns data to be returned in swap handler info
     */
    abstract getInfoData(): any;

    /**
     * Remove swap data
     *
     * @param swap
     * @param ultimateState set the ultimate state of the swap before removing
     */
    protected async removeSwapData(swap: V, ultimateState?: S) {
        if(this.inflightSwaps.delete(swap.getIdentifier()))
            this.logger.debug("removeSwapData(): Removing in-flight swap, current in-flight swaps: "+this.inflightSwaps.size);
        if(ultimateState!=null) await swap.setState(ultimateState);
        if(swap!=null) await PluginManager.swapRemove(swap);
        this.swapLogger.debug(swap, "removeSwapData(): removing swap final state: "+swap.state);
        await this.storageManager.removeData(swap.getIdentifierHash(), swap.getSequence());
    }

    protected async saveSwapData(swap: V) {
        const identifier = swap.getIdentifier();
        if(this.inflightSwapStates.has(swap.state)) {
            if(!this.inflightSwaps.has(identifier)) {
                this.inflightSwaps.add(identifier);
                this.logger.debug("saveSwapData(): Adding in-flight swap, current in-flight swaps: "+this.inflightSwaps.size);
            }
        } else {
            if(this.inflightSwaps.delete(identifier))
                this.logger.debug("saveSwapData(): Removing in-flight swap, current in-flight swaps: "+this.inflightSwaps.size);
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
    protected prefetchNativeBalanceIfNeeded(chainIdentifier: string, abortController: AbortController): Promise<bigint> | null {
        const minNativeTokenReserve: bigint = this.config.minNativeBalances?.[chainIdentifier] ?? 0n;
        if(minNativeTokenReserve===0n) return null;

        const { chainInterface, signer} = this.getChain(chainIdentifier);

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
    protected async checkNativeBalance(chainIdentifier: string, balancePrefetch: Promise<bigint>, signal: AbortSignal | null): Promise<void> {
        if(signal!=null) signal.throwIfAborted();

        const minNativeTokenReserve: bigint = this.config.minNativeBalances?.[chainIdentifier] ?? 0n;
        if(minNativeTokenReserve===0n) return;
        const balance = await balancePrefetch;
        if(signal!=null) signal.throwIfAborted();

        if(balance==null) {
            throw new Error("Failed to fetch native token balance!");
        }

        if(balance < minNativeTokenReserve) {
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
    protected checkTooManyInflightSwaps() {
        if(this.config.maxInflightSwaps==null) return;
        if(this.inflightSwaps.size>=this.config.maxInflightSwaps) throw {
            code: 20013,
            msg: "LP has too many in-flight swaps, retry later!"
        }
    }

    /**
     * Checks if we have enough balance of the token in the swap vault
     *
     * @param totalInToken
     * @param balancePrefetch
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if there are not enough funds in the vault
     */
    protected async checkBalance(totalInToken: bigint, balancePrefetch: Promise<bigint>, signal: AbortSignal | null): Promise<void> {
        const balance = await balancePrefetch;
        if(signal!=null) signal.throwIfAborted();

        if(balance==null || balance < totalInToken) {
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
    protected checkSequence(sequence: bigint) {
        if(sequence < 0n || sequence >= 2n ** 64n) {
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
    protected isTokenSupported(chainId: string, token: string): boolean {
        const chainTokens = this.allowedTokens[chainId];
        if(chainTokens==null) return false;
        return chainTokens.has(token);
    }

    getInfo(): SwapHandlerInfoType {
        const chainTokens: {[chainId: string]: string[]} = {};
        for(let chainId in this.allowedTokens) {
            chainTokens[chainId] = Array.from<string>(this.allowedTokens[chainId]);
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

    protected getInitAuthorizationTimeout(chainIdentifier: string) {
        return this.config.initAuthorizationTimeouts?.[chainIdentifier] ?? this.config.initAuthorizationTimeout;
    }

}
