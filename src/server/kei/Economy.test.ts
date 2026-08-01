/**
 * The economy's one claim, tested: a player's gold and items are on the chain,
 * and the server cannot credit either. Run with `npm run test:economy`.
 *
 * This is not a unit test of the SDK — the SDK has its own. It is the check that
 * the shop's two-signature purchase actually settles, because that is the part
 * a game developer copying this template will get wrong.
 */

import { Kei } from 'kei-transaction'

import { startEconomy, STARTING_GOLD } from './Economy'

const ISSUER_SEED = 'A'.repeat(64)
const PLAYER_SEED = 'B'.repeat(64)

let failures = 0

function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** The settlement is a chain round trip, so it is not instant. */
async function until(predicate: () => Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

const node = await Kei.mock({})

const economy = await startEconomy({ seed: ISSUER_SEED, node, network: 'mock' })
const player = await Kei.start({ node, seed: PLAYER_SEED })

const catalogue = economy.catalogue()
check('the shop has a catalogue', catalogue.items.length > 0, `${catalogue.items.length} items`)
check('gold is a real asset', catalogue.coin.asset.length === 64)
check('the issuer is not the player', economy.address !== player.address)

// A new character is granted its starting gold. This is a mint the issuer signs
// — the one thing a game server legitimately can do.
await economy.grant(player.address, STARTING_GOLD)
await player.sync()
const gold = await player.token.get(catalogue.coin.asset)
check('the player was granted gold', (await gold.balance()) === STARTING_GOLD, `${await gold.balance()}`)
check('the chain agrees', (await economy.goldOf(player.address)) === STARTING_GOLD)

// Buying. The player signs the transfer; the issuer signs the delivery.
const sword = catalogue.items.find((item) => item.key === 'sword_01')!
const order = await economy.order(player.address, 'sword_01')
check('the order quotes the list price', order.price === sword.value, `${order.price}`)
check('the order is payable to the issuer', order.to === economy.address)

const before = await gold.balance()
await gold.transfer(order.to, order.price)

const delivered = await until(async () => {
  const inventory = await economy.inventoryOf(player.address)
  return (inventory['sword_01'] ?? 0) >= 1
})
check('the sword was delivered after the gold landed', delivered)

await player.sync()
check('the player paid for it', (await gold.balance()) === before - order.price, `${await gold.balance()}`)

const inventory = await economy.inventoryOf(player.address)
check('the inventory is read from the chain', (inventory['sword_01'] ?? 0) === 1)

// An order that is not paid for delivers nothing. The order is not the purchase.
// Priced so the player can afford it — being refused here would prove nothing.
await economy.order(player.address, 'potion_small_red')
const notDelivered = await until(async () => {
  const held = await economy.inventoryOf(player.address)
  return (held['potion_small_red'] ?? 0) >= 1
}, 1_000)
check('an unpaid order delivers nothing', !notDelivered)

// A player who cannot afford it is told so rather than quietly served.
let refused = ''
try {
  await economy.order(player.address, 'shield_01' /* 2000, and they have 400 */)
} catch (error) {
  refused = (error as Error).message
}
check('being too poor is an error that says so', refused.includes('gold and you have'), refused)

// Selling is the same trade backwards, and it is worth being precise about why
// it looks like this. The server can mint its own currency, so any call that
// paid a player on request would be a printing press — the only safe trigger is
// something the player cannot fake and the shop cannot fake for them. So there
// is no sell call at all: the player parts with the item, and the shop pays for
// what arrived.
const purse = await gold.balance()
check('the shop quotes what it pays', sword.buyback === Math.floor(sword.value / 2), `${sword.buyback}`)

await player.items.transfer(sword.asset, economy.address)

const settled = await until(async () => {
  await player.sync()
  return (await gold.balance()) > purse
})
check('the shop paid for the sword it was sent', settled)
check('a sale pays the quoted price', (await gold.balance()) === purse + sword.buyback, `${await gold.balance()}`)

const afterSale = await economy.inventoryOf(player.address)
check('and the sword is no longer the player\'s', (afterSale['sword_01'] ?? 0) === 0, `${afterSale['sword_01'] ?? 0}`)

economy.close()
console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
