"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LxConnectionStatus = exports.LxNetwork = exports.LxStatecoinStatus = void 0;
/**
 * Statecoin lifecycle, mirroring mercurylib's CoinStatus. Values match the SE
 * status strings verbatim so a coin status crosses the boundary without mapping.
 * IN_TRANSFER means the sender performed the transfer and the receiver has not
 * completed it.
 */
var LxStatecoinStatus;
(function (LxStatecoinStatus) {
    LxStatecoinStatus["INITIALISED"] = "INITIALISED";
    LxStatecoinStatus["IN_MEMPOOL"] = "IN_MEMPOOL";
    LxStatecoinStatus["UNCONFIRMED"] = "UNCONFIRMED";
    LxStatecoinStatus["CONFIRMED"] = "CONFIRMED";
    LxStatecoinStatus["IN_TRANSFER"] = "IN_TRANSFER";
    LxStatecoinStatus["WITHDRAWING"] = "WITHDRAWING";
    LxStatecoinStatus["TRANSFERRED"] = "TRANSFERRED";
    LxStatecoinStatus["WITHDRAWN"] = "WITHDRAWN";
    LxStatecoinStatus["DUPLICATED"] = "DUPLICATED";
    LxStatecoinStatus["INVALIDATED"] = "INVALIDATED";
})(LxStatecoinStatus = exports.LxStatecoinStatus || (exports.LxStatecoinStatus = {}));
/** Bitcoin network ids, matching the ml-core BitcoinNetwork string values. */
var LxNetwork;
(function (LxNetwork) {
    LxNetwork["Bitcoin"] = "bitcoin";
    LxNetwork["Testnet"] = "testnet";
    LxNetwork["Signet"] = "signet";
    LxNetwork["Regtest"] = "regtest";
})(LxNetwork = exports.LxNetwork || (exports.LxNetwork = {}));
/** LxWallet connectivity lifecycle, surfaced by getStatus(). */
var LxConnectionStatus;
(function (LxConnectionStatus) {
    LxConnectionStatus["Offline"] = "offline";
    LxConnectionStatus["Connecting"] = "connecting";
    LxConnectionStatus["Ready"] = "ready";
    LxConnectionStatus["Disconnected"] = "disconnected";
})(LxConnectionStatus = exports.LxConnectionStatus || (exports.LxConnectionStatus = {}));
