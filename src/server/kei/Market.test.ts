/**
 * The auction house, end to end: two players trade an item for gold, the server
 * is not part of the trade, and the hall can nonetheless show what is for sale.
 * Run with `npm run test:market`.
 *
 * This is the piece SPEC §13 asks of M7, and the reason it is worth a test at
 * all is that the obvious implementation is the wrong one. An auction house
 * backed by a table on this server would look identical to a player and would
 * mean the opposite thing — the shop can already mint gold, so a server that
 * also brokered trades could invent both halves of one.
 *
 * The other thing this pins down is the denomination. `market.sell()` prices in
 * Kei, and gold is not Kei: it is an asset this world issues. So the auction
 * house is `market.offer()`, item on one side and gold on the other, which the
 * ledger settles as one block or not at all.
 *
 * The second half covers what is left for the server to do, which is to be the
 * list of chains worth reading (SPEC §9.4 ships no indexer). Everything it
 * reports is read back off the chain, so the checks below are as much about what
 * the hall cannot do — invent a listing, hide a settlement, hold anybody's
 * asset — as about what it shows.
 */

import { Kei } from 'kei-transaction'

import { lotOffer, offerMatchesDisplay, priceLot } from '../../shared/market'
import { startEconomy, STARTING_GOLD } from './Economy'
import { openHall } from './Hall'

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

// The hall, which is where a player finds any of this. The seller is already on
// its roster because they ordered from the shop; a browser announces itself the
// same way when it opens a wallet.
const open = await economy.hall.read()
const stall = open.listings.find((entry) => entry.hash === offer.hash)
check('the hall shows the listing', stall !== undefined, `${open.listings.length} listing(s)`)
check('and shows it as a sword, priced in gold', stall?.key === 'sword_01' && stall?.price === ASKING, JSON.stringify(stall))
check('read off one chain, not a table', open.accounts === 1, `${open.accounts} account(s)`)
check('nothing has sold yet, which is not the same as selling for nothing', open.history['sword_01'] === undefined)

// The hall is not trusted. Re-reading by hash is only a defence if every leg
// shown to the buyer is bound to what came back from the chain: price and
// quantity alone would let a dishonest hall substitute another item offered at
// the same numbers, or mislabel who is selling it.
const displayed = {
  hash: offer.hash,
  seller: offer.from,
  qty: offer.give.amount,
  price: offer.want.amount,
}
check(
  'the live offer matches the exact trade displayed to the buyer',
  offerMatchesDisplay(offer, displayed, sword.asset, catalogue.coin.asset),
)
check(
  'a same-price offer for another asset is refused',
  !offerMatchesDisplay(
    { ...offer, give: { ...offer.give, asset: 'F'.repeat(64) } },
    displayed,
    sword.asset,
    catalogue.coin.asset,
  ),
)
check(
  'a hall cannot relabel the seller either',
  !offerMatchesDisplay(offer, { ...displayed, seller: buyer.address }, sword.asset, catalogue.coin.asset),
)

await buyer.market.accept(offer)
// What a client does after signing: say there is another chain worth reading.
// The hall never sees the settlement itself — it is not party to one.
economy.hall.watch(buyer.address)

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

// Price history is the settled swaps and nothing else — no time series, and
// nothing this server wrote down (SPEC §9.1).
const settled = await economy.hall.read()
check('the listing is gone from the hall', settled.listings.every((entry) => entry.hash !== offer.hash))
check(
  'and the hall now knows what a sword goes for',
  settled.history['sword_01']?.last === ASKING && settled.history['sword_01']?.trades === 1,
  JSON.stringify(settled.history['sword_01']),
)

// A listing taken back, which is the other way an offer leaves the hall. Only
// its author can write that block, because only their asset is locked (§9.2).
const second = await buyer.market.offer({
  give: { asset: sword.asset, amount: 1 },
  want: { asset: catalogue.coin.asset, amount: ASKING + 5 },
})
economy.hall.watch(buyer.address)
const relisted = await economy.hall.read()
check('a second seller\'s listing shows up too', relisted.listings.some((entry) => entry.hash === second.hash))

// The limit, pinned rather than described. A hall that has not heard of the
// buyer cannot see the buyer's listing, because an offer lives on its author's
// chain and there is no index of chains (SPEC §9.1, §9.4). Being told is the
// only way, and being told grants nothing.
const stranger = openHall({
  kei: seller,
  coin: catalogue.coin.asset,
  items: new Map([[sword.asset, { key: 'sword_01', title: sword.title }]]),
})
const unheard = await stranger.read()
check('a hall that has heard of nobody shows nothing', unheard.listings.length === 0 && unheard.accounts === 0)
stranger.watch(buyer.address)
const heard = await stranger.read()
check('and shows the same listing once it is told where to look', heard.listings.some((entry) => entry.hash === second.hash))
stranger.close()

