/**
 * The whole thing across a URL, the way a browser will actually do it.
 *
 * Economy.test.ts shares a heap with the issuer, which proves the rules but not
 * the deployment. This one talks to a running server over HTTP and nothing else:
 * it reads the shop, signs its own transfer against the node at /rpc, and waits
 * for the item to arrive. If this passes, the hosted client can work.
 *
 *   npm run server-start &
 *   npm run test:e2e
 */

import { Kei, randomSeed } from 'kei-transaction'

const BASE = process.env.KEI_TEST_BASE ?? 'http://localhost:3000'

let failures = 0
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function until(predicate: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

const catalogue = await (await fetch(`${BASE}/kei/catalogue`)).json()
check('the shop answers over HTTP', Array.isArray(catalogue.items) && catalogue.items.length > 0)

// --------------------------------------------------------------- issue #22
//
// Who a browser will let call this server. Asked over the wire because the
// header is the whole mechanism: a policy that is right in `Origins.ts` and
// missing from the response has done nothing at all.
//
// Note what is *not* checked — that a stranger's request fails. It does not, and
// cannot: CORS is a rule browsers apply to themselves after the response
// arrives, so the body below is fetched perfectly well by this test, which is
// not a browser. What decides whether a page may read it is the header.
const allowFor = async (origin: string): Promise<string | null> => {
  const response = await fetch(`${BASE}/kei/catalogue`, { headers: { Origin: origin } })
  return response.headers.get('access-control-allow-origin')
}

check('a page served by the dev server may call the shop', (await allowFor('http://localhost:8080')) === 'http://localhost:8080')
check("a page the player merely had open may not", (await allowFor('https://evil.example')) === null)
check('and neither may a lookalike of an allowed origin', (await allowFor('http://localhost:8080.evil.example')) === null)

// A preflight is the only thing a browser sends before a cross-site POST to the
// money routes, so it is the one that has to refuse.
const preflight = await fetch(`${BASE}/kei/order?address=kei_x&key=sword_01`, {
  method: 'OPTIONS',
  headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
})
check(
  'a cross-site preflight to the order route is not granted',
  preflight.headers.get('access-control-allow-origin') === null,
  String(preflight.status),
)
check(
  'and nothing offers to carry credentials',
  preflight.headers.get('access-control-allow-credentials') === null,
)

// A client has to be able to price both directions without asking, because the
// selling direction has no route to ask.
const sword = catalogue.items.find((item: any) => item.key === 'sword_01')
check('the shop quotes what it charges and what it pays', sword?.value === 100 && sword?.buyback === 50, JSON.stringify(sword))

// A player, holding its own key, talking to the node across a URL — exactly what
// the browser does. Nothing here shares memory with the server.
const player = await Kei.start({ node: `${BASE}/rpc` })
check('a wallet can reach the node at /rpc', typeof player.address === 'string' && player.address.startsWith('kei_'))

const wallet = await (await fetch(`${BASE}/kei/wallet/${player.address}`)).json()
check('a new player owns nothing', wallet.gold === 0 && Object.keys(wallet.inventory).length === 0)

// Being refused is the correct answer when you cannot pay, and the message has
// to be one a player can act on.
const refused = await (await fetch(`${BASE}/kei/order?address=${player.address}&key=sword_01`, { method: 'POST' })).json()
check('a broke player is refused, in a sentence', String(refused.error).includes('you have 0'), refused.error)

// Fund them the way the game would, then buy. The server can mint its own
// currency; what it cannot do is spend the player's.
const granted = await fetch(`${BASE}/kei/grant?address=${player.address}&amount=500`, { method: 'POST' })
if (granted.ok) {
  await player.sync()
  const gold = await player.token.get(catalogue.coin.asset)
  check('the player was funded', (await gold.balance()) === 500, `${await gold.balance()}`)

  const order = await (
    await fetch(`${BASE}/kei/order?address=${player.address}&key=sword_01`, { method: 'POST' })
  ).json()
  check('the shop quotes a price and an address', order.price === 100 && typeof order.to === 'string', JSON.stringify(order))
  // The id is the order's only name and the only credential for reading it, so
  // it has to survive the wire (issue #13).
  check('and names the order with something unguessable', /^[0-9a-f]{48}$/.test(order.id ?? ''), JSON.stringify(order.id))

  const waiting = await (await fetch(`${BASE}/kei/order/${order.id}`)).json()
  check('an order can be read back by its id', waiting.state === 'open' && waiting.key === 'sword_01', JSON.stringify(waiting))
  const invented = await fetch(`${BASE}/kei/order/${'a'.repeat(48)}`)
  check('and an id nobody was given reads as nothing', invented.status === 404, `${invented.status}`)

  // The player signs this. The server never sees a key.
  await gold.transfer(order.to, order.price)

  const arrived = await until(async () => {
    const held = await (await fetch(`${BASE}/kei/wallet/${player.address}`)).json()
    return (held.inventory?.sword_01 ?? 0) >= 1
  })
  check('the sword arrived after the chain confirmed payment', arrived)

  const settled = await (await fetch(`${BASE}/kei/order/${order.id}`)).json()
  check('and the order says so', settled.state === 'delivered', JSON.stringify(settled))

  await player.sync()
  check('the player paid for it', (await gold.balance()) === 400, `${await gold.balance()}`)

  // Selling it back, across the same wire. There is nothing to POST: the shop
  // buys by paying for what lands in its account, so handing over the sword is
  // the entire request. A browser can do this and cannot do anything cheaper.
  const purse = await gold.balance()
  await player.items.transfer(sword.asset, catalogue.issuer)

  const wasPaid = await until(async () => {
    await player.sync()
    return (await gold.balance()) > purse
  })
  check('the shop paid for the sword it was sent', wasPaid)
  check('and it paid what it advertised', (await gold.balance()) === purse + sword.buyback, `${await gold.balance()}`)

  const sold = await (await fetch(`${BASE}/kei/wallet/${player.address}`)).json()
  check('the sword is no longer the player\'s', (sold.inventory?.sword_01 ?? 0) === 0, `${sold.inventory?.sword_01 ?? 0}`)

  // ------------------------------------------------------------ auction house
  //
  // The same trade the panel makes, across a URL. Two browsers, two keys, and a
  // server that only ever answers "here is who to read" — the listing block, the
  // settlement block, and the gold all belong to the players.

  const relist = await (
    await fetch(`${BASE}/kei/order?address=${player.address}&key=sword_01`, { method: 'POST' })
  ).json()
  await gold.transfer(relist.to, relist.price)
  const rebought = await until(async () => {
    const held = await (await fetch(`${BASE}/kei/wallet/${player.address}`)).json()
    return (held.inventory?.sword_01 ?? 0) >= 1
  })
  check('the player has a sword to auction', rebought)

  const ASKING = 80
  await player.sync()
  // What the client's wallet does: announce, then sign the listing itself.
  await fetch(`${BASE}/kei/hall/watch?address=${player.address}`, { method: 'POST' })
  const offer = await player.market.offer({
    give: { asset: sword.asset, amount: 1 },
    want: { asset: catalogue.coin.asset, amount: ASKING },
  })
  await fetch(`${BASE}/kei/hall/watch?address=${player.address}`, { method: 'POST' })

  const hall = await (await fetch(`${BASE}/kei/hall`)).json()
  const stall = (hall.listings ?? []).find((entry: any) => entry.hash === offer.hash)
  check('the hall serves the listing over HTTP', stall !== undefined, `${(hall.listings ?? []).length} listing(s)`)
  check('priced in gold, and named as a sword', stall?.price === ASKING && stall?.key === 'sword_01', JSON.stringify(stall))

  // A second player, holding a second key, sharing nothing with the first. The
  // seed is named because `Kei.start()` persists one and hands the same wallet
  // back on the next call — which is the right behaviour for a returning player
  // in a browser and would make this a trade with itself.
  const rival = await Kei.start({ node: `${BASE}/rpc`, seed: randomSeed() })
  await fetch(`${BASE}/kei/grant?address=${rival.address}&amount=500`, { method: 'POST' })
  await fetch(`${BASE}/kei/hall/watch?address=${rival.address}`, { method: 'POST' })
  await rival.sync()

  const purseBefore = await gold.balance()
  await rival.market.accept(offer.hash)
  await fetch(`${BASE}/kei/hall/watch?address=${rival.address}`, { method: 'POST' })

  const bought = await until(async () => {
    const held = await (await fetch(`${BASE}/kei/wallet/${rival.address}`)).json()
    return (held.inventory?.sword_01 ?? 0) >= 1
  })
  check('the buyer owns the sword, and the server never touched it', bought)

  await player.sync()
  check('the seller was paid in gold, by the buyer', (await gold.balance()) === purseBefore + ASKING, `${await gold.balance()}`)

  const after = await (await fetch(`${BASE}/kei/hall`)).json()
  check('the listing is off the board', (after.listings ?? []).every((entry: any) => entry.hash !== offer.hash))
  check(
    'and the hall reports what a sword went for, off the chain',
    after.history?.sword_01?.last === ASKING,
    JSON.stringify(after.history?.sword_01),
  )
} else {
  console.log('  ..    /kei/grant is not exposed; skipping the funded half')
}

// ------------------------------------------------------------ the first move
//
// Everything above is funded by `/kei/grant`, which is the development faucet and
// answers 404 in production. So none of it says anything about how a real player
// gets their first gold, and that gap is the whole of issue #24: the constant was
// right in the file and unreachable in the only environment that matters.
//
// This section uses no faucet. It creates an account through the same route the
// login screen does, claims the starting purse with the token that route returned,
// and asks the chain. It is deliberately outside the block above so it runs even
// where `/kei/grant` is closed — which is exactly where it needs to run.

const account = (await (await fetch(`${BASE}/returnRandomUser`, { method: 'POST' })).json()).user
check('an account and a character can be created over HTTP', typeof account?.token === 'string' && account?.id > 0, JSON.stringify(account?.name))

const newcomer = await Kei.start({ node: `${BASE}/rpc`, seed: randomSeed() })
const empty = await (await fetch(`${BASE}/kei/wallet/${newcomer.address}`)).json()
check('a fresh character starts with nothing', empty.gold === 0)

const unclaimed = await (
  await fetch(`${BASE}/kei/purse?token=nonsense&character=${account.id}&address=${newcomer.address}`, { method: 'POST' })
).json()
check('a token nobody was issued claims nothing', unclaimed.granted === undefined, JSON.stringify(unclaimed))

const claimed = await (
  await fetch(`${BASE}/kei/purse?token=${account.token}&character=${account.id}&address=${newcomer.address}`, { method: 'POST' })
).json()
check('the character claims its starting purse', claimed.granted > 0, JSON.stringify(claimed))

// A mint arrives as a block addressed to this wallet and is not its property
// until this wallet signs for it (SPEC §5.6.3). That is what `Wallet.refresh()`
// does in the browser after a claim, and skipping it here would be a test that
// believed the server's answer instead of the chain's.
const collected = await until(async () => {
  await newcomer.sync()
  return (await (await fetch(`${BASE}/kei/wallet/${newcomer.address}`)).json()).gold === claimed.granted
})
check('and the chain, not the server, says they have it', collected, `${(await (await fetch(`${BASE}/kei/wallet/${newcomer.address}`)).json()).gold}`)

const affordable = await (
  await fetch(`${BASE}/kei/order?address=${newcomer.address}&key=sword_01`, { method: 'POST' })
).json()
check('which is enough to order the cheapest thing the vendor sells', affordable.price === 100, JSON.stringify(affordable))

const twice = await (
  await fetch(`${BASE}/kei/purse?token=${account.token}&character=${account.id}&address=${newcomer.address}`, { method: 'POST' })
).json()
check('and it is claimed once', twice.granted === 0, JSON.stringify(twice))

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
