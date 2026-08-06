/**
 * The issuer half of the template's economy.
 *
 * This is the file that replaces `character_inventory` and `PlayerSchema.gold`.
 * There is no balances table and no inventory table, because those are questions
 * the chain answers and asking it is `holdings`. What is left here is what a game
 * server is actually for: what things cost, and who is allowed to buy them.
 *
 * It holds the game's seed, so it must never reach the client (SPEC §6.3):
 * `Kei.server()` refuses to start in a browser for exactly that reason.
 *
 * The rule this file exists to keep (SPEC §8): the game server is never the
 * source of truth for money. It cannot credit a player, because it cannot sign
 * for a player's account. All it can do is mint what it issued, to whoever the
 * chain says actually paid it.
 */

import { randomBytes } from 'node:crypto'

import { Kei, KEI_DECIMALS, issuanceBurn, type IssuerToken, type Item } from 'kei-transaction'
import type { KeiNode } from 'kei-transaction'

import { openHall, type Hall } from './Hall'
import { reconcileAgainst, type Issuance } from './Outbox'
import { ItemsDB } from '../data/ItemDB'
import type { Item as ItemData } from '../../shared/types'
import Logger from '../utils/Logger'

/** The currency the world prices things in. t5c called it gold; so do we. */
export const COIN = {
  name: 'Gold',
  symbol: 'GOLD',
  decimals: 0,
  maxSupply: 1_000_000_000,
} as const

/** Gold per Kei at the exchange desk. Local configuration, never on-chain. */
export const GOLD_PER_KEI = 1_000
/** Below this a top-up is not worth a block. */
export const MINIMUM_TOP_UP = 0.001
/**
 * What a character that has never played is given, once.
 *
 * It buys the vendor's sword at 100 and two small potions at 150 each, which is
 * the first five minutes: something to fight with, something to survive a
 * mistake, and 100 spare so the auction house is legible rather than
 * theoretical. It is deliberately not enough for the 2,000-gold armour — that
 * is what playing is for.
 *
 * Reaching a player is `POST /kei/purse`, and how it stays bounded is written
 * there. Before issue #24 this constant was read only by `/kei/grant`, which is
 * closed in production, so the environment it was written for was the one
 * environment it never applied to.
 *
 * `KEI_STARTING_GOLD` overrides it, and `0` turns the purse off for a deployment
 * that would rather its players started with nothing. A value that is not a
 * whole number in range is refused at startup rather than rounded into
 * something nobody chose.
 */
export const STARTING_GOLD = configuredStartingGold()

function configuredStartingGold(): number {
  const configured = process.env.KEI_STARTING_GOLD
  if (configured === undefined || configured === '') return 500
  const amount = Number(configured)
  if (!Number.isInteger(amount) || amount < 0 || amount > 10_000) {
    throw new Error(
      `KEI_STARTING_GOLD is what every new character is given once, so it is a whole number of gold between 0 and 10000 — got "${configured}". Unset it for the usual 500, or set 0 to hand out nothing.`,
    )
  }
  return amount
}

/**
 * How many units of each item may ever exist. t5c items are archetypes — fifty
 * players can each own a `sword_01` — so an item here is a 0-decimal token with
 * a supply, not the single unique asset `items.create()` gives you by default.
 * Owning one is holding at least one unit.
 */
const ITEM_SUPPLY = 100_000

/** An order nobody paid for is forgotten after this long. */
const ORDER_TTL_MS = 120_000

/**
 * How long an order's name is, in bytes of randomness.
 *
 * The id is the whole of an order's authorization, so it has to be a secret
 * rather than a serial number: 24 bytes from the platform CSPRNG is not
 * enumerable, and the only party ever told one is the party that asked for it.
 */
const ORDER_ID_BYTES = 24

/** The oldest shopkeeper's margin there is: you sell back for half of list. */
export const buybackPrice = (value: number): number => Math.floor(value / 2)

/** One whole Kei in raw units, for turning a burn back into a fundable number. */
const KEI_UNIT = 10 ** KEI_DECIMALS

