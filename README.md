# kei-mmo-template

A multiplayer 3D top-down RPG whose **gold and items live on a chain instead of
in the game's database**. Fork it, rename it, and you have an MMO where a
player's sword is theirs rather than a row you could delete.

It is a fork of [`orion3dgames/t5c`](https://github.com/orion3dgames/t5c) — a
real Babylon.js + Colyseus RPG with movement, combat, quests, loot, a navmesh, a
vendor, and a UI. All of that is upstream's work and still upstream's. What this
fork replaces is the economy.

```sh
npm install
npm run server-build && npm run server-start   # http://localhost:3000
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

Nano ID 3 removes the advisory but changes its CommonJS export and makes
Colyseus 0.15 fail at startup. npm's suggested fix is the breaking Colyseus
0.17 line. The remaining moderate is therefore documented until a tested
Colyseus migration can replace the legacy networking stack; rerun the audit
whenever dependencies or the lockfile change.

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
| `NODE_ENV` | `production` closes `/kei/grant` and never loads the Colyseus monitor. |

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
