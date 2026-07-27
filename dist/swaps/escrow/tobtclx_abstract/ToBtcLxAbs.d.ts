import { Express } from "express";
import { ToBtcLxSwapAbs, ToBtcLxSwapState } from "./ToBtcLxSwapAbs";
import { MultichainData, SwapHandlerType } from "../../SwapHandler";
import { ISwapPrice } from "../../../prices/ISwapPrice";
import { ChainSwapType, ClaimEvent, InitializeEvent, RefundEvent, SwapData } from "@atomiqlabs/base";
import { IIntermediaryStorage } from "../../../storage/IIntermediaryStorage";
import { ToBtcBaseConfig, ToBtcBaseSwapHandler } from "../ToBtcBaseSwapHandler";
import { ILxWallet } from "../../../wallets/ILxWallet";
export type ToBtcLxConfig = ToBtcBaseConfig & {
    minSendCltv: bigint;
    /** Bounds the settleLatchedTransfer poll that waits for the client to claim the coin. */
    settleTimeoutMs?: number;
    settlePollIntervalMs?: number;
};
/**
 * The client names the coin (statechainId), the output amount, or both. The LP
 * selects a CONFIRMED inventory coin: exact-output only, since a statecoin is
 * indivisible. At least one of statechainId / amount must be present.
 */
export type ToBtcLxRequestType = {
    statechainId?: string;
    amount?: bigint;
    toAddress: string;
    expiryTimestamp: bigint;
    token: string;
    offerer: string;
};
/**
 * Swap handler paying out a Mercury statecoin (LX rail) against an on-chain HTLC.
 *
 * Mirror of ToBtcLnAbs with the payment rail swapped from ILightningWallet to
 * ILxWallet. Control is inverted: the latch is sender-controlled, so the LP mints
 * the payment hash via createLatchedTransfer BEFORE quoting and binds it to the
 * escrow claim hash, rather than reading it from a client-supplied invoice. The
 * SE releases the preimage once the client claims the coin, which is what makes
 * the swap atomic. Escrow claim/refund and signing are identical to ToBtcLn.
 */
export declare class ToBtcLxAbs extends ToBtcBaseSwapHandler<ToBtcLxSwapAbs, ToBtcLxSwapState> {
    readonly type = SwapHandlerType.TO_BTCLX;
    readonly swapType = ChainSwapType.HTLC;
    readonly inflightSwapStates: Set<ToBtcLxSwapState>;
    activeSubscriptions: Set<string>;
    readonly config: ToBtcLxConfig & {
        minTsSendCltv: bigint;
    };
    readonly lx: ILxWallet;
    constructor(storageDirectory: IIntermediaryStorage<ToBtcLxSwapAbs>, path: string, chainData: MultichainData, lx: ILxWallet, swapPricing: ISwapPrice, config: ToBtcLxConfig);
    protected processPastSwap(swap: ToBtcLxSwapAbs): Promise<void>;
    protected processPastSwaps(): Promise<void>;
    /**
     * Cancels the sender-controlled latch so the coin is not left stranded when a
     * swap fails before the client claims it.
     */
    private cancelLatch;
    /**
     * Tries to claim the escrow with the revealed preimage. Identical to ToBtcLn.
     */
    private tryClaimSwap;
    /**
     * Settles the latch: long-polls settleLatchedTransfer until the client claims
     * the coin and the SE releases the preimage, then claims the escrow with it.
     * This replaces the sendLightningPayment + subscribeToPayment pair in ToBtcLn:
     * the latch has a single awaitable result instead of a pending/confirmed poll.
     */
    private subscribeToSettle;
    private processInitialized;
    protected processInitializeEvent(chainIdentifier: string, swap: ToBtcLxSwapAbs, event: InitializeEvent<SwapData>): Promise<void>;
    protected processClaimEvent(chainIdentifier: string, swap: ToBtcLxSwapAbs, event: ClaimEvent<SwapData>): Promise<void>;
    protected processRefundEvent(chainIdentifier: string, swap: ToBtcLxSwapAbs, event: RefundEvent<SwapData>): Promise<void>;
    /**
     * Picks a CONFIRMED inventory coin for the payout. Exact-output only: a
     * statecoin is indivisible, so amount (when given) must match a coin exactly.
     * At least one of statechainId / amount must be supplied.
     */
    private selectInventoryCoin;
    startRestServer(restServer: Express): void;
    init(): Promise<void>;
    getInfoData(): any;
}
