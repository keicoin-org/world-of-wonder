/**
 * Rewards the server authored, held until the chain has actually taken them.
 *
 * `Inventory.ts` made reward issuance at-most-once: a row goes into
 * `reward_payments` before anything is minted, so a crash between the two
 * under-pays rather than paying twice. That is the safe direction and it is not
 * a finished protocol — the row says "do not pay this again" whether or not the
 * mint ever landed, so an outage, an ambiguous timeout, or a failure between two
 * legs of the same reward leaves the reward looking paid and the player holding
 * nothing. Issue #9 is that gap.
 *
 * What is here instead is an outbox. A reward is written down before it is
 * delivered and stays written down until every leg of it has a chain block
 * behind it. Nothing about it is a balance: the chain still owns the money, and
 * a row in these two tables authorizes nobody to equip, spend, or sell anything.
 *
 * Three things make it safe to run twice, which is the whole point of writing it
 * down:
 *
 * **The intent is one statement.** Neither database adapter in this repo exposes
 * a transaction, so atomicity is structural: the reward's legs are inside the
 * immutable `payload` written by the single `INSERT` that enqueues it. The rows
 * in `reward_outbox_legs` are derived from that payload the first time the
 * reward is claimed, and deriving them again is a no-op. A crash anywhere before
 * or after either step loses no work and duplicates none.
 *
 * **A submission records where it was going to land before it is sent.** A Kei
 * account chain is linear and single-writer (SPEC §5.6.1), so exactly one block
 * can ever have a given block as its `previous`. Recording the issuer's frontier
 * before minting therefore names the operation in advance: after an ambiguous
 * timeout, `Issuance.reconcile` looks at whatever now occupies that position and
 * says whether it is this mint, somebody else's block, or nothing at all. That is
 * reconciliation by block identity. It is deliberately not a balance read —
 * players trade, so a balance can be right for the wrong reason.
 *
 * **A leg is never blindly retried.** A leg whose mint threw, or whose process
 * died mid-flight, is left `submitted` and is reconciled on the next pass before
 * anything is sent again. Only a position the chain says is empty is re-minted.
 *
 * Retention: see `compact`. The outbox grows with every kill and every quest, so
 * it has to be swept, and sweeping a settled reward is only safe when its id
 * cannot be authored a second time — which the author declares, not this file.
 */

import Logger from '../utils/Logger'

/** Which side of the economy a leg pays from. */
export type LegKind = 'gold' | 'item'

/**
 * One asset moving to one address.
 *
 * `units` is raw units as a decimal string, and it is a string on purpose. A
 * JS `number` cannot carry raw units of an 18-decimal asset without losing the
 * bottom of them, and a reward is one of the places where losing the bottom
 * means paying the wrong amount. This world's gold and items are 0-decimal, so
 * today the string is the count — but the type is the one that stays correct
 * when a later asset is not.
 *
 * It is units, not a price, and not a lot total. A leg is "this many of this
 * thing", never "this many at this each" (issue #14 is what happens when those
 * two get the same name).
 */
export interface RewardLeg {
  /** Position in the reward. Stable, so a resumed reward finishes what it started. */
  leg: number
  kind: LegKind
  /** The currency's symbol for gold, an `ItemsDB` archetype key for an item. */
  key: string
  /** Raw units, decimal, no sign, no point. */
  units: string
}

export interface RewardIntent {
  /**
   * What makes this reward this reward, authored by the server and never read
   * off a client message. A loot entity's id, a mob's session id, a character
   * and a quest key.
   */
  id: string
  characterId: number
  /**
   * The proven destination, or null while the character has bound no wallet.
   *
   * Null is a normal state, not an error: the reward waits. What may never
   * appear here is an address a client merely claimed — `Inventory.ts` is the
   * only thing that decides an address is proven.
   */
  address: string | null
  legs: readonly RewardLeg[]
  /**
   * Could this exact id be authored again by ordinary play?
   *
   * True for a quest, whose id is a character and a quest key and which a
   * re-accepted quest would produce a second time. False for loot and kills,
   * whose ids are entity session ids that die with the room. It is the author
   * that knows, so the author says, and `compact` uses the answer to decide
   * whether a settled reward may be forgotten or has to leave a tombstone
   * behind.
   */
  replayable: boolean
}

