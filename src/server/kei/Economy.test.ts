/**
 * The economy's one claim, tested: a player's gold and items are on the chain,
 * and the server cannot credit either. Run with `npm run test:economy`.
 *
 * This is not a unit test of the SDK — the SDK has its own. It is the check that
 * the shop's two-signature purchase actually settles, because that is the part
 * a game developer copying this template will get wrong.
 */

import { Kei } from 'kei-transaction'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { issuanceCost, startEconomy, STARTING_GOLD, type ShopDebt } from './Economy'
import { ItemsDB } from '../data/ItemDB'
import { Database } from '../Database'
import { Config } from '../../shared/Config'

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

// A rejection nobody caught is the whole of issue #28's second half — an
// unhandled rejection out of the detached listener `kei.on('asset-received', ...)`
// registers is fatal on this Node version with nothing in `src/` to catch it.
// Counted here rather than asserted against immediately, so every check below
// that deliberately makes the chain fail can share one proof at the end that
// none of those failures ever escaped as one.
let unhandled = 0
process.on('unhandledRejection', (reason) => {
  unhandled += 1
  console.log('  note  an unhandled rejection reached the process:', reason)
})

// A real, file-backed database — same as Outbox.test.ts — because the point
// of the new `shop_debts` table is that it outlives this process. A row
// written through `Economy.ts`'s `recordDebt` port has to still be there when
// a *different* `Database` instance, pointed at the same file, reads it back.
const directory = mkdtempSync(join(tmpdir(), 'wow-economy-'))
process.env.DATABASE_PATH = join(directory, 'test.db')
const database = new Database(new Config())
await database.init()
await database.create()
// `createDatabase()` fires its statements without awaiting them individually.
await new Promise((resolve) => setTimeout(resolve, 250))

const node = await Kei.mock({})

const economy = await startEconomy({
  seed: ISSUER_SEED,
  node,
  network: 'mock',
  recordDebt: (debt) => database.recordShopDebt(debt),
})
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

// --------------------------------------------------------------- issue #29
//
// A refund that cannot actually send must not tell a player it did. `refund`
// used to resolve normally whether or not the transfer confirmed, and
// `settleGold` set `order.state = 'refunded'` — the player-facing claim that
// the gold came back — before it had even tried. Below, `gold.transfer` is
// made to fail by rejecting the one block it would produce, and the same
// order is watched through both outcomes: a mint failure whose refund still
// works, and one whose refund also fails.
//
// There is no seam in `Economy.ts` for this — `gold` and `itemTokens` are
// closed over, not exposed — so the failure is injected at the one place
// every one of the shop's own transfers, mints, and burns actually has to
// pass through: the mock node's `process`. Both economies in this file share
// one `MockNode`, so this reaches the shop without reaching into it.
const goldAsset = economy.catalogue().coin.asset

/** Rejects the next block matching `matches`, until `restore()` is called. */
function failWhile(matches: (block: any) => boolean, message: string): () => void {
  const original = node.process.bind(node)
  ;(node as any).process = async (block: any) => {
    if (matches(block)) throw new Error(message)
    return original(block)
  }
  return () => {
    ;(node as any).process = original
  }
}

const isSend = (asset: string, kind: 'mint' | 'transfer') => (block: any) =>
  block?.type === 'asset' && block.op?.kind === kind && block.op?.asset === asset && block.account === economy.address

const refundee = await Kei.start({ node, seed: 'F'.repeat(64) })
await economy.grant(refundee.address, 4_000)
await refundee.sync()
const refundeePurse = await refundee.token.get(goldAsset)
const helm = economy.catalogue().items.find((item) => item.key === 'helm_01')!

// Case A: the item cannot be minted, but the refund still can. This is the
// path that already worked before this fix, and it must keep working exactly
// the same way — `refund-failed` must never appear when a refund succeeds.
const orderA = await economy.order(refundee.address, 'helm_01')
const stopFailingMintA = failWhile(isSend(helm.asset, 'mint'), 'simulated mint failure')
await refundeePurse.transfer(orderA.to, orderA.price)
const refundedA = await until(async () => economy.orderStatus(orderA.id)?.state !== 'open')
stopFailingMintA()
check('a mint failure with a working refund still resolves', refundedA, economy.orderStatus(orderA.id)?.state)
check('and reports refunded, not refund-failed', economy.orderStatus(orderA.id)?.state === 'refunded')
check(
  "and the reason a player reads still says the gold came back",
  (economy.orderStatus(orderA.id)?.reason ?? '').includes('has been returned'),
  economy.orderStatus(orderA.id)?.reason,
)
check('a refund that succeeds is not written down as a debt', (await database.shopDebtsFor(refundee.address)).length === 0)

