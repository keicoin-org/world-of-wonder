/**
 * The auction house, which turns out to be an address book.
 *
 * Everything a player sees in the hall is a `swap_offer` block on some other
 * player's own chain (SPEC §9.3), and the trade that settles it is one block
 * that moves both legs or neither (§9.2). None of that happens here. That is
 * deliberate rather than minimal: this server can mint gold, so a hall it
 * brokered would be a hall whose keeper can invent both halves of a trade, and
 * it would look identical to a player.
 *
 * What is left is the one thing a chain will not do for you. An offer lives on
 * the chain of whoever wrote it and Kei ships no indexer (§9.4), so there is no
 * query for "every listing in the world" — somebody has to remember which
 * accounts are worth asking. That is this file: a set of addresses and a cache.
 * It is bookkeeping about *where to look*, never about who owns what, so it puts
 * nobody back in custody of anything. `carpet-markets/server/registry.ts` does
 * the same job for the same reason.
 *
 * Two consequences worth knowing before you design around them.
 *
 * **Nothing here is trusted.** A reader with the same list of addresses gets the
 * same answer without asking this server, and a player's wallet re-reads any
 * offer off the chain before it signs an accept — so the worst a wrong hall can
 * do is hide a listing or advertise one that no longer exists, and the second
 * fails at the ledger rather than costing anybody gold.
 *
 * **The roster is in memory.** A restart empties it and it refills as players
 * come back and announce themselves, so a listing by somebody who has not been
 * seen since is not shown until they are. That is the no-indexer limit showing
 * through rather than a bug, and the seller's item stays locked by the ledger
 * throughout either way — the lock is what makes an abandoned listing the
 * seller's problem instead of the network's (§9.3).
 */

import type { Kei, Offer, Trade } from 'kei-transaction'

/** One listing, named for what a player is looking at rather than what it is. */
export interface Stall {
  /** The `swap_offer` block's hash, which is the offer's id (SPEC §9.3). */
  hash: string
  seller: string
  /** The item archetype, so a client can draw the icon it already has. */
  key: string
  title: string
  qty: number
  /** Total gold asked for the lot. */
  price: number
  /** Gold per unit, so lots of different sizes can be compared. */
  each: number
  /** Advisory, and never enforced by the ledger (SPEC §9.3). */
  expiresAt: number | null
}

/** What an archetype has actually sold for here. Price history is just history. */
export interface Sold {
  key: string
  /** Gold per unit, most recent settlement first by the node's local clock. */
  last: number
  median: number
  low: number
  high: number
  trades: number
}

export interface HallPayload {
  /** How many chains were walked to build this. The hall's own honesty check. */
  accounts: number
  listings: Stall[]
  /** Keyed by archetype. Absent means never sold here, not sold for nothing. */
  history: Record<string, Sold>
}

export interface Hall {
  /**
   * Announce an account whose chain may carry a listing, and say that something
   * has changed.
   *
   * Those are one call rather than two because they arrive together every time:
   * a wallet announces itself when it opens, and again the moment after it
   * lists, accepts, or cancels — which are exactly the moments the cached read
   * below stops being true. The hall cannot notice a settlement by itself,
   * because it is not party to one.
   */
  watch(address: string): void
  /** Every open listing across the chains this hall knows to ask. */
  read(): Promise<HallPayload>
  close(): void
}

export interface HallOptions {
  /** Read with, never signed with. The hall writes no blocks at all. */
  kei: Kei
  /** The asset listings are priced in. Gold, here — not Kei. */
  coin: string
  /** Which archetype each item asset is. */
  items: Map<string, { key: string; title: string }>
}

/**
 * How long a read is reused. The hall is the first thing a panel polls, so
 * without this one open panel is one `account_swaps` per player per refresh.
 */
const CACHE_MS = 3_000

/** Settled swaps read per chain when summarising what things go for. */
const HISTORY_LIMIT = 100

