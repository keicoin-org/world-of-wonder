/**
 * The economy's HTTP surface.
 *
 * Deliberately thin. Everything here either reads the chain or records an
 * intention — there is no endpoint that moves a player's money, because no such
 * endpoint can exist: the game does not hold the player's key (SPEC §6.3). The
 * client signs its own transfers straight to the node.
 *
 * Mounted under /kei so it cannot collide with upstream's /login and /characters.
 */

import { isAddress } from 'kei-transaction'

import { STARTING_GOLD, type Economy } from './Economy'
import { guardRoute } from '../utils/Failsafe'
import Logger from '../utils/Logger'

// An address names somebody; it does not authenticate them. Every hall listing
// prints one, so a route that takes an address has been told who a player is and
// nothing at all about who is asking.
//
// That is enough for the read-only routes below, where a leak costs nothing and
// the one write grants nothing. It was never enough for `/kei/order`, which is
// the only thing that decides what an arriving payment buys — see the order id
// there, and issue #13 for what that route was like without one.
//
// What the openness does not excuse is checking the address with a regex.
// `looksLikeAddress` used to live here as `/^kei_[a-z0-9]{50,70}$/`, and it was
// wrong in three independent ways: a real body is exactly 60 characters rather
// than 50 to 70, it is drawn from Nano's base32 alphabet, which excludes `0`,
// `2`, `l` and `v`, and its last 8 characters are a blake2b checksum over the
// public key that the regex never computed. `isAddress` does all three, and has
// been exported by the SDK the whole time (issue #18).
//
// The cost of the gap was not a worse error message. `/kei/hall/watch` writes
// into a 128-entry roster that evicts by insertion order, so 128 anonymous POSTs
// of syntactically-plausible nonsense evicted every real seller — and the SDK's
// market walk refuses the whole read on the first address it cannot parse, so
// what a player got afterwards was not an empty auction house but a 502.

/** An order id as `Economy.order()` writes them: 24 random bytes in hex. */
const looksLikeOrderId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{48}$/.test(value)

/**
 * What `POST /kei/purse` needs from the game's own account tables.
 *
 * A port rather than a `Database` import, for the same reason `PaidRewards` in
 * `Inventory.ts` is one: this directory holds the issuer's seed and should not
 * also know how characters are stored. What it needs is two questions and one
 * fact — whose character this is, whether the purse has already gone out, and
 * that it has now.
 */
export interface StartingPurses {
  /** Does this login token own this character? The only credential that route has. */
  owns(token: string, characterId: number): Promise<boolean>
  /**
   * Has this address, or this character, already been given one?
   *
   * Both, and durably. The address is the guard that survives a restart, because
   * a Kei address is never reissued; the character is the guard that stops one
   * player claiming again from a second browser wallet.
   */
  granted(address: string, characterId: number): Promise<boolean>
  record(entry: { address: string; characterId: number; amount: number }): Promise<void>
}