// Case B: the item cannot be minted, and the refund cannot send either. This
// is the lie issue #29 is about — before the fix, this order would still have
// read 'refunded' with "your gold has been returned" while the gold sat with
// the shop.
const orderB = await economy.order(refundee.address, 'helm_01')
const stopFailingB = failWhile(
  (block) => isSend(helm.asset, 'mint')(block) || isSend(goldAsset, 'transfer')(block),
  'simulated mint and refund failure',
)
await refundeePurse.transfer(orderB.to, orderB.price)
const settledB = await until(async () => economy.orderStatus(orderB.id)?.state !== 'open')
stopFailingB()
check('a mint and refund failure still resolves the order rather than hanging it open', settledB, economy.orderStatus(orderB.id)?.state)
check('and reports refund-failed rather than the old lie of "refunded"', economy.orderStatus(orderB.id)?.state === 'refund-failed')
check(
  'the reason never claims the gold came back',
  !(economy.orderStatus(orderB.id)?.reason ?? '').includes('has been returned'),
  economy.orderStatus(orderB.id)?.reason,
)
check(
  'and says the shop still owes it, naming the order',
  (economy.orderStatus(orderB.id)?.reason ?? '').includes('still owes') && (economy.orderStatus(orderB.id)?.reason ?? '').includes(orderB.id),
  economy.orderStatus(orderB.id)?.reason,
)
await refundee.sync()
check(
  "the player's gold really is still with the shop, matching what was written down",
  (await refundeePurse.balance()) === 4_000 - orderB.price,
  `${await refundeePurse.balance()}`,
)

const debtsB = await database.shopDebtsFor(refundee.address)
check('the failed refund left exactly one durable debt', debtsB.length === 1, JSON.stringify(debtsB))
check('naming the right amount', debtsB[0]?.amount === orderB.price, `${debtsB[0]?.amount} vs ${orderB.price}`)
check('and an order id a player could quote for support', (debtsB[0]?.reason ?? '').includes(orderB.id))

// `orders`' own TTL (`ORDER_TTL_MS`) forgets the order 120 seconds after it was
// placed, and a restart forgets every order immediately — but the debt above
// was never stored in `orders`, so neither erases it. What proves that below is
// a *different* `Database` instance reading the same file back, the same proof
// `Outbox.test.ts` uses for its own durable tables, folded into the restart
// check this file already does further down (`restartedDatabase`).

// --------------------------------------------------------------- issue #28
//
// The buyback path used to be a detached `void (async () => {...})()` with no
// `.catch` — a rejection from `gold.mint` or an item's `transfer` was, on this
// Node version, an unhandled rejection with nothing in `src/` catching it,
// which is fatal. Below, both failure branches are forced and the process is
// watched (via the `unhandledRejection` counter installed at the top of this
// file) rather than trusted to still be here by assumption.
const seller = await Kei.start({ node, seed: 'C'.repeat(64) })
const hat = economy.catalogue().items.find((item) => item.key === 'hat_01')!
const sellerPurse = await seller.token.get(goldAsset)
await economy.grant(seller.address, hat.value)
await seller.sync()
const hatOrder = await economy.order(seller.address, 'hat_01')
await sellerPurse.transfer(hatOrder.to, hatOrder.price)
await until(async () => (await economy.inventoryOf(seller.address))['hat_01'] === 1)

// Sell it back while the shop's payout mint is made to fail. The hat has
// already left the seller's wallet the moment it arrives — that is what an
// arrival is — so a failed payout here is a debt, not a no-op. The patch
// stays live until the debt itself shows up: the item leaves the seller as
// soon as the transfer lands, well before the shop even attempts the mint, so
// gating on inventory instead would race ahead of the failure this is trying
// to force.
const beforeSale = await sellerPurse.balance()
const stopFailingBuyback = failWhile(isSend(goldAsset, 'mint'), 'simulated buyback payout failure')
await seller.items.transfer(hat.asset, economy.address)
const buybackDebt = await until(async () => (await database.shopDebtsFor(seller.address)).some((debt) => debt.kind === 'gold'))
stopFailingBuyback()
check('a failed buyback payout is written down rather than lost', buybackDebt)
check('the hat left the seller even though the payout failed', ((await economy.inventoryOf(seller.address))['hat_01'] ?? 0) === 0)
const buybackDebts = (await database.shopDebtsFor(seller.address)).filter((debt) => debt.kind === 'gold')
check('naming the gold owed', buybackDebts[0]?.amount === hat.buyback, `${buybackDebts[0]?.amount} vs ${hat.buyback}`)
check('and naming the item and quantity in the reason', (buybackDebts[0]?.reason ?? '').includes('hat_01') || (buybackDebts[0]?.reason ?? '').includes(hat.title))
await seller.sync()
check("the seller was never paid for it — the debt matches reality, not a guess", (await sellerPurse.balance()) === beforeSale)

