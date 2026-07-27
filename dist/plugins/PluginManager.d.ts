import { BitcoinRpc, SwapData } from "@atomiqlabs/base";
import { IPlugin, PluginQuote, QuoteAmountTooHigh, QuoteAmountTooLow, QuoteSetFees, QuoteThrow, ToBtcPluginQuote } from "./IPlugin";
import { FromBtcLnAutoSwap, FromBtcLnRequestType, FromBtcLnSwapAbs, FromBtcLnTrustedSwap, FromBtcRequestType, FromBtcSwapAbs, FromBtcTrustedRequestType, FromBtcTrustedSwap, ISwapPrice, MultichainData, RequestData, SpvVaultPostQuote, SpvVaultSwap, SpvVaultSwapRequestType, SwapHandler, SwapHandlerType, ToBtcLnRequestType, ToBtcLnSwapAbs, ToBtcLxRequestType, ToBtcRequestType, ToBtcSwapAbs } from "..";
import { SwapHandlerSwap } from "../swaps/SwapHandlerSwap";
import { FromBtcLnTrustedRequestType } from "../swaps/trusted/frombtcln_trusted/FromBtcLnTrusted";
import { IBitcoinWallet } from "../wallets/IBitcoinWallet";
import { ILightningWallet } from "../wallets/ILightningWallet";
import { SpvVault } from "../swaps/spv_vault_swap/SpvVault";
export type FailSwapResponse = {
    type: "fail";
    code?: number;
    msg?: string;
};
export type FeeSwapResponse = {
    type: "fee";
    baseFee: bigint;
    feePPM: bigint;
};
export type AmountAndFeeSwapResponse = {
    type: "amountAndFee";
    baseFee?: bigint;
    feePPM?: bigint;
    amount: bigint;
};
export type SwapResponse = FailSwapResponse | FeeSwapResponse | AmountAndFeeSwapResponse;
export declare class PluginManager {
    static plugins: Map<string, IPlugin>;
    static registerPlugin(name: string, plugin: IPlugin): void;
    static unregisterPlugin(name: string): boolean;
    static enable<T extends SwapData>(chainsData: MultichainData, bitcoinRpc: BitcoinRpc<any>, bitcoinWallet: IBitcoinWallet, lightningWallet: ILightningWallet, swapPricing: ISwapPrice, tokens: {
        [chainId: string]: {
            [ticker: string]: {
                address: string;
                decimals: number;
            };
        };
    }, directory: string): Promise<void>;
    static disable(): Promise<void>;
    static serviceInitialize(handler: SwapHandler<any>): Promise<void>;
    static onHttpServerStarted(httpServer: any): Promise<void>;
    static swapStateChange(swap: SwapHandlerSwap, oldState?: any): Promise<void>;
    static swapCreate(swap: SwapHandlerSwap): Promise<void>;
    static swapRemove(swap: SwapHandlerSwap): Promise<void>;
    static onHandlePostFromBtcQuote(swapType: SwapHandlerType.FROM_BTCLN | SwapHandlerType.FROM_BTC | SwapHandlerType.FROM_BTCLN_TRUSTED | SwapHandlerType.FROM_BTC_TRUSTED | SwapHandlerType.FROM_BTC_SPV | SwapHandlerType.FROM_BTCLN_AUTO, request: RequestData<FromBtcLnRequestType | FromBtcRequestType | FromBtcLnTrustedRequestType | FromBtcTrustedRequestType | SpvVaultSwapRequestType>, requestedAmount: {
        input: boolean;
        amount: bigint;
        token: string;
        pricePrefetch?: Promise<bigint>;
    }, chainIdentifier: string, constraints: {
        minInBtc: bigint;
        maxInBtc: bigint;
    }, fees: {
        baseFeeInBtc: bigint;
        feePPM: bigint;
    }, gasTokenAmount?: {
        input: false;
        amount: bigint;
        token: string;
        pricePrefetch?: Promise<bigint>;
    }): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh | PluginQuote>;
    static onHandlePreFromBtcQuote(swapType: SwapHandlerType.FROM_BTCLN | SwapHandlerType.FROM_BTC | SwapHandlerType.FROM_BTCLN_TRUSTED | SwapHandlerType.FROM_BTC_TRUSTED | SwapHandlerType.FROM_BTC_SPV | SwapHandlerType.FROM_BTCLN_AUTO, request: RequestData<FromBtcLnRequestType | FromBtcRequestType | FromBtcLnTrustedRequestType | FromBtcTrustedRequestType | SpvVaultSwapRequestType>, requestedAmount: {
        input: boolean;
        amount: bigint;
        token: string;
    }, chainIdentifier: string, constraints: {
        minInBtc: bigint;
        maxInBtc: bigint;
    }, fees: {
        baseFeeInBtc: bigint;
        feePPM: bigint;
    }, gasTokenAmount?: {
        input: false;
        amount: bigint;
        token: string;
    }): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh>;
    static onHandlePreFromBtcExecute(swapType: SwapHandlerType.FROM_BTCLN | SwapHandlerType.FROM_BTC | SwapHandlerType.FROM_BTCLN_TRUSTED | SwapHandlerType.FROM_BTC_TRUSTED | SwapHandlerType.FROM_BTC_SPV | SwapHandlerType.FROM_BTCLN_AUTO, swap: FromBtcLnSwapAbs | FromBtcSwapAbs | FromBtcLnTrustedSwap | FromBtcTrustedSwap | SpvVaultSwap | FromBtcLnAutoSwap): Promise<QuoteThrow | null>;
    static onHandlePostToBtcQuote<T extends {
        networkFee: bigint;
    }>(swapType: SwapHandlerType.TO_BTCLN | SwapHandlerType.TO_BTC | SwapHandlerType.TO_BTCLX, request: RequestData<ToBtcLnRequestType | ToBtcRequestType | ToBtcLxRequestType>, requestedAmount: {
        input: boolean;
        amount: bigint;
        token: string;
        pricePrefetch?: Promise<bigint>;
    }, chainIdentifier: string, constraints: {
        minInBtc: bigint;
        maxInBtc: bigint;
    }, fees: {
        baseFeeInBtc: bigint;
        feePPM: bigint;
        networkFeeGetter: (amount: bigint) => Promise<T>;
    }): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh | (ToBtcPluginQuote & {
        networkFeeData: T;
    })>;
    static onHandlePreToBtcQuote(swapType: SwapHandlerType.TO_BTCLN | SwapHandlerType.TO_BTC | SwapHandlerType.TO_BTCLX, request: RequestData<ToBtcLnRequestType | ToBtcRequestType | ToBtcLxRequestType>, requestedAmount: {
        input: boolean;
        amount: bigint;
        token: string;
    }, chainIdentifier: string, constraints: {
        minInBtc: bigint;
        maxInBtc: bigint;
    }, fees: {
        baseFeeInBtc: bigint;
        feePPM: bigint;
    }): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh>;
    static onHandlePreToBtcExecute(swapType: SwapHandlerType.TO_BTCLN | SwapHandlerType.TO_BTC, swap: ToBtcLnSwapAbs | ToBtcSwapAbs): Promise<QuoteThrow | null>;
    static onHandlePostedFromBtcQuote(swapType: SwapHandlerType.FROM_BTC_SPV, request: RequestData<SpvVaultPostQuote>, swap: SpvVaultSwap): Promise<QuoteThrow | null>;
    static onVaultSelection(chainIdentifier: string, totalSats: bigint, requestedAmount: {
        amount: bigint;
        token: string;
    }, gasAmount: {
        amount: bigint;
        token: string;
    }): Promise<SpvVault | QuoteThrow | QuoteAmountTooHigh | QuoteAmountTooLow>;
    static getWhitelistedTxIds(): Set<string>;
}
