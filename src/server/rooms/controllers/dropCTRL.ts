import Logger from "../../utils/Logger";
import { Leveling } from "../../../shared/Class/Leveling";
import { randomNumberInRange } from "../../../shared/Utils";
import { GetLoot } from "../../../shared/Class/LootTable";
import { nanoid } from "nanoid";
import { LootSchema } from "../schema/LootSchema";
import { PlayerSchema } from "../schema";
import { ServerMsg } from "../../../shared/types";
import { inventoryAuthority } from "../../kei/Inventory";

export class dropCTRL {
    private _owner: PlayerSchema;
    private _client;

    constructor(owner, client) {
        this._owner = owner;
        this._client = client;
    }

    public addExperience(target) {
        // calculate experience total
        let exp = target.experienceGain;
        if (target.AI_SPAWN_INFO && target.AI_SPAWN_INFO.experienceGain) {
            exp = target.AI_SPAWN_INFO.experienceGain;
        }
        let amount = Math.floor(randomNumberInRange(exp.min, exp.max));
        Leveling.addExperience(this._owner, amount);
        console.log("[addExperience]", amount);
    }

    /**
     * Pay for a kill, which is a mint the issuer signs rather than an addition.
     *
     * The amount is rolled here and never read off a client message, and the
     * account it is paid to is the one this character has proved it holds the key
     * to — not an address a client sent. `target.sessionId` makes the payment
     * idempotent, so the same corpse pays once however many times this is
     * reached.
     *
     * Nothing is paid at all today, because nothing can prove a wallet yet
     * (`kei/Inventory.ts`), and the refusal is said out loud rather than swallowed
     * — a player whose kills silently stopped paying would think the game was
     * broken instead of unfinished.
     */
    public addGold(target) {
        let goldGains = target.goldGain;
        if (target.AI_SPAWN_INFO && target.AI_SPAWN_INFO.goldGain) {
            goldGains = target.AI_SPAWN_INFO.goldGain;
        }
        if (!goldGains || !goldGains.min || !goldGains.max) {
            return;
        }

        const gold = Math.floor(randomNumberInRange(goldGains.min, goldGains.max));
        const authority = inventoryAuthority();

        if (!authority) {
            Logger.warning("[gameroom][addGold] no inventory authority configured, so nothing was paid");
            return;
        }

        void authority
            .pay(this._owner.id, { id: `kill:${target.sessionId}`, gold })
            .then((result) => {
                const message =
                    "paid" in result
                        ? `You pick up ${gold} gold. It is on the chain now.`
                        : `You would have picked up ${gold} gold. ${result.reason}`;
                if (!("paid" in result)) {
                    Logger.warning(`[gameroom][addGold] ${gold} gold refused: ${result.code}`);
                }
                this._client.send(ServerMsg.SERVER_MESSAGE, { type: "event", message, date: new Date() });
            })
            // A mint is a chain round trip and a chain round trip can fail. This
            // is a detached promise, so without a handler the rejection reaches
            // Node's default and takes the whole game server down over one mob.
            .catch((error) => {
                Logger.error(`[gameroom][addGold] paying ${gold} gold failed`, error);
                this._owner.say("Your gold could not be paid out just now. Nothing was taken from you.");
            });
    }

    /**
     * Roll a dead mob's drop table and put the result on the ground.
     *
     * This is the only thing in the server that creates a loot entity, and after
     * issue #10 it is meant to stay the only one. Each drop is stamped with the
     * death that produced it, because walking into one of these mints it: the
     * ground is where a server-authored reward waits to be claimed, so an entity
     * that cannot say which gameplay event authored it is one `pickupItem()`
     * refuses to pay for.
     *
     * The keys come from `target.AI_SPAWN_INFO.drops`, which is server game data,
     * and the quantities from `GetLoot`. Neither is reachable from a client
     * message.
     */
    public dropItems(target) {
        let items = target.AI_SPAWN_INFO.drops ?? [];
        let loot = GetLoot(items);
        loot.forEach((drop, index) => {
            // drop item on the ground
            let sessionId = nanoid(10);
            let currentPosition = target.getPosition();
            currentPosition.x += randomNumberInRange(-2, 2);
            currentPosition.z += randomNumberInRange(-2, 2);
            let data = {
                key: drop.id,
                name: "Apple",
                sessionId: sessionId,
                x: currentPosition.x,
                y: 0.25,
                z: currentPosition.z,
                qty: drop.quantity,
                // The corpse and which drop of it this is. Stable across a
                // restart of this loop, so the same death cannot be rolled into
                // two payable entities for the same slot.
                source: `kill:${target.sessionId}:${index}`,
            };
            let entity = new LootSchema(this._owner._state, data);
            this._owner._state.entities.set(sessionId, entity);
        });
    }
}
