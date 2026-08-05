/**
 * The reward outbox, driven through every way it can be interrupted.
 * Run with `npm run test:outbox`.
 *
 * `Inventory.test.ts` proves a reward is never paid twice. This file is about the
 * other half of issue #9: that a reward the server authored is eventually paid at
 * all — across a wallet that was not provable yet, a process that died mid-mint,
 * a node that accepted a block and failed to say so, and a multi-leg reward whose
 * second leg failed.
 *
 * There is a real chain here, a `MockNode` with a real issuer on it, because the
 * claim being tested is about block identity: reconciliation works by looking at
 * what occupies the position a mint was aimed at, and a fake would just be this
 * file agreeing with itself. What is faked is only the failure — a node cannot be
 * asked to accept a block and then time out — and the fake does the real mint
 * first, so the "ambiguous" case really is ambiguous.
 *
 * The clock is a variable so leases and retention can be tested without waiting.
 */

import { Kei } from 'kei-transaction'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { COIN, startEconomy } from './Economy'
import { openOutbox, toUnits, type Issuance, type RewardIntent } from './Outbox'
import { Database } from '../Database'
import { Config } from '../../shared/Config'

const ISSUER_SEED = 'b3'.repeat(32)
const PLAYER_SEED = 'c9'.repeat(32)
const STRANGER_SEED = 'f1'.repeat(32)
const HERO = 1

let failures = 0

