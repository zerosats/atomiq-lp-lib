// Offline stub for @zerosats/ml-core (aliased in vitest.config.ts). The lp-lib
// unit tests never reach wasm or the SE, so only the runtime values the wallet
// code imports need real shapes: SERejected (the 404-polling branch does
// `instanceof SERejected && status !== 404`) and createMercuryClient (never
// called under test; the wallet's LxClient is replaced by a fake).

export class SERejected extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body?: unknown) {
        super(message);
        this.name = "SERejected";
        this.status = status;
        this.body = body;
    }
}

export function createMercuryClient(): never {
    throw new Error("createMercuryClient stub: not available in unit tests");
}
