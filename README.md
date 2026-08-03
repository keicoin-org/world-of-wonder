# world-of-wonder

A multiplayer 3D top-down RPG whose **gold and items live on a chain instead of
in the game's database**. Fork it, rename it, and you have an MMO where a
player's sword is theirs rather than a row you could delete.

This is the `world-of-wonder` template behind `create-kei-game`, so the usual way
in is to let the scaffolder copy it and rename it for you:

```sh
npm create kei-game my-mmo -- --template world-of-wonder
```

Cloning this repository directly gets you the same files under the name
`world-of-wonder`. Everything below applies either way.

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

> **Status.** By default this settles on the public M3 testnet
> (`https://testnet.keicoin.org/rpc`) — a real network, best-effort, with weak
> consensus, no uptime promise, and Kei that is worth nothing. That default is
> deliberate: a player's wallet is meant to outlive your server, and it cannot do
> that against a chain living inside it. `KEI_NETWORK=mock` gives you the
> in-process chain instead, which is right offline. Mainnet is not open yet
> (SPEC §15).

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
| Selling | Server increments gold | Player signs the item away; the shop pays for what arrived |
| The vendor panel | Sends a room message | Signs with the player's wallet, and reads the purse off the chain |
| The bag panel | Reads `PlayerSchema.inventory` | Refreshes the player's on-chain item balances and purse |
| Player-to-player trade | Nothing upstream | An auction house. A listing is a block on the seller's own chain and a sale is one block that moves both legs |

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

### The wallet is the browser's

`Kei.start()` generates the player's seed on first run and keeps it in
localStorage, so there is no signup and no account to create — and clearing site
data loses the wallet, which is the other half of owning it. The game never holds
that key. That is why the vendor panel signs its own payments and reads the purse
off the chain instead of trusting a number the room sent it.

### Selling takes one, and there is no route for it

A sale is the player transferring the item to the shop, and the shop paying for
what arrived. There is deliberately no `POST /kei/sell`: the server can mint this
world's currency, so any endpoint that paid on request would be a printing press
for whoever found it. Reacting to an arrival costs the seller the item first,
which is the only version of this that a stranger cannot exploit. What the shop
pays is in the catalogue, so a client can still quote a price without asking.

### The auction house takes none

Players trading with each other is the part SPEC §9 says a hobbyist cannot build
safely, and here it is not built at all — it is `@keicoin/market`. Press **AH** in
the menu and the panel does three things, none of which passes through this
server:

- **List.** `market.offer()` writes one block on your own chain that locks the
  item. Not `market.sell()`, which prices in Kei — gold is an asset this world
  issues, so a listing is an item on one side and gold on the other. `sell()`
  would have compiled and quietly denominated the hall in a currency the game
  does not use.
- **Buy.** `market.accept()` writes one block that moves the item and the gold
  together or moves neither (SPEC §9.2). The seller signed their half; you sign
  yours. Nobody signs for anybody.
- **Cancel.** Only the author can, because theirs is the only asset locked. The
  lock is also why an abandoned listing is the seller's problem rather than the
  network's — there is no expiry clock to add (§9.3).

Price history is the settled swaps and nothing else. There is no time-series
table here, and the numbers under a listing were read back off the chain.

**What the server does is remember which chains to read.** An offer lives with
its author (§9.1) and Kei ships no indexer (§9.4), so there is no query for
"every listing in the world" — somebody has to keep the list of accounts worth
asking. That is `src/server/kei/Hall.ts`, and it is bookkeeping about *where to
look* rather than about who owns what, so it puts nobody back in custody of
anything. Two consequences, both real:

- **The hall is not the market.** It shows the listings of players it has heard
  of, which is fewer than every listing on the network. The panel says so
  instead of presenting its handful of offers as the whole book.
- **The roster is in memory, and capped.** A restart empties it, and it refills
  as players come back — a wallet announces itself when it opens and again
  whenever it lists, buys, or cancels. A listing by somebody who has not been
  seen since is invisible until they return, and locked by the ledger the whole
  time either way. The cap is 128 chains, least-recently-heard-from evicted,
  because announcing is unauthenticated and otherwise whoever posted last would
  decide how many node calls every refresh costs.

Nothing the hall says is taken on trust. A wallet re-reads the offer off the
chain before signing, rebuilds its title from the local catalogue, and refuses
unless the seller, item asset, quantity, and price are exactly the ones that
were on screen — so the worst a wrong hall can do is hide a listing or advertise
a dead one. It cannot substitute another item or cost anybody gold. That is the
property that makes it safe for this server to be involved at all, given it can
mint the currency being traded.

## Where things are

```
src/server/kei/Economy.ts       the issuer: gold, items, the shop. Read this one.
src/server/kei/Hall.ts          the auction house's list of chains to read. It signs nothing.
src/server/kei/api.ts           the HTTP surface. Nothing here can move a player's money.
src/server/kei/node.ts          which chain, and which account issues the money
src/server/kei/Economy.test.ts  the rules, against a chain in-process
src/server/kei/Market.test.ts   two players trading, with this server on neither leg
src/server/kei/endtoend.test.ts the same things across a URL, the way a browser does it
src/client/Controllers/Wallet.ts  the player's key, and the only thing that spends their gold
src/client/Controllers/UI/Panels/Dialog/VendorDialog.ts  the shop, as a player sees it
src/client/Controllers/UI/Panels/Panel_Auction.ts        the auction house, as a player sees it
src/client/Utils/index.ts       where the client looks for the server
```