let notMine = ''
try {
  await seller.market.cancel(second)
} catch (error) {
  notMine = (error as Error).message
}
check('somebody else cannot cancel it', notMine !== '', notMine)

await buyer.market.cancel(second)
economy.hall.watch(buyer.address)
const withdrawn = await economy.hall.read()
check('cancelling takes it off the board', withdrawn.listings.every((entry) => entry.hash !== second.hash))

await buyer.sync()
const backInBag = await economy.inventoryOf(buyer.address)
check('and puts the sword back in the seller\'s bag', (backInBag['sword_01'] ?? 0) === 1, `${backInBag['sword_01'] ?? 0}`)

// The hall is an index, not a party. It never held the sword, because it cannot
// — it signs nothing at all.
check('the shop never held the sword any of this was about', (await economy.inventoryOf(economy.address))['sword_01'] === undefined)

// ------------------------------------------------------------------ issue #14
//
// A lot of ten is not ten lots of one, and an offer's `want` leg is the whole
// lot. The auction's Ask box was labelled `Ask`, seeded with the catalogue's
// per-unit `value`, and then spent as that leg — so stepping the quantity to ten
// and trusting the number the panel had already put there signed an offer at a
// tenth of the price on screen, on a lot ten times as large.
//
// `priceLot` is now the only place a per-unit ask is multiplied by a quantity and
// `lotOffer` the only place the two legs are built, so the distinction has one
// home instead of being re-derived by every caller.

const EACH = 25
const LOT = 10

const priced = priceLot(EACH, LOT)
check('a per-unit ask times a quantity is the lot total', priced.total === EACH * LOT, `${priced.total}`)
check('and the lot goes on saying which number was which', priced.each === EACH && priced.qty === LOT)
check('one of something is the only case where the two agree', priceLot(EACH, 1).total === EACH)

// The refusals. A listing that cannot settle for exactly what it displayed is
// worse than one that will not publish.
const refuses = (each: number, qty: number): string => {
  try {
    priceLot(each, qty)
    return ''
  } catch (error) {
    return (error as Error).message
  }
}
check('a fractional ask is refused, in a sentence', refuses(2.5, 4).includes('whole number of gold'), refuses(2.5, 4))
check('a free lot is refused', refuses(0, 4) !== '')
check('half an item is refused', refuses(25, 1.5).includes('whole number of them'), refuses(25, 1.5))
check(
  'and a total no ledger could count is refused rather than quietly rounded',
  refuses(Number.MAX_SAFE_INTEGER, 2).includes('more gold than this world can count'),
  refuses(Number.MAX_SAFE_INTEGER, 2),
)

// The report's own case, against the real signing path: ten units at 25 each is
// an offer for 250 gold, not for 25.
const potion = catalogue.items.find((item) => item.key === 'potion_small_red')!
await economy.deliver(seller.address, 'potion_small_red', LOT)
await until(async () => ((await economy.inventoryOf(seller.address))['potion_small_red'] ?? 0) >= LOT)
await seller.sync()

const lot = await seller.market.offer(lotOffer(potion.asset, catalogue.coin.asset, priced))
check('the lot puts every unit on the block', lot.give.amount === LOT, `${lot.give.amount}`)
check('and asks the lot total rather than the unit price', lot.want.amount === EACH * LOT, `${lot.want.amount}`)
check('so the ledger agrees about what one of them costs', lot.price === EACH, `${lot.price}`)

// And the hall reads it back the way the browse pane has always rendered it,
// which is the asymmetry the report is about: the buying side said "250 gold for
// 10 (25 each)" while the selling side had put 25 in the box.
economy.hall.watch(seller.address)
const board = await economy.hall.read()
const lotStall = board.listings.find((entry) => entry.hash === lot.hash)
check('the hall shows the lot total and the unit price', lotStall?.price === EACH * LOT && lotStall?.each === EACH, JSON.stringify(lotStall))
check(
  'and a buyer clicking it is bound to both',
  offerMatchesDisplay(lot, { hash: lot.hash, seller: lot.from, qty: LOT, price: EACH * LOT }, potion.asset, catalogue.coin.asset),
)
check(
  'a lot priced as though it were one unit does not match what was displayed',
  !offerMatchesDisplay(lot, { hash: lot.hash, seller: lot.from, qty: LOT, price: EACH }, potion.asset, catalogue.coin.asset),
)
await seller.market.cancel(lot)

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
