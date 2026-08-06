/**
 * The economy's one claim, tested: a player's gold and items are on the chain,
 * and the server cannot credit either. Run with `npm run test:economy`.
 *
 * This is not a unit test of the SDK — the SDK has its own. It is the check that
 * the shop's two-signature purchase actually settles, because that is the part
 * a game developer copying this template will get wrong.
 */

import { Kei } from 'kei-transaction'

import { issuanceCost, startEconomy, STARTING_GOLD } from './Economy'
import { ItemsDB } from '../data/ItemDB'

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

// --------------------------------------------------------------- issue #24
//
// What starting this world costs in Kei, measured rather than asserted about.
//
// `startEconomy` drew exactly `issuanceCost(assets)` from the faucet, because it
// held nothing and that is what it asked for. So whatever is left in the issuer's
// account afterwards is the gap between what the arithmetic thought issuing costs
// and what the chain charged for it. It has to be nothing.
//
// The number that was here before asked for 10,100 against a real burn of 55, on
// the strength of a flat 1,000-Kei rule the n-Kei rule had already replaced. A
// check that only asserted "enough" would have passed on it — this one is the
// reason the faucet cannot quietly drift again, in either direction.
const assets = Object.keys(ItemsDB).length + 1
const issuer = await Kei.server({ seed: ISSUER_SEED, node, network: 'mock' })
const spare = await issuer.balance()
issuer.close()
check(
  'issuing this world burned exactly what the faucet was asked for',
  spare === 0,
  `${issuanceCost(assets)} drawn for ${assets} assets, ${spare} left over`,
)
// A restart issues nothing, because issuance is idempotent per (issuer, symbol),
// so it must not draw on a rate-limited faucet for issuances it will not perform.
check('a restart needs no funding at all', issuanceCost(assets, assets) === 0)
check('and one more item type costs one more escalating burn', issuanceCost(assets + 1, assets) === assets + 1)

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

// --------------------------------------------------------------- issue #13
//
// An order is not a slot on an address, and the shop keeps no gold it did not
// sell something for.
//
// It used to be both: `orders` held one entry per address, so a second order
// replaced the first, and an arriving payment was matched against whatever was
// in that slot when it landed. Placing an order needs nothing but an address,
// and an address is printed on every hall listing — so anybody could change
// what somebody else's next payment bought, and because the match only asked
// that the payment *cover* the order, the difference between the two prices was
// kept rather than returned.
//
// A fresh wallet, so these checks are about the orders made below and not about
// anything left over from the purchases above.
const shopper = await Kei.start({ node, seed: 'E'.repeat(64) })
await economy.grant(shopper.address, 1_000)
await shopper.sync()
const purseOf = await shopper.token.get(catalogue.coin.asset)
const potion = catalogue.items.find((item) => item.key === 'potion_small_red')!

const wanted = await economy.order(shopper.address, 'potion_small_red')
// The meddling order: same address, cheaper item, placed after. This is exactly
// what a stranger spraying the route achieves, and what a player who clicks Buy
// on a second item does to themselves.
const meddled = await economy.order(shopper.address, 'sword_01')
check('two orders for one address are two orders', wanted.id !== meddled.id, `${wanted.id} / ${meddled.id}`)
check('and the second does not replace the first', economy.orderStatus(wanted.id)?.state === 'open')
check('the order id is not guessable from the address', wanted.id.length === 48 && !wanted.id.includes(shopper.address))

const spendable = await purseOf.balance()
await purseOf.transfer(wanted.to, wanted.price)

const gotPotion = await until(async () => {
  const held = await economy.inventoryOf(shopper.address)
  return (held['potion_small_red'] ?? 0) >= 1
})
check('the payment bought what its own order said', gotPotion)
const afterMeddling = await economy.inventoryOf(shopper.address)
check('and not what a later order said', (afterMeddling['sword_01'] ?? 0) === 0, `${afterMeddling['sword_01'] ?? 0}`)
check('the order that was paid for is the one that settled', economy.orderStatus(wanted.id)?.state === 'delivered')
check('the other one still waits for its own payment', economy.orderStatus(meddled.id)?.state === 'open')
await shopper.sync()
check('the shopper paid the potion price and no more', (await purseOf.balance()) === spendable - potion.value, `${await purseOf.balance()}`)

