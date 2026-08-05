import { Client } from "@colyseus/core";
import { Schema, type, MapSchema, filterChildren } from "@colyseus/schema";
import { BrainSchema, Entity, EquipmentSchema, LootSchema, PlayerSchema } from "../schema";

import { spawnCTRL } from "../controllers/spawnCTRL";
import { entityCTRL } from "../controllers/entityCTRL";
import { gameDataCTRL } from "../controllers/gameDataCTRL";

import { GameRoom } from "../GameRoom";

import { NavMesh, Vector3 } from "../../../shared/Libs/yuka-min";
import Logger from "../../utils/Logger";
import { ItemClass, ServerMsg, Speed } from "../../../shared/types";
import { Config } from "../../../shared/Config";
import { describeLegacy, isEmptyLegacy, quarantineLegacy } from "../../kei/Legacy";

/**
 * Every message this room answers, and nothing else.
 *
 * The room is registered as a single `*` handler running the if-chain below, so
 * "no branch matched" and "refused" used to be the same thing: a message that
 * had quietly been taken out — PLAYER_BUY_ITEM, the debug commands — went on
 * looking exactly like one that was still there and merely silent, and a client
 * probing for a handler learned as much from a hit as from a miss. Anything not
 * listed here is refused before the chain runs and the refusal is logged
 * (issue #10).
 */
const HANDLED: ReadonlySet<ServerMsg> = new Set([
    ServerMsg.PING,
    ServerMsg.PLAYER_RESSURECT,
    ServerMsg.PLAYER_RESET_POSITION,
    ServerMsg.PLAYER_LEARN_SKILL,
    ServerMsg.PLAYER_ADD_STAT_POINT,
    ServerMsg.PLAYER_MOVE,
    ServerMsg.PLAYER_MOVE_TO,
    ServerMsg.PLAYER_PICKUP,
    ServerMsg.PLAYER_DROP_ITEM,
    ServerMsg.PLAYER_USE_ITEM,
    ServerMsg.PLAYER_UNEQUIP_ITEM,
    ServerMsg.PLAYER_QUEST_UPDATE,
    ServerMsg.PLAYER_HOTBAR_ACTIVATED,
]);

export class GameRoomState extends Schema {
    // networked variables
    /*
    @filterChildren(function (client, key, value: BrainSchema | LootSchema | PlayerSchema, root) {
        const isSelf = value.sessionId === client.sessionId;
        const player = (this as GameRoomState).entityCTRL.get(client.sessionId);
        const isWithinXBounds = Math.abs(player.x - value.x) < Config.PLAYER_VIEW_DISTANCE;
        const isWithinZBounds = Math.abs(player.z - value.z) < Config.PLAYER_VIEW_DISTANCE;
        const isWithinBounds = isWithinXBounds && isWithinZBounds;
        return isSelf || isWithinBounds;
    })*/
    @type({ map: Entity }) entities = new MapSchema<BrainSchema | LootSchema | PlayerSchema>();

    @type("number") serverTime: number = 0.0;

    // not networked variables
    public _gameroom: GameRoom = null;
    public spawnCTRL: spawnCTRL;
    public navMesh: NavMesh = null;
    public entityCTRL: entityCTRL;
    public gameData: gameDataCTRL;

    public config: Config;
    public roomDetails;

    private spawnTimer = 0;
    private spawnInterval = 60000;

    constructor(gameroom: GameRoom, _navMesh: NavMesh, ...args: any[]) {
        super(...args);
        this._gameroom = gameroom;
        this.config = gameroom.config;
        this.navMesh = _navMesh;

        this.init();
    }

    public async init() {
        // load game data
        // in the future, it'll be in the database
        this.gameData = new gameDataCTRL();
        await this.gameData.initialize();

        // get location details
        this.roomDetails = this.gameData.get("location", this._gameroom.metadata.location);

        // load controllers
        this.entityCTRL = new entityCTRL(this);
        this.spawnCTRL = new spawnCTRL(this);
    }

    public update(deltaTime: number) {
        // updating entities
        if (this.entityCTRL.hasEntities()) {
            this.entityCTRL.all.forEach((entity) => {
                entity.update(deltaTime);
                // todo: remove item/loot that's been on the ground over 5 minutes
            });
        }

        // update spawn controller
        this.spawnCTRL.update(deltaTime);
    }

    getEntity(sessionId) {
        return this.entityCTRL.get(sessionId);
    }

    deleteEntity(sessionId) {
        this.entities.delete(sessionId);
    }

    removeTarget(sessionId) {
        this.entityCTRL.all.forEach((entity) => {
            if (entity.type === "entity" && entity.AI_TARGET && entity.AI_TARGET.sessionId === sessionId) {
                entity.AI_TARGET = null;
            }
        });
    }

