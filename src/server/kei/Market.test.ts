/**
 * The auction house's claim, tested: two players trade an item for gold and the
 * server is not part of the trade. Run with `npm run test:market`.
 *
 * This is the piece SPEC §13 still asks of M7, and the reason it is worth a test
 * before any UI exists is that the obvious implementation is the wrong one. An
 * auction house backed by a table on this server would look identical to a
 * player and would mean the opposite thing — the shop can already mint gold, so
 * a server that also brokered trades could invent both halves of one.
 *
 * The other thing this pins down is the denomination. `market.sell()` prices in
 * Kei, and gold is not Kei: it is an asset this world issues. So the auction
 * house is `market.offer()`, item on one side and gold on the other, which the
 * ledger settles as one block or not at all.
 */

import { Kei } from 'kei-transaction'

import { startEconomy, STARTING_GOLD } from './Economy'

const ISSUER_SEED = 'A'.repeat(64)
const SELLER_SEED = 'C'.repeat(64)
const BUYER_SEED = 'D'.repeat(64)

/** What the seller asks for the sword, in gold. Above buyback, below list. */
const ASKING = 75

let failures = 0

function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** Settlement is a chain round trip, so it is not instant. */
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
const seller = await Kei.start({ node, seed: SELLER_SEED })
const buyer = await Kei.start({ node, seed: BUYER_SEED })

const catalogue = economy.catalogue()
const sword = catalogue.items.find((item) => item.key === 'sword_01')!

await economy.grant(seller.address, STARTING_GOLD)
await economy.grant(buyer.address, STARTING_GOLD)
await Promise.all([seller.sync(), buyer.sync()])

const sellerGold = await seller.token.get(catalogue.coin.asset)
const buyerGold = await buyer.token.get(catalogue.coin.asset)

// The seller buys a sword from the shop the ordinary way, so what they list is
// something they actually own rather than a fixture.
const order = await economy.order(seller.address, 'sword_01')
await sellerGold.transfer(order.to, order.price)
const bought = await until(async () => {
  const held = await economy.inventoryOf(seller.address)
  return (held['sword_01'] ?? 0) >= 1
})
check('the seller owns a sword to sell', bought)

await seller.sync()
const sellerBefore = await sellerGold.balance()
const buyerBefore = await buyerGold.balance()

// Item on one side, gold on the other. Not sell(), which would price it in Kei.
const offer = await seller.market.offer({
  give: { asset: sword.asset, amount: 1 },
  want: { asset: catalogue.coin.asset, amount: ASKING },
})
check('the listing is one block on the seller\'s own chain', offer.hash.length === 64)
check('it asks for gold, not Kei', offer.want.asset === catalogue.coin.asset, offer.want.symbol)
check('it asks the seller\'s price', offer.want.amount === ASKING, `${offer.want.amount}`)

// Listing locks it. The sword is no longer the seller's to send anywhere else,
// and that is the ledger's doing rather than the client's.
let doubleSpend = ''
try {
  await seller.items.transfer(sword.asset, buyer.address)
} catch (error) {
  doubleSpend = (error as Error).message
}
check('a listed item cannot also be given away', doubleSpend !== '', doubleSpend)

await buyer.market.accept(offer)

const traded = await until(async () => {
  const held = await economy.inventoryOf(buyer.address)
  return (held['sword_01'] ?? 0) >= 1
})
check('the buyer owns the sword', traded)

await Promise.all([seller.sync(), buyer.sync()])
check(
  'the seller was paid, by the buyer, in gold',
  (await sellerGold.balance()) === sellerBefore + ASKING,
  `${await sellerGold.balance()}`,
)
check('the buyer paid for it', (await buyerGold.balance()) === buyerBefore - ASKING, `${await buyerGold.balance()}`)

const sellerAfter = await economy.inventoryOf(seller.address)
check('and the sword is no longer the seller\'s', (sellerAfter['sword_01'] ?? 0) === 0)

// The shop's gold supply is untouched by any of this: the two legs moved between
// players, so a trade cannot be a way to mint.
check(
  'the trade moved gold rather than making it',
  (await sellerGold.balance()) + (await buyerGold.balance()) === sellerBefore + buyerBefore,
)

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