// Overpaying is the 990-gold half of the report. `meddled` is still open and
// costs 100; this sends 400 at it. There is no branch that keeps the difference,
// because there is no branch that matches the payment at all.
const beforeOverpaying = await purseOf.balance()
await purseOf.transfer(economy.address, 400)
const overpaymentReturned = await until(async () => {
  await shopper.sync()
  return (await purseOf.balance()) === beforeOverpaying
})
check('an overpayment comes back rather than being kept', overpaymentReturned, `${await purseOf.balance()}`)
check('and it delivers nothing', ((await economy.inventoryOf(shopper.address))['sword_01'] ?? 0) === 0)
check('the order it did not match is untouched', economy.orderStatus(meddled.id)?.state === 'open')

// Two live orders that would cost the same and deliver different things. The
// shop cannot know which one the gold was for — so it does not choose, because
// choosing wrong is the whole of this bug and a refund never is.
const twoPotions = await economy.order(shopper.address, 'potion_small_red', 2)
const threeSwords = await economy.order(shopper.address, 'sword_01', 3)
check('both cost the same, which is what makes it ambiguous', twoPotions.price === threeSwords.price, `${twoPotions.price} / ${threeSwords.price}`)
const beforeTie = await purseOf.balance()
await purseOf.transfer(economy.address, twoPotions.price)
const tieReturned = await until(async () => {
  await shopper.sync()
  return (await purseOf.balance()) === beforeTie
})
check('an ambiguous payment comes back rather than being guessed at', tieReturned, `${await purseOf.balance()}`)
check(
  'and both of the tied orders are marked returned',
  economy.orderStatus(twoPotions.id)?.state === 'refunded' && economy.orderStatus(threeSwords.id)?.state === 'refunded',
)
check('with a reason a player can read', (economy.orderStatus(twoPotions.id)?.reason ?? '').includes('could not tell'))

// An id nobody was given is an id about which there is nothing to say.
check('an invented order id reads as nothing', economy.orderStatus('f'.repeat(48)) === undefined)

// --------------------------------------------------------------- issue #37
//
// `ItemsDB` is a plain object literal, so `ItemsDB['toString']` and
// `ItemsDB['__proto__']` are both truthy without naming a real item — a bare
// `if (!data)` treats either as a catalogue hit, priced at `undefined ?? 0`,
// which is a free item. `order()` has to refuse a key it does not own the
// same way it refuses one that is merely absent.
for (const key of ['toString', '__proto__', 'constructor', 'not_a_real_item']) {
  let refusedPrototypeKey = ''
  try {
    await economy.order(shopper.address, key)
  } catch (error) {
    refusedPrototypeKey = (error as Error).message
  }
  check(`ordering "${key}" is refused like an unknown item, not priced free`, refusedPrototypeKey.includes('does not sell'), refusedPrototypeKey)
}

// A server lifetime ends while its ledger does not. Reopening the same economy
// with the stable issuer must recognize exactly the same asset family.
const firstLifetime = economy.catalogue()
economy.close()
const restarted = await startEconomy({ seed: ISSUER_SEED, node, network: 'mock' })
const secondLifetime = restarted.catalogue()
const firstSword = firstLifetime.items.find((item) => item.key === 'sword_01')!
const secondSword = secondLifetime.items.find((item) => item.key === 'sword_01')!
check('issuer is stable across economy lifetimes', secondLifetime.issuer === firstLifetime.issuer)
check('gold asset is stable across economy lifetimes', secondLifetime.coin.asset === firstLifetime.coin.asset)
check('item asset is stable across economy lifetimes', secondSword.asset === firstSword.asset)
restarted.close()
console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
