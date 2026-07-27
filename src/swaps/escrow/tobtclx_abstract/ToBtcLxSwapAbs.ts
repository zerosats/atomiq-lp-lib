import {SwapData} from "@atomiqlabs/base";
import {SwapHandlerType} from "../../../index";
import {ToBtcBaseSwap} from "../ToBtcBaseSwap";

export enum ToBtcLxSwapState {
    REFUNDED = -3,
    CANCELED = -2,
    NON_PAYABLE = -1,
    SAVED = 0,
    COMMITED = 1,
    PAID = 2,
    CLAIMED = 3
}

/**
 * A to-BTCLX swap: the LP pays out a Mercury statecoin via a sender-controlled
 * latch. The SE mints paymentHash (H = sha256(preimage)) at latch creation, so
 * unlike ToBtcLn the hash originates on the LP side and is bound to the on-chain
 * HTLC as its claim hash before the client commits the escrow. secret is the
 * preimage the SE releases once the client claims the coin.
 */
export class ToBtcLxSwapAbs<T extends SwapData = SwapData> extends ToBtcBaseSwap<T, ToBtcLxSwapState> {

    readonly paymentHash: string;
    readonly statechainId: string;
    readonly toAddress: string;
    readonly batchId: string;
    payInitiated: boolean;

    secret: string;

    constructor(
        chainIdentifier: string,
        paymentHash: string,
        statechainId: string,
        toAddress: string,
        batchId: string,
        amount: bigint,
        swapFee: bigint,
        swapFeeInToken: bigint,
        quotedNetworkFee: bigint,
        quotedNetworkFeeInToken: bigint,
    );
    constructor(obj: any);

    constructor(
        chainIdOrObj: string | any,
        paymentHash?: string,
        statechainId?: string,
        toAddress?: string,
        batchId?: string,
        amount?: bigint,
        swapFee?: bigint,
        swapFeeInToken?: bigint,
        quotedNetworkFee?: bigint,
        quotedNetworkFeeInToken?: bigint
    ) {
        if(typeof(chainIdOrObj)==="string") {
            super(chainIdOrObj, amount, swapFee, swapFeeInToken, quotedNetworkFee, quotedNetworkFeeInToken);
            this.state = ToBtcLxSwapState.SAVED;
            this.paymentHash = paymentHash;
            this.statechainId = statechainId;
            this.toAddress = toAddress;
            this.batchId = batchId;
        } else {
            super(chainIdOrObj);
            this.paymentHash = chainIdOrObj.paymentHash;
            this.statechainId = chainIdOrObj.statechainId;
            this.toAddress = chainIdOrObj.toAddress;
            this.batchId = chainIdOrObj.batchId;
            this.secret = chainIdOrObj.secret;
            this.payInitiated = chainIdOrObj.payInitiated;
        }
        this.type = SwapHandlerType.TO_BTCLX;
    }

    getIdentifierHash(): string {
        return this.paymentHash;
    }

    serialize(): any {
        const partialSerialized = super.serialize();
        partialSerialized.paymentHash = this.paymentHash;
        partialSerialized.statechainId = this.statechainId;
        partialSerialized.toAddress = this.toAddress;
        partialSerialized.batchId = this.batchId;
        partialSerialized.secret = this.secret;
        partialSerialized.payInitiated = this.payInitiated;
        return partialSerialized;
    }

    isInitiated(): boolean {
        return this.state!==ToBtcLxSwapState.SAVED;
    }

    isFailed(): boolean {
        return this.state===ToBtcLxSwapState.NON_PAYABLE || this.state===ToBtcLxSwapState.CANCELED || this.state===ToBtcLxSwapState.REFUNDED;
    }

    isSuccess(): boolean {
        return this.state===ToBtcLxSwapState.CLAIMED;
    }

    getDestinationAddress(): string {
        return this.toAddress;
    }

}
