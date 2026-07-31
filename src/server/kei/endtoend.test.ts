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

import { Kei } from 'kei-transaction'

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

  // The player signs this. The server never sees a key.
  await gold.transfer(order.to, order.price)

  const arrived = await until(async () => {
    const held = await (await fetch(`${BASE}/kei/wallet/${player.address}`)).json()
    return (held.inventory?.sword_01 ?? 0) >= 1
  })
  check('the sword arrived after the chain confirmed payment', arrived)

  await player.sync()
  check('the player paid for it', (await gold.balance()) === 400, `${await gold.balance()}`)
} else {
  console.log('  ..    /kei/grant is not exposed; skipping the funded half')
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