export function mountEconomyApi(app: any, economy: Economy, purses: StartingPurses): void {
  /** Addresses whose starting purse is being written down right now. */
  const granting = new Set<string>()

  /** Everything the client needs to render a shop and price it. */
  app.get('/kei/catalogue', (_request: any, response: any) => {
    response.json(economy.catalogue())
  })

  /** What the chain says this address holds. Cheap enough to poll. */
  app.get('/kei/wallet/:address', async (request: any, response: any) => {
    const address = request.params.address
    if (!isAddress(address)) {
      return response.status(400).json({ error: 'That is not a Kei address.' })
    }
    try {
      const [gold, inventory] = await Promise.all([economy.goldOf(address), economy.inventoryOf(address)])
      response.json({ address, gold, inventory })
    } catch (error) {
      Logger.error('[kei][wallet] ' + (error as Error).message)
      response.status(502).json({ error: 'The node did not answer.' })
    }
  })

  /**
   * Take an order. The response says where to send the gold and how much; the
   * client signs that transfer itself. Delivery happens when the chain confirms
   * it, not when this returns — the order is not the purchase.
   *
   * The address here is a destination, not a credential, and this route is
   * writable by anybody — so the order it creates is a *new* order rather than a
   * replacement for whatever that address had waiting, and it can only be
   * settled by a payment of exactly its own price. The id in the response is the
   * order's only name; hold on to it, because `GET /kei/order/:id` is the only
   * way to ask what happened and there is no other way to learn the id.
   */
  app.post('/kei/order', async (request: any, response: any) => {
    const address = request.query.address
    const key = request.query.key
    const qty = Number(request.query.qty ?? 1)

    if (!isAddress(address)) {
      return response.status(400).json({ error: 'That is not a Kei address.' })
    }
    if (typeof key !== 'string' || key === '') {
      return response.status(400).json({ error: 'Which item?' })
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      return response.status(400).json({ error: 'Quantity must be a whole number between 1 and 99.' })
    }

    try {
      response.json(await economy.order(address, key, qty))
    } catch (error) {
      // These messages are written to be shown to a player as-is.
      response.status(400).json({ error: (error as Error).message })
    }
  })

  /**
   * What became of an order: still waiting, delivered, or refunded and why.
   *
   * The id is the credential, and the only one available — an order is placed
   * before the payment exists, so there is nothing signed to check yet, and the
   * game cannot ask the player's wallet to prove control of its address because
   * no such primitive is published (kei-transaction#125/#142). An unguessable id
   * needs neither: it was handed to whoever placed the order and to nobody else,
   * so this route tells a stranger holding an address exactly nothing.
   */
  app.get('/kei/order/:id', (request: any, response: any) => {
    if (!looksLikeOrderId(request.params.id)) {
      return response.status(400).json({ error: 'That is not an order id.' })
    }
    const status = economy.orderStatus(request.params.id)
    if (!status) {
      // The same answer for an id that expired and an id that was invented, so
      // guessing cannot be used to learn which orders exist.
      return response.status(404).json({ error: 'No such order. It may have been forgotten — orders do not wait forever.' })
    }
    response.json(status)
  })

  // Selling deliberately has no route. The shop buys by reacting to an item
  // landing in its account, so a sale costs the seller the item before it pays
  // them — where a "sell this" endpoint would mint gold to anyone who asked for
  // it, having verified nothing. What the shop pays is in the catalogue, so a
  // client can quote a price without asking for one.

  /**
   * The auction house, read off the chains of the accounts it knows to ask.
   *
   * There is no listing here either, and for a stronger reason than above: a
   * listing is a `swap_offer` block on the seller's own chain, so it is not
   * something a server *can* do for them. The client signs it, and the two
   * routes below are the whole of this server's involvement in a trade between
   * two players — a list of addresses in, a list of listings out.
   */
  app.get('/kei/hall', async (_request: any, response: any) => {
    try {
      response.json(await economy.hall.read())
    } catch (error) {
      Logger.error('[kei][hall] ' + (error as Error).message)
      response.status(502).json({ error: 'The node did not answer, so the hall is empty rather than up to date.' })
    }
  })

  /**
   * Announce an address as one worth reading.
   *
   * Nothing is claimed by saying this and nothing is granted by it: an account
   * with no offers contributes an empty read, and an account with offers had
   * them whether or not anyone was looking. It is the client's half of the
   * bookkeeping Hall.ts exists to do.
   */
  app.post('/kei/hall/watch', (request: any, response: any) => {
    const address = request.query.address
    if (!isAddress(address)) {
      return response.status(400).json({ error: 'That is not a Kei address.' })
    }
    economy.hall.watch(address)
    response.json({ watching: address })
  })

  /**
   * The starting purse, and the only mint a production player can reach.
   *
   * A new character owns nothing, because it owns what the chain says it owns
   * and the chain has never heard of it. The cheapest thing the vendor sells is
   * a sword at 100 gold, so before this route existed the deployed game had no
   * first move at all: `STARTING_GOLD` was read only by `/kei/grant`, which is
   * closed in production, which is the only environment a player is in
   * (issue #24).
   *
   * Three properties make this a starting purse rather than a faucet with a
   * longer name.
   *
   * **It is claimed with the game's own credential.** The login token is what
   * `/create_character` already trusts, and it is checked against the character
   * being claimed for, so a stranger cannot claim on somebody else's behalf.
   *
   * **It goes out once, and the record of that survives a restart.** Once per
   * address, because an address is never reissued, and once per character, so a
   * second browser wallet is not a second purse. The row is written before the
   * mint for the reason `Inventory.pay()` writes its own first: an interrupted
   * grant that under-pays is a support question, and one that over-pays is an
   * unbounded mint of this world's currency.
   *
   * **The destination is unproven, and that is survivable here and nowhere
   * else.** This server still cannot check that a wallet belongs to the player
   * holding it (`proofUnavailable`, issue #6), so the address is taken on the
   * claimant's word. What that buys an attacker is the ability to send their own
   * one-time endowment somewhere they do not control. It is not sybil-proof
   * either — accounts are free — and it is not pretending to be: what bounds it
   * is that gold is this world's own token, the shop burns what it takes, and a
   * deployment that wants no starting purse sets `KEI_STARTING_GOLD=0`.
   */
  app.post(
    '/kei/purse',
    guardRoute(async (request: any, response: any) => {
      const token = request.query.token
      const address = request.query.address
      const characterId = Number(request.query.character)

      if (typeof token !== 'string' || token === '') {
        return response.status(400).json({ error: 'Log in first.' })
      }
      if (!isAddress(address)) {
        return response.status(400).json({ error: 'That is not a Kei address.' })
      }
      if (!Number.isInteger(characterId) || characterId < 1) {
        return response.status(400).json({ error: 'Which character?' })
      }
      if (STARTING_GOLD < 1) {
        return response.json({ granted: 0, reason: 'This world does not give out a starting purse.' })
      }

      if (!(await purses.owns(token, characterId))) {
        // The same answer for a character somebody else owns and a character
        // that does not exist, so this cannot be used to enumerate either.
        return response.status(403).json({ error: 'That is not your character.' })
      }

      // Held before anything is awaited, so two claims arriving together do not
      // both read "not granted yet" before either writes a row.
      if (granting.has(address)) {
        return response.json({ granted: 0, reason: 'Your starting purse is on its way.' })
      }
      granting.add(address)
      try {
        if (await purses.granted(address, characterId)) {
          return response.json({ granted: 0, reason: 'You have already had your starting purse.' })
        }

        await purses.record({ address, characterId, amount: STARTING_GOLD })
        await economy.grant(address, STARTING_GOLD)
        Logger.info(`[kei][purse] granted ${STARTING_GOLD} gold to character ${characterId}`)
        response.json({ granted: STARTING_GOLD })
      } finally {
        granting.delete(address)
      }
    }),
  )

  /**
   * A faucet, and only ever a development one.
   *
   * Granting gold is a mint the issuer signs, so an endpoint that does it on
   * request is an endpoint that prints this world's currency for anybody who
   * asks. What a production player gets instead is `/kei/purse` above, which is
   * the same mint bounded by a credential and a durable record.
   */
  app.post('/kei/grant', async (request: any, response: any) => {
    if (process.env.NODE_ENV === 'production') {
      return response.status(404).json({ error: 'No such route.' })
    }

    const address = request.query.address
    const amount = Number(request.query.amount ?? STARTING_GOLD)
    if (!isAddress(address)) {
      return response.status(400).json({ error: 'That is not a Kei address.' })
    }
    if (!Number.isInteger(amount) || amount < 1 || amount > 10_000) {
      return response.status(400).json({ error: 'Grant a whole number between 1 and 10000.' })
    }

    try {
      await economy.grant(address, amount)
      response.json({ granted: amount })
    } catch (error) {
      response.status(400).json({ error: (error as Error).message })
    }
  })

  Logger.info('[kei] economy api mounted at /kei — issuer ' + economy.address)
  Logger.info(
    STARTING_GOLD > 0
      ? `[kei] a new character claims ${STARTING_GOLD} gold once, at /kei/purse`
      : '[kei] KEI_STARTING_GOLD=0, so a new character starts with nothing and earns its first gold at the auction house',
  )
  if (process.env.NODE_ENV !== 'production') {
    Logger.warning('[kei] /kei/grant is open because this is not a production build — it mints gold on request')
  }
}
