import Logger from "../../utils/Logger";

class Auth {
    static async check(db, authData) {
        const character = await db.getCharacter(authData.character_id);

        if (!character) {
            // This branch used to read `character.character_id` off the thing it
            // had just found to be falsy — the same shape as issue #17, and it
            // became reachable the moment getCharacter started answering
            // `undefined` for a missing row instead of throwing.
            Logger.error("[gameroom][onAuth] no character " + authData.character_id + ", joining failed.");
            return false;
        }

        // character found, check if already logged in
        if (character.online > 0) {
            Logger.error("[gameroom][onAuth] client already connected. ", character);
            return false;
        }

        // all checks are good, proceed
        Logger.info("[gameroom][onAuth] client authentified.");
        return character;
    }
}

export { Auth };
