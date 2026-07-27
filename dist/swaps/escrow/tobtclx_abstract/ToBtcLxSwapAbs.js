"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToBtcLxSwapAbs = exports.ToBtcLxSwapState = void 0;
const index_1 = require("../../../index");
const ToBtcBaseSwap_1 = require("../ToBtcBaseSwap");
var ToBtcLxSwapState;
(function (ToBtcLxSwapState) {
    ToBtcLxSwapState[ToBtcLxSwapState["REFUNDED"] = -3] = "REFUNDED";
    ToBtcLxSwapState[ToBtcLxSwapState["CANCELED"] = -2] = "CANCELED";
    ToBtcLxSwapState[ToBtcLxSwapState["NON_PAYABLE"] = -1] = "NON_PAYABLE";
    ToBtcLxSwapState[ToBtcLxSwapState["SAVED"] = 0] = "SAVED";
    ToBtcLxSwapState[ToBtcLxSwapState["COMMITED"] = 1] = "COMMITED";
    ToBtcLxSwapState[ToBtcLxSwapState["PAID"] = 2] = "PAID";
    ToBtcLxSwapState[ToBtcLxSwapState["CLAIMED"] = 3] = "CLAIMED";
})(ToBtcLxSwapState = exports.ToBtcLxSwapState || (exports.ToBtcLxSwapState = {}));
/**
 * A to-BTCLX swap: the LP pays out a Mercury statecoin via a sender-controlled
 * latch. The SE mints paymentHash (H = sha256(preimage)) at latch creation, so
 * unlike ToBtcLn the hash originates on the LP side and is bound to the on-chain
 * HTLC as its claim hash before the client commits the escrow. secret is the
 * preimage the SE releases once the client claims the coin.
 */
class ToBtcLxSwapAbs extends ToBtcBaseSwap_1.ToBtcBaseSwap {
    constructor(chainIdOrObj, paymentHash, statechainId, toAddress, batchId, amount, swapFee, swapFeeInToken, quotedNetworkFee, quotedNetworkFeeInToken) {
        if (typeof (chainIdOrObj) === "string") {
            super(chainIdOrObj, amount, swapFee, swapFeeInToken, quotedNetworkFee, quotedNetworkFeeInToken);
            this.state = ToBtcLxSwapState.SAVED;
            this.paymentHash = paymentHash;
            this.statechainId = statechainId;
            this.toAddress = toAddress;
            this.batchId = batchId;
        }
        else {
            super(chainIdOrObj);
            this.paymentHash = chainIdOrObj.paymentHash;
            this.statechainId = chainIdOrObj.statechainId;
            this.toAddress = chainIdOrObj.toAddress;
            this.batchId = chainIdOrObj.batchId;
            this.secret = chainIdOrObj.secret;
            this.payInitiated = chainIdOrObj.payInitiated;
        }
        this.type = index_1.SwapHandlerType.TO_BTCLX;
    }
    getIdentifierHash() {
        return this.paymentHash;
    }
    serialize() {
        const partialSerialized = super.serialize();
        partialSerialized.paymentHash = this.paymentHash;
        partialSerialized.statechainId = this.statechainId;
        partialSerialized.toAddress = this.toAddress;
        partialSerialized.batchId = this.batchId;
        partialSerialized.secret = this.secret;
        partialSerialized.payInitiated = this.payInitiated;
        return partialSerialized;
    }
    isInitiated() {
        return this.state !== ToBtcLxSwapState.SAVED;
    }
    isFailed() {
        return this.state === ToBtcLxSwapState.NON_PAYABLE || this.state === ToBtcLxSwapState.CANCELED || this.state === ToBtcLxSwapState.REFUNDED;
    }
    isSuccess() {
        return this.state === ToBtcLxSwapState.CLAIMED;
    }
    getDestinationAddress() {
        return this.toAddress;
    }
}
exports.ToBtcLxSwapAbs = ToBtcLxSwapAbs;
