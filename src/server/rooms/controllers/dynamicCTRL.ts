import { Leveling } from "../../../shared/Class/Leveling";
import { QuestsHelper } from "../../../shared/Class/QuestsHelper";
import { Quest, QuestObjective, QuestStatus, QuestUpdate, ServerMsg } from "../../../shared/types";
import { BrainSchema, PlayerSchema, QuestSchema } from "../schema";
import { GameRoomState } from "../state/GameRoomState";
import { inventoryAuthority } from "../../kei/Inventory";
import Logger from "../../utils/Logger";

export class dynamicCTRL {
    private _state: GameRoomState;
    private _player: PlayerSchema;
    private _dynamic;

    constructor(player) {
        this._player = player;
        this._state = player._state;
    }

    public update() {
        //
        let interactive = this._state.roomDetails.dynamic.interactive ?? [];
        if (interactive.length > 0) {
            let currentPos = this._player.getPosition();
            interactive.forEach((element) => {
                let distanceTo = currentPos.distanceTo(element.from);

                if (distanceTo < 2) {
                    if (element.type === "teleport") {
                        this._player.x = element.to_vector.x;
                        this._player.y = element.to_vector.y;
                        this._player.z = element.to_vector.z;
                    }

                    if (element.type == "zone_change" && this._player.isTeleporting === false) {
                        this._player.isTeleporting = true;

                        let client = this._state._gameroom.clients.getById(this._player.sessionId);

                        // update player location in database
                        this._player.location = element.to_map;
                        this._player.x = element.to_vector.x;
                        this._player.y = element.to_vector.y;
                        this._player.z = element.to_vector.z;
                        this._player.rot = 0;

                        // save player before leaving
                        const playerState: PlayerSchema = this._state.getEntity(client.sessionId) as PlayerSchema;
                        playerState.save(this._state._gameroom.database);

                        // inform client he cand now teleport to new zone
                        client.send(ServerMsg.PLAYER_TELEPORT, element.to_map);
                    }
                }
            });
        }
    }

    ////////////////////////////////
    //////////// QUESTS /////////////
    ////////////////////////////////

    // check quest update
    // note: currently called from abilityCtrl when a entity dies
    checkQuestUpdate(type, target: BrainSchema) {
        //
        if (type === "kill" && target.AI_SPAWN_INFO) {
            this._player.player_data.quests.forEach((element: QuestSchema) => {
                if (element.type === QuestObjective.KILL_AMOUNT && element.spawn_key === target.AI_SPAWN_INFO.key) {
                    element.qty++;
                }
            });
        }
    }

    // Issue #12 read this as a dead gate: `quests` is a MapSchema and this
    // indexed it with brackets, which by the declared type is `undefined` and
    // would have put every quest reward below out of reach. It was not dead.
    // `@colyseus/schema` installs a Proxy in the decorated field's setter that
    // forwards an unknown property to `.get()`, so the brackets resolved. The
    // cycle is driven end to end in `dynamicCTRL.test.ts` now, which is what
    // settled the question.
    //
    // `.get()` regardless: it is what the type offers, what the rest of this
    // file uses, and it does not depend on a dependency's internals. The rule
    // itself sits next to the client's copy of it, because the two have to
    // agree on when a quest can be handed in.
    isQuestReadyToComplete(quest: Quest) {
        return QuestsHelper.isReadyToComplete(quest, QuestsHelper.progress(this._player.player_data.quests, quest.key));
    }

    questUpdate(data: QuestUpdate) {
        let quest = this._state.gameData.get("quest", data.key) as Quest;

        if (!quest) {
            return false;
        }

        if (data.status === QuestStatus.OBJECTIVE_UPDATE) {
        }

        if (data.status === QuestStatus.ACCEPTED) {
            this._player.player_data.quests.set(quest.key, new QuestSchema(quest));
        }

        if (data.status === QuestStatus.READY_TO_COMPLETE) {
            // check is quest in complete
            if (!this.isQuestReadyToComplete(quest)) return false;

            // Looked up by the key the server resolved, not the one the message
            // carried, for the same reason the rewards are. `isQuestReadyToComplete`
            // has already established this is present.
            let playerQuest = this._player.player_data.quests.get(quest.key);

            // experience
            let experienceReward = quest.rewards.experience ?? 0;
            if (experienceReward) {
                Leveling.addExperience(this._player, experienceReward);
            }

            // Marked complete before the payment is attempted, and marked from
            // the quest the server looked up rather than from `data`. What a
            // client sends is a key and a status; the rewards, the quantities and
            // the account they are paid to all come from this side. The character
            // and quest key are the idempotency key, so completing it twice —
            // across a reconnect, a restart, or two messages in the same tick —
            // pays once (issue #6).
            playerQuest.status = 1;

            const gold = quest.rewards.gold ?? 0;
            const items = (quest.rewards.items ?? []).map((item: any) => ({ key: item.key, qty: item.qty ?? 1 }));
            if (gold === 0 && items.length === 0) {
                return;
            }

            const authority = inventoryAuthority();
            if (!authority) {
                return;
            }

            void authority
                .pay(this._player.id, { id: `quest:${this._player.id}:${quest.key}`, gold, items })
                .then((result) => {
                    if ("paid" in result) {
                        this._player.say(`${quest.title ?? quest.key} paid out. It is on the chain now.`);
                    } else if (result.code !== "already-paid") {
                        this._player.say(`${quest.title ?? quest.key} could not pay out. ${result.reason}`);
                    }
                })
                // Detached, so an unhandled rejection here would end the process
                // rather than the quest. The quest stays marked complete and
                // unpaid, which is the direction this file errs in deliberately.
                .catch((error) => {
                    Logger.error(`[dynamicCTRL] paying quest ${quest.key} failed`, error);
                    this._player.say(`${quest.title ?? quest.key} could not pay out. Nothing was minted.`);
                });
        }
    }
}
