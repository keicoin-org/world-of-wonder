import Logger from "./utils/Logger";
import { DB_MYSQL } from "./utils/database/mysql";
import { DB_SQLLITE } from "./utils/database/sqllite";
import { nanoid } from "nanoid";
import { PlayerCharacter, PlayerUser } from "../shared/types";
import { ParsedQs } from "qs";
import { InventorySchema } from "./rooms/schema/player/InventorySchema";
import { AbilitySchema } from "./rooms/schema/player/AbilitySchema";
import { EquipmentSchema, HotbarSchema, PlayerSchema, QuestSchema } from "./rooms/schema";
// The package's own entry point rather than a path inside it: @colyseus/schema
// declares `exports`, so reaching past it only resolved under the legacy
// resolver and stops the moment anything modern looks at it.
import { MapSchema } from "@colyseus/schema";
import { Config } from "../shared/Config";
import type { RewardState, RewardStore, StoredLeg, StoredReward } from "./kei/Outbox";

class Database {
    private debug: boolean = true;
    private _config: Config;
    private querier: DB_MYSQL | DB_SQLLITE;

    constructor(config) {
        this._config = config;
    }

    async init() {
        Logger.info("[database] Trying to connect to database");

        if (this._config.database === "mysql") {
            this.querier = new DB_MYSQL();
        } else if (this._config.database === "sqllite") {
            this.querier = new DB_SQLLITE();
        } else {
            this.querier = new DB_SQLLITE();
        }

        await this.querier.init(this._config);

        Logger.info("[database] Connected to database");
    }

    async create() {
        await this.querier.createDatabase();
        Logger.info("[database] imported default mysql structure");
    }

    ///////////////////////////////////////
    ///////////////////////////////////////
    ///////////////////////////////////////

    async getUser(username: string | string[] | ParsedQs | ParsedQs[], password: string | string[] | ParsedQs | ParsedQs[]) {
        const sql = `SELECT * FROM users WHERE username=? AND password=?;`;
        return await this.querier.get(sql, [username, password]);
    }

    async getUserWithToken(token: string | string[] | ParsedQs | ParsedQs[]) {
        const sql = `SELECT * FROM users WHERE token=?;`;
        return await this.querier.get(sql, [token]);
    }

    // The declared type says `| undefined` rather than hiding it behind the `<any>`
    // cast this used to carry. A single-row `get` with no match resolves to
    // undefined, so the cast was the only reason the compiler accepted the next
    // line, and the next line is what turned a missing row into a crash in a
    // handler that had no `.catch` (issue #17).
    async getUserById(user_id: number): Promise<PlayerUser | undefined> {
        const sql = `SELECT * FROM users WHERE id=?;`;
        let user = <PlayerUser>await this.querier.get(sql, [user_id]);
        if (!user) return undefined;
        user.characters = await this.getCharactersForUser(user_id);
        return user;
    }

    async getUserByToken(token: any): Promise<PlayerUser> {
        const sql = `SELECT * FROM users WHERE token=?;`;
        return <PlayerUser>await this.querier.get(sql, [token]);
    }

    async getCharactersForUser(user_id: number): Promise<PlayerCharacter[]> {
        const sql = `SELECT * FROM characters WHERE user_id=?;`;
        return <PlayerCharacter[]>await this.querier.all(sql, [user_id]);
    }

    async hasUser(username: string) {
        const sql = `SELECT * FROM users WHERE username=?;`;
        return await this.querier.get(sql, [username]);
    }

    async refreshToken(user_id: number) {
        let token = nanoid();
        const sql = `UPDATE users SET token=? WHERE id=?;`;
        await this.querier.run(sql, [token, user_id]);
        let user = await this.getUserById(user_id);
        return user;
    }

    async checkToken(token: string): Promise<PlayerUser> {
        let user = await this.getUserByToken(token);
        if (user) {
            user.characters = await this.getCharactersForUser(user.id);
            return user;
        }
        return null;
    }

    async saveUser(username: string, password: string, token: string = nanoid()) {
        let lastId = await this.querier.run(`INSERT INTO users (username, password, token) VALUES (?,?,?)`, [username, password, token]);
        return await this.getUserById(lastId);
    }

