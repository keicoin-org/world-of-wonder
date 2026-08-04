import { Client } from "@colyseus/core";
import { Schema, MapSchema, type, filter } from "@colyseus/schema";
import { abilitiesCTRL } from "../controllers/abilityCTRL";
import { animationCTRL } from "../controllers/animationCTRL";
import { moveCTRL } from "../controllers/moveCTRL";
import { dynamicCTRL } from "../controllers/dynamicCTRL";
import { statsCTRL } from "../controllers/statsCTRL";
import { NavMesh, Vector3 } from "../../../shared/Libs/yuka-min";
import { InventorySchema, EquipmentSchema, AbilitySchema, LootSchema, BrainSchema, QuestSchema, HotbarSchema } from "../schema";
import { GameRoomState } from "../state/GameRoomState";
import { Entity } from "../schema/Entity";
import { EntityState, ItemClass, CalculationTypes, ServerMsg } from "../../../shared/types";
import { Database } from "../../Database";
import Logger from "../../utils/Logger";
import { EMPTY_LEGACY, type LegacyRecord } from "../../kei/Legacy";
import { NO_AUTHORITY_REASON, inventoryAuthority } from "../../kei/Inventory";

export class PlayerData extends Schema {
    /**
     * The working set of items this session has been authorized to act on.
     *
     * It is not the bag. The bag is `wallet.inventory` in the browser, read off
     * the chain, and it is the only place a player's items exist. What belongs
     * here is the subset a proven wallet was checked against so the room can
     * equip or consume it — which is nothing today, because nothing can prove a
     * wallet yet (`kei/Inventory.ts`). The database no longer fills it.
     */
    @type({ map: InventorySchema }) inventory = new MapSchema<InventorySchema>();
    @type({ map: AbilitySchema }) abilities = new MapSchema<AbilitySchema>();
    @type({ map: QuestSchema }) quests = new MapSchema<QuestSchema>();
    @type({ map: HotbarSchema }) hotbar = new MapSchema<HotbarSchema>();
    // `gold` was here, a uint32 the room added to and the database saved. It is
    // gone rather than zeroed: the purse is `balanceOf` on the chain and the
    // client reads it there, so a second number on the wire could only ever
    // disagree with it (issue #6).
    @type("uint8") public strength: number = 0;
    @type("uint8") public endurance: number = 0;
    @type("uint8") public agility: number = 0;
    @type("uint8") public intelligence: number = 0;
    @type("uint8") public wisdom: number = 0;
    @type("uint32") public experience: number = 0;
    @type("uint32") public points: number = 5;
    @type("uint32") public ac: number = 0;
}

export class PlayerSchema extends Entity {
    /////////////////////////////////////////////////////////////
    // the below will be synced to all the players
    @type("number") public x: number = 0;
    @type("number") public y: number = 0;
    @type("number") public z: number = 0;
    @type("number") public rot: number = 0;

    @type("int16") public health: number = 0;
    @type("int16") public maxHealth: number = 0;
    @type("int16") public mana: number = 0;
    @type("int16") public maxMana: number = 0;
    @type("uint8") public level: number = 0;

    @type("string") public name: string = "";
    @type("string") public type: string = "player";
    @type("string") public race: string = "male_knight";
    @type("string") public head: string = "Head_Base";
    @type("int8") public material: number = 0;

    @type("string") public location: string = "";
    @type("number") public sequence: number = 0; // latest input sequence
    @type("boolean") public blocked: boolean = false; // if true, used to block player and to prevent movement
    @type("int8") public anim_state: EntityState = EntityState.IDLE;

    @type({ map: EquipmentSchema }) equipment = new MapSchema<EquipmentSchema>();

    ////////////////////////////////////////////////////////////////////////////
    // the below data only need to synchronized to the player it belongs too
    // player data
    @filter(function (this: PlayerSchema, client: Client) {
        return this.sessionId === client.sessionId;
    })
    @type(PlayerData)
    player_data: PlayerData = new PlayerData();

