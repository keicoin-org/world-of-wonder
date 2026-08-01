const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const appDirectory = fs.realpathSync(process.cwd());
const CopyPlugin = require("copy-webpack-plugin");

// The same `.env` the server reads, so one file documents the whole deployment.
// dotenv never overwrites a variable that is already set, so a value on the
// command line still wins.
//
// Only GAME_SERVER crosses into the bundle, and that is the point of naming it
// here rather than reaching for dotenv-webpack: that plugin inlines whatever it
// finds, and this `.env` is also where KEI_GAME_SEED lives.
require("dotenv").config();

// Where the built client should look for the game server. Empty means "wherever
// this page came from", which is right for `npm run client-dev` and wrong the
// moment the client is hosted somewhere the rooms are not.
//
//   GAME_SERVER=https://mmo.keicoin.org npm run client-build
const GAME_SERVER = process.env.GAME_SERVER || "";

module.exports = {
    entry: path.resolve(appDirectory, "src/client/index.ts"),
    output: {
        filename: "js/bundle.js",
        clean: true,
        path: path.resolve(__dirname, "dist/client"),
    },
    resolve: {
        extensions: [".tsx", ".ts", ".js"],
        fallback: {
            console: false,
            assert: false,
            util: false,
        },
        alias: {
            "@shared": path.resolve(__dirname, "../src/shared"),
        },
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                use: {
                    loader: "ts-loader",
                    options: {
                        //sourceMap: true,
                    },
                },
            },
        ],
    },
    plugins: [
        new webpack.DefinePlugin({
            __GAME_SERVER__: JSON.stringify(GAME_SERVER),
        }),
        new CopyPlugin({
            patterns: [{ from: "public/", to: "./" }],
        }),
    ],
    mode: "development",
};
