/**
 * A `GameRoomState` with one player in it, for tests. Not imported by the
 * server bundle.
 *
 * Everything a live room reaches for that a test cannot have — the HTTP call
 * `init()` makes to load game data, the navmesh, the database, the socket — is
 * the smallest stub that answers the question the room asks. Everything else is
 * the real thing: a real `GameRoomState`, a real `PlayerSchema` built by the
 * real `addPlayer()`, real controllers, real `MapSchema`s. That last one is the
 * point. A test that hands the room a plain object for `player_data.quests`
 * would pass while the game was unplayable (issue #12).
 */

import { GameRoomState } from "./GameRoomState";
import { entityCTRL } from "../controllers/entityCTRL";
import { spawnCTRL } from "../controllers/spawnCTRL";
import { PlayerSchema } from "../schema";
import { GameData } from "../../GameData";
import { Config } from "../../../shared/Config";

/** Game data this room should serve instead of `GameData`, by type then key. */
export type DataOverrides = { [type: string]: { [key: string]: any } };

export interface TestRoomOptions {
    /** The character id rewards are paid against. */
    character?: number;
    /** Extra or replacement quests, races, items — anything `GameData` serves. */
    data?: DataOverrides;
    /** Mob spawns for the location. Empty by default, so the room stays still. */
    spawns?: any[];
}

export interface TestRoom {
    state: GameRoomState;
    /** The location the room is running, mutable so a test can watch it. */
    location: any;
    client: any;
    player: PlayerSchema;
    /** Everything the server sent this client, oldest first. */
    sent: { type: number; message: any }[];
}

export function openTestRoom(options: TestRoomOptions = {}): TestRoom {
    const character = options.character ?? 1;
    const overrides = options.data ?? {};

    const location = {
        key: "test_room",
        title: "Test Room",
        dynamic: { spawns: options.spawns ?? [], interactive: [] },
    };

    const gameData = {
        get: (type: string, key: string) => {
            if (overrides[type] && key in overrides[type]) return overrides[type][key];
            if (type === "location") return key === location.key ? location : false;
            return GameData.get(type, key);
        },
        load: (type: string) => GameData.load(type),
    };

    const sent: { type: number; message: any }[] = [];

    const client: any = {
        sessionId: "session-1",
        auth: {
            id: character,
            name: "Tester",
            race: "humanoid",
            material: 0,
            head: "Head_Base",
            location: location.key,
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
        metadata: { location: location.key },
        config: new Config(),
        navMesh: { getRandomRegion: () => ({ centroid: { x: 0, y: 0, z: 0 } }) },
        clients: { getById: (sessionId: string) => (sessionId === client.sessionId ? client : undefined) },
        database: { toggleOnlineStatus: () => {} },
    };

    /** `init()` reads the game data over HTTP from a running server. This does not. */
    class TestRoomState extends GameRoomState {
        public async init() {
            this.gameData = gameData as any;
            this.roomDetails = location;
            this.entityCTRL = new entityCTRL(this);
            this.spawnCTRL = new spawnCTRL(this);
        }
    }

    const state = new TestRoomState(room, room.navMesh, {});
    state.addPlayer(client);

    return { state, location, client, sent, player: state.getEntity(client.sessionId) as PlayerSchema };
}
