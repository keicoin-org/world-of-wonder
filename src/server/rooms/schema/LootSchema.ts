import { type } from "@colyseus/schema";
import { Entity } from "./Entity";
import { Vector3 } from "../../../shared/Libs/yuka-min";
import { GameRoomState } from "../state/GameRoomState";

export class LootSchema extends Entity {
    // networked player specific
    @type("string") public type: string = "item";
    @type("number") public x: number = 0;
    @type("number") public y: number = 0;
    @type("number") public z: number = 0;
    @type("number") public rot: number = 0;
    @type("string") public key: string = "";
    @type("int16") public qty: number = 0;

    public spawnTimer: number = 0;
    public name: string = "";
    public description: string = "";

    /**
     * Which server-authored event put this on the ground.
     *
     * Not networked, and not from anything a client sent. Picking loot up mints
     * it, so the question "may this become a mint" needs an answer that lives on
     * the entity rather than in the memory of whoever created it — otherwise a
     * loot entity is just an object with a key and a quantity, and any code path
     * that can make one of those can spend the issuer's signature (issue #10).
     *
     * `dropCTRL` sets it to the death it rolled the drop table for.
     * `pickupItem()` refuses anything without it, so the default being empty is
     * the safe answer to "somebody added a third way to spawn loot".
     */
    public source: string = "";

    public AI_TARGET;

    public _state: GameRoomState;

    constructor(state, data, ...args: any[]) {
        super();
        // assign data
        Object.assign(this, data);
        Object.assign(this, state.gameData.get("item", this.key));

        // Last, and on its own: the two assignments above copy whole objects,
        // and the item data is loaded from JSON on disk. An `items.json` that
        // happened to carry a `source` field would otherwise decide provenance
        // for every drop of that archetype.
        this.source = typeof data.source === "string" ? data.source : "";
    }

    // entity update
    public update(delta) {
        this.spawnTimer += delta;
    }

    getPosition() {
        return new Vector3(this.x, this.y, this.z);
    }
}