    ///////////////////////////////////////
    ///////////////////////////////////////
    ///////////////////////////////////////

    async getCharacter(id: number) {
        let character = await this.querier.get(`SELECT * FROM characters WHERE id=?;`, [id]);
        // Same shape as getUserById: no row is `undefined`, and every line below
        // this one writes through it. Callers already branch on a falsy result —
        // they just never got one, because this threw first.
        if (!character) return undefined;
        character.abilities = await this.querier.all(`SELECT CA.* FROM character_abilities CA WHERE CA.owner_id=? ORDER BY CA.id ASC;`, [id]);
        character.hotbar = await this.querier.all(`SELECT CA.* FROM character_hotbar CA WHERE CA.owner_id=? ORDER BY CA.digit ASC;`, [id]);
        character.inventory = await this.querier.all(`SELECT CI.* FROM character_inventory CI WHERE CI.owner_id=?;`, [id]);
        character.equipment = await this.querier.all(`SELECT CI.* FROM character_equipment CI WHERE CI.owner_id=?;`, [id]);
        character.quests = await this.querier.all(`SELECT CI.* FROM character_quests CI WHERE CI.owner_id=? AND CI.status=?;`, [id, 0]);
        return character;
    }

    generateStatPoint() {
        return Math.trunc(70 / 5 + Math.random() * 10);
    }

    async createCharacter(token, name, race, material, head) {
        let user = await this.getUserByToken(token);
        // An unknown token reached `user.id` in the parameter list below, so
        // `POST /create_character?token=anything` was the same fatal dereference
        // as issue #17 wearing a different route.
        if (!user) return undefined;
        let characterId = await (<any>this.querier.run(
            `INSERT INTO characters (
                    user_id, 
                    name, 
                    race, 
                    material, 
                    head, 
                    strength, 
                    endurance, 
                    agility, 
                    intelligence, 
                    wisdom, 
                    location, 
                    x, 
                    y, 
                    z, 
                    rot, 
                    level, 
                    experience, 
                    health, 
                    mana, 
                    gold, 
                    points 
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                `,
            [
                user.id,
                name,
                race,
                material,
                head,
                20,
                20,
                20,
                20,
                20,
                //"training_ground",
                "lh_town",

                6.18,
                0.1,
                -11.21,
                1.72,

                1,
                0,

                1000,
                1000,
                // The `gold` column, which is no longer money and is no longer
                // read. A new character gets nothing in it rather than 50,000,
                // so nothing in this database looks like a balance.
                0,
                50,
            ]
        ));

        // add default abilities
        let abilities = [{ key: "base_attack" }, { key: "fire_dart" }];
        for (const ability of abilities) {
            await this.querier.run("INSERT INTO character_abilities (`owner_id`, `key`) VALUES (?,?);", [characterId, ability.key]);
        }

        // add default hotbar
        let hotbar = [
            { digit: 1, type: "ability", key: "base_attack" },
            { digit: 2, type: "ability", key: "slice_attack" },
            { digit: 3, type: "ability", key: "fire_dart" },
            { digit: 4, type: "ability", key: "poison" },
            { digit: 5, type: "ability", key: "light_heal" },
            { digit: 8, type: "item", key: "potion_small_red" },
            { digit: 9, type: "item", key: "potion_small_blue" },
        ];
        for (const item of hotbar) {
            await this.querier.run("INSERT INTO character_hotbar (`owner_id`, `digit`, `type`, `key`) VALUES (?,?,?,?);", [
                characterId,
                item.digit,
                item.type,
                item.key,
            ]);
        }

        // default quests
        //const sql_quests = `INSERT INTO character_quests ("owner_id", "key", "status", "qty") VALUES ("${c.id}", "LH_DANGEROUS_ERRANDS_01", "0", "5")`;
        //this.run(sql_quests);

        // A starter kit used to be written here: a sword in `character_equipment`
        // and five red potions, five blue, a sword, two armours and an amulet in
        // `character_inventory`. It is gone rather than quarantined, because
        // writing rows the room is no longer allowed to read would have created a
        // character whose database says it owns eight things and whose bag —
        // which is the chain — says it owns none (issue #6, step 1).
        //
        // The kit belongs on the chain, delivered to an address the player has
        // proved is theirs, the same way `STARTING_GOLD` is. Until that proof
        // exists a new character starts with what the chain says it has, which is
        // nothing, and can buy its first sword from the vendor.

        return await this.getCharacter(characterId);
    }

