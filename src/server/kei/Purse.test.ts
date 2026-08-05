/**
 * The starting purse, tested in the environment it was missing from.
 *
 * Issue #24 is not that `STARTING_GOLD` was the wrong number. It is that the
 * only route that read it, `/kei/grant`, answers 404 when `NODE_ENV=production`
 * — so the constant was correct in the file and absent from the deployment, and
 * a player arrived at a 100-gold sword holding nothing. This file therefore sets
 * `NODE_ENV=production` before it does anything else, because a green run under
 * development configuration is exactly the reassurance that was already there.
 *
 * What is checked, in order: that the old route is still closed, that the new one
 * funds a player anyway, that it does so once, and that the credential it wants
 * is the game's own login token rather than an address anybody can name.
 *
 *   npm run test:purse
 */

import express from 'express'
import type { AddressInfo } from 'node:net'
import { Kei } from 'kei-transaction'

import { startEconomy, STARTING_GOLD } from './Economy'
import { mountEconomyApi, type StartingPurses } from './api'

// Before the server is built, and the reason this file exists.
process.env.NODE_ENV = 'production'

const ISSUER_SEED = 'A'.repeat(64)
const NEWCOMER_SEED = 'B'.repeat(64)
const SECOND_WALLET_SEED = 'C'.repeat(64)
const STRANGER_SEED = 'D'.repeat(64)
const RACER_SEED = 'F'.repeat(64)

let failures = 0

function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

//////////////////////////////////////////////////
// A world, and a game database that knows two characters.
//////////////////////////////////////////////////

/** Character id to the login token of the account that owns it. */
const owners = new Map<number, string>([
  [1, 'token-for-the-newcomer'],
  [2, 'token-for-somebody-else'],
  [3, 'token-for-the-racer'],
])

/**
 * The two rows and one join `Database.ts` runs, in memory.
 *
 * `granted` matches the real query's `address=? OR owner_id=?` exactly, because
 * that disjunction is the whole guard: one purse per address, and one per
 * character.
 */
const written: Array<{ address: string; characterId: number; amount: number }> = []
const purses: StartingPurses = {
  async owns(token, characterId) {
    return owners.get(characterId) === token
  },
  async granted(address, characterId) {
    return written.some((row) => row.address === address || row.characterId === characterId)
  },
  async record(entry) {
    written.push(entry)
  },
}

const node = await Kei.mock({})
const economy = await startEconomy({ seed: ISSUER_SEED, node, network: 'mock' })

const app = express()
app.use(express.json())
mountEconomyApi(app, economy, purses)
const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

async function post(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { connection: 'close' } })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

const newcomer = await Kei.start({ node, seed: NEWCOMER_SEED })
const catalogue = economy.catalogue()
const sword = catalogue.items.find((item) => item.key === 'sword_01')!

//////////////////////////////////////////////////
// The state a production player actually arrived in.
//////////////////////////////////////////////////

check('the purse buys the cheapest thing the vendor sells', STARTING_GOLD >= sword.value, `${STARTING_GOLD} vs ${sword.value}`)

const devFaucet = await post(`/kei/grant?address=${newcomer.address}&amount=${STARTING_GOLD}`)
check('POST /kei/grant is still closed in production', devFaucet.status === 404, `${devFaucet.status}`)

check('so the newcomer holds nothing', (await economy.goldOf(newcomer.address)) === 0)

let tooPoor = ''
try {
  await economy.order(newcomer.address, 'sword_01')
} catch (error) {
  tooPoor = (error as Error).message
}
check('and cannot order the sword', tooPoor.includes('gold and you have 0'), tooPoor)

//////////////////////////////////////////////////
// What the token has to be for the mint to happen.
//////////////////////////////////////////////////

const anonymous = await post(`/kei/purse?address=${newcomer.address}&character=1`)
check('POST /kei/purse without a token is refused', anonymous.status === 400, `${anonymous.status}`)

const notAnAddress = await post(`/kei/purse?token=${owners.get(1)}&character=1&address=kei_nope`)
check('POST /kei/purse without an address is refused', notAnAddress.status === 400, `${notAnAddress.status}`)

const noCharacter = await post(`/kei/purse?token=${owners.get(1)}&address=${newcomer.address}`)
check('POST /kei/purse without a character is refused', noCharacter.status === 400, `${noCharacter.status}`)

const invented = await post(`/kei/purse?token=made-this-up&character=1&address=${newcomer.address}`)
check('an invented token claims nothing', invented.status === 403, `${invented.status}`)

// The interesting one: a real, valid token — for a different account. Without the
// join this is a mint to anybody who can name a character id, and ids are 1, 2, 3.
const stranger = await Kei.start({ node, seed: STRANGER_SEED })
const somebodyElses = await post(`/kei/purse?token=${owners.get(2)}&character=1&address=${stranger.address}`)
check("a real token cannot claim another account's character", somebodyElses.status === 403, `${somebodyElses.status}`)
check('and nothing was minted to the address it named', (await economy.goldOf(stranger.address)) === 0)

//////////////////////////////////////////////////
// The first five minutes.
//////////////////////////////////////////////////

const claimed = await post(`/kei/purse?token=${owners.get(1)}&character=1&address=${newcomer.address}`)
check('a logged-in character claims its purse in production', claimed.status === 200 && claimed.body.granted === STARTING_GOLD, JSON.stringify(claimed.body))
check('and the chain agrees', (await economy.goldOf(newcomer.address)) === STARTING_GOLD)

const order = await economy.order(newcomer.address, 'sword_01')
check('which is enough to order the sword', order.price === sword.value, `${order.price}`)

//////////////////////////////////////////////////
// Once, and only once.
//////////////////////////////////////////////////

const again = await post(`/kei/purse?token=${owners.get(1)}&character=1&address=${newcomer.address}`)
check('a second claim grants nothing', again.status === 200 && again.body.granted === 0, JSON.stringify(again.body))
check('and mints nothing', (await economy.goldOf(newcomer.address)) === STARTING_GOLD)

// Clearing site data makes a new wallet, and a new wallet is a new address. The
// character is what refuses this, which is why the record keys on both.
const secondWallet = await Kei.start({ node, seed: SECOND_WALLET_SEED })
const secondPurse = await post(`/kei/purse?token=${owners.get(1)}&character=1&address=${secondWallet.address}`)
check('the same character cannot claim again from a second wallet', secondPurse.body.granted === 0, JSON.stringify(secondPurse.body))
check('and that wallet holds nothing', (await economy.goldOf(secondWallet.address)) === 0)

// Two claims in flight together. Both read the store before either writes to it,
// so without the in-process hold this is two mints for one character.
const racer = await Kei.start({ node, seed: RACER_SEED })
const raced = await Promise.all([
  post(`/kei/purse?token=${owners.get(3)}&character=3&address=${racer.address}`),
  post(`/kei/purse?token=${owners.get(3)}&character=3&address=${racer.address}`),
])
check('two simultaneous claims pay one purse', (await economy.goldOf(racer.address)) === STARTING_GOLD, `${await economy.goldOf(racer.address)}`)
check('and one of them is told so', raced.filter((response) => response.body.granted === STARTING_GOLD).length === 1, JSON.stringify(raced.map((r) => r.body)))
check('with one row written for it', written.filter((row) => row.characterId === 3).length === 1, `${written.length} rows in total`)

economy.close()
await new Promise((resolve) => server.close(resolve))

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
