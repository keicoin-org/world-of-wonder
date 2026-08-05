/**
 * A quest, from accepting it to being paid for it. Run with `npm run test:quests`.
 *
 * This file was written to settle issue #12, which reported that no quest could
 * ever be completed: `isQuestReadyToComplete()` indexed `player_data.quests`
 * with brackets, `quests` is a `MapSchema`, and a `MapSchema` is a `Map`, so the
 * gate in front of every quest reward should have been shut forever.
 *
 * It is not, and the checks below are the evidence. `@colyseus/schema` installs
 * a `Proxy` in the setter of every decorated map field whose `get` trap forwards
 * an unknown property to `.get()` (`lib/annotations.js`, `lib/types/MapSchema.js`),
 * and the decoder assigns through that setter too, so brackets resolve on both
 * sides of the wire. The whole cycle ran on unmodified `main`.
 *
 * The proxy is asserted by name below rather than left implicit, because it is
 * the load-bearing fact and nothing in the repo depended on knowing it. It
 * survives only while class fields are emitted as assignments; `strict` and
 * `useDefineForClassFields` are both off here, which is also what
 * `@colyseus/schema` v2 requires to work at all.
 *
 * What was true is that none of this had a test. Accepting, counting, handing
 * in, being paid, and being paid exactly once were all unexercised.
 *
 * In-process and deterministic. There is no chain: the authority is a list, and
 * what is being checked is what got put on it.
 */

import { openTestRoom } from "../state/TestRoom";
import { BrainSchema, QuestSchema } from "../schema";
import { QuestObjective, QuestStatus, ServerMsg } from "../../../shared/types";
import { QuestsDB } from "../../data/QuestsDB";
import { useInventoryAuthority, type InventoryAuthority } from "../../kei/Inventory";

const CHARACTER = 1;
const ADDRESS = "kei_" + "a".repeat(60);
const BANDITS = "lh_town_bandits";

let failures = 0;

function check(what: string, ok: boolean, detail = ""): void {
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures += 1;
}

////////////////////////////////////////////////////////////////////////////////
// An authority with a bound wallet that mints whatever it is handed, so that a
// reward which does not arrive is this room's fault and not the chain's.

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
        // The same id twice is the thing the room is not supposed to send. It is
        // recorded rather than refused here, so a double payout shows up as two
        // entries instead of being quietly absorbed by the layer under test.
        minted.push({ characterId, reward });
        return { paid: true, address: ADDRESS, gold: reward.gold ?? 0, items: reward.items ?? [] };
    },
} as unknown as InventoryAuthority;

useInventoryAuthority(authority);

/** The mint is detached from the message handler, so it lands a tick later. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

const paidFor = (key: string) => minted.filter((entry) => entry.reward.id === `quest:${CHARACTER}:${key}`);

////////////////////////////////////////////////////////////////////////////////
// The one quest the game actually ships, plus one with an item reward, because
// the shipped one pays only gold and experience and the item branch has never
// run either.

const ERRANDS = QuestsDB.LH_DANGEROUS_ERRANDS_01;

const BOUNTY = {
    key: "TEST_BOUNTY",
    title: "Bandit Bounty",
    description: "",
    objective: "",
    type: QuestObjective.KILL_AMOUNT,
    location: "test_room",
    spawn_key: BANDITS,
    quantity: 2,
    isRepeatable: false,
    // Enough experience to cross the level-2 threshold on top of what the first
    // quest pays, so the level-up branch of `Leveling.addExperience` runs too.
    rewards: { experience: 1000, gold: 0, items: [{ key: "potion_small_red", qty: 3 }] },
};

const { state, client, player } = openTestRoom({
    character: CHARACTER,
    data: { quest: { [ERRANDS.key]: ERRANDS, [BOUNTY.key]: BOUNTY } },
});

/** A mob of the given spawn, killed. `checkQuestUpdate` reads only the spawn. */
function kill(spawnKey: string, times = 1): void {
    const mob = { AI_SPAWN_INFO: { key: spawnKey } } as unknown as BrainSchema;
    for (let i = 0; i < times; i++) {
        player.dynamicCTRL.checkQuestUpdate("kill", mob);
    }
}

