/**
 * What a client message is allowed to cause, tested. Run with `npm run test:room`.
 *
 * A room message may say what a player intends. It may not create the thing the
 * issuer later signs for. PLAYER_HOTBAR_ACTIVATED with digit 6 used to drop a
 * catalogue item at the sender's feet, and a dropped item is what
 * `pickupItem()` mints from, so the whole exploit was: send the message, walk
 * two paces, repeat (issue #10). It is refused here as it is refused in
 * production, with a wallet bound and an authority that would mint if asked —
 * because the proof-unavailable mode this ships in today would hide the bug
 * rather than fix it.
 *
 * In-process and deterministic. There is no chain here at all: the authority is
 * a counter, and what is being checked is who called it.
 */

import { GameRoomState } from "./GameRoomState";
import { entityCTRL } from "../controllers/entityCTRL";
import { spawnCTRL } from "../controllers/spawnCTRL";
import { LootSchema, PlayerSchema } from "../schema";
import { GameData } from "../../GameData";
import { Config } from "../../../shared/Config";
import { ServerMsg } from "../../../shared/types";
import { useInventoryAuthority, type InventoryAuthority } from "../../kei/Inventory";
import Logger from "../../utils/Logger";

const CHARACTER = 1;
const ADDRESS = "kei_" + "a".repeat(60);

let failures = 0;

function check(what: string, ok: boolean, detail = ""): void {
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures += 1;
}

////////////////////////////////////////////////////////////////////////////////
// An authority that mints anything it is asked to, to a wallet that is already
// bound. The point of the tests below is that nothing asks it.

const minted: { characterId: number; reward: any }[] = [];

const authority = {
    challenge: () => "challenge",
    bind: async () => ({ characterId: CHARACTER, address: ADDRESS }),
    addressOf: () => ADDRESS,
    release: () => {},
    holdings: async () => ({}),
    purse: async () => 0,
    authorize: async () => ({ allowed: true, address: ADDRESS, held: 1 }),
    pay: async (characterId: number, reward: any) => {
        minted.push({ characterId, reward });
        return { paid: true, address: ADDRESS, gold: reward.gold ?? 0, items: reward.items ?? [] };
    },
} as unknown as InventoryAuthority;

useInventoryAuthority(authority);

////////////////////////////////////////////////////////////////////////////////
// A refusal nobody can see is not a refusal.

const refusals: string[] = [];
const warning = Logger.warning.bind(Logger);
Logger.warning = (message: any, data: any = []) => {
    if (typeof message === "string" && message.includes("[gameroom][refused]")) {
        refusals.push(message);
    }
    warning(message, data);
};

////////////////////////////////////////////////////////////////////////////////
// One room, one player, and a location with no spawns of its own so that every
// entity in the room got there because something in this file put it there.

const LOCATION = { key: "test_room", title: "Test Room", dynamic: { spawns: [], interactive: [] } };

const gameData = {
    get: (type: string, key: string) => (type === "location" ? (key === LOCATION.key ? LOCATION : false) : GameData.get(type, key)),
    load: (type: string) => GameData.load(type),
};

const sent: { type: number; message: any }[] = [];

const client: any = {
    sessionId: "session-1",
    auth: {
        id: CHARACTER,
        name: "Tester",
        race: "humanoid",
        material: 0,
        head: "Head_Base",
        location: LOCATION.key,
        x: 0,
        y: 0,
        z: 0,
        rot: 0,
        health: 100,
        mana: 100,
        level: 1,
        abilities: [],
        quests: [],
        hotbar: [],
    },
    send: (type: number, message: any) => sent.push({ type, message }),
};

const room: any = {
    roomId: "test",
    metadata: { location: LOCATION.key },
    config: new Config(),
    navMesh: { getRandomRegion: () => ({ centroid: { x: 0, y: 0, z: 0 } }) },
    clients: { getById: (sessionId: string) => (sessionId === client.sessionId ? client : undefined) },
    database: { toggleOnlineStatus: () => {} },
};

/** `init()` reads the game data over HTTP from a running server. This does not. */
class TestRoomState extends GameRoomState {
    public async init() {
        this.gameData = gameData as any;
        this.roomDetails = LOCATION;
        this.entityCTRL = new entityCTRL(this);
        this.spawnCTRL = new spawnCTRL(this);
    }
}

const state = new TestRoomState(room, room.navMesh, {});
state.addPlayer(client);

const player = state.getEntity(client.sessionId) as PlayerSchema;
const loot = () => [...state.entities.values()].filter((entity) => entity instanceof LootSchema);

check("the room has one player and nothing else", state.entities.size === 1 && loot().length === 0);
check("and a wallet the authority would pay", authority.addressOf(CHARACTER) === ADDRESS);

////////////////////////////////////////////////////////////////////////////////
// The faucet.

