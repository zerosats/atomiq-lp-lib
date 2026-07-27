import {BitcoinRpc} from "@atomiqlabs/base";
import {
    FromBtcLnAbs, FromBtcLnAutoSwap,
    FromBtcLnRequestType, FromBtcLnSwapAbs, FromBtcLnTrustedSwap,
    FromBtcRequestType, FromBtcSwapAbs, FromBtcTrustedRequestType, FromBtcTrustedSwap,
    ISwapPrice, MultichainData, RequestData, SpvVaultPostQuote, SpvVaultSwap, SpvVaultSwapRequestType,
    SwapHandler, SwapHandlerType,
    ToBtcLnRequestType, ToBtcLnSwapAbs,
    ToBtcLxRequestType,
    ToBtcRequestType, ToBtcSwapAbs
} from "..";
import {SwapHandlerSwap} from "../swaps/SwapHandlerSwap";
import {Command} from "@atomiqlabs/server-base";
import {FromBtcLnTrustedRequestType} from "../swaps/trusted/frombtcln_trusted/FromBtcLnTrusted";
import {IBitcoinWallet} from "../wallets/IBitcoinWallet";
import {ILightningWallet} from "../wallets/ILightningWallet";
import {SpvVault} from "../swaps/spv_vault_swap/SpvVault";

export type QuoteThrow = {
    type: "throw",
    message: string
}

export function isQuoteThrow(obj: any): obj is QuoteThrow {
    return obj!=null && obj.type==="throw" && typeof(obj.message)==="string";
}

export type QuoteSetFees = {
    type: "fees"
    baseFee?: bigint,
    feePPM?: bigint,
    securityDepositApyPPM?: bigint,
    securityDepositBaseMultiplierPPM?: bigint
};

export function isQuoteSetFees(obj: any): obj is QuoteSetFees {
    return obj!=null &&
        obj.type==="fees" &&
        (obj.baseFee==null || typeof(obj.baseFee) === "bigint") &&
        (obj.feePPM==null || typeof(obj.feePPM) === "bigint") &&
        (obj.securityDepositApyPPM==null || typeof(obj.securityDepositApyPPM) === "bigint") &&
        (obj.securityDepositBaseMultiplierPPM==null || typeof(obj.securityDepositBaseMultiplierPPM) === "bigint");
}

export type QuoteAmountTooLow = {
    type: "low",
    data: { min: bigint, max: bigint }
}

export function isQuoteAmountTooLow(obj: any): obj is QuoteAmountTooLow {
    return obj!=null && obj.type==="low" && obj.data!=null && typeof(obj.data)==="object" && typeof(obj.data.min)==="bigint" && typeof(obj.data.max)==="bigint";
}

export type QuoteAmountTooHigh = {
    type: "high",
    data: { min: bigint, max: bigint }
}

export function isQuoteAmountTooHigh(obj: any): obj is QuoteAmountTooHigh {
    return obj!=null && obj.type==="high" && obj.data!=null && typeof(obj.data)==="object" && typeof(obj.data.min)==="bigint" && typeof(obj.data.max)==="bigint";
}

export type PluginQuote = {
    type: "success",
    amount: {input: boolean, amount: bigint},
    swapFee: { inInputTokens: bigint, inOutputTokens: bigint }
};

export function isPluginQuote(obj: any): obj is PluginQuote {
    return obj!=null && obj.type==="success" &&
        obj.amount!=null && typeof(obj.amount)==="object" && typeof(obj.amount.input)==="boolean" && typeof(obj.amount.amount)==="bigint" &&
        obj.swapFee!=null && typeof(obj.swapFee)==="object" && typeof(obj.swapFee.inInputTokens)==="bigint" && typeof(obj.swapFee.inOutputTokens)==="bigint";
}

export type ToBtcPluginQuote = PluginQuote & {
    networkFee: { inInputTokens: bigint, inOutputTokens: bigint }
}

export function isToBtcPluginQuote(obj: any): obj is ToBtcPluginQuote {
    return obj!=null && obj.networkFee!=null && typeof(obj.networkFee)==="object" && typeof(obj.networkFee.inInputTokens)==="bigint" && typeof(obj.networkFee.inOutputTokens)==="bigint" &&
        isPluginQuote(obj);
}

export interface IPlugin {

    name: string;
    author: string;
    description: string;

    //Needs to be called by implementation
    onEnable(
        chainsData: MultichainData,

        bitcoinRpc: BitcoinRpc<any>,
        bitcoinWallet: IBitcoinWallet,
        lightningWallet: ILightningWallet,

        swapPricing: ISwapPrice,
        tokens: {
            [chainId: string]: {
                [ticker: string]: {
                    address: string,
                    decimals: number
                }
            }
        },

        directory: string
    ): Promise<void>;
    onDisable(): Promise<void>;

    //Called in the library
    onServiceInitialize(service: SwapHandler<any>): Promise<void>;

    onHttpServerStarted?(expressServer: any): Promise<void>;

    onSwapStateChange?(swap: SwapHandlerSwap): Promise<void>;
    onSwapCreate?(swap: SwapHandlerSwap): Promise<void>;
    onSwapRemove?(swap: SwapHandlerSwap): Promise<void>;

