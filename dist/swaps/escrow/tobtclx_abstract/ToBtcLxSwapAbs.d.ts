import { SwapData } from "@atomiqlabs/base";
import { ToBtcBaseSwap } from "../ToBtcBaseSwap";
export declare enum ToBtcLxSwapState {
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
export declare class ToBtcLxSwapAbs<T extends SwapData = SwapData> extends ToBtcBaseSwap<T, ToBtcLxSwapState> {
    readonly paymentHash: string;
    readonly statechainId: string;
    readonly toAddress: string;
    readonly batchId: string;
    payInitiated: boolean;
    secret: string;
    constructor(chainIdentifier: string, paymentHash: string, statechainId: string, toAddress: string, batchId: string, amount: bigint, swapFee: bigint, swapFeeInToken: bigint, quotedNetworkFee: bigint, quotedNetworkFeeInToken: bigint);
    constructor(obj: any);
    getIdentifierHash(): string;
    serialize(): any;
    isInitiated(): boolean;
    isFailed(): boolean;
    isSuccess(): boolean;
    getDestinationAddress(): string;
}
