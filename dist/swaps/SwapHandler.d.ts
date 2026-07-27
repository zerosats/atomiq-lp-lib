import { Express, Request } from "express";
import { ISwapPrice } from "../prices/ISwapPrice";
import { ChainType } from "@atomiqlabs/base";
import { SwapHandlerSwap } from "./SwapHandlerSwap";
import { IIntermediaryStorage } from "../storage/IIntermediaryStorage";
import { IParamReader } from "../utils/paramcoders/IParamReader";
import { LoggerType } from "../utils/Utils";
export declare enum SwapHandlerType {
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
    swapFeePPM: number;
    swapBaseFee: number;
    min: number;
    max: number;
    chainTokens: {
        [chainId: string]: string[];
    };
    data?: any;
};
export type SwapBaseConfig = {
    initAuthorizationTimeout: number;
    initAuthorizationTimeouts?: {
        [chainId: string]: number;
    };
    minNativeBalances?: {
        [chainId: string]: bigint;
    };
    maxInflightSwaps?: number;
    bitcoinBlocktime: bigint;
    baseFee: bigint;
    feePPM: bigint;
    safetyFactor: bigint;
    swapCheckInterval: number;
    max: bigint;
    min: bigint;
    minMaxOverrides?: {
        [chainIdentifier: string]: {
            min: bigint;
            max: bigint;
        };
    };
};
export type MultichainData = {
    chains: {
        [identifier: string]: ChainData;
    };
};
export type ChainData<T extends ChainType = ChainType> = {
    signer: T["Signer"];
    swapContract: T["Contract"];
    spvVaultContract: T["SpvVaultContract"];
    chainInterface: T["ChainInterface"];
    chainEvents: T["Events"];
    allowedTokens: string[];
    tokenMultipliers?: {
        [tokenAddress: string]: bigint;
    };
    allowedDepositTokens?: string[];
    btcRelay?: T["BtcRelay"];
    contractVersion?: string;
};
export type RequestData<T> = {
    chainIdentifier: string;
    raw: Request & {
        paramReader: IParamReader;
    };
    parsed: T;
    metadata: any;
};
/**
 * An abstract class defining a singular swap service
 */
export declare abstract class SwapHandler<V extends SwapHandlerSwap<S> = SwapHandlerSwap, S = any> {
    abstract readonly type: SwapHandlerType;
    readonly storageManager: IIntermediaryStorage<V>;
    readonly path: string;
    readonly chains: MultichainData;
    readonly allowedTokens: {
        [chainId: string]: Set<string>;
    };
    readonly swapPricing: ISwapPrice;
    abstract readonly inflightSwapStates: Set<S>;
    abstract config: SwapBaseConfig;
    inflightSwaps: Set<string>;
    logger: LoggerType;
    protected swapLogger: {
        debug: (swap: SwapHandlerSwap, msg: string, ...args: any) => void;
        info: (swap: SwapHandlerSwap, msg: string, ...args: any) => void;
        warn: (swap: SwapHandlerSwap, msg: string, ...args: any) => void;
        error: (swap: SwapHandlerSwap, msg: string, ...args: any) => void;
    };
    protected constructor(storageDirectory: IIntermediaryStorage<V>, path: string, chainsData: MultichainData, swapPricing: ISwapPrice);
    protected getChain(identifier: string): ChainData;
    protected abstract processPastSwaps(): Promise<void>;
    /**
     * Starts the watchdog checking past swaps for expiry or claim eligibility.
     */
    startWatchdog(): Promise<void>;
    /**
     * Initializes swap handler, loads data and subscribes to chain events
     */
    abstract init(): Promise<void>;
    protected loadData(ctor: new (data: any) => V): Promise<void>;
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
    protected removeSwapData(swap: V, ultimateState?: S): Promise<void>;
    protected saveSwapData(swap: V): Promise<void>;
    /**
     * Pre-fetches native balance to further check if we have enough reserve in a native token
     *
     * @param chainIdentifier
     * @param abortController
     * @protected
     */
    protected prefetchNativeBalanceIfNeeded(chainIdentifier: string, abortController: AbortController): Promise<bigint> | null;
    /**
     * Checks if we have enough native balance to facilitate swaps
     *
     * @param chainIdentifier
     * @param balancePrefetch
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if there are not enough funds in the vault
     */
    protected checkNativeBalance(chainIdentifier: string, balancePrefetch: Promise<bigint>, signal: AbortSignal | null): Promise<void>;
    /**
     * Checks whether there are too many swaps in-flight currently
     * @private
     */
    protected checkTooManyInflightSwaps(): void;
    /**
     * Checks if we have enough balance of the token in the swap vault
     *
     * @param totalInToken
     * @param balancePrefetch
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if there are not enough funds in the vault
     */
    protected checkBalance(totalInToken: bigint, balancePrefetch: Promise<bigint>, signal: AbortSignal | null): Promise<void>;
    /**
     * Checks if the sequence number is between 0-2^64
     *
     * @param sequence
     * @throws {DefinedRuntimeError} will throw an error if sequence number is out of bounds
     */
    protected checkSequence(sequence: bigint): void;
    /**
     * Checks whether a given token is supported on a specified chain
     *
     * @param chainId
     * @param token
     * @protected
     */
    protected isTokenSupported(chainId: string, token: string): boolean;
    getInfo(): SwapHandlerInfoType;
    protected getInitAuthorizationTimeout(chainIdentifier: string): number;
}