/**
 * What it costs this account, in Kei, to get from `issuedAlready` assets to
 * `assets`.
 *
 * Asked rather than stated. The n-th asset an account issues burns n Kei
 * (SPEC §5.6.5) and `issuanceBurn` is the SDK's own copy of that rule, so this
 * cannot drift from what the chain will actually charge — which is the whole
 * complaint in issue #24, where the number here was sized against a flat 1,000
 * Kei that the n-Kei rule had already replaced. This world's ten assets burn 55
 * Kei between them; the arithmetic that asked for 10,100 was not conservative,
 * it was fossilised.
 *
 * Zero once the account has already issued them all, which is what a restart
 * is: issuance is idempotent per (issuer, symbol), so a second start performs no
 * issuances and needs no funding for them.
 */
export function issuanceCost(assets: number, issuedAlready = 0): number {
  let kei = 0
  for (let n = issuedAlready; n < assets; n += 1) {
    // `issuanceBurn` answers in raw units and a faucet is asked in whole Kei.
    // Rounded up per asset, so a rule that ever charged a fraction of one still
    // leaves this address able to pay it.
    kei += Math.ceil(Number(issuanceBurn(n)) / KEI_UNIT)
  }
  return kei
}

export interface EconomyOptions {
  seed: string
  /** Undefined leaves the SDK to pick the public node for `network`. */
  node?: KeiNode | string
  network?: 'mock' | 'testnet' | 'mainnet'
  /** SPEC §8: the game must be playable with payments switched off. */
  exchange?: boolean
  /** Told when a purchase settles, so the room can put the item in the bag. */
  onDelivered?: (delivery: { to: string; key: string; qty: number }) => void
  /**
   * Where an owed refund or a held-and-owed item goes when the chain will not
   * take it back — a failed `refund` (issue #29), a failed buyback mint, or a
   * failed return of an item this shop declined to buy (issue #28).
   *
   * A port, the same shape as `onDelivered`: this file holds the issuer's seed
   * and should not also know how the game stores durable records, so it is
   * handed a place to write one rather than a `Database` import. `undefined`
   * is accepted so the economy still starts without one, but it only logs the
   * debt then — a deployment that wants the debt to survive a restart wires
   * this up, the same way `index.ts` wires `Database.recordShopDebt`.
   */
  recordDebt?: (debt: ShopDebt) => Promise<void>
}

/**
 * One thing this shop owes and did not pay: gold it could not send back or
 * mint out, or an item it took but could not return.
 *
 * `reason` is written to be shown to a player or a support agent as-is, the
 * same rule `Order.reason` and every `refund` message already follow — it
 * names the amount and, where one exists, the order it came from, and never a
 * secret.
 */
export interface ShopDebt {
  /** Who the shop owes. */
  address: string
  /** Gold, or one of `ItemsDB`'s archetypes. */
  kind: 'gold' | 'item'
  /** The item key. Absent for a gold debt. */
  key?: string
  /** Gold owed, or how many units of `key` are being held. */
  amount: number
  reason: string
}

export interface CataloguePayload {
  issuer: string
  network: string
  coin: { asset: string; symbol: string; decimals: number }
  exchange: { open: boolean; goldPerKei: number; minimum: number }
  items: Array<{
    key: string
    title: string
    value: number
    /** What the shop pays to take one back. Zero when it will not buy it at all. */
    buyback: number
    asset: string
    sellable: boolean
  }>
}

/**
 * Where an order got to. There are only four answers now, and three of them
 * are final: the item was minted, the gold went back, or the gold could not
 * be sent back and the shop still owes it.
 *
 * `'refund-failed'` exists because `'refunded'` used to be the only failure
 * exit, and it lies: it is what `settleGold` wrote *before* `refund` had even
 * been tried, on the assumption that returning gold cannot itself fail. It
 * can, and when it does the player's gold is still sitting with the shop —
 * which is exactly the debt `refund-failed` and `EconomyOptions.recordDebt`
 * exist to say out loud instead of hiding behind a claim that never happened
 * (issue #29).
 */
export type OrderState = 'open' | 'delivered' | 'refunded' | 'refund-failed'

/** What the client is handed when the shop takes an order. */
export interface OrderTicket {
  /**
   * The order's name, and the only name it has.
   *
   * Unguessable on purpose. An address is public — every hall listing prints one
   * — so an order keyed on an address is an order any stranger can find, and
   * before this id existed the map held one slot per address, which made it an
   * order any stranger could overwrite (issue #13). The id is returned to
   * whoever placed the order and told to nobody else.
   */
  id: string
  /** Where to send the gold. The client signs that transfer itself. */
  to: string
  /** What the whole order costs, in gold. Pay exactly this. */
  price: number
  asset: string
}

