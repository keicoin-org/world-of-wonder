/**
 * What the /kei routes will accept as an address, and what a wrong answer costs.
 *
 * `looksLikeAddress` was `/^kei_[a-z0-9]{50,70}$/`, which is not what a Kei
 * address is: the body is exactly 60 characters, drawn from Nano's base32
 * alphabet, and its last 8 are a checksum over the public key. So the regex
 * accepted a wide space of strings that decode to nothing, and every one of them
 * could be POSTed to `/kei/hall/watch` — an unauthenticated route by design,
 * because announcing an address claims nothing — into a roster of 128 that
 * evicts by insertion order.
 *
 * The consequence is the reason this file talks over HTTP against a real chain
 * instead of unit-testing a predicate. 128 anonymous POSTs used to empty the
 * auction house for every player in the world, and cost the attacker nothing to
 * keep it that way, because the SDK's market walk drops an unparseable address
 * before it makes a node call. So the check that matters below is not "is the
 * fake refused" but "is the real seller's sword still on the board afterwards"
 * (issue #18).
 *
 * The last section pins what this fix does *not* do, on purpose.
 *
 *   npm run test:addresses
 */

import express from 'express'
import type { AddressInfo } from 'node:net'
import { Kei, addressFromPublicKey, isAddress, keyPairFromSeed } from 'kei-transaction'

import { startEconomy, STARTING_GOLD } from './Economy'
import { mountEconomyApi } from './api'

const ISSUER_SEED = 'A'.repeat(64)
const SELLER_SEED = 'C'.repeat(64)
/** Only ever used to make addresses, never to hold anything. */
const ATTACKER_SEED = 'E'.repeat(64)

const ASKING = 75

/**
 * The check this file replaced, kept verbatim.
 *
 * Every "the old check would have taken this" assertion below is measured
 * against it rather than described in a comment, because the interesting property
 * of each hostile string is not that `isAddress` refuses it — almost everything
 * fails that — but that the regex did not.
 */
const LOOKS_LIKE_ADDRESS = /^kei_[a-z0-9]{50,70}$/

/** Nano's base32 alphabet. No 0, 2, l, or v. */
const ALPHABET = '13456789abcdefghijkmnopqrstuwxyz'

let failures = 0