export type RewardState =
  /** There is work to do: legs to mint, or a wallet to wait for. */
  | 'pending'
  /** Every leg has a chain block behind it. Terminal and never re-delivered. */
  | 'settled'
  /** Stopped, and a person has to look. Never delivered by a retry. */
  | 'held'

export type LegState =
  /** Nothing has been sent for this leg. */
  | 'pending'
  /** A mint was started against `previous`. Reconcile before sending again. */
  | 'submitted'
  /** A block on the issuer's chain paid this leg. `receipt` is its hash. */
  | 'confirmed'

export interface StoredReward {
  id: string
  characterId: number
  address: string | null
  /** The issuer these legs were authored against. A different one is not this world. */
  issuer: string
  /** Canonical JSON of the legs. Immutable once written. */
  payload: string
  replayable: boolean
  state: RewardState
  attempts: number
  /** Whoever is working on it holds it until here. Compare-and-swap, not a mutex. */
  leaseUntil: number
  /** Why it is waiting or why it stopped, in words a player could be shown. */
  reason: string | null
  enqueuedAt: number
  settledAt: number | null
}

export interface StoredLeg extends RewardLeg {
  rewardId: string
  state: LegState
  attempts: number
  /** The issuer frontier this leg's mint was to build on. Its operation identity. */
  previous: string | null
  /** The hash of the block that paid it. */
  receipt: string | null
  error: string | null
}

/** What `reconcile` found at the position a submission was aimed at. */
export type Reconciled =
  /** The mint landed. This is its block. */
  | { found: 'confirmed'; receipt: string }
  /** Nothing occupies that position, or something that is not this mint does. */
  | { found: 'absent' }
  /** The chain cannot say, so neither will this. A person has to look. */
  | { found: 'unknown'; reason: string }

/**
 * The issuer's half, narrowed to what delivery needs.
 *
 * `Economy.ts` implements it. It is an interface here so the tests can drive the
 * state machine through every failure the chain can hand it — an ambiguous
 * timeout is not something a mock node can be asked for.
 */
export interface Issuance {
  /** The account whose signature is a mint. Recorded so a swap cannot go unnoticed. */
  readonly issuer: string
  /** The asset a leg pays in, or undefined if this world does not issue it. */
  assetFor(kind: LegKind, key: string): string | undefined
  /**
   * What to call a leg when telling a player about it.
   *
   * Assets are named on the chain, so there is never a reason to show somebody
   * sixty-four hex characters (SPEC §7).
   */
  nameFor(kind: LegKind, key: string): string
  /** The issuer's frontier right now. */
  frontier(): Promise<string>
  /** Mint raw units. The units are a string for the reason `RewardLeg.units` is. */
  mint(kind: LegKind, key: string, to: string, units: string): Promise<{ hash: string }>
  /** What became of the block that was to follow `previous`. */
  reconcile(previous: string, expected: { asset: string; to: string; units: string }): Promise<Reconciled>
}

/**
 * Where the outbox lives.
 *
 * Every method is either a single statement or idempotent, because there are no
 * transactions to lean on. `enqueue` and `claim` return whether they were the
 * one that acted — that boolean is the compare-and-swap two processes race for.
 */
export interface RewardStore {
  /** False when this id is already enqueued. One statement, so no check-then-write. */
  enqueue(reward: StoredReward): Promise<boolean>
  find(id: string): Promise<StoredReward | undefined>
  /** Pending rewards whose lease has run out, oldest first. */
  due(now: number, limit: number): Promise<StoredReward[]>
  /** Take the lease if it is free. False means somebody else has this reward. */
  claim(id: string, now: number, until: number): Promise<boolean>
  patch(id: string, fields: Partial<Pick<StoredReward, 'state' | 'address' | 'reason' | 'leaseUntil' | 'attempts' | 'settledAt'>>): Promise<void>
  /** Write a leg if it is not there. Safe to call on every claim. */
  addLeg(leg: StoredLeg): Promise<void>
  legs(id: string): Promise<StoredLeg[]>
  patchLeg(id: string, leg: number, fields: Partial<Pick<StoredLeg, 'state' | 'attempts' | 'previous' | 'receipt' | 'error'>>): Promise<void>
  /**
   * Retention, in the store because it is two DELETEs and an UPDATE.
   *
   * `before` is a settled-at cutoff. Rewards that cannot be authored again are
   * removed entirely; the rest keep an empty row so their id still suppresses a
   * second payment. Nothing pending and nothing held is ever touched.
   */
  compact(before: number): Promise<{ removed: number; tombstoned: number }>
  /** Queue depth, for the log line that makes a backlog visible. */
  counts(now: number): Promise<{ pending: number; settled: number; held: number; oldestPendingAge: number }>
}

