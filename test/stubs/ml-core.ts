// Offline stub for @zerosats/ml-core (aliased in vitest.config.ts). The lp-lib
// unit tests never reach wasm or the SE, so only the runtime values the wallet
// code imports need real shapes: SERejected (the 404-polling branch does
// `instanceof SERejected && status !== 404`) and createMercuryClient (never
// called under test; the wallet's LxClient is replaced by a fake).

// Mirrors the real signature exactly: SERejected(status, body), message built by
// the SDK, `name` from the constructor. An earlier stub declared
// (message, status, body); a test constructing it that way put the message where
// the status belongs, so the 404 branch it claimed to cover was never taken.
export class SERejected extends Error {
    readonly code = "SE_REJECTED";
    constructor(readonly status: number, readonly body: unknown) {
        super(`the SE rejected the request with status ${status}: ${JSON.stringify(body)}`);
        this.name = "SERejected";
    }
}

export function createMercuryClient(): never {
    throw new Error("createMercuryClient stub: not available in unit tests");
}
