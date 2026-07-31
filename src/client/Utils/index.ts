/**
 * Where the game server is.
 *
 * Upstream assumed the client was served by the same host that runs the rooms,
 * and derived both URLs from `window.location`. That stops being true the moment
 * the client is hosted as a static example — keicoin.org serves the page and
 * mmo.keicoin.org runs Colyseus — so the origin is a build-time setting with the
 * old same-origin behaviour as its default.
 *
 *   GAME_SERVER=https://mmo.keicoin.org npm run client-build
 */

declare const __GAME_SERVER__: string

const configured = (): string => (typeof __GAME_SERVER__ === "string" ? __GAME_SERVER__ : "");

const isLocal = function () {
    return window.location.host === "localhost:8080";
};

/** `https://host` — no trailing slash, whatever the setting looked like. */
const serverOrigin = function (port) {
    const set = configured();
    if (set) return set.replace(/\/+$/, "");
    if (isLocal()) return "http://localhost:" + port;
    return "https://" + window.location.hostname;
};

const apiUrl = function (port) {
    return serverOrigin(port);
};

/** The same host, as a websocket. Colyseus needs the scheme swapped, not guessed. */
const socketUrl = function (port) {
    return serverOrigin(port).replace(/^http/, "ws");
};

/** Where the player's wallet talks to the chain (SPEC §6.3 — it signs its own blocks). */
const nodeUrl = function (port) {
    return serverOrigin(port) + "/rpc";
};

export { isLocal, apiUrl, socketUrl, nodeUrl, serverOrigin };