// A non-sellable item's return failing is a silent confiscation today if it
// is not caught the same way. Nothing in `ItemsDB` is non-sellable right now,
// so `sellable` is flipped off for one item just for this check and restored
// immediately after — the shop's refusal branch is real code with no other
// way to reach it.
const held = economy.catalogue().items.find((item) => item.key === 'armor_01')!
await economy.deliver(seller.address, 'armor_01', 1)
;(ItemsDB.armor_01 as any).sellable = false
const stopFailingReturn = failWhile(isSend(held.asset, 'transfer'), 'simulated held-item return failure')
await seller.items.transfer(held.asset, economy.address)
const heldDebt = await until(async () => (await database.shopDebtsFor(seller.address)).some((debt) => debt.kind === 'item' && debt.key === 'armor_01'))
stopFailingReturn()
;(ItemsDB.armor_01 as any).sellable = true
check('a refused item the shop could not return is held-and-owed, not silently dropped', heldDebt)
check('and it still leaves the seller even though the shop could not hand it back', ((await economy.inventoryOf(seller.address))['armor_01'] ?? 0) === 0)
const itemDebts = (await database.shopDebtsFor(seller.address)).filter((debt) => debt.kind === 'item')
check('naming the payer, the item and the quantity', itemDebts[0]?.address === seller.address && itemDebts[0]?.key === 'armor_01' && itemDebts[0]?.amount === 1)

// Nothing above was allowed to take the process with it, and an unrelated
// order placed afterwards proves the shop is still doing its job rather than
// merely still being reachable.
const bystander = await Kei.start({ node, seed: 'D'.repeat(64) })
await economy.grant(bystander.address, STARTING_GOLD)
await bystander.sync()
const bystanderPurse = await bystander.token.get(goldAsset)
const bystanderOrder = await economy.order(bystander.address, 'sword_01')
await bystanderPurse.transfer(bystanderOrder.to, bystanderOrder.price)
const bystanderServed = await until(async () => (await economy.inventoryOf(bystander.address))['sword_01'] === 1)
check('an unrelated order still settles normally after every failure above', bystanderServed)

check('none of the induced failures above ever escaped as an unhandled rejection', unhandled === 0, `${unhandled}`)

// A server lifetime ends while its ledger does not. Reopening the same economy
// with the stable issuer must recognize exactly the same asset family.
const firstLifetime = economy.catalogue()
economy.close()
const restarted = await startEconomy({ seed: ISSUER_SEED, node, network: 'mock', recordDebt: (debt) => database.recordShopDebt(debt) })
const secondLifetime = restarted.catalogue()
const firstSword = firstLifetime.items.find((item) => item.key === 'sword_01')!
const secondSword = secondLifetime.items.find((item) => item.key === 'sword_01')!
check('issuer is stable across economy lifetimes', secondLifetime.issuer === firstLifetime.issuer)
check('gold asset is stable across economy lifetimes', secondLifetime.coin.asset === firstLifetime.coin.asset)
check('item asset is stable across economy lifetimes', secondSword.asset === firstSword.asset)
restarted.close()

// The debts from issues #28 and #29 above were written before this restart —
// long before `ORDER_TTL_MS` would have forgotten the orders they came from,
// and now on the far side of the same "close one economy, open another" this
// file already treats as its restart test. A *different* `Database`, opened
// fresh against the same file rather than the same in-process instance that
// wrote them, is what makes this a restart proof rather than a rerun of the
// same object's own cache.
const restartedDatabase = new Database(new Config())
await restartedDatabase.init()
const survivedRefund = await restartedDatabase.shopDebtsFor(refundee.address)
const survivedBuyback = await restartedDatabase.shopDebtsFor(seller.address)
check('the refund debt survives a restart, naming the amount owed', survivedRefund.some((debt) => debt.kind === 'gold' && debt.amount === orderB.price))
check('the buyback debt survives a restart, naming the amount owed', survivedBuyback.some((debt) => debt.kind === 'gold' && debt.amount === hat.buyback))
check(
  'and the held item survives a restart, naming the item and quantity',
  survivedBuyback.some((debt) => debt.kind === 'item' && debt.key === 'armor_01' && debt.amount === 1),
)

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