const accept = (key: string) => state.processMessage(client, ServerMsg.PLAYER_QUEST_UPDATE, { key, status: QuestStatus.ACCEPTED });
const handIn = (key: string) => state.processMessage(client, ServerMsg.PLAYER_QUEST_UPDATE, { key, status: QuestStatus.READY_TO_COMPLETE });
const progress = (key: string) => player.player_data.quests.get(key) as QuestSchema;

////////////////////////////////////////////////////////////////////////////////
// Accepting.

check("a player starts with no quests", player.player_data.quests.size === 0);

accept(ERRANDS.key);

check("accepting one records it", progress(ERRANDS.key) instanceof QuestSchema);
check("at no progress and not handed in", progress(ERRANDS.key).qty === 0 && progress(ERRANDS.key).status === 0);
// The claim in issue #12, checked directly. `.get()` is what the code uses;
// the bracket read it used to use resolves too, and this is why.
const quests = player.player_data.quests as any;
check("a MapSchema field answers to .get()", quests.get(ERRANDS.key) !== undefined);
check("and @colyseus/schema has proxied the field", quests["$proxy"] === true);
check("so the bracket read issue #12 reported as dead resolves as well", quests[ERRANDS.key] !== undefined);

////////////////////////////////////////////////////////////////////////////////
// Handing in a quest that is not done.

handIn(ERRANDS.key);
await settled();

check("a quest with no kills on it pays nothing", minted.length === 0, JSON.stringify(minted));
check("and no experience either", player.player_data.experience === 0, `${player.player_data.experience}`);
check("and is not marked handed in", progress(ERRANDS.key).status === 0);

////////////////////////////////////////////////////////////////////////////////
// Doing it.

kill("some_other_mob", 20);
check("killing something else counts for nothing", progress(ERRANDS.key).qty === 0, `${progress(ERRANDS.key).qty}`);

kill(BANDITS, ERRANDS.quantity - 1);
check("killing the right thing counts", progress(ERRANDS.key).qty === ERRANDS.quantity - 1, `${progress(ERRANDS.key).qty}`);
check("one short is not ready", !player.dynamicCTRL.isQuestReadyToComplete(ERRANDS as any));

handIn(ERRANDS.key);
await settled();
check("and one short pays nothing", minted.length === 0, JSON.stringify(minted));

kill(BANDITS);
check("the last kill makes it ready", player.dynamicCTRL.isQuestReadyToComplete(ERRANDS as any));

////////////////////////////////////////////////////////////////////////////////
// Being paid. This is the block that had never run.

const levelBefore = player.level;
handIn(ERRANDS.key);
await settled();

check("handing in a finished quest pays once", paidFor(ERRANDS.key).length === 1, JSON.stringify(minted));
check(
    "the gold the quest offers, to the character that did it",
    paidFor(ERRANDS.key)[0]?.reward.gold === ERRANDS.rewards.gold && paidFor(ERRANDS.key)[0]?.characterId === CHARACTER,
    JSON.stringify(paidFor(ERRANDS.key)[0]?.reward)
);
check("the experience lands in the room, where progression lives", player.player_data.experience === ERRANDS.rewards.experience, `${player.player_data.experience}`);
check("and 500 is short of the 1000 level 2 costs", player.level === levelBefore, `${levelBefore} -> ${player.level}`);
check("the quest is marked handed in", progress(ERRANDS.key).status === 1);

////////////////////////////////////////////////////////////////////////////////
// Being paid twice. The comment in `dynamicCTRL` claims the character and the
// quest key are the idempotency key; this is the first time anything has been
// in a position to check it.

handIn(ERRANDS.key);
await settled();
check("handing the same quest in again pays nothing", paidFor(ERRANDS.key).length === 1, JSON.stringify(minted));
check("and awards no second helping of experience", player.player_data.experience === ERRANDS.rewards.experience, `${player.player_data.experience}`);

// Colyseus dispatches messages one at a time, so "at once" is what a client
// gets by writing twenty frames before the room reads any of them.
await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => handIn(ERRANDS.key))));
await settled();
check("nor does a burst of them", paidFor(ERRANDS.key).length === 1, `${paidFor(ERRANDS.key).length} payments`);