state.processMessage(client, ServerMsg.PLAYER_HOTBAR_ACTIVATED, { senderId: client.sessionId, targetId: false, digit: 6 });
check("digit 6 spawns nothing", loot().length === 0, `${loot().length} on the ground`);
check("and mints nothing", minted.length === 0);

for (let i = 0; i < 100; i++) {
    state.processMessage(client, ServerMsg.PLAYER_HOTBAR_ACTIVATED, { senderId: client.sessionId, targetId: false, digit: 6 });
}
check("a hundred of them spawn nothing", loot().length === 0, `${loot().length} on the ground`);

// Colyseus dispatches messages one at a time, so "concurrent" is what a client
// gets by writing a hundred frames before the room reads any of them.
await Promise.all(
    Array.from({ length: 100 }, () =>
        Promise.resolve().then(() =>
            state.processMessage(client, ServerMsg.PLAYER_HOTBAR_ACTIVATED, { senderId: client.sessionId, targetId: false, digit: 6 })
        )
    )
);
check("and neither does a burst of them", loot().length === 0 && minted.length === 0, `${loot().length} on the ground`);

// The UI only ever sends a number. These are the shapes it never sends.
const forgeries = [
    { digit: "6" },
    { digit: 6.0 },
    { digit: 6, admin: true, debug: true },
    { digit: [6] },
    { digit: 6, qty: 99, key: "sword_01" },
    {},
];
for (const payload of forgeries) {
    state.processMessage(client, ServerMsg.PLAYER_HOTBAR_ACTIVATED, { senderId: client.sessionId, ...payload });
}
check("nor any of the payloads the UI cannot produce", loot().length === 0 && minted.length === 0, JSON.stringify(forgeries));

////////////////////////////////////////////////////////////////////////////////
// A message this room does not handle is refused, not ignored. Silence and
// refusal look the same from the outside, and one of them is guessable.

refusals.length = 0;
const unknown = [9999, -1, 0, "PLAYER_HOTBAR_ACTIVATED", "DEBUG_BOTS", ServerMsg.PLAYER_BUY_ITEM, ServerMsg.PLAYER_SELL_ITEM];
const answered = unknown.map((type) => state.processMessage(client, type as any, { digit: 6 }));
check(
    "an unknown or retired message is refused",
    answered.every((answer) => answer === false),
    JSON.stringify(answered)
);
check("and each refusal reaches the log", refusals.length === unknown.length, `${refusals.length} of ${unknown.length}`);
const first = refusals[0] ?? "";
const forged = refusals[3] ?? "";
check("naming the message and the session, and nothing else", first.includes(client.sessionId) && !first.includes(ADDRESS));
check("and naming it as it arrived rather than as the enum reads it", first.includes("9999") && forged.includes('"PLAYER_HOTBAR_ACTIVATED"'), forged);
check("refusing costs the player nothing in chat", sent.filter((message) => message.type === ServerMsg.SERVER_MESSAGE).length === 0);

// The four debug commands are among them, and the two that did something are
// checked for what they did rather than only for the refusal.
const spawnsBefore = LOCATION.dynamic.spawns.length;
state.processMessage(client, ServerMsg.DEBUG_BOTS, {});
check("DEBUG_BOTS adds no spawns", LOCATION.dynamic.spawns.length === spawnsBefore, `${LOCATION.dynamic.spawns.length}`);

////////////////////////////////////////////////////////////////////////////////
// What the server authors still works, and is still the only thing that does.

const drop = new LootSchema(state, { key: "sword_01", name: "Sword", sessionId: "drop-1", x: 0, y: 0, z: 0, qty: 1 });
state.entityCTRL.add(drop);

state.processMessage(client, ServerMsg.DEBUG_REMOVE_ENTITIES, {});
check("DEBUG_REMOVE_ENTITIES cannot delete a server-authored drop", loot().length === 1);

// Asking to pick something up is a request to walk to it. The mint happens in
// moveCTRL, when the player is actually standing there.
state.processMessage(client, ServerMsg.PLAYER_PICKUP, { sessionId: drop.sessionId });
check("PLAYER_PICKUP takes a target and mints nothing by itself", player.AI_TARGET === drop && minted.length === 0);

state.processMessage(client, ServerMsg.PLAYER_PICKUP, { sessionId: "no-such-entity" });
check("and a pickup aimed at nothing does nothing", minted.length === 0);

player.pickupItem(drop);
await new Promise((resolve) => setTimeout(resolve, 50));
check("walking into the drop pays once", minted.length === 1, JSON.stringify(minted));
check(
    "for the entity the server made, at the quantity it chose",
    minted[0]?.reward.id === `loot:${drop.sessionId}` && minted[0]?.reward.items[0].key === "sword_01" && minted[0]?.reward.items[0].qty === 1,
    JSON.stringify(minted[0]?.reward)
);
check("to the character that walked into it", minted[0]?.characterId === CHARACTER);
check("and the drop is off the ground", loot().length === 0);

console.log(failures === 0 ? "\nall good\n" : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
