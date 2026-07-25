import {Command} from "@atomiqlabs/server-base";

/**
 * LX statecoin liquidity rail (MercuryLayer statecoins), a sibling of
 * ILightningWallet.
 *
 * Method groups mirror ILightningWallet where a sensible analog exists, but two
 * facts shape the surface and are documented rather than hidden:
 *
 * 1. Mercury's latch is sender-controlled, the opposite of an LN hodl invoice
 *    (receiver-controlled). The LP calling createLatchedTransfer is the sender,
 *    and settleLatchedTransfer reveals a preimage as output rather than consuming
 *    one as input. This is why the ToBtcLX direction (LP as sender) maps cleanly
 *    onto ToBtcLnAbs. The reverse (FromBtcLX) does not fit Atomiq's on-chain
 *    escrow (which needs the preimage at the claimer, while the latch releases it
 *    to the coin sender), but it settles atomically through the latch itself
 *    (route C): one hash H, the coin sender always mints H and retrieves the
 *    preimage. A trustless FromBtcLX handler awaits an SE-side verifiable
 *    lock-proof; the commitment primitive for it exists on the payy_swaps branch.
 * 2. The Mercury ts-sdk has no events, webhooks or subscriptions. Every status
 *    change is discovered by polling (client.wallet.list is a network round-trip,
 *    not a local read), so the waitFor* methods are backed by an internal polling
 *    loop in the implementation, not a passthrough subscription.
 *
 * Atomicity of a swap stays anchored on the existing on-chain SwapContract HTLC,
 * exactly as it is for Lightning swaps today. This is a payment-rail/inventory
 * wallet, not a replacement escrow: Mercury's own 2-of-2 and backup-tx timelocks
 * are not used as the sole atomicity mechanism.
 *
 * Amounts are whole-coin. A statecoin is indivisible: send and latched-transfer
 * move the entire coin named by statechainId, there is no partial-amount send.
 */
export interface ILxWallet {

    init(): Promise<void>;
    /** Stop background work (poller + connectivity watchdog). Idempotent. */
    stop(): void;

    isReady(): boolean;
    getStatus(): string;
    getStatusInfo(): Promise<Record<string, string>>;
    getCommands(): Command<any>[];

    getLxBalance(): Promise<LxBalanceResponse>;

    /**
     * Wallet-level identity key. Mercury has no native one (each coin carries its
     * own auth_pubkey), so the implementation derives a stable key from the wallet
     * mnemonic on a fixed derivation path.
     */
    getIdentityPublicKey(): Promise<string>;

    /**
     * Mint a deposit token. On a paid-token SE the caller must pay its `fee` to
     * `depositAddress` and wait `confirmationTarget` confirmations before the
     * token can back a deposit; then pass the `tokenId` to createDeposit.
     */
    newDepositToken(): Promise<LxDepositToken>;
    createDeposit(init: LxDepositInit): Promise<LxDeposit>;
    getCoin(statechainId: string): Promise<LxStatecoin | null>;
    waitForDeposit(statechainId: string, abortSignal?: AbortSignal): Promise<LxStatecoin>;

    createLatchedTransfer(init: LxLatchedTransferInit): Promise<LxLatchedTransfer>;
    /**
     * Reveal the latch preimage. Polls until the receiver has claimed the coin
     * (the SE withholds the preimage until then, which is what makes the swap
     * atomic), so pass a timeout / abort to bound the wait.
     */
    settleLatchedTransfer(batchId: string, opts?: LxLatchSettleOptions): Promise<LxLatchSettleResult>;
    cancelLatchedTransfer(batchId: string): Promise<void>;

    send(init: LxTransferInit): Promise<LxTransferStatus>;
    getTransfer(statechainId: string): Promise<LxTransferStatus | null>;
    waitForTransfer(statechainId: string, abortSignal?: AbortSignal): Promise<LxTransferStatus>;

    newReceiveAddress(generateBatchId?: boolean): Promise<LxReceiveAddress>;
    receiveTransfers(): Promise<LxReceiveResult>;

    withdraw(statechainId: string, toAddress: string, feeRate?: number): Promise<string>;
    forceExit(statechainId: string, toAddress: string, feeRate?: number): Promise<LxBroadcastResult>;

}

/**
 * Statecoin lifecycle, mirroring mercurylib's CoinStatus. Values match the SE
 * status strings verbatim so a coin status crosses the boundary without mapping.
 * IN_TRANSFER means the sender performed the transfer and the receiver has not
 * completed it.
 */