// Kills keep being counted after the hand-in, and must not re-open it.
kill(BANDITS, 10);
handIn(ERRANDS.key);
await settled();
check("and killing more of them afterwards does not re-open it", paidFor(ERRANDS.key).length === 1, `${paidFor(ERRANDS.key).length} payments`);

////////////////////////////////////////////////////////////////////////////////
// Item rewards, which take a different branch to gold.

accept(BOUNTY.key);
kill(BANDITS, BOUNTY.quantity);
handIn(BOUNTY.key);
await settled();

const bounty = paidFor(BOUNTY.key)[0];
check("a quest that pays in items pays once", paidFor(BOUNTY.key).length === 1, JSON.stringify(minted));
check(
    "at the key and quantity the server looked up",
    bounty?.reward.items?.length === 1 && bounty.reward.items[0].key === "potion_small_red" && bounty.reward.items[0].qty === 3,
    JSON.stringify(bounty?.reward)
);
check(
    "and its experience takes the player up a level",
    player.player_data.experience === ERRANDS.rewards.experience + BOUNTY.rewards.experience && player.level === 2,
    `${player.player_data.experience} xp, level ${player.level}`
);

////////////////////////////////////////////////////////////////////////////////
// What a message may not do. The rewards come from the server's copy of the
// quest; the message carries a key and a status and nothing else is read.

const before = minted.length;
state.processMessage(client, ServerMsg.PLAYER_QUEST_UPDATE, {
    key: ERRANDS.key,
    status: QuestStatus.READY_TO_COMPLETE,
    rewards: { gold: 1_000_000, items: [{ key: "sword_01", qty: 99 }] },
} as any);
state.processMessage(client, ServerMsg.PLAYER_QUEST_UPDATE, { key: "NO_SUCH_QUEST", status: QuestStatus.ACCEPTED });
state.processMessage(client, ServerMsg.PLAYER_QUEST_UPDATE, { key: "NO_SUCH_QUEST", status: QuestStatus.READY_TO_COMPLETE });
await settled();

check("rewards attached to the message are not read", minted.length === before, JSON.stringify(minted.slice(before)));
check("a quest the world does not have cannot be accepted", player.player_data.quests.get("NO_SUCH_QUEST") === undefined);
check("or handed in", minted.length === before);

// Handing in a quest that was never accepted: the definition resolves, the
// player's progress does not.
state.processMessage(client, ServerMsg.PLAYER_QUEST_UPDATE, { key: BOUNTY.key, status: QuestStatus.ACCEPTED });
const unaccepted = openTestRoom({ character: 2, data: { quest: { [ERRANDS.key]: ERRANDS } } });
unaccepted.state.processMessage(unaccepted.client, ServerMsg.PLAYER_QUEST_UPDATE, { key: ERRANDS.key, status: QuestStatus.READY_TO_COMPLETE });
await settled();
check("a quest nobody accepted cannot be handed in", minted.filter((entry) => entry.characterId === 2).length === 0);

////////////////////////////////////////////////////////////////////////////////
// The same mistake, in the other direction. `abilities` is a MapSchema too, and
// `learnAbility()` read it with brackets to decide whether the player already
// knew the thing — so the answer was always no and every visit to a trainer
// spent another hotbar slot. Latent rather than live: the room message that
// calls this is commented out in `GameRoomState.processMessage`.

const learner = openTestRoom({ character: 3 }).player;
const slots = () => learner.player_data.hotbar.size;

learner.abilitiesCTRL.learnAbility("fire_dart");
const afterFirst = slots();
check("learning an ability records it once", learner.player_data.abilities.size === 1 && learner.player_data.abilities.get("fire_dart") !== undefined);
check("and puts it on the hotbar", afterFirst === 1, `${afterFirst} slots`);

for (let i = 0; i < 10; i++) {
    learner.abilitiesCTRL.learnAbility("fire_dart");
}
check("learning it again changes nothing", learner.player_data.abilities.size === 1 && slots() === afterFirst, `${learner.player_data.abilities.size} abilities, ${slots()} slots`);

learner.abilitiesCTRL.learnAbility("not_an_ability");
check("and an ability the world does not have is not learned", learner.player_data.abilities.size === 1);

console.log(failures === 0 ? "\nall good\n" : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
