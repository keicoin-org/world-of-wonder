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

import { STARTING_GOLD, type Economy } from './Economy'
import Logger from '../utils/Logger'

/** A player address is the only credential these routes need, and it is public. */
const looksLikeAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^kei_[a-z0-9]{50,70}$/.test(value)

export function mountEconomyApi(app: any, economy: Economy): void {
  /** Everything the client needs to render a shop and price it. */
  app.get('/kei/catalogue', (_request: any, response: any) => {
    response.json(economy.catalogue())
  })

  /** What the chain says this address holds. Cheap enough to poll. */
  app.get('/kei/wallet/:address', async (request: any, response: any) => {
    const address = request.params.address
    if (!looksLikeAddress(address)) {
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
   */
  app.post('/kei/order', async (request: any, response: any) => {
    const address = request.query.address
    const key = request.query.key
    const qty = Number(request.query.qty ?? 1)

    if (!looksLikeAddress(address)) {
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
    if (!looksLikeAddress(address)) {
      return response.status(400).json({ error: 'That is not a Kei address.' })
    }
    economy.hall.watch(address)
    response.json({ watching: address })
  })

  /**
   * A faucet, and only ever a development one.
   *
   * Granting gold is a mint the issuer signs, so an endpoint that does it on
   * request is an endpoint that prints this world's currency for anybody who
   * asks. In a real deployment a character is granted its starting gold once,
   * when it is created, and never from a route the client can call.
   */
  app.post('/kei/grant', async (request: any, response: any) => {
    if (process.env.NODE_ENV === 'production') {
      return response.status(404).json({ error: 'No such route.' })
    }

    const address = request.query.address
    const amount = Number(request.query.amount ?? STARTING_GOLD)
    if (!looksLikeAddress(address)) {
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
  if (process.env.NODE_ENV !== 'production') {
    Logger.warning('[kei] /kei/grant is open because this is not a production build — it mints gold on request')
  }
}
