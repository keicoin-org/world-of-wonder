# kei-mmo-template

A multiplayer 3D top-down RPG whose **gold and items live on a chain instead of
in the game's database**. Fork it, rename it, and you have an MMO where a
player's sword is theirs rather than a row you could delete.

It is a fork of [`orion3dgames/t5c`](https://github.com/orion3dgames/t5c) — a
real Babylon.js + Colyseus RPG with movement, combat, quests, loot, a navmesh, a
vendor, and a UI. All of that is upstream's work and still upstream's. What this
fork replaces is the economy.

Node 20.17 or newer.

```sh
npm ci
cp .env.example .env                            # optional — everything has a default
npm run server-build && npm run server-start    # http://localhost:3000
npm run client-dev                              # http://localhost:8080
```

The released `kei-transaction` SDK is a normal npm dependency. A clean clone
does not need a sibling checkout or a link step; CI installs exactly the locked
dependency tree with `npm ci`.

> **Status.** The chain underneath is an in-memory mock served at `/rpc` by the
> game server. It dies when you stop the process and nothing here is worth
> anything. M3 points it at a real node, and nothing above that line changes.

## What changed from upstream

t5c kept `gold` as a `uint32` on `PlayerSchema` and inventory in a
`character_inventory` table. That is the ordinary way to build this, and it means
the developer owns every player's belongings — "you own this item" is then a
promise about your intentions, not a fact about the world.

| | Upstream | Here |
|---|---|---|
| Gold | `PlayerSchema.gold`, saved to SQLite | A Kei token. `balanceOf` is the only source of truth. |
| Inventory | `character_inventory` rows | One 0-decimal asset per item archetype; owning a sword is holding a unit of it. |
| Buying | Server decrements gold, adds a row | Player signs a transfer; the issuer mints **after** the chain confirms it |
| Selling | Server increments gold | The shop mints the payment; the item moves only if its owner moves it |

The database is still there, and deliberately: it holds accounts, characters, and
where they were standing. Colyseus is still authoritative over presence and
position. Neither is authoritative over money, which is the whole point
(SPEC §8).

### Buying takes two signatures

The game cannot sign for a player's wallet, so a purchase is always the player
signing a transfer and the issuer signing a delivery (SPEC §6.3). A transfer
carries no memo, so the shop records the order first and matches the arrival to
it — and delivers nothing until the chain says the gold landed.

**The order is not the purchase.** `src/server/kei/Economy.test.ts` holds the
code to that: an unpaid order delivers nothing, and a player who cannot afford
something is refused in a sentence they can act on.

## Where things are

```
src/server/kei/Economy.ts       the issuer: gold, items, the shop. Read this one.
src/server/kei/api.ts           the HTTP surface. Nothing here can move a player's money.
src/server/kei/node.ts          which chain, and which account issues the money
src/server/kei/Economy.test.ts  the rules, against a chain in-process
src/server/kei/endtoend.test.ts the same thing across a URL, the way a browser does it
src/client/Utils/index.ts       where the client looks for the server
```

## Tests

```sh
npm run test:economy    # the rules, in-process
npm run server-start &
npm run test:e2e        # the same thing over HTTP, sharing no memory with the server
```

`test:e2e` is the one worth trusting. It signs its own transfers against `/rpc`
and waits for the item to arrive, so passing it means a hosted client can work
rather than suggesting it might.

## Dependency security

CI rejects high and critical production advisories. `npm audit --omit=dev`
currently reports one moderate advisory chain: `@colyseus/ws-transport` →
`@colyseus/core@0.15.57` → `nanoid@2.1.11`
([GHSA-mwcw-c2x4-8c55](https://github.com/advisories/GHSA-mwcw-c2x4-8c55)).
The advisory concerns predictable output when Nano ID is passed a non-integer
length. This application and Colyseus call `generateId()` without an argument,
which uses the integer default `9`, so the affected input is not reachable here.

The advisory is confined to that one nested copy. This project's own `nanoid`
import is a direct dependency held at `^3.3.8` — the first patched release — so
the code in `src/` resolves to 3.3.16 and is out of range regardless of what
Colyseus carries underneath it.

Nano ID 3 removes the advisory and cannot be forced into place. Its CommonJS
export is an object of named functions where 2.x exported the function itself,
and `@colyseus/core` calls it as one — with `overrides` pointing that dependency
at `^3.3.8`, `generateId()` throws
`TypeError: (0 , import_nanoid.default) is not a function`. `MatchMaker` calls
it while assigning `processId`, so the server dies on `listen()` rather than
somewhere quiet. Widening that to a top-level `"nanoid"` override does not even
get as far as running: npm refuses it with `EOVERRIDE — Override for
nanoid@^3.0.0 conflicts with direct dependency`. npm's own suggested fix is the
breaking Colyseus 0.17 line, which wants `@colyseus/schema@^4` against the
`^2.0.37` the eleven files that declare `@type()` fields are written for, plus
`colyseus.js` on the client moving in lockstep with the wire format.

The remaining moderate is therefore documented rather than papered over, until a
tested Colyseus migration can replace the 0.15 networking stack. Rerun
`npm audit --omit=dev` whenever the dependencies or the lockfile change.

Everything else the audit used to report is gone rather than suppressed:

| | |
|---|---|
| `sqlite3` 5 → 6 | Drops `node-gyp`, and with it `tar`, `cacache`, `make-fetch-happen`, `http-proxy-agent`, and `@tootallnate/once` — one critical and five more advisories, none of them in code that ever ran. |
| `express` → 4.22.2 | `path-to-regexp`, `body-parser`, and `qs`. |
| dropped the `colyseus` umbrella | The two things imported from it, `generateId` and `Client`, are `@colyseus/core`'s own exports. The umbrella also pulled in `@colyseus/auth` → `grant` → `jwk-to-pem`/`request-oauth`, along with both Redis drivers, none of which this server mounts. |
| dropped `@bananocoin/bananojs` and `fs-extra` | The first now arrives through the SDK at one version instead of two; the second was imported nowhere. |
| `ws` | Resolves to 7.5.13 and 8.21.1, both patched, once the tree above is settled. |

Two development-only advisories are handled the same way: `copy-webpack-plugin`
moves to 14 for a fixed `serialize-javascript`, and `webpack-dev-server`'s
`sockjs` gets an `overrides` bump to `uuid@11`, which it uses only as
`require('uuid').v4()`.

## Hosting it

The client is static and the rooms are not, so they usually end up on different
origins. Upstream derived both URLs from `window.location`; here the origin is a
build-time setting:

```sh
GAME_SERVER=https://mmo.example.org npm run client-build
```

With `GAME_SERVER` unset the old same-origin behaviour applies, which is what
`client-dev` wants.

The server is one bundled file. It reads `public/` and `database/` from its
working directory, so start it from the project root:

| Variable | |
|---|---|
| `KEI_GAME_SEED` | 64 hex characters. **This is the economy** — whoever holds it can mint this world's currency without limit. Without one a seed is generated per run, so every asset id changes on restart. |
| `KEI_NODE` | A node URL. Unset means an in-process mock served at `/rpc`, which dies with the process. |
| `KEI_EXCHANGE` | `off` disables paying Kei for gold. SPEC §8 requires the game to be playable with payments off. |
| `NODE_ENV` | `production` closes `/kei/grant`, never loads the Colyseus monitor, and turns off the latency simulation. |
| `DATABASE_PATH` | Where sqlite keeps accounts and characters. Defaults to `./database.db`. |
| `DATABASE_HOST` `DATABASE_DB` `DATABASE_USER` `DATABASE_PASSWORD` | mysql, read only when `database` in `src/shared/Config.ts` is `"mysql"`. |
| `GAME_SERVER` | Build-time, not runtime — see above. |
| `KEI_TEST_BASE` | What `test:e2e` points at. Defaults to `http://localhost:3000`. |

Both halves read `.env`, and a variable already in the environment beats a line
in it. [`.env.example`](.env.example) is the full list with the reasoning; it
holds no secrets and is safe to commit.

The listen port is `port` in `src/shared/Config.ts`, not an environment
variable. A host that assigns you a port expects that file to be edited.

## What is not here yet

- **The auction house.** SPEC §10.3 specifies it on `@keicoin/market`, which is
  M5 and does not exist. Building a database-backed one in the meantime would
  contradict everything above, so there is nothing rather than a lie.
- **The vendor UI still reads upstream's inventory.** The chain is authoritative
  on the server and over HTTP; the Babylon panels have not been rewritten to
  read from it yet.
- **`construction/`** — 757MB of `.blend` and `.afdesign` art *source*, against
  28MB for the whole runtime game. Get it from
  [upstream](https://github.com/orion3dgames/t5c) if you need to edit the models.

## Licence

MIT, and upstream's copyright notice is retained in [`LICENSE`](LICENSE) as that
licence requires. The game systems, art, and world are `orion3dgames/t5c`'s work.
