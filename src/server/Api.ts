import express from "express";
import path from "path";
import Logger from "./utils/Logger";
import { generateRandomPlayerName } from "../shared/Utils";
import { GameData } from "./GameData";
import { Database } from "./Database";
import { guardRoute } from "./utils/Failsafe";
import { generateId } from "@colyseus/core";

class Api {
    constructor(app, database: Database) {
        // default to built client index.html
        let indexPath = "dist/client/";
        let clientFile = "index.html";

        // serve client
        app.use(express.static(indexPath));
        let indexFile = path.resolve(indexPath + clientFile);
        app.get("/", function (req, res) {
            res.sendFile(indexFile);
        });

        //////////////////////////////////////////////////
        ///////////// ESPRESS MINI API ///////////////////
        //////////////////////////////////////////////////
        //
        // Every route below that touches the database is `async` and wrapped in
        // `guardRoute`, and both halves of that matter. Express 4 does not catch
        // a rejection raised inside a promise callback, so the `.then` chains
        // these used to be turned a locked table — or a row that was not there —
        // into an unhandled rejection, which Node makes fatal. One anonymous
        // request was enough to exit the process and drop every room with it
        // (issue #17). `guardRoute` hands the rejection to Express instead.
        //
        // The other half of the same rule: a branch that finds no record has to
        // `return`. `/check` always did. `/loginWithToken` did not, and read
        // `.id` off the user it had just logged as missing.
        app.post(
            "/login",
            guardRoute(async (req, res) => {
                const username: string = (req.query.username as string) ?? "";
                const password: string = (req.query.password as string) ?? "";
                if (!username || !password) {
                    Logger.error("[api][/login] login failed.");
                    return res.status(400).send({
                        message: "Wrong Parameters",
                    });
                }

                Logger.info("[api][/login] checking password.");
                const found = await database.getUser(username, password);

                let user;
                if (found) {
                    Logger.info("[api][/login] user found, refreshing login token.");
                    user = await database.refreshToken(found.id);
                } else {
                    Logger.info("[api][/login] user not found, creating new user.");
                    user = await database.saveUser(username, password);
                }

                if (!user) {
                    Logger.error("[api][/login] login failed: the account could not be read back.");
                    return res.status(400).send({
                        message: "Login Failed",
                    });
                }

                Logger.info("[api][/login] login succesful.");
                return res.send({
                    message: "Login Successful",
                    user: user,
                });
            })
        );

        app.get(
            "/loginWithToken",
            guardRoute(async (req, res) => {
                const token: string = (req.query.token as string) ?? "";
                if (!token) {
                    // Answering at all is half the fix here: falling out of the
                    // handler left the request open until the client gave up.
                    Logger.error("[api][/loginWithToken] no token given.");
                    return res.status(400).send({
                        message: "Wrong Parameters",
                    });
                }

                Logger.info("[api][/loginWithToken] checking token.");
                const found = await database.getUserWithToken(token);
                if (!found) {
                    // This `return` is issue #17. Without it the next line read
                    // `.id` off the row it had just established was absent, in a
                    // chain with no `.catch`, so `?token=anything` exited the
                    // process.
                    Logger.info("[api][/loginWithToken] invalid token.");
                    return res.status(400).send({
                        message: "Login Failed",
                    });
                }

                Logger.info("[api][/loginWithToken] valid token, refreshing login token.");
                const user = await database.refreshToken(found.id);
                if (!user) {
                    Logger.error("[api][/loginWithToken] login failed: the account could not be read back.");
                    return res.status(400).send({
                        message: "Login Failed",
                    });
                }

                Logger.info("[api][/loginWithToken] login succesful.");
                return res.send({
                    message: "Login Successful",
                    user: user,
                });
            })
        );

        app.post(
            "/check",
            guardRoute(async (req, res) => {
                const token: string = (req.query.token as string) ?? "";
                if (token === "") {
                    return res.status(400).send({
                        message: "Check Failed",
                    });
                }

                const user = await database.checkToken(token);
                if (!user) {
                    return res.status(400).send({
                        message: "Check Failed",
                    });
                }

                return res.send({
                    message: "Check Successful",
                    user: user,
                });
            })
        );

        app.post(
            "/create_character",
            guardRoute(async (req, res) => {
                const token: string = (req.query.token as string) ?? "";
                const name: string = (req.query.name as string) ?? "";
                const race: string = (req.query.race as string) ?? "";
                const material: number = (req.query.material as number) ?? 0;
                const head: number = (req.query.head as number) ?? 0;
                if (token === "") {
                    return res.status(400).send({
                        message: "Create Failed",
                    });
                }

                // `createCharacter` used to read `.id` off whatever an unknown
                // token matched, which was the same crash as /loginWithToken by
                // another route. It answers `undefined` now, which this branch
                // was already written for.
                const character = await database.createCharacter(token, name, race, material, head);
                if (!character) {
                    return res.status(400).send({
                        message: "Create Failed",
                    });
                }

                return res.send({
                    message: "Create Successful",
                    character: character,
                });
            })
        );

        app.get(
            "/get_character",
            guardRoute(async (req, res) => {
                // `parseInt("")` and `parseInt("nope")` are both NaN, which the
                // query then matches against nothing — so the shape is checked
                // here rather than discovered as a missing row further in.
                const character_id: number = parseInt((req.query.character_id as string) ?? "", 10);
                if (!Number.isInteger(character_id)) {
                    return res.status(400).send({
                        message: "Get Character Failed",
                    });
                }

                const character = await database.getCharacter(character_id);
                if (!character) {
                    return res.status(400).send({
                        message: "Get Character Failed",
                    });
                }

                return res.send({
                    message: "Get Character Successful",
                    character: character,
                });
            })
        );

        // Never implemented upstream. An empty handler is not "not implemented":
        // it accepts the request and then holds the connection until the client
        // times out, so say so instead.
        app.get("/register", (req, res) => {
            return res.status(501).send({
                message: "Registration happens through /login.",
            });
        });

        app.post(
            "/returnRandomUser",
            guardRoute(async (req, res) => {
                const password = generateId();

                // The retry ceiling here used to read `if (result > 20)`, which
                // compares the string "no" against a number and is therefore
                // never true — a name generator that kept colliding spun this
                // handler forever on an unauthenticated route. Count attempts.
                let username = "";
                for (let attempt = 0; attempt < 20; attempt += 1) {
                    const candidate = generateRandomPlayerName();
                    const taken = await database.doesUserNameExists(candidate);
                    if (!taken || taken.count === 0) {
                        username = candidate;
                        break;
                    }
                }
                if (username === "") {
                    Logger.error("[api][/returnRandomUser] no free name in 20 tries.");
                    return res.status(503).send({
                        message: "Could not name a character right now.",
                    });
                }

                const user = await database.saveUser(username, password);
                if (!user) {
                    Logger.error("[api][/returnRandomUser] the new account could not be read back.");
                    return res.status(500).send({
                        message: "Could not create a user.",
                    });
                }

                const race = GameData.get("race", "humanoid");
                const material = race.materials[Math.floor(Math.random() * race.materials.length)];
                const materialIndex = race.materials.indexOf(material);
                const character = await database.createCharacter(user.token, generateRandomPlayerName(), race.key, materialIndex, "Head_Paladin");
                if (!character) {
                    Logger.error("[api][/returnRandomUser] the new character could not be read back.");
                    return res.status(500).send({
                        message: "Could not create a character.",
                    });
                }

                character.user_id = user.id;
                character.token = user.token;
                character.password = user.password;
                Logger.info("[api][/returnRandomUser] " + character.name);
                return res.send({
                    message: "Successful",
                    user: character,
                });
            })
        );

        app.get("/getHelpPage", function (req, res) {
            // Read from the working directory for the same reason the navmesh is:
            // there is no `__dirname` in the bundled server, and the directory
            // depth it assumed no longer exists.
            //
            // The page name comes from the query string and is about to become a
            // file path, so it is matched against a safe shape rather than
            // trusted — `?page=../../.env` is otherwise a file read.
            let page = String(req.query.page ?? "");
            if (!/^[a-zA-Z0-9_-]+$/.test(page)) {
                return res.status(400).send("No such help page.");
            }
            res.sendFile(path.join(process.cwd(), "src/shared/Help/", page + ".html"));
        });

        app.get("/load_game_data", (req, res) => {
            return res.send({
                message: "Loaded successfully.",
                data: {
                    items: GameData.load("items"),
                    abilities: GameData.load("abilities"),
                    locations: GameData.load("locations"),
                    races: GameData.load("races"),
                    quests: GameData.load("quests"),
                    help: GameData.load("help"),
                },
            });
        });
    }
}

export { Api };