    onHandlePreFromBtcQuote?(
        swapType: SwapHandlerType.FROM_BTCLN | SwapHandlerType.FROM_BTC | SwapHandlerType.FROM_BTCLN_TRUSTED | SwapHandlerType.FROM_BTC_TRUSTED | SwapHandlerType.FROM_BTC_SPV | SwapHandlerType.FROM_BTCLN_AUTO,
        request: RequestData<FromBtcLnRequestType | FromBtcRequestType | FromBtcLnTrustedRequestType | FromBtcTrustedRequestType | SpvVaultSwapRequestType>,
        requestedAmount: {input: boolean, amount: bigint, token: string},
        chainIdentifier: string,
        constraints: {minInBtc: bigint, maxInBtc: bigint},
        fees: {baseFeeInBtc: bigint, feePPM: bigint},
        gasTokenAmount?: {input: false, amount: bigint, token: string}
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh>;
    onHandlePostFromBtcQuote?(
        swapType: SwapHandlerType.FROM_BTCLN | SwapHandlerType.FROM_BTC | SwapHandlerType.FROM_BTCLN_TRUSTED | SwapHandlerType.FROM_BTC_TRUSTED | SwapHandlerType.FROM_BTC_SPV | SwapHandlerType.FROM_BTCLN_AUTO,
        request: RequestData<FromBtcLnRequestType | FromBtcRequestType | FromBtcLnTrustedRequestType | FromBtcTrustedRequestType | SpvVaultSwapRequestType>,
        requestedAmount: {input: boolean, amount: bigint, token: string, pricePrefetch?: Promise<bigint>},
        chainIdentifier: string,
        constraints: {minInBtc: bigint, maxInBtc: bigint},
        fees: {baseFeeInBtc: bigint, feePPM: bigint},
        gasTokenAmount?: {input: false, amount: bigint, token: string, pricePrefetch?: Promise<bigint>}
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh | PluginQuote>;
    /**
     * Triggered when the quote is about to get executed, this means:
     * - FROM_BTCLN - lightning network payment received and the LP is about to sign an authorization allowing the user to settle
     * - FROM_BTC - triggered on quote request, before the final authorization is given to the user
     * - FROM_BTCLN_TRUSTED - triggered when the LP receives the funds on the source chain and before destination funds are sent
     * - FROM_BTC_TRUSTED - triggered when the LP receives the funds on the source chain and before destination funds are sent
     * - FROM_BTC_SPV - triggered before LP broadcasts the co-signed swap PSBT
     * - FROM_BTCLN_AUTO - lightning network payment received and the LP is about to offer an HTLC to the user
     *
     * @param swapType
     * @param swap
     */
    onHandlePreFromBtcExecute?(
        swapType: SwapHandlerType.FROM_BTCLN | SwapHandlerType.FROM_BTC | SwapHandlerType.FROM_BTCLN_TRUSTED | SwapHandlerType.FROM_BTC_TRUSTED | SwapHandlerType.FROM_BTC_SPV | SwapHandlerType.FROM_BTCLN_AUTO,
        swap: FromBtcLnSwapAbs | FromBtcSwapAbs | FromBtcLnTrustedSwap | FromBtcTrustedSwap | SpvVaultSwap | FromBtcLnAutoSwap
    ): Promise<QuoteThrow | null>;

    onHandlePreToBtcQuote?(
        swapType: SwapHandlerType.TO_BTCLN | SwapHandlerType.TO_BTC | SwapHandlerType.TO_BTCLX,
        request: RequestData<ToBtcLnRequestType | ToBtcRequestType | ToBtcLxRequestType>,
        requestedAmount: {input: boolean, amount: bigint, token: string},
        chainIdentifier: string,
        constraints: {minInBtc: bigint, maxInBtc: bigint},
        fees: {baseFeeInBtc: bigint, feePPM: bigint}
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh>;
    onHandlePostToBtcQuote?(
        swapType: SwapHandlerType.TO_BTCLN | SwapHandlerType.TO_BTC | SwapHandlerType.TO_BTCLX,
        request: RequestData<ToBtcLnRequestType | ToBtcRequestType | ToBtcLxRequestType>,
        requestedAmount: {input: boolean, amount: bigint, token: string, pricePrefetch?: Promise<bigint>},
        chainIdentifier: string,
        constraints: {minInBtc: bigint, maxInBtc: bigint},
        fees: {baseFeeInBtc: bigint, feePPM: bigint, networkFeeGetter: (amount: bigint) => Promise<bigint>}
    ): Promise<QuoteThrow | QuoteSetFees | QuoteAmountTooLow | QuoteAmountTooHigh | ToBtcPluginQuote>;
    onHandlePreToBtcExecute?(
        swapType: SwapHandlerType.TO_BTCLN | SwapHandlerType.TO_BTC,
        swap: ToBtcLnSwapAbs | ToBtcSwapAbs
    ): Promise<QuoteThrow | null>;

    onHandlePostedFromBtcQuote?(
        swapType: SwapHandlerType.FROM_BTC_SPV,
        request: RequestData<SpvVaultPostQuote>,
        swap: SpvVaultSwap
    ): Promise<QuoteThrow | null>;

    onVaultSelection?(
        chainIdentifier: string,
        totalSats: bigint,
        requestedAmount: {amount: bigint, token: string},
        gasAmount: {amount: bigint, token: string}
    ): Promise<SpvVault | QuoteThrow | QuoteAmountTooHigh | QuoteAmountTooLow | null>;

    /**
     * Returns whitelisted bitcoin txIds that are OK to spend even with 0-confs
     */
    getWhitelistedTxIds?(): string[];

    getCommands?(): Command<any>[];

}
