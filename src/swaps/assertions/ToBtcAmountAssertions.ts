import {AmountAssertions} from "./AmountAssertions";
import {ToBtcLnRequestType} from "../escrow/tobtcln_abstract/ToBtcLnAbs";
import {ToBtcRequestType} from "../escrow/tobtc_abstract/ToBtcAbs";
import {ToBtcLxRequestType} from "../escrow/tobtclx_abstract/ToBtcLxAbs";
import {PluginManager} from "../../plugins/PluginManager";
import {isQuoteSetFees, isToBtcPluginQuote} from "../../plugins/IPlugin";
import {RequestData, SwapHandlerType} from "../SwapHandler";


export class ToBtcAmountAssertions extends AmountAssertions {

    /**
     * Checks minimums/maximums, calculates the fee & total amount
     *
     * @param swapType
     * @param request
     * @param requestedAmount
     * @throws {DefinedRuntimeError} will throw an error if the amount is outside minimum/maximum bounds
     */
    async preCheckToBtcAmounts(
        swapType: SwapHandlerType.TO_BTCLN | SwapHandlerType.TO_BTC | SwapHandlerType.TO_BTCLX,
        request: RequestData<ToBtcLnRequestType | ToBtcRequestType | ToBtcLxRequestType>,
        requestedAmount: {input: boolean, amount: bigint, token: string}
    ): Promise<{baseFee: bigint, feePPM: bigint}> {
        const min = this.getSwapMinimum(request.chainIdentifier);
        const max = this.getSwapMaximum(request.chainIdentifier);

        const res = await PluginManager.onHandlePreToBtcQuote(
            swapType,
            request,
            requestedAmount,
            request.chainIdentifier,
            {minInBtc: min, maxInBtc: max},
            {baseFeeInBtc: this.config.baseFee, feePPM: this.config.feePPM},
        );
        if(res!=null) {
            AmountAssertions.handlePluginErrorResponses(res);
            if(isQuoteSetFees(res)) {
                return {
                    baseFee: res.baseFee ?? this.config.baseFee,
                    feePPM: res.feePPM ?? this.config.feePPM
                }
            }
        }
        if(!requestedAmount.input) {
            this.checkBtcAmountInBounds(requestedAmount.amount, request.chainIdentifier);
        }
        return {
            baseFee: this.config.baseFee,
            feePPM: this.config.feePPM
        };
    }

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
    async checkToBtcAmount<T extends {networkFee: bigint}>(
        swapType: SwapHandlerType.TO_BTCLN | SwapHandlerType.TO_BTC | SwapHandlerType.TO_BTCLX,
        request: RequestData<ToBtcLnRequestType | ToBtcRequestType | ToBtcLxRequestType>,
        requestedAmount: {input: boolean, amount: bigint, token: string, pricePrefetch?: Promise<bigint>},
        fees: {baseFee: bigint, feePPM: bigint},
        getNetworkFee: (amount: bigint) => Promise<T>,
        signal: AbortSignal
    ): Promise<{
        amountBD: bigint,
        networkFeeData: T,
        swapFee: bigint,
        swapFeeInToken: bigint,
        networkFee: bigint,
        networkFeeInToken: bigint,
        totalInToken: bigint
    }> {
        const chainIdentifier = request.chainIdentifier;

        const min = this.getSwapMinimum(chainIdentifier);
        const max = this.getSwapMaximum(chainIdentifier);

        const res = await PluginManager.onHandlePostToBtcQuote<T>(
            swapType,
            request,
            requestedAmount,
            request.chainIdentifier,
            {minInBtc: min, maxInBtc: max},
            {baseFeeInBtc: fees.baseFee, feePPM: fees.feePPM, networkFeeGetter: getNetworkFee}
        );
        signal.throwIfAborted();
        if(res!=null) {
            AmountAssertions.handlePluginErrorResponses(res);
            if(isQuoteSetFees(res)) {
                if(res.baseFee!=null) fees.baseFee = res.baseFee;
                if(res.feePPM!=null) fees.feePPM = res.feePPM;
            }
            if(isToBtcPluginQuote(res)) {
                if(requestedAmount.input) {
                    return {
                        amountBD: res.amount.amount,
                        swapFee: res.swapFee.inOutputTokens,
                        swapFeeInToken: res.swapFee.inInputTokens,
                        networkFee: res.networkFee.inOutputTokens,
                        networkFeeInToken: res.networkFee.inInputTokens,
                        networkFeeData: res.networkFeeData,
                        totalInToken: requestedAmount.amount
                    }
                } else {
                    return {
                        amountBD: requestedAmount.amount,
                        swapFee: res.swapFee.inOutputTokens,
                        swapFeeInToken: res.swapFee.inInputTokens,
                        networkFee: res.networkFee.inOutputTokens,
                        networkFeeInToken: res.networkFee.inInputTokens,
                        networkFeeData: res.networkFeeData,
                        totalInToken: res.amount.amount + res.swapFee.inInputTokens + res.networkFee.inInputTokens
                    }
                }
            }
        }

        let amountBD: bigint;
        let tooHigh = false;
        let tooLow = false;
        if(requestedAmount.input) {
            amountBD = await this.swapPricing.getToBtcSwapAmount(requestedAmount.amount, requestedAmount.token, chainIdentifier, null, requestedAmount.pricePrefetch);
            signal.throwIfAborted();

            //Decrease by base fee
            amountBD = amountBD - fees.baseFee;

            //If it's already smaller than minimum, set it to minimum so we can calculate the network fee
            if(amountBD < (min * 95n / 100n)) {
                amountBD = min;
                tooLow = true;
            }
            //If it's already larger than maximum, set it to maximum so we can calculate the network fee
            if(amountBD > (max * 105n / 100n)) {
                amountBD = max;
                tooHigh = true;
            }
        } else {
            amountBD = requestedAmount.amount;
            this.checkBtcAmountInBounds(amountBD, chainIdentifier);
        }

        const resp = await getNetworkFee(amountBD);
        signal.throwIfAborted();

        if(requestedAmount.input) {
            //Decrease by network fee
            amountBD = amountBD - resp.networkFee;

            //Decrease by percentage fee
            amountBD = amountBD * 1000000n / (fees.feePPM + 1000000n);

            tooHigh ||= amountBD > (max * 105n / 100n);
            tooLow ||= amountBD < (min * 95n / 100n);
            if(tooLow || tooHigh) {
                //Compute min/max
                let adjustedMin = min * (fees.feePPM + 1000000n) / 1000000n;
                let adjustedMax = max * (fees.feePPM + 1000000n) / 1000000n;
                adjustedMin = adjustedMin + fees.baseFee + resp.networkFee;
                adjustedMax = adjustedMax + fees.baseFee + resp.networkFee;
                const minIn = await this.swapPricing.getFromBtcSwapAmount(
                    adjustedMin, requestedAmount.token, chainIdentifier, null, requestedAmount.pricePrefetch
                );
                const maxIn = await this.swapPricing.getFromBtcSwapAmount(
                    adjustedMax, requestedAmount.token, chainIdentifier, null, requestedAmount.pricePrefetch
                );
                throw {
                    code: tooLow ? 20003 : 20004,
                    msg: tooLow ? "Amount too low!" : "Amount too high!",
                    data: {
                        min: minIn.toString(10),
                        max: maxIn.toString(10)
                    }
                };
            }
        }

        const swapFee = fees.baseFee + (amountBD * fees.feePPM / 1000000n);

        const networkFeeInToken = await this.swapPricing.getFromBtcSwapAmount(
            resp.networkFee, requestedAmount.token, chainIdentifier, true, requestedAmount.pricePrefetch
        );
        const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(
            swapFee, requestedAmount.token, chainIdentifier, true, requestedAmount.pricePrefetch
        );
        signal.throwIfAborted();

        let total: bigint;
        if(requestedAmount.input) {
            total = requestedAmount.amount;
        } else {
            const amountInToken = await this.swapPricing.getFromBtcSwapAmount(
                requestedAmount.amount, requestedAmount.token, chainIdentifier, true, requestedAmount.pricePrefetch
            );
            signal.throwIfAborted();
            total = amountInToken + swapFeeInToken + networkFeeInToken;
        }

        return {amountBD, networkFeeData: resp, swapFee, swapFeeInToken, networkFee: resp.networkFee, networkFeeInToken, totalInToken: total};
    }

}