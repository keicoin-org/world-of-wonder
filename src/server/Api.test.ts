/**
 * Every route in Api.ts has to answer — including when the record it looks for
 * is not there, and when the database refuses to talk at all.
 *
 * The status codes are not really the point. The point is that this file gets to
 * its last line. Express 4 does not catch a rejection raised inside a promise
 * callback or an `async` handler, and Node has exited the process over an
 * unhandled rejection since v15, so a `.then` that read a field off a row the
 * database did not have was a remote kill switch: `GET /loginWithToken?token=x`
 * with no account, no session and no token that ever existed took the process
 * down, and the Colyseus rooms, the connected players and the issuer wallet with
 * it (issue #17).
 *
 * **No process guard is installed here, on purpose.** `keepProcessAlive()` lives
 * in index.ts and is not called for the real process anywhere below, so if a
 * handler leaks a rejection this test dies the same way the server did — mid-run,
 * with no summary line and a nonzero exit. The reproduction and the regression
 * test are the same file. A guard here would hide exactly what is measured.
 *
 * The body is a function rather than top-level `await` for a duller reason: this
 * file sits directly in `src/server`, which is the one directory `tsconfig.json`
 * includes by glob, so unlike the tests under `src/server/kei` it is checked by
 * `npm run typecheck` — and `target` is ES6.
 *
 *   npm run test:api
 */

import express from "express";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { Api } from "./Api";
import { keepProcessAlive, mountFailsafeResponder, guardRoute } from "./utils/Failsafe";

let failures = 0;
function check(what: string, ok: boolean, detail = ""): void {
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures += 1;
}

/**
 * Two databases, and the difference between them is the two ways a handler can
 * come apart.
 *
 * `empty` resolves the way sqlite3 actually does when nothing matches: a
 * single-row `get` gives you `undefined`, not an error and not `null`. That is
 * the shape that produced issue #17.
 *
 * `broken` rejects everything, which is a locked table or a dropped connection.
 * No handler in this file used to have a `.catch`, so every one of them was the
 * same crash on a bad day.
 */
type Mode = "empty" | "broken";

function fakeDatabase(mode: Mode): any {
    const refuse = () => Promise.reject(new Error("SQLITE_BUSY: database is locked"));
    const nothing = mode === "broken" ? refuse : async () => undefined;
    return {
        getUser: nothing,
        getUserWithToken: nothing,
        getUserById: nothing,
        getUserByToken: nothing,
        refreshToken: nothing,
        saveUser: nothing,
        createCharacter: nothing,
        getCharacter: nothing,
        // The real one returns `null` explicitly, which is why /check was the one
        // handler in the file that already branched correctly.
        checkToken: mode === "broken" ? refuse : async () => null,
        // `SELECT COUNT(id) as count` always has a row, so this one has no empty
        // case — only a refusing one.
        doesUserNameExists: mode === "broken" ? refuse : async () => ({ count: 0 }),
    };
}

interface Served {
    port: number;
    close(): Promise<void>;
}

async function serve(mode: Mode): Promise<Served> {
    const app = express();
    app.use(express.json());
    new Api(app, fakeDatabase(mode));
    // Mounted in the same position index.ts mounts it: after every route.
    mountFailsafeResponder(app);

    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    return {
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

/**
 * The status, or 0 for "never answered".
 *
 * A handler that falls off the end without touching `res` — which is what
 * `/loginWithToken` with an empty token and `/register` both did — holds the
 * connection open rather than failing, so a hang has to be a distinguishable
 * result and not a hung test run.
 */
async function status(port: number, path: string, method = "GET"): Promise<number> {
    try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(5_000) });
        return response.status;
    } catch {
        return 0;
    }
}

const answered = (code: number) => code >= 400 && code < 600;