    /**
     * Add player
     * @param client
     */
    addPlayer(client: Client): void {
        // prepare player data
        let data = client.auth;

        // What the old tables still claim this character owns. It is read here so
        // the player can be told about it, and then it goes no further: gold,
        // inventory and equipment are not loaded into the room at all, because a
        // row this server can edit is not ownership (issue #6, `kei/Legacy.ts`).
        const legacy = quarantineLegacy(data);

        let player_data = {
            strength: data.strength ?? 0,
            endurance: data.endurance ?? 0,
            agility: data.agility ?? 0,
            intelligence: data.intelligence ?? 0,
            wisdom: data.wisdom ?? 0,
            experience: data.experience ?? 0,
            points: data.points ?? 0,
        };

        let player = {
            id: data.id,

            x: data.x ?? 0,
            y: data.y ?? 0,
            z: data.z ?? 0,
            rot: data.rot ?? 0,

            health: data.health,
            maxHealth: data.health,
            mana: data.mana,
            maxMana: data.mana,
            level: data.level,

            sessionId: client.sessionId,
            name: data.name,
            type: "player",
            race: data.race,
            material: data.material,
            head: data.head,

            location: data.location,
            sequence: 0,
            blocked: false,

            initial_player_data: player_data,
            initial_abilities: data.abilities ?? [],
            // Empty, and not from `data`. The bag and what is worn are both
            // references to assets the chain has to agree the player holds, and
            // nothing can prove which wallet is theirs yet, so a session starts
            // owning nothing here rather than owning whatever SQLite said.
            initial_inventory: [],
            initial_equipment: [],
            initial_quests: data.quests ?? [],
            initial_hotbar: data.hotbar ?? [],
            legacy,
        };

        this.entityCTRL.add(new PlayerSchema(this, player));

        // set player as online
        this._gameroom.database.toggleOnlineStatus(client.auth.id, 1);

        // Say what happened to the starter potions, once. A player who is told
        // nothing would reasonably conclude the server had eaten them.
        if (!isEmptyLegacy(legacy)) {
            client.send(ServerMsg.SERVER_MESSAGE, {
                type: "event",
                message: describeLegacy(legacy),
                date: new Date(),
            });
        }

        // log
        Logger.info(`[gameroom][onJoin] player ${client.sessionId} joined room ${this._gameroom.roomId}.`);
    }