    async updateCharacter(character_id: number, data) {
        let p = [];
        p["location"] = data.location;
        p["x"] = data.x;
        p["y"] = data.y;
        p["z"] = data.z;
        p["rot"] = data.rot;
        if (data.level) {
            p["level"] = data.level;
        }
        if (data.maxHealth) {
            p["health"] = data.maxHealth;
        }
        if (data.maxMana) {
            p["mana"] = data.maxMana;
        }

        if (data.player_data) {
            // `gold` is deliberately not written. The column still exists and
            // still holds whatever a character last had before the economy moved
            // to the chain, and it is left exactly as it was: writing it would
            // let a session overwrite the only record of what the old economy
            // owed, and reading it would make an editable row into money
            // (issue #6, `kei/Legacy.ts`).
            p["experience"] = data.player_data.experience ?? 0;
            p["points"] = data.player_data.points ?? 0;
            p["strength"] = data.player_data.strength ?? 0;
            p["endurance"] = data.player_data.endurance ?? 0;
            p["agility"] = data.player_data.agility ?? 0;
            p["intelligence"] = data.player_data.intelligence ?? 0;
            p["wisdom"] = data.player_data.wisdom ?? 0;
        }

        let sql = "UPDATE characters SET ";

        for (let i in p) {
            const el = p[i];
            sql += i + "='" + el + "',";
        }
        sql = sql.slice(0, -1);
        sql += " WHERE id= " + character_id;
        //console.log(sql);
        return this.querier.run(sql, []);
    }

    // removes and saves character hotbar
    // terrible way to do it
    async saveHotbar(character_id: number, hotbar: MapSchema<HotbarSchema, string>) {
        const sql = `DELETE FROM character_hotbar WHERE owner_id=?;`;
        await this.querier.run(sql, [character_id]);
        if (hotbar && hotbar.size > 0) {
            hotbar.forEach((item) => {
                this.querier.run("INSERT INTO character_hotbar (`owner_id`, `digit`, `type`, `key`) VALUES (?,?,?,?);", [
                    character_id,
                    item.digit,
                    item.type,
                    item.key,
                ]);
            });
        }
    }

    /**
     * Has this server-authored reward already been minted on the chain?
     *
     * The row is the whole answer: it is written before the mint and never
     * updated, so its presence means "do not pay this again" whether the process
     * that wrote it finished, crashed, or was replaced.
     */
    async hasPaidReward(id: string): Promise<boolean> {
        const row = await this.querier.get(`SELECT id FROM reward_payments WHERE id=?;`, [id]);
        return !!row;
    }

    async recordRewardPayment(entry: { id: string; characterId: number; address: string; gold: number; items: string }) {
        const sql = "INSERT INTO reward_payments (`id`, `owner_id`, `address`, `gold`, `items`, `paid_at`) VALUES (?,?,?,?,?,?)";
        return this.querier.run(sql, [entry.id, entry.characterId, entry.address, entry.gold, entry.items, Date.now()] as any);
    }

    ///////////////////////////////////////
    /////////// REWARD OUTBOX /////////////
    ///////////////////////////////////////
    //
    // The storage half of src/server/kei/Outbox.ts, which is where the state
    // machine and the reasoning behind it live. Two properties are load-bearing
    // and neither is obvious from the SQL, so they are worth saying here too:
    //
    // Every write below is either a single statement or idempotent, because
    // neither adapter in this repo gives out a transaction. Authoring a reward is
    // one INSERT whose payload contains the whole intent; the per-leg rows are
    // derived from it later and re-deriving them writes nothing.
    //
    // Claiming work is a compare-and-swap, not a read followed by a write.
    // `change()` reports how many rows an UPDATE actually matched, and a claim
    // that matched nothing means another worker has the reward. That is what
    // stops two processes minting the same leg.

