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
npm run link-sdk       # once — links ../kei-transaction (SPEC §10.5)
npm run server-build && npm run server-start   # http://localhost:3000
npm run client-dev                              # http://localhost:8080
```

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
| Selling | Server increments gold | Player signs the item away; the shop pays for what arrived |
| The vendor panel | Sends a room message | Signs with the player's wallet, and reads the purse off the chain |

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

## Where things are

```
src/server/kei/Economy.ts       the issuer: gold, items, the shop. Read this one.
src/server/kei/api.ts           the HTTP surface. Nothing here can move a player's money.
src/server/kei/node.ts          which chain, and which account issues the money
src/server/kei/Economy.test.ts  the rules, against a chain in-process
src/server/kei/endtoend.test.ts the same thing across a URL, the way a browser does it
src/client/Controllers/Wallet.ts  the player's key, and the only thing that spends their gold
src/client/Controllers/UI/Panels/Dialog/VendorDialog.ts  the shop, as a player sees it
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
- **The bag still shows upstream's inventory.** The vendor is wholly on the chain
  now — the purse it counts, the wares it sells, and what it will buy back all
  come from there — but the inventory panel, equipping, loot and quest rewards
  are still the database's. So a sword bought from a vendor is yours on the chain
  and will not appear in the bag, and the gold in the bag's corner is not the
  gold the vendor counts. The vendor shows its own numbers rather than papering
  over the difference. Moving the bag across is the next slice, and the awkward
  half-state until then is the honest way round: the chain is right and the panel
  is behind, not the reverse.
- **The trainer still spends `player_data.gold`**, which is no longer money.
- **`construction/`** — 757MB of `.blend` and `.afdesign` art *source*, against
  28MB for the whole runtime game. Get it from
  [upstream](https://github.com/orion3dgames/t5c) if you need to edit the models.

## Licence

MIT, and upstream's copyright notice is retained in [`LICENSE`](LICENSE) as that
licence requires. The game systems, art, and world are `orion3dgames/t5c`'s work.