    processMessage(client, type, data) {
        ////////////////////////////////////
        ////////// SERVER EVENTS ///////////
        ////////////////////////////////////

        // Said out loud, and to the log rather than to the room: a player who
        // forges a message should not learn from the chat whether they guessed
        // a real one, and an operator watching a deployment should be able to
        // see that somebody tried.
        if (!HANDLED.has(type)) {
            // Named as it arrived. `ServerMsg` maps both ways, so resolving a
            // string through it would log the number a forgery was trying to
            // spell rather than the forgery.
            const sent = typeof type === "number" ? ServerMsg[type] ?? type : JSON.stringify(type);
            Logger.warning(`[gameroom][refused] player ${client.sessionId} sent ${sent}, which this room does not accept`);
            return false;
        }

        if (type !== ServerMsg.PING) {
            Logger.info(`[gameroom][` + ServerMsg[type] + `] player message`, data);
        }

        if (type === ServerMsg.PING) {
            client.send(ServerMsg.PONG, data);
        }

        ////////////////////////////////////
        ////////// PLAYER EVENTS ///////////
        ////////////////////////////////////
        const playerState: PlayerSchema = this.getEntity(client.sessionId) as PlayerSchema;
        if (!playerState) {
            return false;
        }

        /////////////////////////////////////
        // on player ressurect
        if (type === ServerMsg.PLAYER_RESSURECT) {
            playerState.ressurect();
        }

        // make sure player is not dead
        if (playerState.isDead) {
            return false;
        }

        //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
        //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
        //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
        //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
        //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

        /////////////////////////////////////
        // on player reset position
        if (type === ServerMsg.PLAYER_RESET_POSITION) {
            playerState.resetPosition();
        }

        /////////////////////////////////////
        // on player learn skill
        if (type === ServerMsg.PLAYER_LEARN_SKILL) {
            //playerState.abilitiesCTRL.learnAbility(data.key);
        }

        /////////////////////////////////////
        // on player add stat point
        if (type === ServerMsg.PLAYER_ADD_STAT_POINT) {
            let key = data.key;
            if (playerState.player_data.points > 0) {
                // remove point
                playerState.player_data.points -= 1;

                // update controller
                playerState.statsCTRL.updateBaseStats(key, 1);
            }
        }

        /////////////////////////////////////
        // on player input
        if (type === ServerMsg.PLAYER_MOVE) {
            playerState.moveCTRL.processPlayerInput(data);
        }

        // on player click to move
        if (type === ServerMsg.PLAYER_MOVE_TO) {
            //playerState.abilitiesCTRL.cancelAutoAttack(playerState);
            playerState.moveCTRL.setTargetDestination(new Vector3(data.x, data.y, data.z));
        }

        /////////////////////////////////////
        // on player ressurect
        if (type === ServerMsg.PLAYER_PICKUP) {
            //playerState.abilitiesCTRL.cancelAutoAttack(playerState);
            const itemState = this.getEntity(data.sessionId);
            if (itemState) {
                playerState.setTarget(itemState);
            }
        }

        // The slot index this used to carry is gone with the bag it indexed into.
        // `dropItem()` says why rather than doing nothing, because a message that
        // is quietly ignored looks like a dropped packet.
        if (type === ServerMsg.PLAYER_DROP_ITEM) {
            playerState.dropItem();
        }

        // PLAYER_BUY_ITEM and PLAYER_SELL_ITEM used to be handled here, and are
        // deliberately not any more. Trading happens between the player's wallet
        // and the shop's account, so a room message that handed over an item or
        // credited gold would be a second, forgeable way to do the one thing this
        // server must not be able to do (SPEC §8).

        /////////////////////////////////////
        // on player equip
        //
        // `data.index` is a slot in `player_data.inventory`, which is now the set
        // of items a proven wallet was checked against rather than a copy of
        // `character_inventory` — so it is empty, and this resolves to nothing.
        // The index is the part that has to change: what the wallet holds is
        // keyed by item, and a slot number is a database row's shape (issue #6).
        if (type === ServerMsg.PLAYER_USE_ITEM) {
            const index = data.index;
            const item = playerState.getInventoryItemByIndex(index);
            if (item) {
                if (item.class === ItemClass.CONSUMABLE) {
                    playerState.consumeItem(item);
                } else if (item.equippable) {
                    playerState.equipItem(item);
                }
            } else {
                playerState.say(
                    "Equipping and using items off the chain is not built yet. What you own is in the bag and can be sold to the vendor or listed in the auction house."
                );
            }
        }

        /////////////////////////////////////
        // on player unequip
        if (type === ServerMsg.PLAYER_UNEQUIP_ITEM) {
            const key = data.key;
            const item = this.gameData.get("item", key);
            // does item exist in database
            if (item) {
                playerState.unequipItem(item.key, item.slot);
            }
        }

        /////////////////////////////////////
        // on player unequip
        if (type === ServerMsg.PLAYER_QUEST_UPDATE) {
            playerState.dynamicCTRL.questUpdate(data);
        }

        /////////////////////////////////////
        // player entity_attack
        if (type === ServerMsg.PLAYER_HOTBAR_ACTIVATED) {
            // get players involved
            let targetState = this.getEntity(data.targetId) as Entity;
            let hotbarData = playerState.player_data.hotbar.get("" + data.digit);

            Logger.warning(`[ServerMsg.PLAYER_HOTBAR_ACTIVATED]`, data.digit);

            // Digit 6 used to drop a random item from the catalogue at the
            // sender's feet, before the hotbar was even looked at. A ground item
            // is what `pickupItem()` mints from, so that made a room message the
            // client controls into the first half of an issuer call: send it,
            // walk two paces, repeat. It is an ordinary hotbar slot again, and
            // the only thing that puts loot on the ground is a mob dying
            // (issue #10).

            if (!hotbarData) {
                return false;
            }

            // if item
            if (hotbarData && hotbarData.type === "item") {
                const item = playerState.getInventoryItem(hotbarData.key, "key");
                if (item && item.class === ItemClass.CONSUMABLE) {
                    playerState.consumeItem(item);
                }
                return false;
            }

            // if ability
            if (hotbarData && hotbarData.type === "ability") {
                playerState.abilitiesCTRL.addAbility(playerState, targetState, data);
                return false;
            }
        }

        /////////
        /////// DEBUG /////////////////

        // DEBUG_BOTS and DEBUG_REMOVE_ENTITIES were handled here, in every
        // build, with no check of any kind. Neither minted, but the first
        // appended a hundred spawn definitions to this location's game data on
        // every press and nothing ever took them out again, and the second
        // deleted every non-player entity in the room — which includes loot the
        // server had authored for somebody else to walk into, so a client could
        // destroy a reward it did not own. Both are gone; their enum values stay
        // because the numbering is the wire format (issue #10).
    }
}