/** What became of an order, for whoever holds its id. */
export interface OrderStatus {
  id: string
  state: OrderState
  key: string
  qty: number
  price: number
  /** Why the gold came back. Written to be shown to a player as-is. */
  reason?: string
}

export interface Economy {
  address: string
  /**
   * The auction house. It is not part of the shop and cannot be: players trade
   * with each other there, and this account takes no side in it (SPEC §9.2).
   */
  hall: Hall
  /**
   * The narrow issuing surface `kei/Outbox.ts` delivers rewards through.
   *
   * Separate from `grant`/`deliver` because durable delivery needs three things
   * those two cannot give it: raw units as a string rather than a `number`, the
   * hash of the block that paid, and a way to find that block again after a
   * timeout that told us nothing.
   */
  issuance: Issuance
  catalogue(): CataloguePayload
  /** Take an order, so an anonymous coin transfer can be matched to a purchase. */
  order(player: string, key: string, qty?: number): Promise<OrderTicket>
  /**
   * What became of an order. Undefined for an id that is not one, which is also
   * what a guess gets — the id is the only credential this needs, so there is
   * nothing here to learn from an address.
   */
  orderStatus(id: string): OrderStatus | undefined
  /** What the chain says a player holds. Not a cache — the chain is asked. */
  goldOf(address: string): Promise<number>
  inventoryOf(address: string): Promise<Record<string, number>>
  // Selling has no method here on purpose. A sale is the player transferring the
  // item to this address, and the shop paying for what arrived — so the only way
  // to trigger one is to actually part with the item. An endpoint that paid on
  // request would be a mint on request, which is a printing press with a nicer
  // name.
  /** Starting gold for a character that has never played. */
  grant(address: string, amount: number): Promise<void>
  /**
   * Mint an item the server authored — loot, a quest reward — to an address.
   *
   * The same power as `grant` and the same rule: there is no route to it, and
   * the only caller is `Inventory.ts`, which will not call it for a quantity a
   * client asked for or for an address a client merely claimed.
   */
  deliver(address: string, key: string, qty: number): Promise<void>
  close(): void
}

interface Order {
  id: string
  /** Whose payment this order is waiting for. */
  address: string
  key: string
  qty: number
  price: number
  at: number
  state: OrderState
  reason?: string
}

