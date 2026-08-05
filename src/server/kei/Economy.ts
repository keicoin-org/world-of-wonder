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

// There is deliberately no STARTING_GOLD here any more.
//
// It said 500 and did nothing: the only thing that ever spent it was
// `/kei/grant`, which is closed in production, so a player on the deployed site
// started with 0 gold against a 100-gold sword and no route forward (issue #24).
// A constant that is right in the file and absent from the only environment that
// matters is worse than no constant, because it reads like a decision.
//
// The route a production player actually has is the exchange desk below: they
// send Kei and this account mints them `GOLD_PER_KEI` gold for each one, which
// is a swap the player signs rather than a gift the server hands out. That
// distinction is the whole of SPEC §8 — a server that could credit a character
// on its own say-so would be a server whose database is the economy again — and
// it is why the grant cannot simply be moved somewhere production reaches.
// Until a character can prove which wallet is its own (`proofUnavailable` in
// Inventory.ts), there is no address this world could safely mint a welcome gift
// to in the first place.

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

/** One Kei in raw units, built rather than written as a literal: `tsconfig` targets ES6. */
const ONE_KEI_RAW = BigInt('1'.padEnd(KEI_DECIMALS + 1, '0'))

/**
 * What it costs, in Kei, for an account that has already issued `issuedAlready`
 * assets to issue `count` more.
 *
 * The rule is SPEC §5.6.5 — the nth asset an account issues burns n Kei — and
 * the arithmetic is `issuanceBurn`'s rather than this file's. That is the point:
 * a pricing rule copied into an application is a rule that goes stale there, and
 * this one already had. What stood here charged a flat 1,000 per asset, which is
 * the rule §5.6.5 says it *replaced*, and so asked a rate-limited faucet for
 * 10,100 Kei to spend 55 (issue #24).
 *
 * Zero or fewer is zero, which is the ordinary case on a restart: issuing is
 * idempotent per (issuer, symbol), so a world that already has its assets pays
 * for none of them again.
 */
export function issuanceCost(count: number, issuedAlready = 0): number {
  let kei = 0
  // Divided in BigInt and only then made a number: a raw balance is far past
  // where a double still counts in ones, and every burn is a whole Kei, so the
  // division is exact.
  for (let n = 0; n < count; n += 1) kei += Number(issuanceBurn(issuedAlready + n) / ONE_KEI_RAW)
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
 * Where an order got to. There are only three answers, and two of them are
 * final: the item was minted, or the gold went back.
 */
export type OrderState = 'open' | 'delivered' | 'refunded'

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
  /**
   * Mint gold to an address, on this server's own authority.
   *
   * A printing press, so the callers are counted: a reward the server itself
   * authored (`Inventory.pay`), and the development faucet at `/kei/grant`,
   * which production closes. Nothing a player can reach calls this — the way a
   * player gets gold is to buy it at the exchange desk or earn it in the hall.
   */
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
  // What is asked for is what the list below actually burns. The node is the one
  // that knows how many assets this account has issued, and it prices the next
  // one, so a world part-way through its catalogue asks for the rest of it and a
  // world that has all of it asks for nothing — which is what keeps an ordinary
  // restart off a rate-limited faucet entirely.
  const keys = Object.keys(ItemsDB)
  const issuedAlready = (await kei.client.node.accountInfo(kei.address))?.issuedCount ?? 0
  const needed = issuanceCost(keys.length + 1 - issuedAlready, issuedAlready)
  const balance = await kei.balance()
  if (needed > 0 && balance < needed) {
    if (options.network === 'mainnet') {
      throw new Error(
        `This world needs ${needed} Kei to issue its currency and ${keys.length} item types, and ${kei.address} holds ${balance}. There is no faucet on mainnet — send the difference to that address and start the server again.`,
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
   * Gold that bought nothing goes back.
   *
   * There is no third option. The shop cannot ask what a transfer was for after
   * the fact and it has no claim on gold it did not sell anything for, so the
   * only honest answers are "deliver" and "return" — and before this existed the
   * answer to a mismatch was "keep it", which cost a player 990 gold in the
   * report that found it.
   */
  const refund = async (address: string, amount: number, why: string): Promise<void> => {
    try {
      await gold.transfer(address, amount)
    } catch (error) {
      // Worth saying loudly: an unreturned refund is indistinguishable from the
      // shop having simply pocketed the difference.
      Logger.error(`[kei][refund] ${amount} gold owed back to ${address} (${why}): ${(error as Error).message}`)
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
      await refund(
        from,
        amount,
        'no open order at that price',
      )
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
      const why =
        'Two different orders were waiting on a payment of exactly this much, so the shop could not tell which one your gold was for. It has been sent back — order one thing at a time.'
      for (const tied of waiting) {
        tied.state = 'refunded'
        tied.reason = why
      }
      await refund(from, amount, 'more than one order matched, delivering different items')
      return
    }

    // Claimed before anything is awaited. Two payments landing together must not
    // both find this order open and mint against it twice.
    order.state = 'delivered'

    const token = itemTokens.get(order.key)
    if (!token) {
      order.state = 'refunded'
      order.reason = `This world no longer issues ${order.key}, so your gold has been returned.`
      await refund(from, amount, `no issuer token for ${order.key}`)
      return
    }

    try {
      await token.mint(from, order.qty)
    } catch (error) {
      order.state = 'refunded'
      order.reason = 'The shop could not hand the item over, so your gold has been returned.'
      await refund(from, amount, `minting ${order.qty} ${order.key} failed: ${(error as Error).message}`)
      return
    }

    // The shop is a sink: gold spent here stops existing, which frees the
    // headroom it took under the cap (SPEC §5.6.6).
    await gold.burn(order.price)
    options.onDelivered?.({ to: from, key: order.key, qty: order.qty })
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
   */
  const stopSettling = kei.on('asset-received', (arrival) => {
    // Somebody who has traded with the shop is somebody whose chain may carry a
    // listing later, so the hall's roster fills itself out of ordinary play
    // rather than out of a sign-up (see Hall.ts).
    hall.watch(arrival.from)

    if (arrival.asset === gold.id) {
      void settleGold(arrival.from, arrival.amount)
      return
    }

    const key = itemKeys.get(arrival.asset)
    if (key === undefined) return

    void (async () => {
      const data = ItemsDB[key] as ItemData
      const qty = Math.floor(arrival.amount)
      if (qty < 1) return

      // Refusing to buy something cannot mean keeping it. The shop has no claim
      // on an item it would not pay for, so it goes straight back.
      if (!data.sellable) {
        await itemTokens.get(key)!.transfer(arrival.from, qty)
        return
      }

      await gold.mint(arrival.from, buybackPrice(data.value ?? 0) * qty)
    })()
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
