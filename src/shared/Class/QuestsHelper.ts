import { QuestObjective } from "../types";

/**
 * How far along a quest a player is, as the room tracks it.
 *
 * Structurally this is `QuestSchema`, but that class lives on the server and
 * the browser gets an equivalent built by the decoder, so the rule below is
 * written against the three fields both of them have.
 */
export type QuestProgress = {
    key: string;
    /** 0 while it is being worked on, 1 once it has been handed in. */
    status: number;
    qty: number;
};

export class QuestsHelper {
    public static findQuestTargetName(location, targetName, quantity): string {
        let spawns = location.dynamic.spawns ?? [];
        let found = "";
        spawns.forEach((element) => {
            if (element.key === targetName) {
                found = element.name;
            }
        });
        if (quantity > 1) {
            found += "s";
        }
        return found;
    }

    /**
     * A player's progress on one quest, or `undefined` if they never took it.
     *
     * `player_data.quests` is a `MapSchema` — a `Map`, not an object — on both
     * sides of the wire. `quests[key]` compiles, because `strict` is off in
     * this repo, and evaluates to `undefined` forever. That is what made every
     * quest in the game impossible to hand in and impossible to see the
     * progress of (issue #12). Four call sites had it; they now share this one.
     */
    public static progress(quests, key: string): QuestProgress | undefined {
        if (!quests || !key) {
            return undefined;
        }
        return quests.get(key);
    }

    /**
     * Whether a quest can be handed in right now.
     *
     * The server pays out on this and the client draws the hand-in dialog on
     * it, so the two used to be the same twelve lines written twice — and both
     * copies were broken in the same way. One copy, one bug, one fix.
     *
     * `quest` is the definition out of `QuestsDB`; `progress` is what the
     * player has done. A quest already handed in (`status` 1) is not ready
     * again, which is what stops a second hand-in paying twice.
     */
    public static isReadyToComplete(quest, progress: QuestProgress | undefined): boolean {
        if (!quest || !progress) {
            return false;
        }
        if (quest.type !== QuestObjective.KILL_AMOUNT) {
            return false;
        }
        return progress.qty >= quest.quantity && progress.status === 0;
    }
}