function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function until(predicate: () => Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

//////////////////////////////////////////////////
// A world with one seller who has something for sale.
//////////////////////////////////////////////////

const node = await Kei.mock({})
const economy = await startEconomy({ seed: ISSUER_SEED, node, network: 'mock' })
const seller = await Kei.start({ node, seed: SELLER_SEED })

const app = express()
app.use(express.json())
mountEconomyApi(app, economy)
const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

/**
 * One request, and a retry if the socket rather than the server said no.
 *
 * This file makes ~270 sequential requests, which is enough to run into a
 * keep-alive socket being reused on one side while the other is closing it —
 * ECONNRESET, on a loaded machine, in a loop of 128. `connection: close` avoids
 * reusing sockets at all and the retry covers the rest; a transport hiccup is not
 * what any assertion here is about, and letting one masquerade as a validator
 * result would be worse than either.
 */
async function request(path: string, method = 'GET'): Promise<{ status: number; body: any }> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${base}${path}`, { method, headers: { connection: 'close' } })
      return { status: response.status, body: await response.json() }
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw last
}

const get = (path: string) => request(path)
const post = (path: string) => request(path, 'POST')

/**
 * The board, or an empty one if the hall did not answer with a board at all.
 *
 * Not defensive padding. A poisoned roster does not produce an empty hall in this
 * SDK version — `market.offers({ from })` throws on the first unparseable
 * address, so `GET /kei/hall` answers 502 and `listings` is absent. Reading
 * through that would crash this file instead of reporting which assertion broke.
 */
const listings = (body: any): any[] => (Array.isArray(body?.listings) ? body.listings : [])

const catalogue = economy.catalogue()
const sword = catalogue.items.find((item) => item.key === 'sword_01')!

await economy.grant(seller.address, STARTING_GOLD)
await seller.sync()
const sellerGold = await seller.token.get(catalogue.coin.asset)

const order = await economy.order(seller.address, 'sword_01')
await sellerGold.transfer(order.to, order.price)
check(
  'the seller owns a sword to sell',
  await until(async () => ((await economy.inventoryOf(seller.address))['sword_01'] ?? 0) >= 1),
)

const offer = await seller.market.offer({
  give: { asset: sword.asset, amount: 1 },
  want: { asset: catalogue.coin.asset, amount: ASKING },
})

const announced = await post(`/kei/hall/watch?address=${seller.address}`)
check('a real address is accepted', announced.status === 200, JSON.stringify(announced.body))

const board = await get('/kei/hall')
check(
  'and the hall shows their sword',
  listings(board.body).some((entry) => entry.hash === offer.hash),
  `${listings(board.body).length} listing(s)`,
)

//////////////////////////////////////////////////
// The attack from the issue, unchanged: 128 strings the regex liked.
//////////////////////////////////////////////////

// `kei_` plus fifty-two zeros plus 0001, 0002 … exactly as reported. A 56-
// character body, so the old 50-to-70 window took it; `0` is not in the base32
// alphabet at all, so it never decoded to anything.
const flood = Array.from({ length: 128 }, (_, index) => `kei_${'0'.repeat(52)}${String(index + 1).padStart(4, '0')}`)

check('every one of the 128 would have passed the old regex', flood.every((address) => LOOKS_LIKE_ADDRESS.test(address)))
check('and none of them is an address', flood.every((address) => !isAddress(address)))

let accepted = 0
for (const address of flood) {
  const response = await post(`/kei/hall/watch?address=${address}`)
  if (response.status !== 400) accepted += 1
}
check('POST /kei/hall/watch refuses all 128', accepted === 0, `${accepted} accepted`)

// The checks the issue is actually about. The roster holds 128 and evicts the
// oldest, so under the old validator these 128 replaced the seller entirely.
//
// Worth recording what that produced, because it is worse than the issue
// predicted: it expected an empty board, on the basis that the SDK's market walk
// skips an address it cannot parse. This SDK version throws instead, so the
// poisoned roster made `GET /kei/hall` answer 502 to every player rather than
// answering with nothing — and `watch()` drops the read cache, so there was no
// stale board left to fall back on either.
const afterFlood = await get('/kei/hall')
check('the hall still answers after the flood', afterFlood.status === 200, `${afterFlood.status}`)
check(
  'the seller is still on the board after the flood',
  listings(afterFlood.body).some((entry) => entry.hash === offer.hash),
  `${listings(afterFlood.body).length} listing(s)`,
)
check('and nothing was added to the roster', afterFlood.body.accounts === 1, `${afterFlood.body.accounts} account(s)`)

//////////////////////////////////////////////////
// The three ways the regex was wrong, one at a time.
//////////////////////////////////////////////////

// 1. The checksum, which is the whole reason this cannot be a regex. Same prefix,
// same length, same alphabet, one key character swapped for another legal one.
const at = 10
const corrupted =
  seller.address.slice(0, at) +
  ALPHABET[(ALPHABET.indexOf(seller.address[at]) + 1) % ALPHABET.length] +
  seller.address.slice(at + 1)
check('the checksum-invalid address is the same shape as the real one', LOOKS_LIKE_ADDRESS.test(corrupted) && corrupted.length === seller.address.length)
check('and the SDK knows it is not an address', !isAddress(corrupted))
const badChecksum = await post(`/kei/hall/watch?address=${corrupted}`)
check('POST /kei/hall/watch refuses a checksum-invalid address', badChecksum.status === 400, `${badChecksum.status}`)

// 2. The alphabet. `0`, `2`, `l` and `v` cannot appear in a Kei address and all
// four are in `[a-z0-9]`.
for (const excluded of ['0', '2', 'l', 'v']) {
  const wrongAlphabet = seller.address.slice(0, at) + excluded + seller.address.slice(at + 1)
  const response = await post(`/kei/hall/watch?address=${wrongAlphabet}`)
  check(`POST /kei/hall/watch refuses "${excluded}", which base32 excludes`, response.status === 400 && LOOKS_LIKE_ADDRESS.test(wrongAlphabet), `${response.status}`)
}

// 3. The length window. No real address has a body of 50 or of 70; the regex
// accepted both ends and everything between.
for (const length of [50, 60, 70]) {
  const wrongLength = `kei_${'a'.repeat(length)}`
  const response = await post(`/kei/hall/watch?address=${wrongLength}`)
  check(`POST /kei/hall/watch refuses a ${length}-character body`, response.status === 400, `${response.status}`)
}

//////////////////////////////////////////////////
// The same validator gates three more routes, one of which is a mint.
//////////////////////////////////////////////////

const fake = flood[0]
const walletOfNobody = await get(`/kei/wallet/${fake}`)
check('GET /kei/wallet refuses it', walletOfNobody.status === 400, `${walletOfNobody.status}`)

const orderByNobody = await post(`/kei/order?address=${fake}&key=sword_01`)
check('POST /kei/order refuses it', orderByNobody.status === 400, `${orderByNobody.status}`)

// This one signs an issuer mint. A checksum-invalid destination was previously
// accepted all the way to `gold.mint(address, amount)`.
const grantToNobody = await post(`/kei/grant?address=${corrupted}&amount=10`)
check('POST /kei/grant refuses a checksum-invalid destination', grantToNobody.status === 400, `${grantToNobody.status}`)

//////////////////////////////////////////////////
// Hall.watch's own check, which is not the route's repeated.
//////////////////////////////////////////////////

// `Economy.ts` calls `hall.watch()` directly for anyone who sends the shop
// something, so this is the only validation on those paths. It used to be
// `startsWith('kei_')`, which accepts the four-character string `kei_`.
for (const notAnAddress of ['kei_', 'kei_' + '0'.repeat(60), '', 'nope']) {
  economy.hall.watch(notAnAddress)
}
const afterDirectWatch = await get('/kei/hall')
check('Hall.watch takes none of them either', afterDirectWatch.body.accounts === 1, `${afterDirectWatch.body.accounts} account(s)`)

//////////////////////////////////////////////////
// What this fix does not do.
//////////////////////////////////////////////////

// Addresses are free to generate, so the eviction is still available to anybody
// willing to spend 128 keypairs on it — which is a fraction of a second. This is
// asserted rather than described so that nobody reads the section above and
// concludes the roster is now safe: it is not, and the fix for it is to stop
// evicting accounts the last walk saw holding an open offer.
const keypairs = await Promise.all(Array.from({ length: 128 }, (_, index) => keyPairFromSeed(ATTACKER_SEED, index)))
const real = keypairs.map((pair) => addressFromPublicKey(pair.publicKey))
check('128 real addresses cost nothing but a keypair each', real.every((address) => isAddress(address)))

let refused = 0
for (const address of real) {
  const response = await post(`/kei/hall/watch?address=${address}`)
  if (response.status !== 200) refused += 1
}
check('all 128 are accepted, because they are addresses', refused === 0, `${refused} refused`)

const evicted = await get('/kei/hall')
check(
  'KNOWN, NOT FIXED: 128 valid addresses still evict the seller from a 128-entry roster',
  evicted.status === 200 && listings(evicted.body).every((entry) => entry.hash !== offer.hash),
  `${listings(evicted.body).length} listing(s), ${evicted.body.accounts} account(s)`,
)

economy.close()
await new Promise((resolve) => server.close(resolve))

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