export interface OutboxOptions {
  store: RewardStore
  issuance: Issuance
  /**
   * The proven address for a character right now, or undefined.
   *
   * Asked at delivery rather than trusted from the row, so a reward enqueued
   * before the player proved a wallet is paid once they have, and a reward
   * enqueued against one address is never quietly paid to another.
   */
  addressOf(characterId: number): string | undefined
  /**
   * False observes without minting: every decision is logged, no leg moves.
   *
   * This is the mode a deployment runs first (issue #9's sequencing), so that
   * the queue and the reconciliation can be watched before they are allowed to
   * sign anything.
   */
  deliver?: boolean
  /** How long a claim holds a reward. Long enough for a slow chain, short enough to recover. */
  leaseMs?: number
  /** After this many failed passes a reward stops and waits for a person. */
  maxAttempts?: number
  /** How long a settled reward's payload is kept. See `compact`. */
  retentionMs?: number
  /** How many rewards one pass will take on. */
  batch?: number
  now?: () => number
}

export interface DrainReport {
  claimed: number
  settled: number
  held: number
  waiting: number
  minted: number
  reconciled: number
  /** What a dry run would have minted, and did not. */
  wouldMint: number
}

export interface Outbox {
  /**
   * Write a reward down. Rejects a malformed one before anything is durable.
   *
   * `duplicate` is a success: the reward is already in hand and this call was a
   * replay of the message that authored it.
   */
  offer(intent: RewardIntent): Promise<'enqueued' | 'duplicate' | { rejected: string }>
  /** Deliver everything that is due. Safe to run in two processes at once. */
  drain(): Promise<DrainReport>
  /** Retention. Returns what it dropped. */
  compact(): Promise<{ removed: number; tombstoned: number }>
  /** What a player should be told about one of their rewards. */
  status(id: string): Promise<{ state: RewardState; reason: string | null; legs: StoredLeg[] } | undefined>
  /**
   * Stop delivering anything for a character whose identity may have been
   * reused, rather than letting a stale row suppress a new player's reward.
   */
  quarantine(reason: string): Promise<number>
  close(): void
}

/** A `varchar(255)` has to hold it, with room for a prefix nobody has invented yet. */
const MAX_ID_LENGTH = 190
/** A reward is a mob's drop table or a quest's reward list, not a shopping cart. */
const MAX_LEGS = 16
/**
 * The largest raw units one leg may pay.
 *
 * Well under the currency's 1e9 cap and under `Number.MAX_SAFE_INTEGER`, so a
 * quantity that would overflow the column, the cap, or a reader that parses it
 * back into a number is refused at the door rather than discovered by a failed
 * mint halfway through a multi-leg reward.
 */
const MAX_UNITS = BigInt(1_000_000_000)
const ZERO = BigInt(0)

const DEFAULTS = {
  leaseMs: 30_000,
  maxAttempts: 8,
  /** A week. Long enough to answer "where is my sword", short enough to bound. */
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
  batch: 32,
}

/**
 * Raw units from whatever the room had.
 *
 * The room deals in small whole numbers and this is the one place they stop
 * being numbers. Anything that is not a non-negative integer is rejected rather
 * than rounded: a fractional reward is a bug in the caller, and rounding it
 * would hide the bug and pay the wrong amount.
 */
export function toUnits(value: number | string | bigint): string | undefined {
  if (typeof value === 'bigint') return value >= ZERO && value <= MAX_UNITS ? value.toString() : undefined
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return undefined
    return value.toString()
  }
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) return undefined
  return BigInt(value) <= MAX_UNITS ? BigInt(value).toString() : undefined
}