export enum LxStatecoinStatus {
    INITIALISED = "INITIALISED",
    IN_MEMPOOL = "IN_MEMPOOL",
    UNCONFIRMED = "UNCONFIRMED",
    CONFIRMED = "CONFIRMED",
    IN_TRANSFER = "IN_TRANSFER",
    WITHDRAWING = "WITHDRAWING",
    TRANSFERRED = "TRANSFERRED",
    WITHDRAWN = "WITHDRAWN",
    DUPLICATED = "DUPLICATED",
    INVALIDATED = "INVALIDATED"
}

/** Bitcoin network ids, matching the ml-core BitcoinNetwork string values. */
export enum LxNetwork {
    Bitcoin = "bitcoin",
    Testnet = "testnet",
    Signet = "signet",
    Regtest = "regtest"
}

/** LxWallet connectivity lifecycle, surfaced by getStatus(). */
export enum LxConnectionStatus {
    Offline = "offline",
    Connecting = "connecting",
    Ready = "ready",
    Disconnected = "disconnected"
}

/**
 * LP-facing projection of a statecoin, curated from the SDK's StatecoinSummary.
 * amount is in sats (bigint to match the Atomiq wallet conventions), null until
 * the coin is funded. address is the transfer address to send the coin to;
 * depositAddress is the on-chain aggregated address that funds it.
 */
export type LxStatecoin = {
    statechainId: string | null,
    utxoTxid: string | null,
    utxoVout: number | null,
    amount: bigint | null,
    status: LxStatecoinStatus,
    address: string,
    depositAddress: string | null,
    locktime: number | null,
    duplicateIndex: number
};

/**
 * A deposit is an on-chain funding address, not a re-usable invoice. tokenId is
 * optional: when omitted the implementation mints a deposit token itself (token
 * issuance is a deployment property of the SE).
 */
export type LxDepositInit = {
    amount: bigint,
    tokenId?: string
};

export type LxDeposit = {
    depositAddress: string,
    statechainId: string,
    amount: bigint
};

/**
 * A minted deposit token. On a paid-token SE, `fee` sats must be paid to
 * `depositAddress` and confirmed (`confirmationTarget` blocks) before the token
 * backs a deposit. `fee` is 0 on a free-token SE.
 */
export type LxDepositToken = {
    tokenId: string,
    depositAddress: string,
    fee: bigint,
    confirmationTarget: number
};

/**
 * Init for a sender-controlled latched transfer. The LP is the sender: the SE
 * mints the payment hash (server-generated), so unlike a BOLT11 payment hash the
 * LP receives from a user, the LP must create the latch before quoting and bind
 * the returned paymentHash to the on-chain HTLC as its claim hash.
 */
export type LxLatchedTransferInit = {
    statechainId: string,
    toAddress: string
};

export type LxLatchedTransfer = {
    batchId: string,
    paymentHash: string,
    statechainId: string
};

/** settleLatchedTransfer reveals the preimage (H = sha256(preimage)) as output. */
export type LxLatchSettleResult = {
    preimage: string
};

/** Bounds the settleLatchedTransfer poll that waits for the receiver to claim. */
export type LxLatchSettleOptions = {
    abortSignal?: AbortSignal,
    timeoutMs?: number,
    pollIntervalMs?: number
};

/** Init for a plain (non-latched) whole-coin send. */
export type LxTransferInit = {
    statechainId: string,
    toAddress: string
};

export type LxTransferStatus = {
    statechainId: string,
    status: LxStatecoinStatus
};

export type LxReceiveAddress = {
    transferAddress: string,
    batchId?: string
};

/**
 * One transfer message that failed to claim; the coin is left unclaimed and can
 * be retried. Curated from the SDK's TransferIssue (its typed cause is flattened
 * to a message string at this boundary).
 */
export type LxReceiveIssue = {
    operation: "fetch" | "claim",
    statechainId: string | null,
    message: string
};

export type LxReceiveResult = {
    isBatchLocked: boolean,
    receivedStatechainIds: string[],
    issues: LxReceiveIssue[]
};

export type LxBalanceResponse = {
    confirmed: bigint,
    pending: bigint,
    total: bigint
};

/** TXIDs from a unilateral exit: the backup transaction plus its CPFP child. */
export type LxBroadcastResult = {
    backupTxid: string,
    cpfpTxid: string
};
