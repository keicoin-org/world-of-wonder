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

import { Kei, type IssuerToken, type Item } from 'kei-transaction'
import type { KeiNode } from 'kei-transaction'

import { ItemsDB } from '../data/ItemDB'
import type { Item as ItemData } from '../../shared/types'

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
/** What a character that has never played starts with. */
export const STARTING_GOLD = 500

/**
 * How many units of each item may ever exist. t5c items are archetypes — fifty
 * players can each own a `sword_01` — so an item here is a 0-decimal token with
 * a supply, not the single unique asset `items.create()` gives you by default.
 * Owning one is holding at least one unit.
 */
const ITEM_SUPPLY = 100_000

/** An order nobody paid for is forgotten after this long. */
const ORDER_TTL_MS = 120_000

/** The oldest shopkeeper's margin there is: you sell back for half of list. */
export const buybackPrice = (value: number): number => Math.floor(value / 2)

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

export interface Economy {
  address: string
  catalogue(): CataloguePayload
  /** Take an order, so an anonymous coin transfer can be matched to a purchase. */
  order(player: string, key: string, qty?: number): Promise<{ to: string; price: number; asset: string }>
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
  close(): void
}

interface Order {
  key: string
  qty: number
  price: number
  at: number
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
  const keys = Object.keys(ItemsDB)
  const needed = (keys.length + 1) * 1_000 + 100
  const balance = await kei.balance()
  if (balance < needed) {
    if (options.network === 'mainnet') {
      throw new Error(
        `This world needs about ${needed} Kei to issue its currency and ${keys.length} item types, and ${kei.address} holds ${balance}. There is no faucet on mainnet — send the difference to that address and start the server again.`,
      )
    }
    await kei.faucet(needed)
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

  const exchange = options.exchange !== false
  const stopTopUps = exchange
    ? kei.acceptTopUps({ token: gold, rate: GOLD_PER_KEI, minimum: MINIMUM_TOP_UP })
    : undefined

  const orders = new Map<string, Order>()

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
    if (arrival.asset === gold.id) {
      const order = orders.get(arrival.from)
      if (!order || arrival.amount < order.price) return
      orders.delete(arrival.from)

      void (async () => {
        const token = itemTokens.get(order.key)
        if (!token) return
        await token.mint(arrival.from, order.qty)
        // The shop is a sink: gold spent here stops existing, which frees the
        // headroom it took under the cap (SPEC §5.6.6).
        await gold.burn(order.price)
        options.onDelivered?.({ to: arrival.from, key: order.key, qty: order.qty })
      })()
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

  return {
    address: kei.address,

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

      for (const [who, order] of orders) {
        if (Date.now() - order.at > ORDER_TTL_MS) orders.delete(who)
      }
      orders.set(player, { key, qty, price, at: Date.now() })
      return { to: kei.address, price, asset: gold.id }
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

    close() {
      stopTopUps?.()
      stopSettling()
      orders.clear()
      kei.close()
    },
  }
}
