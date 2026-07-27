import { AmountAssertions } from "./AmountAssertions";
import { ToBtcLnRequestType } from "../escrow/tobtcln_abstract/ToBtcLnAbs";
import { ToBtcRequestType } from "../escrow/tobtc_abstract/ToBtcAbs";
import { ToBtcLxRequestType } from "../escrow/tobtclx_abstract/ToBtcLxAbs";
import { RequestData, SwapHandlerType } from "../SwapHandler";
export declare class ToBtcAmountAssertions extends AmountAssertions {
    /**
     * Checks minimums/maximums, calculates the fee & total amount
     *
     * @param swapType
     * @param request
     * @param requestedAmount
     * @throws {DefinedRuntimeError} will throw an error if the amount is outside minimum/maximum bounds
     */
    preCheckToBtcAmounts(swapType: SwapHandlerType.TO_BTCLN | SwapHandlerType.TO_BTC | SwapHandlerType.TO_BTCLX, request: RequestData<ToBtcLnRequestType | ToBtcRequestType | ToBtcLxRequestType>, requestedAmount: {
        input: boolean;
        amount: bigint;
        token: string;
    }): Promise<{
        baseFee: bigint;
        feePPM: bigint;
    }>;
    /**
     * Checks minimums/maximums, calculates network fee (based on the callback passed), swap fee & total amount
     *
     * @param swapType
     * @param request
     * @param requestedAmount
     * @param fees
     * @param getNetworkFee
     * @param signal
     * @throws {DefinedRuntimeError} will throw an error if the amount is outside minimum/maximum bounds,
     *  or if we don't have enough funds (getNetworkFee callback throws)
     */
    checkToBtcAmount<T extends {
        networkFee: bigint;
    }>(swapType: SwapHandlerType.TO_BTCLN | SwapHandlerType.TO_BTC | SwapHandlerType.TO_BTCLX, request: RequestData<ToBtcLnRequestType | ToBtcRequestType | ToBtcLxRequestType>, requestedAmount: {
        input: boolean;
        amount: bigint;
        token: string;
        pricePrefetch?: Promise<bigint>;
    }, fees: {
        baseFee: bigint;
        feePPM: bigint;
    }, getNetworkFee: (amount: bigint) => Promise<T>, signal: AbortSignal): Promise<{
        amountBD: bigint;
        networkFeeData: T;
        swapFee: bigint;
        swapFeeInToken: bigint;
        networkFee: bigint;
        networkFeeInToken: bigint;
        totalInToken: bigint;
    }>;
}
