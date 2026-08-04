/**
 * The boundary issue #6 is about, tested: a row in SQLite is not ownership, and
 * nothing this server authors is paid to an address it cannot prove belongs to
 * the player. Run with `npm run test:inventory`.
 *
 * Everything here is in-process and deterministic — a `MockNode`, a temporary
 * SQLite file, fixed seeds — because the claims being checked are about refusal
 * and about idempotency, and both have to hold on the first run and the tenth.
 *
 * What this file does *not* prove is the finished migration. There is no bound
 * wallet in a running deployment (see `proofUnavailable`), so the tests that
 * exercise a bound one inject a verifier that says yes. That is the seam the
 * next slice fills, and holding it still under test is the point of having it.
 */

import { Kei } from 'kei-transaction'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startEconomy } from './Economy'
import { openInventoryAuthority, proofUnavailable, type ProofVerifier, type WalletProof } from './Inventory'
import { describeLegacy, isEmptyLegacy, quarantineLegacy } from './Legacy'
import { Database } from '../Database'
import { Config } from '../../shared/Config'

const ISSUER_SEED = 'd4'.repeat(32)
const PLAYER_SEED = 'e7'.repeat(32)
const CHARACTER = 1

let failures = 0

function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** A chain round trip is not instant, and a mint is a chain round trip. */
async function until(predicate: () => Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** Stands in for the wallet-session proof that does not exist yet. */
const acceptsAnySignature: ProofVerifier = async (proof) => proof.signature === 'signed'

const directory = mkdtempSync(join(tmpdir(), 'wow-inventory-'))
process.env.DATABASE_PATH = join(directory, 'test.db')

const database = new Database(new Config())
await database.init()
await database.create()
// `createDatabase()` fires its statements without awaiting them individually.
await new Promise((resolve) => setTimeout(resolve, 250))

const node = await Kei.mock({})
const economy = await startEconomy({ seed: ISSUER_SEED, node, network: 'mock' })
const player = await Kei.start({ node, seed: PLAYER_SEED })
const catalogue = economy.catalogue()
const sword = catalogue.items.find((item) => item.key === 'sword_01')!

const payments = {
  paid: (id: string) => database.hasPaidReward(id),
  record: (entry: any) => database.recordRewardPayment(entry),
}

////////////////////////////////////////////////////////////////////////////////
// A fresh character owns what the chain says it owns, which is nothing.

const user = await database.saveUser('boundary', 'password')
const character = await database.createCharacter(user.token, 'Boundary', 'male_knight', 0, 'Head_Base')

check('a fresh character has no inventory rows', (character.inventory ?? []).length === 0)
check('a fresh character has no equipment rows', (character.equipment ?? []).length === 0)
check('a fresh character has no gold in the database', Number(character.gold) === 0, `${character.gold}`)
check('it does keep its abilities and hotbar', (character.abilities ?? []).length === 2 && (character.hotbar ?? []).length === 7)
check(
  'and the chain agrees it holds nothing',
  Object.keys(await economy.inventoryOf(player.address)).length === 0 && (await economy.goldOf(player.address)) === 0,
)

////////////////////////////////////////////////////////////////////////////////
// A database somebody has edited. This is the shape of every existing dev DB,
// and of anybody who reaches for sqlite3 to give themselves a sword.

const shadow = database as any
await shadow.querier.run('INSERT INTO character_inventory (`owner_id`, `qty`, `order`, `key`) VALUES (?,?,?,?)', [
  character.id,
  1,
  1,
  'sword_01',
])
await shadow.querier.run('INSERT INTO character_inventory (`owner_id`, `qty`, `order`, `key`) VALUES (?,?,?,?)', [
  character.id,
  5,
  1,
  'potion_small_red',
])
await shadow.querier.run('INSERT INTO character_equipment (`owner_id`, `slot`, `key`) VALUES (?,?,?)', [
  character.id,
  1,
  'sword_01',
])
await shadow.querier.run('UPDATE characters SET gold=? WHERE id=?', [999_999, character.id])

const edited = await database.getCharacter(character.id)
const legacy = quarantineLegacy(edited)

check('the edited rows are there to be found', edited.inventory.length === 2 && Number(edited.gold) === 999_999)
check('quarantine sees all of them', legacy.items.length === 2 && legacy.equipment.length === 1 && legacy.gold === 999_999)
check('and reports the character as not clean', !isEmptyLegacy(legacy))
check('what a player is told names the tables, not a bug', describeLegacy(legacy).includes('cannot be used'))

////////////////////////////////////////////////////////////////////////////////
// The authority a deployment actually gets: it can check no proof, so it
// authorizes nothing at all.

const shipped = openInventoryAuthority({ economy, verify: proofUnavailable, payments })

const forged: WalletProof = { address: player.address, challenge: shipped.challenge(CHARACTER), signature: 'signed' }
const refusedBind = await shipped.bind(CHARACTER, forged)
check('a proof nothing can check does not bind', !('bound' in refusedBind))
check('the address stays unbound', shipped.addressOf(CHARACTER) === undefined)

const shadowSword = await shipped.authorize(CHARACTER, 'sword_01')
check('the sword in character_inventory authorizes nothing', !shadowSword.allowed)
check('and the refusal says why', !shadowSword.allowed && shadowSword.code === 'unbound', (shadowSword as any).code)
check('the shadow purse is not spendable either', (await shipped.purse(CHARACTER)) === 0)
check('and the service reports no holdings', Object.keys(await shipped.holdings(CHARACTER)).length === 0)

const unpaid = await shipped.pay(CHARACTER, { id: 'kill:mob-1', gold: 50 })
check('a kill pays nothing to a character with no wallet', !('paid' in unpaid))
check('and no gold was minted anywhere', (await economy.goldOf(player.address)) === 0)

////////////////////////////////////////////////////////////////////////////////
// Binding, with the verifier the next slice has to supply for real.

const authority = openInventoryAuthority({ economy, verify: acceptsAnySignature, payments })

const unasked = await authority.bind(CHARACTER, { address: player.address, challenge: 'made up', signature: 'signed' })
check('a challenge this server never issued does not bind', !('bound' in unasked))

const challenge = authority.challenge(CHARACTER)
check('the challenge is domain-separated by world and character', challenge.includes(economy.address) && challenge.endsWith(`:${CHARACTER}:${challenge.split(':').pop()}`))

const wrongChallenge = await authority.bind(CHARACTER, {
  address: player.address,
  challenge: challenge + 'x',
  signature: 'signed',
})
check('a signature for a different challenge does not bind', !('bound' in wrongChallenge))

const replayed = await authority.bind(CHARACTER, { address: player.address, challenge, signature: 'signed' })
check('and a used-up challenge cannot be re-answered', !('bound' in replayed))

const bound = await authority.bind(CHARACTER, {
  address: player.address,
  challenge: authority.challenge(CHARACTER),
  signature: 'signed',
})
check('a checked proof binds the character', 'bound' in bound && bound.address === player.address)

const stillNothing = await authority.authorize(CHARACTER, 'sword_01')
check('binding a wallet does not import the database sword', !stillNothing.allowed && stillNothing.code === 'not-held')

////////////////////////////////////////////////////////////////////////////////
// What the chain says, it says. A held item authorizes; a listed one stops.

await economy.deliver(player.address, 'sword_01', 1)
check(
  'a minted sword arrives',
  await until(async () => (await economy.inventoryOf(player.address))['sword_01'] === 1),
)

const held = await authority.authorize(CHARACTER, 'sword_01')
check('an on-chain sword authorizes an action', held.allowed && held.address === player.address)
check('two of them do not', !(await authority.authorize(CHARACTER, 'sword_01', 2)).allowed)

await player.sync()
await player.market.offer({ give: { asset: sword.asset, amount: 1 }, want: { asset: catalogue.coin.asset, amount: 250 } })

const listed = await authority.authorize(CHARACTER, 'sword_01')
check('listing it in the hall stops it authorizing anything', !listed.allowed, (listed as any).code)
check('and the refusal mentions the lock', !listed.allowed && listed.reason.includes('locked'))

////////////////////////////////////////////////////////////////////////////////
// Rewards. Once each, whatever happens.

const kill = { id: 'kill:mob-7', gold: 40 }
const paid = await authority.pay(CHARACTER, kill)
check('an authorized kill pays', 'paid' in paid && paid.gold === 40)
check(
  'and the gold is on the chain',
  await until(async () => (await economy.goldOf(player.address)) === 40),
)

const again = await authority.pay(CHARACTER, kill)
check('a replayed kill pays nothing', !('paid' in again) && (again as any).code === 'already-paid')

const [first, second] = await Promise.all([
  authority.pay(CHARACTER, { id: 'quest:1:LH_DANGEROUS_ERRANDS_01', gold: 50 }),
  authority.pay(CHARACTER, { id: 'quest:1:LH_DANGEROUS_ERRANDS_01', gold: 50 }),
])
const settled = ['paid' in first, 'paid' in second].filter(Boolean).length
check('two completions in the same tick pay once', settled === 1, `${settled} paid`)
check(
  'so the purse holds one kill and one quest',
  await until(async () => (await economy.goldOf(player.address)) === 90),
  `${await economy.goldOf(player.address)}`,
)

const questItems = await authority.pay(CHARACTER, {
  id: 'quest:1:items',
  items: [{ key: 'potion_small_red', qty: 2 }],
})
check('an item reward is minted to the proven address', 'paid' in questItems)
check(
  'and lands in the bag the player can see',
  await until(async () => (await economy.inventoryOf(player.address))['potion_small_red'] === 2),
)

////////////////////////////////////////////////////////////////////////////////
// A restart. The chain outlives the process and so does the record of what it
// was already told to mint.

const restarted = openInventoryAuthority({ economy, verify: acceptsAnySignature, payments })
const rebound = await restarted.bind(CHARACTER, {
  address: player.address,
  challenge: restarted.challenge(CHARACTER),
  signature: 'signed',
})
check('a session proves its wallet again after a restart', 'bound' in rebound)

const afterRestart = await restarted.pay(CHARACTER, kill)
check('and the kill it already paid for stays paid', !('paid' in afterRestart) && (afterRestart as any).code === 'already-paid')
check('with the purse unmoved', (await economy.goldOf(player.address)) === 90, `${await economy.goldOf(player.address)}`)

const survivor = await restarted.authorize(CHARACTER, 'potion_small_red', 2)
check('holdings reconcile off the chain rather than off a cache', survivor.allowed && survivor.held === 2)

////////////////////////////////////////////////////////////////////////////////
// The legacy rows are still exactly where they were. Nothing minted them and
// nothing erased them.

const afterEverything = await database.getCharacter(character.id)
check('the quarantined rows survived the session', afterEverything.inventory.length === 2 && afterEverything.equipment.length === 1)
check('including the balance nobody can spend', Number(afterEverything.gold) === 999_999)

// The autosave path writes the character row every ten seconds, and `gold` is
// the column it must leave alone.
await database.updateCharacter(character.id, {
  location: 'lh_town',
  x: 1,
  y: 2,
  z: 3,
  rot: 0,
  player_data: { experience: 10, points: 1, strength: 20, endurance: 20, agility: 20, intelligence: 20, wisdom: 20 },
})
const saved = await database.getCharacter(character.id)
check('a save moves the character', Number(saved.x) === 1 && Number(saved.experience) === 10)
check('and does not touch the legacy balance', Number(saved.gold) === 999_999, `${saved.gold}`)

economy.close()
// Windows will not unlink a file sqlite still has open, so the handle goes first.
await new Promise((resolve) => shadow.querier.db.close(resolve))
rmSync(directory, { recursive: true, force: true })
console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