    /////////////////////////////////////////////////////////////
    // does not need to be synced
    public id: number = 0;
    public manaRegen: number = 0;
    public healthRegen: number = 0;
    public speed: number = 0;
    public experienceGain: number = 0;
    public gracePeriod: boolean = true;
    public attackTimer;
    public isMoving: boolean = false;
    public isDead: boolean = false;
    public isTeleporting: boolean = false;
    public isInteracting;
    public interactingStep: number = 0;
    public interactingTarget: BrainSchema;

    // controllers
    public _navMesh: NavMesh;
    public _state: GameRoomState;
    public client;
    public abilitiesCTRL: abilitiesCTRL;
    public moveCTRL: moveCTRL;
    public animationCTRL: animationCTRL;
    public dynamicCTRL: dynamicCTRL;
    public statsCTRL: statsCTRL;

    // TIMER
    public spawnTimer: number = 0;
    public regenTimer: number = 5000;
    public regenTimerElapsed: number = 0;

    ////////////////////////////
    public AI_TARGET = null; // AI_TARGET will always represent an entity
    public AI_TARGET_POSITION = null;
    public AI_TARGET_DISTANCE = null;
    public AI_TARGET_WAYPOINTS = [];
    public AI_ABILITY = null;
    public AI_TARGET_FOUND = false;
    public AI_TARGET_ATTACK_SPOTS;

    // inventory
    public INVENTORY_LENGTH = 25;

    /** What the old tables still hold for this character. Never acted on. */
    public legacy: LegacyRecord = EMPTY_LEGACY;

    constructor(state: GameRoomState, data) {
        super();
        //
        this._navMesh = state.navMesh;
        this._state = state;
        this.client = this.getClient();
        this.isTeleporting = false;

        // add default race data
        Object.assign(this, this._state.gameData.get("race", data.race));

        // add spawn data
        Object.assign(this, data);

        // add default player data (from DB)
        Object.entries(data.initial_player_data).forEach(([k, v]) => {
            this.player_data[k] = v;
        });

        // initalize stats
        this.statsCTRL = new statsCTRL(this);

        // add abilities
        console.log(data.initial_abilities);
        data.initial_abilities.forEach((element) => {
            this.player_data.abilities.set(element.key, new AbilitySchema(element));
        });

        // add equipment
        data.initial_equipment.forEach((element) => {
            this.equipment.set(element.key, new EquipmentSchema(element, this));
        });

        // add quests
        data.initial_quests.forEach((element) => {
            this.player_data.quests.set(element.key, new QuestSchema(element));
        });

        // add hotbar
        data.initial_hotbar.forEach((element) => {
            this.player_data.hotbar.set(element.digit, new HotbarSchema(element));
        });

        // add inventory items
        let i = 0;
        data.initial_inventory.forEach((element) => {
            element.i = "" + i;
            this.player_data.inventory.set("" + i, new InventorySchema(element));
            i++;
        });

        // set controllers
        this.abilitiesCTRL = new abilitiesCTRL(this);
        this.moveCTRL = new moveCTRL(this);
        this.animationCTRL = new animationCTRL(this);
        this.dynamicCTRL = new dynamicCTRL(this);

        //
        this.start();
    }

    // on player state initialized
    start() {
        // add a 5 second grace period where the player can not be targeted by the ennemies
        setTimeout(() => {
            this.gracePeriod = false;
        }, this._state.config.PLAYER_GRACE_PERIOD);
    }

