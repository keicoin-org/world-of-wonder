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

import { startEconomy, type Economy } from "./kei/Economy";
import { mountEconomyApi } from "./kei/api";
import { mountNodeRpc, openStartupChain } from "./kei/node";
import { openInventoryAuthority, proofUnavailable, useInventoryAuthority } from "./kei/Inventory";

import Logger from "./utils/Logger";
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
        useInventoryAuthority(
            openInventoryAuthority({
                economy: this.economy,
                verify: proofUnavailable,
                payments: {
                    paid: (id) => this.database.hasPaidReward(id),
                    record: (entry) => this.database.recordRewardPayment(entry),
                },
            })
        );
        Logger.warning(
            "[kei] wallet-session proof is not built yet, so no character is bound to an address: loot, quest rewards and pickups are refused rather than written to the database (issue #6)"
        );

        //////////////////////////////////////////////////
        ///////////// COLYSEUS GAME SERVER ///////////////
        //////////////////////////////////////////////////
        const port = this.config.port;
        const app = express();
        app.use(cors());
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
    }
}

new GameServer();