    /** SQLite and MySQL spell "insert unless it is already there" differently. */
    private get insertIgnore(): string {
        return this._config.database === "mysql" ? "INSERT IGNORE INTO" : "INSERT OR IGNORE INTO";
    }

    /** The outbox's store, bound to this connection. */
    rewardStore(): RewardStore {
        return {
            enqueue: (reward) => this.enqueueReward(reward),
            find: (id) => this.findReward(id),
            due: (now, limit) => this.dueRewards(now, limit),
            claim: (id, now, until) => this.claimReward(id, now, until),
            patch: (id, fields) => this.patchReward(id, fields),
            addLeg: (leg) => this.addRewardLeg(leg),
            legs: (id) => this.rewardLegs(id),
            patchLeg: (id, leg, fields) => this.patchRewardLeg(id, leg, fields),
            compact: (before) => this.compactRewardOutbox(before),
            counts: (now) => this.rewardOutboxCounts(now),
        };
    }

    async enqueueReward(reward: StoredReward): Promise<boolean> {
        const sql =
            this.insertIgnore +
            " reward_outbox (`id`, `owner_id`, `address`, `issuer`, `payload`, `replayable`, `state`, `attempts`, `lease_until`, `reason`, `enqueued_at`, `settled_at`)" +
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)";
        const written = await this.querier.change(sql, [
            reward.id,
            reward.characterId,
            reward.address,
            reward.issuer,
            reward.payload,
            reward.replayable ? 1 : 0,
            reward.state,
            reward.attempts,
            reward.leaseUntil,
            reward.reason,
            reward.enqueuedAt,
            reward.settledAt,
        ] as any);
        return written > 0;
    }

    async findReward(id: string): Promise<StoredReward | undefined> {
        const row = await this.querier.get("SELECT * FROM reward_outbox WHERE id=?;", [id]);
        return row ? toStoredReward(row) : undefined;
    }

    // Oldest first, so a reward that has been waiting the longest is the one that
    // gets the next attempt. `lease_until` doubles as the retry backoff: a worker
    // that gave up on a reward sets it to zero and a worker that is still on one
    // holds it until its lease runs out.
    async dueRewards(now: number, limit: number): Promise<StoredReward[]> {
        const sql = "SELECT * FROM reward_outbox WHERE state='pending' AND lease_until<=? ORDER BY enqueued_at ASC LIMIT ?;";
        const rows = await this.querier.all(sql, [now, limit] as any);
        return (rows ?? []).map(toStoredReward);
    }

    async claimReward(id: string, now: number, until: number): Promise<boolean> {
        const sql = "UPDATE reward_outbox SET lease_until=? WHERE id=? AND state='pending' AND lease_until<=?;";
        return (await this.querier.change(sql, [until, id, now] as any)) === 1;
    }

    async patchReward(id: string, fields: Partial<StoredReward>): Promise<void> {
        const columns = { state: "state", address: "address", reason: "reason", leaseUntil: "lease_until", attempts: "attempts", settledAt: "settled_at" };
        const sets: string[] = [];
        const params: any[] = [];
        for (const [field, column] of Object.entries(columns)) {
            if (!(field in fields)) continue;
            sets.push("`" + column + "`=?");
            params.push((fields as any)[field]);
        }
        if (sets.length === 0) return;
        params.push(id);
        await this.querier.run("UPDATE reward_outbox SET " + sets.join(", ") + " WHERE id=?;", params as any);
    }

    async addRewardLeg(leg: StoredLeg): Promise<void> {
        const sql =
            this.insertIgnore +
            " reward_outbox_legs (`reward_id`, `leg`, `kind`, `key`, `units`, `state`, `attempts`, `previous`, `receipt`, `error`)" +
            " VALUES (?,?,?,?,?,?,?,?,?,?)";
        await this.querier.change(sql, [
            leg.rewardId,
            leg.leg,
            leg.kind,
            leg.key,
            leg.units,
            leg.state,
            leg.attempts,
            leg.previous,
            leg.receipt,
            leg.error,
        ] as any);
    }

    async rewardLegs(id: string): Promise<StoredLeg[]> {
        const rows = await this.querier.all("SELECT * FROM reward_outbox_legs WHERE reward_id=? ORDER BY leg ASC;", [id]);
        return (rows ?? []).map((row: any) => ({
            rewardId: row.reward_id,
            leg: Number(row.leg),
            kind: row.kind,
            key: row.key,
            // Left as the string it was written as. Parsing it into a number here
            // would undo the reason it is a string.
            units: String(row.units),
            state: row.state,
            attempts: Number(row.attempts ?? 0),
            previous: row.previous ?? null,
            receipt: row.receipt ?? null,
            error: row.error ?? null,
        }));
    }

    async patchRewardLeg(id: string, leg: number, fields: Partial<StoredLeg>): Promise<void> {
        const columns = { state: "state", attempts: "attempts", previous: "previous", receipt: "receipt", error: "error" };
        const sets: string[] = [];
        const params: any[] = [];
        for (const [field, column] of Object.entries(columns)) {
            if (!(field in fields)) continue;
            sets.push("`" + column + "`=?");
            params.push((fields as any)[field]);
        }
        if (sets.length === 0) return;
        params.push(id, leg);
        await this.querier.run("UPDATE reward_outbox_legs SET " + sets.join(", ") + " WHERE reward_id=? AND leg=?;", params as any);
    }

    /**
     * Retention, which the outbox needs from its first day: it grows with every
     * kill and every quest and nothing else would ever remove a row.
     *
     * Only settled rewards past the cutoff are touched. Pending work is the queue
     * and held work is waiting for a person, so deleting either would be losing
     * somebody's reward to save a kilobyte.
     *
     * The legs and the payload are the bulk and they go. The row itself can only
     * go when ordinary play could not author the same id again — a loot pickup or
     * a kill, whose id is an entity that no longer exists. A quest's id is a
     * character and a quest key, so a re-accepted quest would produce it a second
     * time, and an empty row is what refuses to pay for it twice. That leaves a
     * tombstone set bounded by characters times quests rather than by playtime.
     */
    async compactRewardOutbox(before: number): Promise<{ removed: number; tombstoned: number }> {
        const settled = "SELECT id FROM reward_outbox WHERE state='settled' AND settled_at IS NOT NULL AND settled_at<?";
        await this.querier.run("DELETE FROM reward_outbox_legs WHERE reward_id IN (" + settled + ");", [before] as any);
        const removed = await this.querier.change(
            "DELETE FROM reward_outbox WHERE state='settled' AND settled_at IS NOT NULL AND settled_at<? AND replayable=0;",
            [before] as any
        );
        const tombstoned = await this.querier.change(
            "UPDATE reward_outbox SET payload='', address=NULL, reason=NULL WHERE state='settled' AND settled_at IS NOT NULL AND settled_at<? AND replayable=1 AND payload<>'';",
            [before] as any
        );
        return { removed, tombstoned };
    }

    async rewardOutboxCounts(now: number): Promise<{ pending: number; settled: number; held: number; oldestPendingAge: number }> {
        const rows = await this.querier.all("SELECT state, COUNT(*) AS total FROM reward_outbox GROUP BY state;", []);
        const totals: Record<string, number> = {};
        for (const row of rows ?? []) {
            totals[(row as any).state] = Number((row as any).total ?? 0);
        }
        const oldest = await this.querier.get("SELECT MIN(enqueued_at) AS oldest FROM reward_outbox WHERE state='pending';", []);
        const at = Number((oldest as any)?.oldest ?? 0);
        return {
            pending: totals["pending"] ?? 0,
            settled: totals["settled"] ?? 0,
            held: totals["held"] ?? 0,
            oldestPendingAge: at > 0 ? Math.max(0, now - at) : 0,
        };
    }

    // removes and saves character items
    // terrible way to do it
    //
    // Nothing calls this any more. `PlayerSchema.save()` used to, and stopping is
    // half of the boundary in `kei/Legacy.ts`: this method deletes every row a
    // character has and re-inserts the room's bag, so leaving it wired up while
    // the room no longer loads the old inventory would have emptied the tables it
    // is the point of that file to preserve. It is kept because the migration
    // that finally reads those rows will want the shape of them.
    async saveItems(character_id: number, items: MapSchema<InventorySchema, string>) {
        const sql = `DELETE FROM character_inventory WHERE owner_id=?;`;
        await this.querier.run(sql, [character_id]);
        if (items && items.size > 0) {
            let sqlItems = "INSERT INTO character_inventory (`owner_id`, `qty`, `key`) VALUES ";
            items.forEach((element: InventorySchema) => {
                sqlItems += ` ('${character_id}', '${element.qty}', '${element.key}'),`;
            });
            sqlItems = sqlItems.slice(0, -1);
            return await this.querier.run(sqlItems);
        }
    }

    // removes and saves character abilities
    // terrible way to do it
    async saveAbilities(character_id: number, abilities: MapSchema<AbilitySchema, string>) {
        const sql = `DELETE FROM character_abilities WHERE owner_id=?;`;
        await this.querier.run(sql, [character_id]);
        if (abilities && abilities.size > 0) {
            let sqlItems = "INSERT INTO character_abilities (`owner_id`, `key`) VALUES ";
            abilities.forEach((element: AbilitySchema) => {
                sqlItems += ` ('${character_id}', '${element.key}'),`;
            });
            sqlItems = sqlItems.slice(0, -1);
            return await this.querier.run(sqlItems);
        }
    }

    // removes and saves character equipment
    // terrible way to do it
    //
    // Also unwired, and for the same reason as `saveItems` above: what is worn is
    // a reference to an asset the wearer has to still hold, so it cannot be
    // written back from a room that is not yet allowed to load it.
    async saveEquipment(character_id: number, equipments: MapSchema<EquipmentSchema, string>) {
        const sql = `DELETE FROM character_equipment WHERE owner_id=?;`;
        await this.querier.run(sql, [character_id]);
        if (equipments && equipments.size > 0) {
            let sqlString = "INSERT INTO character_equipment (`owner_id`, `key`, `slot`) VALUES ";
            equipments.forEach((element: EquipmentSchema) => {
                sqlString += ` ('${character_id}', '${element.key}', '${element.slot}'),`;
            });
            sqlString = sqlString.slice(0, -1);
            return await this.querier.run(sqlString);
        }
    }

    // removes and saves quests
    // terrible way to do it
    async saveQuests(character_id: number, quests: MapSchema<QuestSchema, string>) {
        const sql = `DELETE FROM character_quests WHERE owner_id=?;`;
        await this.querier.run(sql, [character_id]);
        if (quests && quests.size > 0) {
            let sqlString = `INSERT INTO character_quests (owner_id, key, status, qty) VALUES `;
            quests.forEach((element: QuestSchema) => {
                sqlString += ` ('${character_id}', '${element.key}', '${element.status}', '${element.qty}'),`;
            });
            sqlString = sqlString.slice(0, -1);
            return await this.querier.run(sqlString);
        }
    }

    async toggleOnlineStatus(character_id: number, online: number) {
        const sql = `UPDATE characters SET online=? WHERE id=? ;`;
        return this.querier.run(sql, [online, character_id]);
    }

    async doesUserNameExists(name: string) {
        const sql = `SELECT COUNT(id) as count FROM users WHERE username=? ;`;
        return this.querier.get(sql, [name]);
    }
}

// MySQL hands `bigint` back as a string and SQLite as a number, and the outbox
// compares these against a clock, so they are normalized in one place rather
// than at every comparison.
function toStoredReward(row: any): StoredReward {
    return {
        id: row.id,
        characterId: Number(row.owner_id),
        address: row.address ?? null,
        issuer: row.issuer ?? "",
        payload: row.payload ?? "",
        replayable: Number(row.replayable ?? 0) === 1,
        state: (row.state ?? "pending") as RewardState,
        attempts: Number(row.attempts ?? 0),
        leaseUntil: Number(row.lease_until ?? 0),
        reason: row.reason ?? null,
        enqueuedAt: Number(row.enqueued_at ?? 0),
        settledAt: row.settled_at === null || row.settled_at === undefined ? null : Number(row.settled_at),
    };
}

export { Database };