    // runs on every server iteration
    update() {
        // always check if player is dead ??
        if (this.isEntityDead() && !this.isDead) {
            //this.setAsDead();
        }

        // if not dead
        if (this.isDead === true) {
            // if player is dead make sure player animation is EntityState.DEAD
            if (this.anim_state !== EntityState.DEAD) {
                this.anim_state = EntityState.DEAD;
            }
            return false;
        }

        // regen timer 5seconds
        this.regenTimerElapsed += this._state.config.updateRate;
        if (this.regenTimerElapsed >= this.regenTimer) {
            // continuously gain mana
            if (this.mana < this.maxMana) {
                this.mana += this.manaRegen;
            }
            // continuously gain health
            if (this.health < this.maxHealth) {
                this.health += this.healthRegen;
            }
            this.regenTimerElapsed = 0;
        }

        // update dynamic stuuf
        this.dynamicCTRL.update();

        // move player
        this.moveCTRL.update();
    }

    public getClient() {
        return this._state._gameroom.clients.getById(this.sessionId);
    }

    save(db: Database) {
        let client = this.getClient();
        let character = client.auth;

        // update character
        db.updateCharacter(client.auth.id, this);

        // `saveItems()` and `saveEquipment()` used to be called here, and are
        // deliberately not any more. Both delete every row a character has and
        // re-insert what the room is holding, so calling them from a session that
        // starts with an empty bag would erase `character_inventory` and
        // `character_equipment` on the first autosave — turning a boundary that
        // ignores those rows into one that destroys them. They are preserved
        // untouched instead, for a migration that can prove who to give them to
        // (issue #6, `kei/Legacy.ts`).

        // update player abilities
        db.saveAbilities(character.id, this.player_data.abilities);

        // update player quests
        db.saveQuests(character.id, this.player_data.quests);

        // update player hotbar
        db.saveHotbar(character.id, this.player_data.hotbar);

        // log
        Logger.info("[gameroom][onCreate] player " + this.name + " saved to database.");
    }

    /**
     * Calculate rotation based on moving from v1 to v2
     * @param {Vector3} v1
     * @param {Vector3} v2
     * @returns rotation in radians
     */
    rotateTowards(v1: Vector3, v2: Vector3): number {
        return Math.atan2(v1.x - v2.x, v1.z - v2.z);
    }

    //////////////////////////////////////////////
    /////////////// HOTBAR ///////////////////////
    //////////////////////////////////////////////

    findNextAvailableHotbarSlot(): number | boolean {
        if (this.player_data.hotbar.size > 0) {
            for (let i = 1; i <= this._state.config.PLAYER_HOTBAR_SIZE; i++) {
                if (!this.player_data.hotbar.get("" + i)) {
                    return i;
                }
            }
            return false;
        }
        return 1;
    }

    //////////////////////////////////////////////
    /////////////// INVENTORY ////////////////////
    //////////////////////////////////////////////

    getInventoryItem(value, key = "index"): InventorySchema {
        let found;
        this.player_data.inventory.forEach((el, k) => {
            if (key === "index" && k === value) {
                found = el;
            } else if (key === "key" && el.key === value) {
                found = el;
            }
        });
        return found;
    }

    getInventoryItemByIndex(value): InventorySchema {
        return this.player_data.inventory.get("" + value);
    }

    isEquipementSlotAvailable(slot) {
        let available = true;
        this.equipment.forEach((item) => {
            if (item.slot === slot) {
                available = false;
            }
        });
        return available;
    }

    reduceItemQuantity(inventoryItem, amount = 1) {
        let quantity = inventoryItem.qty - amount;
        if (quantity < 1) {
            this.player_data.inventory.delete("" + inventoryItem.i);
        } else {
            inventoryItem.qty -= 1;
        }
    }

    /**
     * Put something on the ground, which this slice will not do.
     *
     * Dropping used to be "remove the row, add a loot entity", and both halves
     * were the server's to decide. Now the ground is a place the server mints
     * from — `pickupItem()` pays whoever walks into it — while the item itself
     * never left the dropper's wallet, so the old body would have made one unit
     * into two. Doing it properly means the player signing the item away, which
     * is a wallet action and not a room message.
     */
    dropItem() {
        this.say(
            "Dropping an item is not built yet: it lives in your wallet, so the room cannot put it on the ground without making a second one. Sell it to the vendor or list it in the auction house.",
        );
        return false;
    }