function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** A mint is a chain round trip, and a chain round trip is not instant. */
async function until(predicate: () => Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

const directory = mkdtempSync(join(tmpdir(), 'wow-outbox-'))
process.env.DATABASE_PATH = join(directory, 'test.db')

const database = new Database(new Config())
await database.init()
await database.create()
// `createDatabase()` fires its statements without awaiting them individually.
await new Promise((resolve) => setTimeout(resolve, 250))

const node = await Kei.mock({})
const economy = await startEconomy({ seed: ISSUER_SEED, node, network: 'mock' })
const player = await Kei.start({ node, seed: PLAYER_SEED })
const stranger = await Kei.start({ node, seed: STRANGER_SEED })
const store = database.rewardStore()

////////////////////////////////////////////////////////////////////////////////
// The seams. A binding this test controls, a clock it controls, and an issuer
// that can be made to fail in the two ways a real one does.

/** Who has proved which wallet. `Inventory.ts` owns this in a real deployment. */
const proven = new Map<number, string>()

let clock = 1_700_000_000_000
const now = () => clock

type Fault =
  /** The mint never reaches the node. */
  | { on: string; mode: 'refused' }
  /** The node takes the block and the answer is lost. This is the bad one. */
  | { on: string; mode: 'ambiguous' }
let fault: Fault | undefined

/** Every mint this outbox attempted, so a second attempt is visible rather than inferred. */
const attempted: Array<{ key: string; to: string; units: string }> = []

const issuance: Issuance = {
  ...economy.issuance,
  async mint(kind, key, to, units) {
    attempted.push({ key, to, units })
    if (fault?.on === key && fault.mode === 'refused') {
      throw new Error('the node is not answering')
    }
    if (fault?.on === key && fault.mode === 'ambiguous') {
      // Really minted, then really lost. The block is on the chain and this
      // process has no idea, which is the only interesting failure there is.
      await economy.issuance.mint(kind, key, to, units)
      throw new Error('timed out waiting for the node')
    }
    return economy.issuance.mint(kind, key, to, units)
  },
}

const open = (deliver = true) =>
  openOutbox({
    store,
    issuance,
    addressOf: (characterId) => proven.get(characterId),
    deliver,
    now,
    leaseMs: 30_000,
    retentionMs: 0,
    maxAttempts: 3,
  })

let outbox = open()

const gold = (units: number) => ({ leg: 0, kind: 'gold' as const, key: COIN.symbol, units: String(units) })
const item = (leg: number, key: string, units: number) => ({ leg, kind: 'item' as const, key, units: String(units) })

const quest = (key: string, legs: RewardIntent['legs']): RewardIntent => ({
  id: `quest:${HERO}:${key}`,
  characterId: HERO,
  address: proven.get(HERO) ?? null,
  legs,
  // A quest key and a character are an id ordinary play can produce again.
  replayable: true,
})

const loot = (entity: string, legs: RewardIntent['legs']): RewardIntent => ({
  id: `loot:${entity}`,
  characterId: HERO,
  address: proven.get(HERO) ?? null,
  legs,
  // An entity id dies with the room, so nothing will ever author this again.
  replayable: false,
})

////////////////////////////////////////////////////////////////////////////////
// Raw units. The reason `units` is a string is that a number cannot be trusted
// with it, so the conversion is where a bad quantity has to be stopped.

check('a whole number is units', toUnits(40) === '40')
check('so is a decimal string', toUnits('40') === '40')
check('and a bigint', toUnits(7n) === '7')
check('a fraction is not', toUnits(1.5) === undefined)
check('nor is a negative', toUnits(-1) === undefined && toUnits(-1n) === undefined)
check('nor infinity or NaN', toUnits(Infinity) === undefined && toUnits(NaN) === undefined)
check('nor a number too big to be exact', toUnits(2 ** 53) === undefined)
check('nor a quantity past the currency cap', toUnits('9999999999') === undefined)
check('nor anything that is not a number at all', toUnits('12x') === undefined && toUnits('') === undefined)

////////////////////////////////////////////////////////////////////////////////
// What may not become durable. Every one of these has to be refused before a row
// exists, because a row is what stops the reward being paid later.

const rejections: Array<[string, any]> = [
  ['an empty id', { ...quest('A', [gold(1)]), id: '' }],
  ['an id longer than the column', { ...quest('A', [gold(1)]), id: 'q'.repeat(300) }],
  ['a character that is not one', { ...quest('A', [gold(1)]), characterId: 0 }],
  ['a fractional character id', { ...quest('A', [gold(1)]), characterId: 1.5 }],
  ['a reward that pays nothing', { ...quest('A', []) }],
  ['a reward with more legs than a mob has drops', { ...quest('A', Array.from({ length: 17 }, (_, i) => item(i, 'potion_small_red', 1))) }],
  ['an item this world does not issue', { ...quest('A', [item(0, 'excalibur', 1)]) }],
  ['a currency this world does not issue', { ...quest('A', [{ leg: 0, kind: 'gold' as const, key: 'DOGE', units: '1' }]) }],
  ['a fractional quantity', { ...quest('A', [item(0, 'potion_small_red', 2.5)]) }],
  ['a negative quantity', { ...quest('A', [{ leg: 0, kind: 'item' as const, key: 'potion_small_red', units: '-3' }]) }],
  ['a quantity that would overflow the column', { ...quest('A', [{ leg: 0, kind: 'gold' as const, key: COIN.symbol, units: '9'.repeat(40) }]) }],
  ['a leg that pays zero', { ...quest('A', [gold(0)]) }],
  ['two legs in the same position', { ...quest('A', [gold(1), { leg: 0, kind: 'item' as const, key: 'potion_small_red', units: '1' }]) }],
  ['a destination that is not an address or nothing', { ...quest('A', [gold(1)]), address: 42 }],
]

let refused = 0
for (const [what, intent] of rejections) {
  const result = await outbox.offer(intent)
  const ok = typeof result === 'object' && 'rejected' in result
  check(`${what} is refused`, ok, ok ? '' : JSON.stringify(result))
  if (ok) refused += 1
}
check('and none of them left a row behind', (await store.counts(now())).pending === 0, `${refused} refused`)
check('nor attempted a mint', attempted.length === 0, JSON.stringify(attempted))

////////////////////////////////////////////////////////////////////////////////
// A quest completed while no wallet can be proved. This is the case that made
// issue #9: today it is refused and forgotten, so enabling proof later pays
// nothing. The outbox writes it down instead.

const ERRAND = quest('LH_DANGEROUS_ERRANDS_01', [gold(500)])

check('a quest completed with no wallet is still written down', (await outbox.offer(ERRAND)) === 'enqueued')

const unbound = await outbox.drain()
check('and it is not delivered anywhere', unbound.waiting === 1 && unbound.minted === 0, JSON.stringify(unbound))
check('nothing was minted at all', attempted.length === 0)

const waiting = await outbox.status(ERRAND.id)
check('it is pending, not failed', waiting?.state === 'pending', waiting?.state)
check('and says what it is waiting for', (waiting?.reason ?? '').includes('prove which wallet is yours'), waiting?.reason ?? '')
check('the purse is untouched', (await economy.goldOf(player.address)) === 0)

// The wallet is proved, and the client never re-sends anything. This is the
// acceptance criterion the issue leads with.
proven.set(HERO, player.address)

const afterBinding = await outbox.drain()
check('binding a wallet pays the reward that was waiting', afterBinding.settled === 1 && afterBinding.minted === 1, JSON.stringify(afterBinding))
check(
  'and the gold is on the chain, not in a table',
  await until(async () => (await economy.goldOf(player.address)) === 500),
  `${await economy.goldOf(player.address)}`,
)

const settledErrand = await outbox.status(ERRAND.id)
check('the reward is settled', settledErrand?.state === 'settled', settledErrand?.state)
check('with a chain receipt against its leg', (settledErrand?.legs[0]?.receipt ?? '').length > 0, settledErrand?.legs[0]?.receipt ?? 'none')
check('and the leg still carries units as a string', settledErrand?.legs[0]?.units === '500', String(settledErrand?.legs[0]?.units))

////////////////////////////////////////////////////////////////////////////////
// The same message again, and again after a restart. One payload, one payment.

check('the same reward offered twice is a duplicate, not a second reward', (await outbox.offer(ERRAND)) === 'duplicate')
check('offered twenty more times, still one', (await Promise.all(Array.from({ length: 20 }, () => outbox.offer(ERRAND)))).every((r) => r === 'duplicate'))

const replayed = await outbox.drain()
check('and draining finds nothing to do', replayed.claimed === 0, JSON.stringify(replayed))

// A restart is a new outbox over the same tables. The chain and the record of
// what it was told outlive the process.
outbox = open()
const restarted = await outbox.drain()
check('a restart does not pay a settled reward again', restarted.claimed === 0 && (await economy.goldOf(player.address)) === 500)

////////////////////////////////////////////////////////////////////////////////
// The node took the block and the answer never came back. A blind retry here is
// a double mint, which is the thing the whole design exists to refuse.

const AMBIGUOUS = loot('mob-2f8a1c', [item(0, 'potion_small_red', 2)])
fault = { on: 'potion_small_red', mode: 'ambiguous' }

await outbox.offer(AMBIGUOUS)
const lost = await outbox.drain()
check('an ambiguous mint does not settle the reward', lost.settled === 0, JSON.stringify(lost))

const inflight = await outbox.status(AMBIGUOUS.id)
check('the leg is left submitted rather than pending', inflight?.legs[0]?.state === 'submitted', inflight?.legs[0]?.state)
check('with the frontier it was aimed at written down', (inflight?.legs[0]?.previous ?? '').length > 0)
check('and the error said out loud', (inflight?.legs[0]?.error ?? '').includes('timed out'), inflight?.legs[0]?.error ?? '')
check(
  'meanwhile the potions really did arrive',
  await until(async () => (await economy.inventoryOf(player.address))['potion_small_red'] === 2),
  JSON.stringify(await economy.inventoryOf(player.address)),
)

// Whatever happens next must not mint again. Restart, clear the failure, drain.
fault = undefined
outbox = open()
const attemptsBefore = attempted.length
const reconciled = await outbox.drain()

check('the next pass reconciles instead of re-minting', reconciled.reconciled === 1 && reconciled.minted === 0, JSON.stringify(reconciled))
check('it sent nothing to the chain', attempted.length === attemptsBefore, JSON.stringify(attempted.slice(attemptsBefore)))
check('the reward settles on the block that was already there', (await outbox.status(AMBIGUOUS.id))?.state === 'settled')
check(
  'and the player holds two potions, not four',
  (await economy.inventoryOf(player.address))['potion_small_red'] === 2,
  JSON.stringify(await economy.inventoryOf(player.address)),
)

const receipt = (await outbox.status(AMBIGUOUS.id))?.legs[0]?.receipt ?? ''
check('the receipt names a block', /^[0-9A-Fa-f]{16,}$/.test(receipt), receipt)
check('and the node knows that block', (await node.blockInfo(receipt)) !== null)

////////////////////////////////////////////////////////////////////////////////
// Three legs, and the third one fails. The two that landed must not land again.

const HOARD = loot('mob-77b204', [gold(120), item(1, 'potion_small_blue', 3), item(2, 'sword_01', 1)])
fault = { on: 'sword_01', mode: 'refused' }

await outbox.offer(HOARD)
const partial = await outbox.drain()
check('a reward with a failing leg does not settle', partial.settled === 0 && partial.minted === 2, JSON.stringify(partial))

const legs = (await outbox.status(HOARD.id))?.legs ?? []
check('the legs that worked are confirmed', legs[0]?.state === 'confirmed' && legs[1]?.state === 'confirmed', legs.map((l) => l.state).join(','))
check('the one that did not is submitted, not confirmed', legs[2]?.state === 'submitted', legs[2]?.state)
check('and it has no receipt', legs[2]?.receipt === null)

fault = undefined
outbox = open()
const sinceResume = attempted.length
const resumed = await outbox.drain()

check('resuming pays only the missing leg', resumed.minted === 1 && resumed.settled === 1, JSON.stringify(resumed))
check('and only that leg was sent', attempted.slice(sinceResume).every((call) => call.key === 'sword_01'), JSON.stringify(attempted.slice(sinceResume)))
check(
  'so the gold is 620 and not 740',
  await until(async () => (await economy.goldOf(player.address)) === 620),
  `${await economy.goldOf(player.address)}`,
)
check(
  'and there are three blue potions, not six',
  (await economy.inventoryOf(player.address))['potion_small_blue'] === 3,
  JSON.stringify(await economy.inventoryOf(player.address)),
)

////////////////////////////////////////////////////////////////////////////////
// A process that died holding the lease. Nobody may touch the reward until the
// lease runs out, and then somebody must.

const ORPHAN = loot('mob-1d0e55', [gold(15)])
await outbox.offer(ORPHAN)
await store.claim(ORPHAN.id, now(), now() + 30_000)

const leased = await outbox.drain()
check('a leased reward is left alone', leased.claimed === 0, JSON.stringify(leased))

clock += 30_001
const expired = await outbox.drain()
check('and picked up once the lease expires', expired.settled === 1 && expired.minted === 1, JSON.stringify(expired))

////////////////////////////////////////////////////////////////////////////////
// Two workers, one database. Exactly one of them may submit each leg.

const CONTESTED = loot('mob-9ac3f0', [gold(30)])
await outbox.offer(CONTESTED)

const a = open()
const b = open()
const raced = await Promise.all([a.drain(), b.drain()])
const winners = raced.filter((report) => report.claimed === 1).length

check('only one worker claims the reward', winners === 1, JSON.stringify(raced))
check('so it is minted once', raced.reduce((total, report) => total + report.minted, 0) === 1, JSON.stringify(raced))
check(
  'and the purse moved by thirty',
  await until(async () => (await economy.goldOf(player.address)) === 665),
  `${await economy.goldOf(player.address)}`,
)

////////////////////////////////////////////////////////////////////////////////
// The wallet changed after the reward was authored. It is not paid to the new
// one, and it is not quietly paid to the old one either.

const OWED = loot('mob-5be117', [gold(90)])
await outbox.offer(OWED)
proven.set(HERO, stranger.address)

const redirected = await outbox.drain()
check('a reward owed to another wallet is held, not redirected', redirected.held === 1 && redirected.minted === 0, JSON.stringify(redirected))
check('and the stranger got nothing', (await economy.goldOf(stranger.address)) === 0)

const heldReward = await outbox.status(OWED.id)
check('it says a person has to look', heldReward?.state === 'held' && (heldReward?.reason ?? '').includes('waiting for someone'), heldReward?.reason ?? '')

const notRetried = await outbox.drain()
check('and no retry will pick it up', notRetried.claimed === 0, JSON.stringify(notRetried))

proven.set(HERO, player.address)

////////////////////////////////////////////////////////////////////////////////
// A different issuer. This is the ephemeral-mock restart: the rows survive, the
// economy does not, and the assets the legs name were never made by this one.

const STALE = { ...loot('mob-ffffff', [gold(5)]), id: 'loot:from-another-world' }
await store.enqueue({
  id: STALE.id,
  characterId: HERO,
  address: player.address,
  issuer: 'kei_' + 'z'.repeat(60),
  payload: JSON.stringify(STALE.legs),
  replayable: false,
  state: 'pending',
  attempts: 0,
  leaseUntil: 0,
  reason: null,
  enqueuedAt: now(),
  settledAt: null,
})

const foreign = await outbox.drain()
check('a reward from another issuer is held', foreign.held === 1 && foreign.minted === 0, JSON.stringify(foreign))
check('and says so', ((await outbox.status(STALE.id))?.reason ?? '').includes('different issuer'))

////////////////////////////////////////////////////////////////////////////////
// Character ids reused. On MySQL the character table is recreated on every boot,
// so startup stops everything undelivered rather than paying it to whoever
// inherited the number.

const INHERITED = loot('mob-abc123', [gold(70)])
await outbox.offer(INHERITED)
const quarantined = await outbox.quarantine('the character table was recreated')

check('quarantine holds the pending queue', quarantined === 1, `${quarantined}`)
check('the reward is held', (await outbox.status(INHERITED.id))?.state === 'held')
check('and no drain will deliver it', (await outbox.drain()).claimed === 0)
check('while what was already settled stays settled', (await outbox.status(ERRAND.id))?.state === 'settled')

////////////////////////////////////////////////////////////////////////////////
// Observation without delivery. This is the mode a deployment runs first.

const OBSERVED = loot('mob-0f0f0f', [gold(11)])
const dryRun = open(false)
await dryRun.offer(OBSERVED)

const sinceDry = attempted.length
const observed = await dryRun.drain()
check('a dry run reports what it would pay', observed.wouldMint === 1 && observed.minted === 0, JSON.stringify(observed))
check('and signs nothing', attempted.length === sinceDry)
check('leaving the reward pending for a later pass', (await dryRun.status(OBSERVED.id))?.state === 'pending')
check('with its leg untouched', (await dryRun.status(OBSERVED.id))?.legs[0]?.state === 'pending')

const delivered = await outbox.drain()
check('and an outbox that does deliver then pays it', delivered.settled === 1, JSON.stringify(delivered))

////////////////////////////////////////////////////////////////////////////////
// Retention. Nothing here may grow forever, and forgetting a settled reward is
// only safe when nothing can author its id again.

const beforeCompaction = await store.counts(now())
clock += 1_000
const swept = await outbox.compact()

check('compaction removes settled rewards nothing can re-author', swept.removed > 0, JSON.stringify(swept))
check('and tombstones the ones that could come back', swept.tombstoned > 0, JSON.stringify(swept))
check('a removed loot reward is gone entirely', (await store.find(AMBIGUOUS.id)) === undefined)
check('and its legs with it', (await store.legs(AMBIGUOUS.id)).length === 0)

const tombstone = await store.find(ERRAND.id)
check('a quest reward keeps a row', tombstone !== undefined)
check('with the payload dropped', tombstone?.payload === '', tombstone?.payload)
check('and the address it paid dropped too', tombstone?.address === null)
check('but still settled', tombstone?.state === 'settled')
check('so the same quest cannot be paid a second time', (await outbox.offer(ERRAND)) === 'duplicate')

const afterCompaction = await store.counts(now())
check('nothing pending was swept', afterCompaction.pending === beforeCompaction.pending, `${beforeCompaction.pending} -> ${afterCompaction.pending}`)
check('nothing held was swept either', afterCompaction.held === beforeCompaction.held, `${beforeCompaction.held} -> ${afterCompaction.held}`)
check('and held rewards are still counted, so a backlog is visible', afterCompaction.held === 3, `${afterCompaction.held}`)

const sweptAgain = await outbox.compact()
check('sweeping twice drops nothing the second time', sweptAgain.removed === 0 && sweptAgain.tombstoned === 0, JSON.stringify(sweptAgain))

////////////////////////////////////////////////////////////////////////////////
// The operator's second pass. Whatever a person does twice must be a no-op the
// second time.

const idle = await outbox.drain()
check('draining a drained queue does nothing', idle.claimed === 0 && idle.minted === 0, JSON.stringify(idle))
check(
  'and the chain holds exactly what was authored, once each',
  // 500 for the quest, then 120, 15, 30 and 11 across five pieces of loot.
  (await economy.goldOf(player.address)) === 676 &&
    (await economy.inventoryOf(player.address))['potion_small_red'] === 2 &&
    (await economy.inventoryOf(player.address))['potion_small_blue'] === 3 &&
    (await economy.inventoryOf(player.address))['sword_01'] === 1,
  `${await economy.goldOf(player.address)} gold, ${JSON.stringify(await economy.inventoryOf(player.address))}`,
)

////////////////////////////////////////////////////////////////////////////////
// And none of it went anywhere near the tables issue #6 is about.

const shadow = database as any
const shadowRows = await shadow.querier.all('SELECT COUNT(*) AS total FROM character_inventory;', [])
check('no reward wrote a row to character_inventory', Number(shadowRows[0].total) === 0, `${shadowRows[0].total}`)

outbox.close()
economy.close()
// Windows will not unlink a file sqlite still has open, so the handle goes first.
await new Promise((resolve) => shadow.querier.db.close(resolve))
rmSync(directory, { recursive: true, force: true })
console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
