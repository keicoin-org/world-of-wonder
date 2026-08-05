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
     * `player_data.quests` is a `MapSchema`, and the four call sites that used
     * to do this read it as `quests[key]`. That works — `@colyseus/schema`
     * installs a `Proxy` in the decorated field's setter that forwards an
     * unknown property to `.get()` — but it works by accident of a dependency's
     * internals rather than by anything the type says, and it only type-checks
     * because `strict` is off. `MapSchema` declares `get()`; use it.
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
     * The server pays out on this and the client decides whether to draw a
     * hand-in button on it, so it was the same rule written twice. If the
     * client's copy ever says yes where the server's says no, the player gets
     * a button that silently does nothing.
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
