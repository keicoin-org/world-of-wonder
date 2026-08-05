import { BrainSchema } from "../schema";
import { GameRoom } from "../GameRoom";
import { EntityState, Speed } from "../../../shared/types";
import { nanoid } from "nanoid";
import Logger from "../../utils/Logger";
import { randomNumberInRange } from "../../../shared/Utils";
import { GameRoomState } from "../state/GameRoomState";

export class spawnCTRL {
    private _state: GameRoomState;
    private _room: GameRoom;
    public location;
    private spawnsAmount = [];
    private SPAWN_RATE = 10;
    private SPAWN_INTERVAL = 300;
    private SPAWN_CURRENT = 0;

    constructor(state: GameRoomState) {
        this._state = state;
        this._room = state._gameroom;
        this.location = this._state.gameData.get("location", this._room.metadata.location);

        //
        this.process();
    }

    public update(delta) {
        this.SPAWN_CURRENT += delta;

        // spawn every SPAWN_INTERVAL
        if (this.SPAWN_CURRENT >= this.SPAWN_INTERVAL) {
            this.process();
            this.SPAWN_CURRENT = 0;
        }
    }

    public process() {
        //Logger.info("[gameroom][state][spawning] process: " + this.location.key, this.spawnsAmount);
        let dynamic = this.location.dynamic;
        let spawns = dynamic.spawns ?? [];
        spawns.forEach((spawn, index) => {
            // needed later to find spawn details on client???
            // todo: improve
            spawn.index = index;

            // if first spawn, set amount to zero
            if (!this.spawnsAmount[spawn.key]) {
                this.spawnsAmount[spawn.key] = 0;
            }

            // only spawn if more are needed
            if (this.spawnsAmount[spawn.key] < spawn.amount) {
                this.spawn(spawn);
            }
        });
    }

    private spawn(spawn) {
        for (let i = 0; i < this.SPAWN_RATE; i++) {
            if (this.spawnsAmount[spawn.key] < spawn.amount) {
                this.createEntity(spawn);
            }
        }
    }

    // createItem() put a random catalogue item on the ground and had one caller:
    // a hotbar digit any client could send. Loot on the ground is a mint waiting
    // for somebody to walk into it, so the only thing that authors one now is a
    // mob dying, in dropCTRL, off a drop table this server chose (issue #10).
    // debug_bots(), debug_increase() and debug_decrease() went with it.

    public createEntity(spawn) {
        // random id
        let sessionId = nanoid(10);

        // monster pool to chose from
        let raceData = this._state.gameData.get("race", spawn.race);
        let position = spawn.points[Math.floor(Math.random() * spawn.points.length)];

        // replace default stats
        let health = spawn.baseHealth ?? raceData.baseHealth;
        let mana = spawn.baseMana ?? raceData.baseMana;
        let rotation = spawn.rotation ?? randomNumberInRange(0, Math.PI);
        let speed = spawn.baseSpeed ?? Speed.MEDIUM;
        let head = spawn.head ?? "Head_Base";
        let material = spawn.material ?? 0;
        let experienceGain = spawn.experienceGain ?? 0;

        // if randomize
        if (spawn.randomize) {
            let heads = raceData.vat.meshes.head ?? [];
            material = randomNumberInRange(0, 23);
            if (heads.length > 0) {
                head = heads[Math.floor(Math.random() * heads.length)];
            }
        }

        // create entity
        let data = {
            sessionId: sessionId,
            type: "entity",
            race: raceData.key,
            material: material,
            head: head,
            name: spawn.name,
            location: this._room.metadata.location,
            x: position.x ?? 0,
            y: position.y ?? 0,
            z: position.z ?? 0,
            rot: rotation,
            health: health,
            mana: raceData.baseMana,
            maxHealth: health,
            maxMana: 100,
            speed: speed,
            level: 1,
            anim_state: EntityState.IDLE,
            toRegion: false,
            AI_SPAWN_INFO: spawn,
            spawn_id: spawn.index,
            spawn_key: spawn.key,
            experienceGain: experienceGain,
            initial_equipment: spawn.equipment,
        };

        //
        this.spawnsAmount[spawn.key]++;

        // add to manager
        this._state.entityCTRL.add(new BrainSchema(this._state, data));

        // log
        Logger.info("[gameroom][state][createEntity] created new entity " + raceData.key + ": " + sessionId + ":" + mana);
    }

    removeEntity(entity) {
        if (entity.AI_SPAWN_INFO) {
            this.spawnsAmount[entity.AI_SPAWN_INFO.key]--;
        }
        this._state.entities.delete(entity.sessionId);
    }
}