export function openHall(options: HallOptions): Hall {
  const { kei, coin, items } = options

  /**
   * Every account whose chain might carry a listing.
   *
   * Seeded by play rather than by a sign-up: `Economy` announces anyone who
   * orders from the shop or sends it something, and a client announces itself
   * when it opens a wallet and again whenever it lists. Being wrong is cheap in
   * one direction — an account with no offers contributes an empty read — and
   * invisible in the other, since an unheard-of account's offers are simply not
   * listed, exactly as they would not be by any other reader who had not heard
   * of it either.
   */
  const traders = new Set<string>()
  let cached: { at: number; payload: HallPayload } | undefined
  let inflight: Promise<HallPayload> | undefined
  /** Bumped by `watch`, so a walk that started before a change never caches. */
  let generation = 0

  const stallOf = (offer: Offer): Stall | undefined => {
    const item = items.get(offer.give.asset)
    if (!item || offer.want.asset !== coin) return undefined
    return {
      hash: offer.hash,
      seller: offer.from,
      key: item.key,
      title: item.title,
      qty: offer.give.amount,
      price: offer.want.amount,
      each: offer.price,
      expiresAt: offer.expiresAt,
    }
  }

  /**
   * What things have gone for, off one walk rather than one per archetype.
   *
   * `market.price()` would answer this per asset, and asking it fifteen times
   * would re-read the same chains fifteen times. The trades are the same set
   * either way, so they are read once and grouped here.
   */
  const summarise = (trades: readonly Trade[]): Record<string, Sold> => {
    const each: Record<string, number[]> = {}
    // `trades` arrives newest first, so the first price seen for an archetype is
    // the latest one.
    const last: Record<string, number> = {}

    for (const trade of trades) {
      const sold = items.get(trade.give.asset)
      const bought = items.get(trade.want.asset)
      const item = sold ?? bought
      if (!item) continue
      const units = sold ? trade.give.amount : trade.want.amount
      const paid = sold ? trade.want.amount : trade.give.amount
      const against = sold ? trade.want.asset : trade.give.asset
      if (against !== coin || units <= 0) continue

      const price = paid / units
      ;(each[item.key] ??= []).push(price)
      last[item.key] ??= price
    }

    const history: Record<string, Sold> = {}
    for (const [key, prices] of Object.entries(each)) {
      const sorted = [...prices].sort((a, b) => a - b)
      const middle = sorted.length >> 1
      history[key] = {
        key,
        last: last[key] as number,
        median: sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
        low: sorted[0],
        high: sorted[sorted.length - 1],
        trades: sorted.length,
      }
    }
    return history
  }

  const walk = async (): Promise<HallPayload> => {
    const from = [...traders]
    if (from.length === 0) return { accounts: 0, listings: [], history: {} }

    const [offers, trades] = await Promise.all([
      kei.market.offers({ from, want: coin, state: 'open' }),
      kei.market.trades({ from, quote: coin, limit: HISTORY_LIMIT }),
    ])

    const listings: Stall[] = []
    for (const offer of offers) {
      const stall = stallOf(offer)
      if (stall) listings.push(stall)
    }
    // Cheapest per unit first, which is the order a buyer wants and the one
    // nothing else is going to impose — there is no matching engine here.
    listings.sort((a, b) => a.each - b.each || a.title.localeCompare(b.title))

    return { accounts: from.length, listings, history: summarise(trades) }
  }

  return {
    watch(address) {
      if (typeof address !== 'string' || !address.startsWith('kei_')) return
      traders.add(address)
      // Whoever said this either just arrived or just traded, so the last walk
      // is out of date either way. Dropping it costs at most one extra read —
      // concurrent reads collapse into one walk below — and keeps a panel from
      // showing a listing that was bought three seconds ago.
      cached = undefined
      generation += 1
    },

    async read() {
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.payload

      // One walk at a time. Two panels refreshing together should cost one read
      // of every chain, not two.
      if (!inflight) {
        const started = generation
        inflight = walk()
          .then((payload) => {
            // A walk that raced a `watch` read the world before the change it
            // was told about, so it answers this caller and is not kept.
            if (generation === started) cached = { at: Date.now(), payload }
            return payload
          })
          .finally(() => {
            inflight = undefined
          })
      }

      try {
        return await inflight
      } catch (error) {
        // A stale hall beats an empty one: a listing from three seconds ago is
        // still there, and a panel that blanked every time one node read timed
        // out would read as "the market closed".
        if (cached) return cached.payload
        throw error
      }
    },

    close() {
      traders.clear()
      cached = undefined
    },
  }
}