export function openOutbox(options: OutboxOptions): Outbox {
  const { store, issuance, addressOf } = options
  const deliver = options.deliver !== false
  const leaseMs = options.leaseMs ?? DEFAULTS.leaseMs
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts
  const retentionMs = options.retentionMs ?? DEFAULTS.retentionMs
  const batch = options.batch ?? DEFAULTS.batch
  const now = options.now ?? Date.now

  /**
   * Rewards this process is working on.
   *
   * The lease is what stops two processes on the same reward, but it is read
   * then written, and two `drain()` calls in the same tick would both read it
   * free. This closes that window without a round trip.
   */
  const working = new Set<string>()

  /** Rejects a leg the world cannot pay, before the reward becomes durable. */
  const checkLeg = (leg: RewardLeg): string | undefined => {
    if (!Number.isInteger(leg.leg) || leg.leg < 0 || leg.leg >= MAX_LEGS) return `leg ${leg.leg} is not a position`
    if (leg.kind !== 'gold' && leg.kind !== 'item') return `leg ${leg.leg} is neither gold nor an item`
    if (typeof leg.key !== 'string' || leg.key === '') return `leg ${leg.leg} names nothing`
    if (issuance.assetFor(leg.kind, leg.key) === undefined) return `this world does not issue "${leg.key}"`
    const units = toUnits(leg.units)
    if (units === undefined || units === '0') return `leg ${leg.leg} pays "${leg.units}", which is not an amount`
    return undefined
  }

  return {
    async offer(intent) {
      if (typeof intent?.id !== 'string' || intent.id === '' || intent.id.length > MAX_ID_LENGTH) {
        return { rejected: 'a reward needs an id this database can hold' }
      }
      if (!Number.isSafeInteger(intent.characterId) || intent.characterId <= 0) {
        return { rejected: 'a reward needs a character to belong to' }
      }
      if (!Array.isArray(intent.legs) || intent.legs.length === 0 || intent.legs.length > MAX_LEGS) {
        return { rejected: 'a reward pays between one and sixteen things' }
      }
      if (intent.address !== null && typeof intent.address !== 'string') {
        return { rejected: 'a destination is an address or nothing at all' }
      }

      const positions = new Set<number>()
      for (const leg of intent.legs) {
        const wrong = checkLeg(leg)
        if (wrong) return { rejected: wrong }
        if (positions.has(leg.leg)) return { rejected: `two legs both call themselves ${leg.leg}` }
        positions.add(leg.leg)
      }

      // Normalized here, once, so the payload the store holds is the payload
      // every later pass reads. `units` in particular stops being a number the
      // moment it is written down and never becomes one again.
      const legs = intent.legs.map((leg) => ({
        leg: leg.leg,
        kind: leg.kind,
        key: leg.key,
        units: toUnits(leg.units)!,
      }))

      const at = now()
      const created = await store.enqueue({
        id: intent.id,
        characterId: intent.characterId,
        address: intent.address,
        issuer: issuance.issuer,
        payload: JSON.stringify(legs),
        replayable: intent.replayable,
        state: 'pending',
        attempts: 0,
        leaseUntil: 0,
        reason: intent.address === null ? UNBOUND_REASON : null,
        enqueuedAt: at,
        settledAt: null,
      })

      return created ? 'enqueued' : 'duplicate'
    },

    async drain() {
      const report: DrainReport = { claimed: 0, settled: 0, held: 0, waiting: 0, minted: 0, reconciled: 0, wouldMint: 0 }
      const at = now()

      for (const reward of await store.due(at, batch)) {
        if (working.has(reward.id)) continue
        if (!(await store.claim(reward.id, at, at + leaseMs))) continue
        working.add(reward.id)
        report.claimed += 1

        try {
          await deliverReward(reward, report)
        } catch (error) {
          // The lease expiring is what recovers this reward, so the only thing
          // to do here is stop holding it and say what happened. A throw out of
          // one reward must not abandon the rest of the batch.
          Logger.error(`[outbox] ${reward.id} failed mid-delivery`, error)
          await store.patch(reward.id, { leaseUntil: 0, reason: describe(error) })
        } finally {
          working.delete(reward.id)
        }
      }

      return report
    },

    async compact() {
      const dropped = await store.compact(now() - retentionMs)
      const counts = await store.counts(now())
      // The one line that makes a backlog visible. No addresses and no payloads:
      // a log is not a place to put where somebody's money went.
      Logger.info(
        `[outbox] ${counts.pending} pending, ${counts.settled} settled, ${counts.held} held for review; ` +
          `oldest pending ${Math.round(counts.oldestPendingAge / 1_000)}s; ` +
          `compaction removed ${dropped.removed} and tombstoned ${dropped.tombstoned}; issuer ${issuance.issuer}`,
      )
      return dropped
    },

    async status(id) {
      const reward = await store.find(id)
      if (!reward) return undefined
      return { state: reward.state, reason: reward.reason, legs: await store.legs(id) }
    },

    async quarantine(reason) {
      let held = 0
      // Bounded by the batch and looped until it stops finding work, so a large
      // backlog does not become one enormous result set. The cutoff is the end
      // of time because a lease is irrelevant here: whoever holds one is about
      // to find the reward held under them.
      for (;;) {
        const due = await store.due(Number.MAX_SAFE_INTEGER, batch)
        if (due.length === 0) return held
        for (const reward of due) {
          await store.patch(reward.id, { state: 'held', reason, leaseUntil: 0 })
          held += 1
        }
      }
    },

    close() {
      working.clear()
    },
  }

  /** One reward, from wherever it got to last time. */
  async function deliverReward(reward: StoredReward, report: DrainReport): Promise<void> {
    // A reward authored against a different issuer is a reward from a different
    // economy — an ephemeral mock that restarted, or a seed that was replaced.
    // Its legs name assets this issuer never made, so paying them would mint
    // the wrong things (issue #9).
    if (reward.issuer !== issuance.issuer) {
      await hold(reward, 'This reward was authored by a different issuer, so this world will not pay it.', report)
      return
    }

    // Asked now rather than trusted from the row. A reward that had nowhere to
    // go when it was authored gets somewhere the moment the player proves a
    // wallet, and that is the case issue #9 exists for.
    const proven = addressOf(reward.characterId)
    if (proven === undefined) {
      await wait(reward, UNBOUND_REASON, report)
      return
    }
    if (reward.address !== null && reward.address !== proven) {
      // First proven destination wins, and it is not negotiable. A reward that
      // followed the wallet would be a reward an attacker could redirect by
      // proving a second address.
      await hold(
        reward,
        'This reward was owed to a different wallet than the one now proven, so it is waiting for someone to look at it.',
        report,
      )
      return
    }
    if (reward.address === null) await store.patch(reward.id, { address: proven, reason: null })

    if (reward.attempts >= maxAttempts) {
      await hold(reward, `This reward could not be delivered in ${maxAttempts} attempts, so it stopped trying.`, report)
      return
    }

    // Materialized from the payload rather than written at enqueue, which is
    // what makes enqueueing one statement. Doing it twice writes nothing.
    const authored: RewardLeg[] = JSON.parse(reward.payload)
    for (const leg of authored) {
      await store.addLeg({
        rewardId: reward.id,
        ...leg,
        state: 'pending',
        attempts: 0,
        previous: null,
        receipt: null,
        error: null,
      })
    }

    const legs = await store.legs(reward.id)
    let outstanding = 0

    for (const leg of legs) {
      if (leg.state === 'confirmed') continue

      const asset = issuance.assetFor(leg.kind, leg.key)
      if (asset === undefined) {
        await hold(reward, `This reward pays in ${issuance.nameFor(leg.kind, leg.key)}, which this world does not issue.`, report)
        return
      }
      const expected = { asset, to: proven, units: leg.units }

      // A leg that was already sent is reconciled before anything is sent
      // again. This is the ambiguous-timeout case, and the reason the frontier
      // was written down before the mint.
      if (leg.state === 'submitted' && leg.previous !== null) {
        const found = await issuance.reconcile(leg.previous, expected)
        report.reconciled += 1
        if (found.found === 'confirmed') {
          await store.patchLeg(reward.id, leg.leg, { state: 'confirmed', receipt: found.receipt, error: null })
          continue
        }
        if (found.found === 'unknown') {
          await hold(reward, `This reward cannot be reconciled with the chain: ${found.reason}`, report)
          return
        }
        // 'absent' — the position is empty or holds somebody else's block, so
        // this mint never landed and sending it again pays once, not twice.
        await store.patchLeg(reward.id, leg.leg, { state: 'pending', previous: null })
      }

      if (!deliver) {
        report.wouldMint += 1
        outstanding += 1
        continue
      }

      const previous = await issuance.frontier()
      // Durable before the mint, and this is the whole trick: the frontier is
      // the operation's identity, so whatever happens next can be looked up.
      await store.patchLeg(reward.id, leg.leg, {
        state: 'submitted',
        previous,
        attempts: leg.attempts + 1,
        error: null,
      })

      try {
        const receipt = await issuance.mint(leg.kind, leg.key, proven, leg.units)
        await store.patchLeg(reward.id, leg.leg, { state: 'confirmed', receipt: receipt.hash, error: null })
        report.minted += 1
      } catch (error) {
        // Left `submitted` on purpose. The node may have accepted the block and
        // failed to say so, so the next pass reconciles rather than re-mints.
        await store.patchLeg(reward.id, leg.leg, { error: describe(error) })
        await store.patch(reward.id, { attempts: reward.attempts + 1, leaseUntil: 0, reason: describe(error) })
        Logger.warning(`[outbox] ${reward.id} leg ${leg.leg} did not confirm: ${describe(error)}`)
        return
      }
    }

    if (outstanding > 0) {
      // A dry run. Nothing moved, so nothing is recorded except that the lease
      // is free again.
      await store.patch(reward.id, { leaseUntil: 0 })
      report.waiting += 1
      return
    }

    await store.patch(reward.id, { state: 'settled', reason: null, leaseUntil: 0, settledAt: now() })
    report.settled += 1
  }

  async function wait(reward: StoredReward, reason: string, report: DrainReport): Promise<void> {
    // The lease is dropped rather than the attempt counted: waiting for a wallet
    // is not a failed delivery, and counting it would eventually hold a reward
    // that never had anything wrong with it.
    await store.patch(reward.id, { leaseUntil: 0, reason })
    report.waiting += 1
  }

  async function hold(reward: StoredReward, reason: string, report: DrainReport): Promise<void> {
    await store.patch(reward.id, { state: 'held', reason, leaseUntil: 0 })
    report.held += 1
    Logger.warning(`[outbox] ${reward.id} held for review: ${reason}`)
  }
}