    // buyItem() and sellItem() lived here and were the whole economy: an item
    // appeared because this method said so, and gold moved because it did the
    // arithmetic. Both are on the chain now (src/server/kei/Economy.ts), where
    // the player signs for their own side and this server cannot.

    /**
     * Take something off the ground, which is now a mint rather than a row.
     *
     * The loot entity was authored by this server — a mob's drop table, or a
     * quest reward — so paying for it is a legitimate thing for the server to
     * sign (SPEC §8). What it cannot do is decide whose wallet to pay, so a
     * character with no proven address picks nothing up and the loot stays where
     * it is. The old body added an `InventorySchema` to `player_data.inventory`
     * and that was the whole of "you own this" (issue #6).
     */
    pickupItem(loot: LootSchema) {
        // play animation // disabled
        //this.animationCTRL.playAnim(this, EntityState.PICKUP, () => {});

        // Provenance before anything else. A loot entity is only payable if a
        // server-authored gameplay event put it there, and `source` is where that
        // event names itself — so an entity that arrived some other way is left
        // on the ground rather than minted (issue #10). Today the only thing that
        // sets it is `dropCTRL.dropItems()`.
        if (!loot.source) {
            Logger.warning(`[pickupItem] ${loot.key} (${loot.sessionId}) has no server-authored provenance and was not paid for`);
            this.say("That was not put there by anything this world did, so it is not yours to pick up.");
            return false;
        }

        const authority = inventoryAuthority();
        if (!authority) {
            this.say(NO_AUTHORITY_REASON);
            return false;
        }

        // Checked before the entity is removed, and synchronously, so a refusal
        // cannot lose the drop. Whether there is a bound wallet is a local fact;
        // only what it holds needs the chain.
        if (!authority.addressOf(this.id)) {
            this.say(`You cannot pick up ${loot.key.replace(/_/g, " ")} yet. ` + NO_AUTHORITY_REASON);
            return false;
        }

        // The provenance is the idempotency key, not the entity's session id. A
        // session id is fresh per object, so it made "how many entities exist"
        // into "how many payments happen" — which is exactly the lever the debug
        // spawner pulled. Keyed by the death and the drop slot instead, a second
        // entity for the same drop pays nothing however it came to exist.
        const reward = { id: `loot:${loot.source}`, items: [{ key: loot.key, qty: loot.qty }] };

        if (this._state.entities.get(loot.sessionId)) {
            this._state.entities.delete(loot.sessionId);
        }

        void authority
            .pay(this.id, reward)
            .then((result) => {
                if ("paid" in result) {
                    this.say(`Picked up ${loot.qty} × ${loot.key.replace(/_/g, " ")}. It is on the chain now.`);
                } else {
                    Logger.warning(`[pickupItem] ${loot.key} refused: ${result.code}`);
                    this.say(result.reason);
                }
            })
            // Detached, so an unhandled rejection would take the process down.
            // The entity is already gone by here, so a failed mint loses the
            // drop — which is the safe direction, and the reason the reward id
            // is the entity's: a retry later would still pay exactly once.
            .catch((error) => {
                Logger.error(`[pickupItem] paying for ${loot.key} failed`, error);
                this.say("That could not be picked up just now. Nothing was minted.");
            });

        // stop chasing target
        this.AI_TARGET = null;
    }

    /** One line to the player who caused this, in the chat notifications. */
    public say(message: string) {
        const client = this.getClient();
        if (!client) return;
        client.send(ServerMsg.SERVER_MESSAGE, { type: "event", message, date: new Date() });
    }

    consumeItem(item) {
        // process
        for (let stat in item.statModifiers) {
            item.statModifiers[stat].forEach((modifier) => {
                if (CalculationTypes.ADD === modifier.type) {
                    this[stat] += modifier.value;
                }
                if (CalculationTypes.REMOVE === modifier.type) {
                    this[stat] -= modifier.value;
                }
            });
        }

        // reduce item quantity
        this.reduceItemQuantity(item, 1);

        // make sure not stats are out of bounds
        this.normalizeStats();
    }