export async function startEconomy(options: EconomyOptions): Promise<Economy> {
  const kei = await Kei.server({
    seed: options.seed,
    ...(options.node === undefined ? {} : { node: options.node }),
    ...(options.network === undefined ? {} : { network: options.network }),
  })

  // Issuance burns an escalating amount of Kei per asset (SPEC §5.6.5), and this
  // world issues one currency plus one asset per item archetype. On testnet and
  // on a mock the faucet covers it; on mainnet there is no faucet, so a person
  // funds this address once and the shortfall has to be said out loud rather
  // than discovered as a failed issuance halfway through the list.
  //
  // How many of those assets this account has issued already is asked of the
  // chain rather than assumed, so the figure is what the issuances below will
  // actually burn: everything on a first run, and nothing at all on a restart.
  // Asking a rate-limited faucet for 10,100 on every boot to perform issuances
  // that burn 55 once was an availability risk with no upside (issue #24).
  const keys = Object.keys(ItemsDB)
  const account = await kei.client.node.accountInfo(kei.address)
  const issuedAlready = account?.issuedCount ?? 0
  const remaining = Math.max(0, keys.length + 1 - issuedAlready)
  const needed = issuanceCost(keys.length + 1, issuedAlready)
  const balance = await kei.balance()
  if (balance < needed) {
    if (options.network === 'mainnet') {
      throw new Error(
        `This world has ${remaining} assets left to issue and burns ${needed} Kei doing it, and ${kei.address} holds ${balance}. There is no faucet on mainnet — send the difference to that address and start the server again.`,
      )
    }
    try {
      await kei.faucet(needed)
    } catch (cause) {
      // The public testnet is rate-limited and makes no uptime promise, so this
      // is a thing that happens rather than a thing that has gone wrong. Say
      // which address needs funding and how else to start, instead of letting a
      // node-error stack be somebody's first minute with the template.
      throw new Error(
        `Could not draw ${needed} Kei from the ${options.network ?? 'testnet'} faucet for ${kei.address}: ${
          (cause as Error).message
        }\n` +
          'The public testnet is best-effort and rate-limited. Wait and start again, send Kei to that address yourself, or run KEI_NETWORK=mock to develop against a chain in this process.',
      )
    }
  }

  const gold = await kei.token.issue({
    name: COIN.name,
    symbol: COIN.symbol,
    decimals: COIN.decimals,
    maxSupply: COIN.maxSupply,
    // Open, because players trading gold with each other is most of the reason
    // to put it on a chain. Closing it would make the chain decorative.
    transfer: 'open',
    swap: 'one-way',
    rate: GOLD_PER_KEI,
  })

  // One asset per item archetype. Issuing is idempotent per (issuer, symbol), so
  // a restart returns the same asset ids rather than a second economy — which is
  // what makes "stop the server, the items are still yours" true rather than a
  // claim.
  const items = new Map<string, Item>()
  const itemTokens = new Map<string, IssuerToken>()
  /** Which archetype an asset is, for reading an arrival the other way round. */
  const itemKeys = new Map<string, string>()
  for (const key of keys) {
    const data = ItemsDB[key] as ItemData
    const item = await kei.items.create({
      name: data.title ?? key,
      description: data.description ?? '',
      supply: ITEM_SUPPLY,
      transfer: 'open',
      symbol: key.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12),
    })
    items.set(key, item)
    itemTokens.set(key, await kei.items.token(item.id))
    itemKeys.set(item.id, key)
  }

  // The auction house reads with this wallet and signs nothing with it. Players
  // trade with each other there; the shop is not a party to any of it.
  const hall = openHall({
    kei,
    coin: gold.id,
    items: new Map(
      [...itemKeys].map(([asset, key]) => [asset, { key, title: (ItemsDB[key] as ItemData).title ?? key }]),
    ),
  })

  const exchange = options.exchange !== false
  const stopTopUps = exchange
    ? kei.acceptTopUps({ token: gold, rate: GOLD_PER_KEI, minimum: MINIMUM_TOP_UP })
    : undefined

  /**
   * Live orders, keyed by their own unguessable id and never by address.
   *
   * One slot per address was the whole of issue #13: a second order replaced the
   * first, so anybody who could name an address — which is everybody — could
   * change what that address's next payment bought, and a player who opened two
   * vendor panels could do it to themselves. An id per order means concurrent
   * orders from one address are ordinary rather than mutually destructive.
   */
  const orders = new Map<string, Order>()

  /** An order nobody paid for is not worth remembering. */
  const forgetStaleOrders = (): void => {
    for (const [id, order] of orders) {
      if (Date.now() - order.at > ORDER_TTL_MS) orders.delete(id)
    }
  }

  /**
   * Write down what the shop owes and could not pay.
   *
   * `orders` is an in-memory map with a 120s TTL, and it was, before this, the
   * only place a failed refund was written down at all — so the debt evaporated
   * from view long before anyone could act on it, and did not survive a
   * restart either. This is the durable side of that: `EconomyOptions.recordDebt`
   * is asked to hold what a log line cannot.
   *
   * Falls back to a log line when no store was wired in, so a deployment that
   * forgot to pass one still runs — but a debt that only ever reaches this
   * fallback is one this file warned about and could not otherwise keep.
   */
  const recordDebt =
    options.recordDebt ??
    (async (debt: ShopDebt): Promise<void> => {
      Logger.error(
        `[kei][debt] no durable store was wired into this economy, so this can only be logged: ${debt.address} is owed ` +
          `${debt.amount} ${debt.kind === 'gold' ? 'gold' : `× ${debt.key ?? '?'}`} (${debt.reason})`,
      )
    })

  /**
   * Gold that bought nothing goes back.
   *
   * There is no third option. The shop cannot ask what a transfer was for after
   * the fact and it has no claim on gold it did not sell anything for, so the
   * only honest answers are "deliver" and "return" — and before this existed the
   * answer to a mismatch was "keep it", which cost a player 990 gold in the
   * report that found it.
   *
   * Resolves to whether the transfer actually confirmed. It used to resolve
   * normally either way, logging a failure but never saying so to its caller —
   * which is how `settleGold` came to tell a player their gold had come back
   * before it had any idea whether that was true (issue #29). A caller cannot
   * report the truth about something this function will not say.
   */
  const refund = async (address: string, amount: number, why: string): Promise<boolean> => {
    try {
      await gold.transfer(address, amount)
      return true
    } catch (error) {
      // Worth saying loudly: an unreturned refund is indistinguishable from the
      // shop having simply pocketed the difference.
      Logger.error(`[kei][refund] ${amount} gold owed back to ${address} (${why}): ${(error as Error).message}`)
      return false
    }
  }

  /**
   * Match an arriving pile of gold to the order it paid for, or give it back.
   *
   * A transfer carries no memo (decisions-m0 §4), so the arrival names only a
   * payer and an amount. That is enough to identify one of *that payer's* own
   * orders and never enough to identify an order somebody else placed for them:
   * the price has to be exactly right, and where two of the payer's live orders
   * would both fit and would deliver different things, the shop refuses to guess.
   */
  const settleGold = async (from: string, amount: number): Promise<void> => {
    forgetStaleOrders()
    const waiting = [...orders.values()]
      .filter((order) => order.state === 'open' && order.address === from && order.price === amount)
      .sort((a, b) => a.at - b.at)

    if (waiting.length === 0) {
      const ok = await refund(from, amount, 'no open order at that price')
      if (!ok) {
        // Nothing was claimed against, so there is no order to mark — but the
        // gold is exactly as unaccounted for as if there had been one.
        await recordDebt({
          address: from,
          kind: 'gold',
          amount,
          reason: `${amount} gold arrived matching no open order and could not be sent back to ${from}.`,
        })
      }
      return
    }

    // Two orders for the same item at the same quantity are interchangeable, so
    // paying for one of them is not ambiguous — a player who clicked Buy twice
    // gets one of the two things they asked for, which is one of the two things
    // they asked for either way. Two orders that would deliver *different*
    // things are ambiguous, and guessing between them is precisely how a
    // stranger's order gets to spend somebody else's gold.
    const order = waiting[0]!
    const contested = waiting.some((other) => other.key !== order.key || other.qty !== order.qty)
    if (contested) {
      const ids = waiting.map((tied) => tied.id).join(', ')
      const ok = await refund(from, amount, 'more than one order matched, delivering different items')
      // The debt is written before either order is told about the outcome, so a
      // read of either order's status can never land between "refund failed"
      // and "the shop wrote that down" (issues #28/#29).
      if (!ok) {
        await recordDebt({
          address: from,
          kind: 'gold',
          amount,
          reason: `An ambiguous payment of ${amount} gold across orders ${ids} could not be sent back to ${from}.`,
        })
      }
      const why = ok
        ? 'Two different orders were waiting on a payment of exactly this much, so the shop could not tell which one your gold was for. It has been sent back — order one thing at a time.'
        : `Two different orders were waiting on a payment of exactly this much, so the shop could not tell which one your gold was for. It tried to send the ${amount} gold back and could not — the shop still owes it. Quote this order id if you ask for it.`
      for (const tied of waiting) {
        tied.state = ok ? 'refunded' : 'refund-failed'
        tied.reason = why
      }
      return
    }

    // Claimed before anything is awaited. Two payments landing together must not
    // both find this order open and mint against it twice.
    order.state = 'delivered'

    const token = itemTokens.get(order.key)
    if (!token) {
      const ok = await refund(from, amount, `no issuer token for ${order.key}`)
      if (!ok) {
        await recordDebt({
          address: from,
          kind: 'gold',
          amount,
          reason: `Order ${order.id} paid for ${order.key}, which this world no longer issues, and the ${amount}-gold refund failed. The shop still owes it.`,
        })
      }
      order.state = ok ? 'refunded' : 'refund-failed'
      order.reason = ok
        ? `This world no longer issues ${order.key}, so your gold has been returned.`
        : `This world no longer issues ${order.key}. The shop tried to return your gold and could not — it still owes you ${amount} gold for order ${order.id}.`
      return
    }

    try {
      await token.mint(from, order.qty)
    } catch (error) {
      const ok = await refund(from, amount, `minting ${order.qty} ${order.key} failed: ${(error as Error).message}`)
      if (!ok) {
        await recordDebt({
          address: from,
          kind: 'gold',
          amount,
          reason: `Order ${order.id} for ${order.qty} × ${order.key} could not be delivered and the ${amount}-gold refund failed too. The shop still owes it.`,
        })
      }
      order.state = ok ? 'refunded' : 'refund-failed'
      order.reason = ok
        ? 'The shop could not hand the item over, so your gold has been returned.'
        : `The shop could not hand the item over, and it could not return your gold either — it still owes you ${amount} gold for order ${order.id}.`
      return
    }

    try {
      // The shop is a sink: gold spent here stops existing, which frees the
      // headroom it took under the cap (SPEC §5.6.6).
      await gold.burn(order.price)
    } catch (error) {
      // The item already minted to the player — that succeeded, and nothing
      // here may roll it back or reclassify it as a failed delivery. A burn
      // that fails to fire afterwards is the shop's own bookkeeping falling
      // behind, not a debt to the player, so it is loud in the log and nowhere
      // else (issue #28, item 3).
      Logger.error(
        `[kei][settleGold] burning ${order.price} gold for order ${order.id} failed after ${order.key} was already delivered: ${(error as Error).message}`,
      )
    }
    options.onDelivered?.({ to: from, key: order.key, qty: order.qty })
  }

  /**
   * A sale, or a refusal handed back — the item-arrival half of settlement.
   *
   * Both branches move something *after* the item has already left the
   * seller's wallet: an arrival is one-way, so by the time either `transfer`
   * or `mint` below is even attempted, the shop is already holding an item it
   * has neither paid for nor returned. A failure here is therefore never
   * "nothing happened" — it is always "the shop now owes something" — which is
   * why both branches record a debt on failure rather than only logging one
   * (issue #28, items 2 and 4).
   *
   * This used to be a detached `void (async () => {...})()` with no `.catch`,
   * so a rejection from either `transfer` or `mint` — a node mid-restart is
   * enough — was an unhandled rejection, which Node treats as fatal with
   * nothing in `src/` catching it. That took every room and every connected
   * player down over one failed sale. Catching per-branch here, and again
   * where this is called below, is belt and suspenders on purpose: the debt
   * this function writes needs the specific item and quantity that only it
   * still has in scope by the time something goes wrong.
   */
  const settleItem = async (from: string, key: string, rawAmount: number): Promise<void> => {
    const data = ItemsDB[key] as ItemData
    const qty = Math.floor(rawAmount)
    if (qty < 1) return

    // Refusing to buy something cannot mean keeping it. The shop has no claim
    // on an item it would not pay for, so it goes straight back.
    if (!data.sellable) {
      try {
        await itemTokens.get(key)!.transfer(from, qty)
      } catch (error) {
        Logger.error(`[kei][settleItem] returning ${qty} × ${key} to ${from} failed: ${(error as Error).message}`)
        await recordDebt({
          address: from,
          kind: 'item',
          key,
          amount: qty,
          reason: `The shop does not buy ${data.title ?? key} and tried to send back ${qty} of it, but the return failed. The shop is still holding it.`,
        })
      }
      return
    }

    const payout = buybackPrice(data.value ?? 0) * qty
    try {
      await gold.mint(from, payout)
    } catch (error) {
      Logger.error(`[kei][settleItem] paying ${payout} gold to ${from} for ${qty} × ${key} failed: ${(error as Error).message}`)
      await recordDebt({
        address: from,
        kind: 'gold',
        amount: payout,
        reason: `The shop took ${qty} × ${data.title ?? key} but could not pay out ${payout} gold for it. The shop still owes this.`,
      })
    }
  }

  /**
   * Settlement, both ways round. Everything the shop does is a reaction to
   * something arriving, because an arrival is the one thing a player cannot
   * fake and the server cannot fake on their behalf.
   *
   * Gold arriving is a purchase. A transfer carries no memo (decisions-m0 §4),
   * so what it was for is recorded by `order()` and matched here — the order is
   * not the purchase, and nothing is delivered until the gold has landed.
   *
   * An item arriving is a sale, and needs no order at all: the asset says which
   * item it is, and its being here says whose it was.
   *
   * Both `settleGold` and `settleItem` already catch every failure they know
   * how to name and turn it into a debt rather than a throw. The `.catch` here
   * is the outer net for anything that still escapes them — `recordDebt`
   * itself rejecting, most plausibly — so that this handler, which `kei-transaction`
   * calls with nothing downstream of it to catch a rejection, can never be the
   * thing that turns one failed settlement into every disconnected player
   * (issue #28, item 1).
   */
  const stopSettling = kei.on('asset-received', (arrival) => {
    // Somebody who has traded with the shop is somebody whose chain may carry a
    // listing later, so the hall's roster fills itself out of ordinary play
    // rather than out of a sign-up (see Hall.ts).
    hall.watch(arrival.from)

    if (arrival.asset === gold.id) {
      settleGold(arrival.from, arrival.amount).catch((error) => {
        Logger.error(`[kei][settleGold] settling ${arrival.amount} gold from ${arrival.from} failed: ${(error as Error).message}`)
      })
      return
    }

    const key = itemKeys.get(arrival.asset)
    if (key === undefined) return

    settleItem(arrival.from, key, arrival.amount).catch((error) => {
      Logger.error(`[kei][settleItem] settling ${arrival.amount} × ${key} from ${arrival.from} failed: ${(error as Error).message}`)
    })
  })

  /** Which token pays a reward leg. Gold is the currency; anything else is an archetype. */
  const tokenFor = (kind: 'gold' | 'item', key: string) => (kind === 'gold' ? gold : itemTokens.get(key))

  return {
    address: kei.address,
    hall,

    issuance: {
      issuer: kei.address,

      assetFor(kind, key) {
        if (kind === 'gold') return key === COIN.symbol ? gold.id : undefined
        return items.get(key)?.id
      },

      nameFor(kind, key) {
        if (kind === 'gold') return COIN.name
        // The chain carries the name, so a player never has to be shown an
        // asset id (SPEC §7). `ItemsDB` is where that name came from.
        return (ItemsDB[key] as ItemData | undefined)?.title ?? key
      },

      async frontier() {
        const info = await kei.client.node.accountInfo(kei.address)
        if (!info) throw new Error(`The node does not know this world's issuer, ${kei.address}.`)
        return info.frontier
      },

      async mint(kind, key, to, units) {
        const token = tokenFor(kind, key)
        if (!token) throw new Error(`This world does not issue "${key}".`)
        // The string goes through untouched. `mint()` takes `number | string`
        // and the number half is the lossy one.
        const { hash } = await token.mint(to, units)
        return { hash }
      },

      reconcile(previous, expected) {
        return reconcileAgainst(kei.client.node, kei.address, previous, expected)
      },
    },

    catalogue() {
      return {
        issuer: kei.address,
        network: kei.network,
        coin: { asset: gold.id, symbol: gold.symbol, decimals: gold.decimals },
        exchange: { open: exchange, goldPerKei: GOLD_PER_KEI, minimum: MINIMUM_TOP_UP },
        items: keys.map((key) => {
          const data = ItemsDB[key] as ItemData
          const sellable = data.sellable ?? false
          return {
            key,
            title: data.title ?? key,
            value: data.value ?? 0,
            buyback: sellable ? buybackPrice(data.value ?? 0) : 0,
            asset: items.get(key)!.id,
            sellable,
          }
        }),
      }
    },

    async order(player, key, qty = 1) {
      const data = ItemsDB[key] as ItemData | undefined
      if (!data) throw new Error(`The shop does not sell "${key}".`)

      const price = (data.value ?? 0) * qty
      const held = await gold.balanceOf(player)
      if (held < price) {
        throw new Error(`${data.title ?? key} costs ${price} gold and you have ${held}.`)
      }

      forgetStaleOrders()
      const id = randomBytes(ORDER_ID_BYTES).toString('hex')
      orders.set(id, { id, address: player, key, qty, price, at: Date.now(), state: 'open' })
      hall.watch(player)
      return { id, to: kei.address, price, asset: gold.id }
    },

    orderStatus(id) {
      forgetStaleOrders()
      const order = orders.get(id)
      if (!order) return undefined
      return {
        id: order.id,
        state: order.state,
        key: order.key,
        qty: order.qty,
        price: order.price,
        ...(order.reason === undefined ? {} : { reason: order.reason }),
      }
    },

    async goldOf(address) {
      return gold.balanceOf(address)
    },

    /** One prefix scan rather than one call per archetype (SPEC §7). */
    async inventoryOf(address) {
      const holdings = await kei.client.node.holdings(address)
      const counts: Record<string, number> = {}
      for (const [key, item] of items) {
        const holding = holdings.find((entry) => entry.asset === item.id)
        if (holding) counts[key] = Number(holding.balance)
      }
      return counts
    },

    async grant(address, amount) {
      await gold.mint(address, amount)
    },

    async deliver(address, key, qty) {
      const token = itemTokens.get(key)
      if (!token) throw new Error(`This world does not issue "${key}".`)
      await token.mint(address, qty)
    },

    close() {
      stopTopUps?.()
      stopSettling()
      hall.close()
      orders.clear()
      kei.close()
    },
  }
}
