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

export { Database };
