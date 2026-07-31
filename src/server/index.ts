// Colyseus + Express
import { createServer } from "http";
import express from "express";
import cors from "cors";

import { Server, matchMaker } from "@colyseus/core";
import { monitor } from "@colyseus/monitor";

import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./rooms/GameRoom";
import { ChatRoom } from "./rooms/ChatRoom";

import { Api } from "./Api";
import { Database } from "./Database";

import { startEconomy, type Economy } from "./kei/Economy";
import { mountEconomyApi } from "./kei/api";
import { openChain, mountNodeRpc, resolveIssuerSeed } from "./kei/node";

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
        const chain = await openChain();
        this.economy = await startEconomy({
            seed: resolveIssuerSeed(),
            node: chain.node,
            // SPEC §8: the game must be playable with payments switched off.
            exchange: process.env.KEI_EXCHANGE !== "off",
        });

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
            // start monitor
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