async function main(): Promise<void> {
    //////////////////////////////////////////////////
    // The defect, on a database that simply has no such row.
    //////////////////////////////////////////////////

    const empty = await serve("empty");

    const invalidToken = await status(empty.port, "/loginWithToken?token=nope");
    check("GET /loginWithToken with an invented token is refused rather than fatal", invalidToken === 400, `${invalidToken}`);

    const noToken = await status(empty.port, "/loginWithToken");
    check("GET /loginWithToken with no token answers instead of holding the connection", noToken === 400, `${noToken}`);

    // Two more routes with the same dereference behind them. `createCharacter`
    // read `.id` off whatever an unknown token matched, and `getCharacter` wrote
    // `.abilities` onto a missing row — both inside chains with no `.catch`, so
    // both were the same anonymous kill as the route above.
    const unknownCharacterToken = await status(empty.port, "/create_character?token=nope&name=Ghost&race=humanoid", "POST");
    check("POST /create_character with an unknown token is refused rather than fatal", unknownCharacterToken === 400, `${unknownCharacterToken}`);

    const missingCharacter = await status(empty.port, "/get_character?character_id=999999");
    check("GET /get_character for a character that does not exist is refused rather than fatal", missingCharacter === 400, `${missingCharacter}`);

    const notANumber = await status(empty.port, "/get_character?character_id=nope");
    check("GET /get_character with a non-numeric id is refused", notANumber === 400, `${notANumber}`);

    const noId = await status(empty.port, "/get_character");
    check("GET /get_character with no id at all is refused", noId === 400, `${noId}`);

    // /check is the handler the rest of the file should have copied. It has always
    // branched on a missing user; this pins that it still does.
    const checkMissing = await status(empty.port, "/check?token=nope", "POST");
    check("POST /check with an invented token still answers 400", checkMissing === 400, `${checkMissing}`);

    const registered = await status(empty.port, "/register");
    check("GET /register says it is not implemented instead of hanging", registered === 501, `${registered}`);

    // An account that cannot be read back after being written is an answer rather
    // than a crash. In the real database `saveUser` always reads its own insert
    // back, so this only happens when something is wrong — which is the point.
    const login = await status(empty.port, "/login?username=someone&password=secret", "POST");
    check("POST /login answers when the new account cannot be read back", answered(login), `${login}`);

    const randomUser = await status(empty.port, "/returnRandomUser", "POST");
    check("POST /returnRandomUser answers when the new account cannot be read back", answered(randomUser), `${randomUser}`);

    // Nothing above was allowed to take the process with it, and the only way to
    // know that from inside is to still be here and still be served.
    const stillUpAfterEmpty = await status(empty.port, "/load_game_data");
    check("the server still answers after every request above", stillUpAfterEmpty === 200, `${stillUpAfterEmpty}`);

    await empty.close();

    //////////////////////////////////////////////////
    // The same routes with a database that refuses. Every chain in this file used
    // to have no `.catch` at all, so this is the whole class rather than one route.
    //////////////////////////////////////////////////

    const broken = await serve("broken");

    for (const [what, path, method] of [
        ["POST /login", "/login?username=someone&password=secret", "POST"],
        ["GET /loginWithToken", "/loginWithToken?token=nope", "GET"],
        ["POST /check", "/check?token=nope", "POST"],
        ["POST /create_character", "/create_character?token=nope&name=Ghost&race=humanoid", "POST"],
        ["GET /get_character", "/get_character?character_id=1", "GET"],
        ["POST /returnRandomUser", "/returnRandomUser", "POST"],
    ] as const) {
        const code = await status(broken.port, path, method);
        check(`${what} answers 500 when the database refuses`, code === 500, `${code}`);
    }

    const leaked = await (await fetch(`http://127.0.0.1:${broken.port}/loginWithToken?token=nope`)).text();
    check("a failed request does not put the database error in the response", !leaked.includes("SQLITE_BUSY"), leaked.slice(0, 120));

    const stillUpAfterBroken = await status(broken.port, "/load_game_data");
    check("the server still answers after every refused query above", stillUpAfterBroken === 200, `${stillUpAfterBroken}`);

    await broken.close();

    //////////////////////////////////////////////////
    // The nets themselves.
    //////////////////////////////////////////////////

    // `guardRoute` is the piece that makes any of the above possible: without it a
    // rejection never becomes an error Express has heard of.
    const thrown = new Error("from inside an async handler");

    let handed: unknown;
    await new Promise<void>((resolve) => {
        guardRoute(async () => {
            throw thrown;
        })({}, {}, (error) => {
            handed = error;
            resolve();
        });
    });
    check("guardRoute hands a rejection to Express rather than to the process", handed === thrown);

    let handedSync: unknown;
    await new Promise<void>((resolve) => {
        guardRoute(() => {
            throw thrown;
        })({}, {}, (error) => {
            handedSync = error;
            resolve();
        });
    });
    check("guardRoute also catches a handler that throws before it awaits", handedSync === thrown);

    // The process guard, against something other than the real process —
    // installing it here for real would silence the fatal behaviour every check
    // above depends on.
    const target = new FakeProcess();
    keepProcessAlive(target);
    check(
        "keepProcessAlive listens for both events",
        target.listenerCount("unhandledRejection") === 1 && target.listenerCount("uncaughtException") === 1
    );

    target.emit("unhandledRejection", new Error("a leaked promise"));
    check("an unhandled rejection is logged and the process is left running", target.exits.length === 0);

    target.emit("uncaughtException", new Error("a real stack unwound from somewhere"));
    check("an uncaught exception is still fatal, deliberately", target.exits.length === 1 && target.exits[0] === 1, JSON.stringify(target.exits));
}

class FakeProcess extends EventEmitter {
    exits: number[] = [];
    exit(code?: number) {
        this.exits.push(code ?? 0);
    }
}

main().then(() => {
    console.log(failures === 0 ? "\nall good\n" : `\n${failures} failed\n`);
    process.exit(failures === 0 ? 0 : 1);
});