## Tests

```sh
npm run test            # test:economy and test:market, both in-process
npm run server-start &
npm run test:e2e        # the same things over HTTP, sharing no memory with the server
```

`test:e2e` is the one worth trusting. It signs its own transfers against `/rpc`
and waits for the item to arrive, so passing it means a hosted client can work
rather than suggesting it might. It ends with two wallets trading a sword for
gold through the auction house across the same wire, which is the exact path the
panel takes.

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

Nano ID 3 removes the advisory, and an `overrides` entry does install it — npm
collapses the nested copy and `npm audit --omit=dev` comes back clean. It also
breaks the server. Nano ID 2 exported the function itself; 3 exports an object
of named functions, and `@colyseus/core` calls it the old way, so the built
server dies before it listens:

```
TypeError: (0 , import_nanoid5.default) is not a function
    at generateId3 (dist/server/index.mjs)
    at Object.setup            ← MatchMaker, assigning processId
    at new Server3
```

A clean audit bought by a server that exits 1 on startup is worse than the
advisory. npm's own suggested fix is the breaking Colyseus 0.17 line, which
wants `@colyseus/schema@^4` against the `^2.0.37` the eleven files that declare
`@type()` fields are written for, plus `colyseus.js` on the client moving in
lockstep with the wire format.

The remaining moderate is therefore documented rather than papered over, until a
tested Colyseus migration can replace the 0.15 networking stack. Rerun
`npm audit --omit=dev` whenever the dependencies or the lockfile change.

Everything else the audit used to report is gone rather than suppressed:

| | |
|---|---|
| `sqlite3` 5 → 6 | Swaps `node-pre-gyp` for `prebuild-install` and `node-gyp@12`, which takes `cacache`, `make-fetch-happen`, `http-proxy-agent`, and `@tootallnate/once` out of the tree entirely and moves `tar` to a patched 7.5.22 — the one critical and five of the highs, all of them in install-time machinery rather than in anything the server runs. It also sets the floor at Node 20.17. |
| `express` → 4.22.2 | `path-to-regexp`, `body-parser`, and `qs`. |
| dropped the `colyseus` umbrella | The two things imported from it, `generateId` and `Client`, are `@colyseus/core`'s own exports. The umbrella also pulled in `@colyseus/auth` → `grant` → `jwk-to-pem`/`request-oauth`, along with both Redis drivers, none of which this server mounts. |
| dropped `@bananocoin/bananojs` and `fs-extra` | The first now arrives through the SDK at one version instead of two; the second was imported nowhere. |
| dropped `dotenv-webpack` | Declared, never used, and the wrong tool for this repo: it inlines whatever is in `.env` into the browser bundle, and `.env` is where `KEI_GAME_SEED` lives. `webpack.common.js` reads `.env` with plain `dotenv` and passes exactly one variable through `DefinePlugin`. |
| `ws` | 7.5.13 under `@colyseus/core` and 8.21.1 under the transport and the client, both patched, once the tree above settles. |

Two development-only advisories are handled the same way: `copy-webpack-plugin`
moves to 14 for a fixed `serialize-javascript`, and `webpack-dev-server`'s
`sockjs` gets an `overrides` bump to `uuid@11`, which it uses only as
`require('uuid').v4()`.

The count, `npm audit` with everything included: 47 → 3, and all three are the
one `nanoid` chain above.

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
| `KEI_NETWORK` | `testnet` (default), `mainnet`, or `mock`. Mainnet is not open and has no faucet, so it stops with an explanation rather than settling elsewhere. |
| `KEI_NODE` | A node URL, overriding the public one for `KEI_NETWORK`. Unset is the normal case. |
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

- **Bids, and anything an auction is normally called.** The hall lists items for
  gold and settles them; it does not do timed auctions, reserve prices, or
  standing buy orders. `market.bid()` is the mirror of a sale and would be the
  next thing, and the panel does not read bids today, so a player who writes one
  by hand is invisible in it.

  Timed bidding in particular is not a small addition and should not be added
  casually: the block-lattice has no clock (SPEC §5.5), so "highest bid when the
  timer runs out" cannot be a consensus rule. It would have to be somebody's
  wall clock, and the somebody would be this server — which is the shape the
  rest of the file exists to avoid.
- **Equipping, loot and quest rewards still use upstream inventory state.** The
  bag and vendor now show the chain's item balances and purse, so anything bought
  or sold appears consistently in both. Gameplay rewards and equipped gear have
  not moved yet; they are deliberately not merged into the bag because that would
  make database rows look like on-chain ownership. Moving those producers and
  consumers across is the next slice.
- **The trainer still spends `player_data.gold`**, which is no longer money.
- **`construction/`** — 757MB of `.blend` and `.afdesign` art *source*, against
  28MB for the whole runtime game. Get it from
  [upstream](https://github.com/orion3dgames/t5c) if you need to edit the models.

## Licence

MIT, and upstream's copyright notice is retained in [`LICENSE`](LICENSE) as that
licence requires. The game systems, art, and world are `orion3dgames/t5c`'s work.
