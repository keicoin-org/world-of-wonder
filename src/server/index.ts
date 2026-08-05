// Colyseus + Express
import { createServer } from "http";
import express from "express";
import cors from "cors";

import { Server, matchMaker } from "@colyseus/core";

import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./rooms/GameRoom";
import { ChatRoom } from "./rooms/ChatRoom";

import { Api } from "./Api";
import { Database } from "./Database";
import { describeOrigins, originAllowed, readAllowedOrigins } from "./Origins";

import { startEconomy, type Economy } from "./kei/Economy";
import { mountEconomyApi } from "./kei/api";
import { mountNodeRpc, openStartupChain } from "./kei/node";
import { openInventoryAuthority, proofUnavailable, useInventoryAuthority } from "./kei/Inventory";
import { openOutbox } from "./kei/Outbox";

import Logger from "./utils/Logger";
import { keepProcessAlive, mountFailsafeResponder } from "./utils/Failsafe";
import { Config } from "../shared/Config";

import "dotenv/config";

//////////////////////////////////////////////////
//////////////////////////////////////////////////
//////////////////////////////////////////////////

class GameServer {
    public api;
    public database: Database;
    public config: Config;
    public economy: Economy;

    constructor() {
        this.config = new Config();
        this.init();
    }

    async init() {
        // Validate identity before the database, node, faucet, issuer, or any
        // listeners are opened. A process restart must not replace the economy.
        const { chain, seed } = await openStartupChain();

        // start db
        //
        // Still here, and deliberately so: it holds accounts, characters, and
        // where they were standing. What it no longer holds is money — gold and
        // items moved to the chain, because a database the developer controls is
        // not ownership (SPEC §8). Colyseus stays authoritative over presence and
        // position, and over nothing else.
        this.database = new Database(this.config);
        await this.database.init();
        await this.database.create();

        // start the economy
        this.economy = await startEconomy({
            seed,
            ...(chain.node === undefined ? {} : { node: chain.node }),
            network: chain.network,
            // SPEC §8: the game must be playable with payments switched off.
            exchange: process.env.KEI_EXCHANGE !== "off",
        });

        // The room's half of the economy: the one place gameplay is allowed to
        // ask whether a player owns something, and the reason it stops asking
        // SQLite (issue #6).
        //
        // `proofUnavailable` is the whole shape of what is left to do. Until a
        // character can be bound to an address by a signature this server can
        // check, every authorization below refuses, loot and quest rewards go
        // unpaid rather than into a database, and the old tables sit untouched.
        // That is the safety mode, and it is deliberately the loud kind.
        const authority = openInventoryAuthority({
            economy: this.economy,
            verify: proofUnavailable,
            payments: {
                paid: (id) => this.database.hasPaidReward(id),
                record: (entry) => this.database.recordRewardPayment(entry),
            },
        });
        useInventoryAuthority(authority);
        Logger.warning(
            "[kei] wallet-session proof is not built yet, so no character is bound to an address: loot, quest rewards and pickups are refused rather than written to the database (issue #6)"
        );

        // The durable half of paying a reward (issue #9). Nothing enqueues into it
        // yet — loot, quests, and equipment still go through
        // `InventoryAuthority.pay()`, which is at-most-once and gives up quietly —
        // so what this does today is run the queue, the reconciler, and the
        // retention sweep against an empty table where they can be watched.
        //
        // Delivery is off unless a deployment turns it on. That is the sequencing
        // issue #9 asks for: the workers and the reconciliation ship, get observed
        // making no chain writes, and become the rollback floor before anything is
        // allowed to sign a mint.
        const outbox = openOutbox({
            store: this.database.rewardStore(),
            issuance: this.economy.issuance,
            // Asked at delivery, never stored from a client. A reward written down
            // while nobody could prove a wallet is paid once somebody can.
            addressOf: (characterId) => authority.addressOf(characterId),
            deliver: process.env.KEI_REWARD_DELIVERY === "on",
        });

        // There used to be a MySQL-only startup quarantine here, because that
        // adapter dropped and recreated `characters` on every boot and a reward id
        // names a character by an id that therefore meant somebody else after a
        // restart. `database/mysql.sql` no longer drops anything, so the reuse it
        // defended against cannot happen — and leaving it would have been worse
        // than useless: holding the whole pending queue on every boot means this
        // adapter never delivers a reward at all (issue #21).
        //
        // Nothing pending predates that change. Under the old code the last boot
        // that dropped the table also held everything then pending, and `held` is
        // terminal, so every row still pending was enqueued against the character
        // table that is now kept. `outbox.quarantine()` stays on the interface for
        // an operator who needs it.

        const rewardTicker = setInterval(() => {
            void outbox.drain().catch((error) => Logger.error("[outbox] a delivery pass failed", error));
        }, 5_000);
        const rewardSweeper = setInterval(() => {
            void outbox.compact().catch((error) => Logger.error("[outbox] compaction failed", error));
        }, 60_000);
        // Nothing here should hold the process open on its own.
        rewardTicker.unref?.();
        rewardSweeper.unref?.();

        //////////////////////////////////////////////////
        ///////////// COLYSEUS GAME SERVER ///////////////
        //////////////////////////////////////////////////
        const port = this.config.port;
        const app = express();

        // Which pages may call this server, rather than all of them (issue #22).
        //
        // Read before anything is mounted so a misspelt entry stops the server
        // here, where it says so, instead of turning into a CORS error in
        // somebody's console a week later.
        //
        // `credentials` is off, and that is a statement rather than a default:
        // no route on this server is authorized by anything a browser attaches
        // on its own. There are no session cookies, the login token is put in
        // the request by the client that holds it, and an order is authorized by
        // the unguessable id `/kei/order` handed back (issue #13). So there is
        // nothing here for a cross-site request to ride on, and asking browsers
        // to send credentials would be inventing the problem.
        const allowedOrigins = readAllowedOrigins(process.env);
        app.use(
            cors((request, done) => {
                done(null, {
                    origin: originAllowed(request.headers.origin, request.headers.host, allowedOrigins),
                    credentials: false,
                    methods: ["GET", "POST"],
                });
            })
        );
        Logger.info("[cors] " + describeOrigins(allowedOrigins));
        app.use(express.json());

        // The player's wallet lives in their browser and signs its own blocks,
        // so it needs a node it can reach over HTTP. On a mock that is us.
        if (chain.mock) mountNodeRpc(app, chain.mock);
        mountEconomyApi(app, this.economy);

        // create colyseus server
        const gameServer = new Server({
            transport: new WebSocketTransport({
                server: createServer(app),
            }),
        });

        // define all rooms
        gameServer.define("game_room", GameRoom);
        gameServer.define("chat_room", ChatRoom);

        // on localhost, simulate bad latency
        if (process.env.NODE_ENV !== "production") {
            Logger.info("[gameserver] Simulating 200ms of latency.");
            gameServer.simulateLatency(250);
        }

        // The net goes on here, and the position in this function is the whole
        // argument for it.
        //
        // Everything above this line is startup, and startup is supposed to be
        // fatal: `openStartupChain()` refuses rather than warns when the issuer
        // seed is missing, and that refusal reaches the process as an unhandled
        // rejection out of `init()`. A guard installed at the top of this file
        // would catch it and leave the server running without an issuer — turning
        // a fail-closed check into a fail-open one. Below this line there are
        // players connected, and the trade reverses: one request without an
        // answer is a much smaller loss than every room in the world.
        //
        // Do not move it earlier. `Failsafe.ts` argues the rest.
        keepProcessAlive();

        // listen
        gameServer.listen(port).then(() => {
            // server is now running
            Logger.info("[gameserver] listening on http://localhost:" + port);

            // create town room
            //matchMaker.createRoom("game_room", { location: "lh_town" });

            // create island room
            //matchMaker.createRoom("game_room", { location: "lh_dungeon_01" });
        });

        // start dev routes
        if (process.env.NODE_ENV !== "production") {
            // Loaded here rather than at the top of the file so a production
            // deployment does not need the package at all. The monitor is a
            // development tool that drags in @colyseus/core as a peer, and an
            // unauthenticated view of every room is not something to ship and
            // rely on an `if` to hide.
            const { monitor } = await import("@colyseus/monitor");
            app.use("/colyseus", monitor());

            // bind it as an express middleware
            //app.use("/playground", playground);
        }

        //////////////////////////////////////////////////
        //// SERVING CLIENT DIST FOLDER TO EXPRESS ///////
        /////////////////////////////////////////////////

        this.api = new Api(app, this.database);

        // Last, because Express dispatches error middleware in the order it was
        // added and one registered before a route never sees that route's errors.
        // This is what `guardRoute` hands a rejection to, and it is also the only
        // thing standing between a failed `res.sendFile` and Express's own default
        // handler, which writes the stack trace into the response body whenever
        // NODE_ENV is not "production".
        mountFailsafeResponder(app);
    }
}

new GameServer();
