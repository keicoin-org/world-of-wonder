const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const appDirectory = fs.realpathSync(process.cwd());
const CopyPlugin = require("copy-webpack-plugin");

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
            // The wallet reaches node-only modules through two libraries that
            // already know they might be in a browser, so the right answer is
            // "there is no such module" rather than a polyfill of it:
            //
            //   crypto     tweetnacl, under bananojs, under the SDK's signing.
            //              It tries the browser's WebCrypto first and only asks
            //              node for randomBytes if there is none.
            //   fs/promises  the SDK's IPFS helper, which reads a local file to
            //              hash it. It checks for node before importing, so in a
            //              browser the import never runs.
            //   http/https bananojs's own RPC client, reached only because it
            //              sits in the same entry point as the signing. Nothing
            //              here calls it — the SDK talks to a Kei node itself.
            crypto: false,
            "fs/promises": false,
            http: false,
            https: false,
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
        // `import('node:fs/promises')` is a URI as far as webpack is concerned,
        // so it fails as an unhandled scheme before any fallback is consulted.
        // Strip the prefix and it becomes an ordinary request that the fallback
        // above can answer.
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
            resource.request = resource.request.replace(/^node:/, "");
        }),
        new webpack.DefinePlugin({
            __GAME_SERVER__: JSON.stringify(GAME_SERVER),
        }),
        new CopyPlugin({
            patterns: [{ from: "public/", to: "./" }],
        }),
    ],
    mode: "development",
};