export const UNBOUND_REASON =
  'This reward is waiting for you to prove which wallet is yours. It is written down and will be paid when you have.'

/** An error's message, and nothing a secret could be hiding in. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}

/**
 * The reconciliation half of `Issuance`, against a node.
 *
 * Here rather than in `Economy.ts` because it is about how a Kei account chain
 * is shaped and not about what this game sells, and because the tests want it
 * without an issuer.
 *
 * The claim it rests on: an account chain is linear and only its owner may
 * extend it (SPEC §5.6.1), so at most one block in existence has any given
 * block as its `previous`. Whatever is at that position is the answer.
 */
export async function reconcileAgainst(
  node: { accountInfo(address: string): Promise<any>; accountHistory(address: string, options?: { limit?: number }): Promise<any[]> },
  issuer: string,
  previous: string,
  expected: { asset: string; to: string; units: string },
  window = 256,
): Promise<Reconciled> {
  const info = await node.accountInfo(issuer)
  if (!info) return { found: 'unknown', reason: 'the node does not know this issuer' }

  const history = await node.accountHistory(issuer, { limit: window })
  const index = history.findIndex((block: any) => block.previous === previous)

  if (index === -1) {
    // Nothing built on it. Either it is still the frontier, in which case the
    // submission definitively never landed, or it is buried deeper than the
    // window and this function will not guess.
    if (info.frontier === previous) return { found: 'absent' }
    return { found: 'unknown', reason: `no block follows ${previous.slice(0, 12)} within ${window} blocks` }
  }

  const block = history[index]
  const op = block.type === 'asset' ? block.op : undefined
  if (op?.kind !== 'mint' || op.asset !== expected.asset || op.to !== expected.to || op.amount !== expected.units) {
    // Something else got there first, so this mint was never accepted and
    // re-sending it is a first payment rather than a second.
    return { found: 'absent' }
  }

  // The hash of a block is the `previous` of whatever came after it, and the
  // newest block's hash is the account's frontier. Either way the chain hands
  // it over without a hashing function in this repo.
  const receipt = index === 0 ? info.frontier : history[index - 1].previous
  return { found: 'confirmed', receipt }
}