    equipItem(item) {
        if (item.class !== ItemClass.ARMOR && item.class !== ItemClass.WEAPON) {
            console.log("this item class cannot be equipped", item);
            return false;
        }

        // make sure item is equipable
        if (!item.equippable) {
            console.log("item cannot be equipped", item);
            return false;
        }

        let slot = item.equippable.slot;
        let key = item.key;

        // if can equip
        if (this.canEquip(item, slot)) {
            // remove from inventory
            this.reduceItemQuantity(item, 1);

            // equip
            this.equipment.set(key, new EquipmentSchema({ key: key, slot: slot }, this));
        }
    }

    /**
     * Take something off.
     *
     * Two changes from upstream, both because equipment is now a reference to an
     * asset rather than the asset itself.
     *
     * It refuses when the player is not wearing the thing. `PLAYER_UNEQUIP_ITEM`
     * carries an item key and the handler only checked that the key exists in the
     * game data, so unequipping something you never had was a message anybody
     * could send — and the old body ended by putting a fresh copy of it in the
     * bag. That was a way to ask the server for an item.
     *
     * And nothing is created by taking something off. The unit is in the player's
     * wallet the whole time it is worn; this map is only the room's note of which
     * one is in which slot, so removing the note moves nothing.
     */
    unequipItem(key, slot) {
        if (!this.equipment.get(key)) {
            return false;
        }

        // remove item from equipment
        this.equipment.delete(key);

        this.statsCTRL.unequipItem(this._state.gameData.get("item", key));
    }

    canEquip(item, slot) {
        return item && item.qty > 0 && this.isEquipementSlotAvailable(slot) === true;
    }

    ///////////////////////////////////////////////
    ///////////////////////////////////////////////
    ///////////////////////////////////////////////

    setAsDead() {
        this.AI_TARGET = null;
        this.AI_ABILITY = null;
        this.isDead = true;
        this.health = 0;
        this.blocked = true;
        this.anim_state = EntityState.DEAD;
        console.log("setAsDead", "SET AS DEAD", this.sessionId);
    }

    resetPosition() {
        this.x = 6.3;
        this.y = 0;
        this.z = -23.5;
        this.rot = 3.13;
        this.ressurect();
    }

    ressurect() {
        this.isDead = false;
        this.health = this.maxHealth;
        this.mana = this.maxMana;
        this.blocked = false;
        this.gracePeriod = true;
        this.anim_state = EntityState.IDLE;
        setTimeout(() => {
            this.gracePeriod = false;
        }, this._state.config.PLAYER_GRACE_PERIOD);
    }

    /**
     * is entity dead (isDead is there to prevent setting a player as dead multiple time)
     * @returns true if health smaller than 0 and not already set as dead.
     */
    isEntityDead() {
        return this.health <= 0;
    }

    // make sure no value are out of range
    normalizeStats() {
        // health
        if (this.health > this.maxHealth) {
            this.health = this.maxHealth;
        }
        if (this.health < 0) {
            this.health = 0;
        }

        // mana
        if (this.mana > this.maxMana) {
            this.mana = this.maxMana;
        }
        if (this.mana < 0) {
            this.mana = 0;
        }
    }

    getPosition() {
        return new Vector3(this.x, this.y, this.z);
    }

    hasTarget() {
        return this.AI_TARGET ?? false;
    }

    setTarget(target) {
        this.AI_TARGET = target;
    }

    monitorTarget() {
        if (this.AI_TARGET !== null && this.AI_TARGET !== undefined) {
            let targetPos = this.AI_TARGET.getPosition();
            let entityPos = this.getPosition();
            let distanceBetween = entityPos.distanceTo(targetPos);
            this.AI_TARGET_POSITION = targetPos;
            this.AI_TARGET_DISTANCE = distanceBetween;
        }
    }
}
