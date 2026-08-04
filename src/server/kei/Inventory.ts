/**
 * Who may act on an item, and on whose authority.
 *
 * `Economy.ts` is the issuer's half — what things cost and who is allowed to buy
 * them. This is the room's half: the one place the game asks whether a player
 * actually owns the thing they are about to equip, consume, drop, or be paid.
 *
 * The rule it exists to keep is the one issue #6 is about. The ledger owns
 * quantity; the room owns transient action state. A row in `character_inventory`
 * is not ownership and never was, so this service will not answer a question
 * about it — it reads `holdings` off the chain and nothing else.
 *
 * Two consequences follow from that, and both are deliberate.
 *
 * **Nothing is authorized without a proven wallet.** A character is bound to an
 * address by a signature over a challenge this server issued, not by a client
 * saying which address it is. There is no verifier yet (see `proofUnavailable`),
 * so in a running deployment every call below refuses. That is the safety mode,
 * not the finished migration: the refusal is what keeps hidden database gold and
 * items from reaching gameplay while the proof is built.
 *
 * **A locked holding is not a holding.** An item listed in the auction house
 * leaves its owner's spendable balance until the offer settles or is cancelled
 * (SPEC §9.3), so an item sold from another tab stops authorizing anything here
 * on the next read, without this file knowing anything about the market.
 */

import { isAddress } from 'kei-transaction'

import type { Economy } from './Economy'

/** Why an action was refused, for a caller that wants to branch rather than read. */
export type RefusalCode =
  /** This character has not proven a wallet, so it owns nothing this world can see. */
  | 'unbound'
  /** The chain does not show the holding: never held, spent, or locked in an offer. */
  | 'not-held'
  /** A proof was offered and could not be checked. See `proofUnavailable`. */
  | 'unproven'
  /** This exact reward was already paid. Replays are not payments. */
  | 'already-paid'
  /** The reward asked for nothing, or for an item the shop does not issue. */
  | 'nothing-to-pay'

export interface Authorized {
  allowed: true
  address: string
  /** Unlocked units the chain says the address holds, at the moment it was asked. */
  held: number
}

export interface Refused {
  allowed: false
  code: RefusalCode
  /** Written to be shown to a player as-is. */
  reason: string
}

export type Decision = Authorized | Refused

export interface Binding {
  bound: true
  address: string
}

export interface WalletProof {
  address: string
  /** The challenge this server issued for this character. */
  challenge: string
  signature: string
}

/**
 * Checks that whoever sent a proof holds the key to `proof.address`.
 *
 * This is a parameter rather than an implementation because the honest one does
 * not exist yet on either side of the wire. The player's wallet has no helper
 * that signs a domain-separated challenge (the SDK exports no signing surface
 * for arbitrary messages, only block signing), and writing one here would mean
 * this application handling raw player keys — which is the thing SPEC §6.3 says
 * it must never do. The work is tracked against Button issue #10.
 */
export type ProofVerifier = (proof: WalletProof, challenge: string) => Promise<boolean>

/**
 * The verifier a deployment gets today: it refuses everything.
 *
 * Fail closed rather than fail open, and refuse in one obvious place rather than
 * in every caller. A verifier that returned `true` here would be this server
 * asserting that a client-supplied address belongs to the client, which is the
 * one assumption the whole design is arranged to avoid.
 */
export const proofUnavailable: ProofVerifier = async () => false

export interface RewardItem {
  key: string
  qty: number
}

export interface Reward {
  /**
   * What makes this payment this payment.
   *
   * The server authors it — a loot entity's id, or a character and quest key —
   * and it is recorded before the mint and checked before the next one, so a
   * replayed kill, a reconnect mid-payment, or two quest-completion messages
   * arriving together pay once.
   */
  id: string
  gold?: number
  items?: readonly RewardItem[]
}

export interface Payment {
  paid: true
  address: string
  gold: number
  items: readonly RewardItem[]
}

export type PaymentResult = Payment | Refused

/**
 * Where paid rewards are remembered.
 *
 * In the database rather than in memory, because a process that forgot what it
 * had already minted would pay every outstanding reward again on restart. This
 * is a record that money moved, not money — it authorizes nothing and holds no
 * balance.
 */
export interface PaidRewards {
  paid(id: string): Promise<boolean>
  record(entry: { id: string; characterId: number; address: string; gold: number; items: string }): Promise<void>
}

export interface InventoryAuthority {
  /**
   * The string a character must sign to bind a wallet.
   *
   * Domain-separated by issuer and by character, and single-use, so a signature
   * taken from one world cannot bind an address in another and a captured proof
   * cannot be replayed for a second character.
   */
  challenge(characterId: number): string
  bind(characterId: number, proof: WalletProof): Promise<Binding | Refused>
  /** The proven address for this character, or undefined. Reads no chain. */
  addressOf(characterId: number): string | undefined
  /** Forget a binding. A session's proof does not outlive the session. */
  release(characterId: number): void
  /** What the chain says this character may act on. Empty while unbound. */
  holdings(characterId: number): Promise<Record<string, number>>
  purse(characterId: number): Promise<number>
  /** May this character act on `qty` of `key` right now? Asks the chain. */
  authorize(characterId: number, key: string, qty?: number): Promise<Decision>
  /** Pay a reward the server authored. Never a quantity a client asked for. */
  pay(characterId: number, reward: Reward): Promise<PaymentResult>
}

export interface InventoryAuthorityOptions {
  economy: Economy
  /** No default: a deployment must say out loud that it cannot check proofs. */
  verify: ProofVerifier
  payments: PaidRewards
  /** Injectable so a test can prove a challenge is single-use. */
  nonce?: () => string
}

/** The domain a challenge belongs to. Changing it invalidates every old proof. */
const CHALLENGE_DOMAIN = 'kei:world-of-wonder:bind-character:v1'

const UNBOUND_REASON =
  'This world cannot yet prove which wallet is yours, so it will not hand anything to it. Your gold and items are on the chain and are unaffected.'

export function openInventoryAuthority(options: InventoryAuthorityOptions): InventoryAuthority {
  const { economy, verify, payments } = options
  const nonce = options.nonce ?? randomNonce

  /** Character id to proven address. Session-scoped, never written to disk. */
  const bound = new Map<number, string>()
  /** Outstanding challenges, one per character, consumed by a successful bind. */
  const challenges = new Map<number, string>()
  /**
   * Reward ids being paid right now.
   *
   * The database record is written before the mint, but two messages arriving in
   * the same tick both read "not paid" before either writes. This closes that
   * window inside one process; the record closes it across restarts.
   */
  const settling = new Set<string>()

  const refuse = (code: RefusalCode, reason: string): Refused => ({ allowed: false, code, reason })

  return {
    challenge(characterId) {
      const challenge = `${CHALLENGE_DOMAIN}:${economy.address}:${characterId}:${nonce()}`
      challenges.set(characterId, challenge)
      return challenge
    },

    async bind(characterId, proof) {
      const expected = challenges.get(characterId)
      if (expected === undefined) {
        return refuse('unproven', 'Ask this world for a challenge before signing one.')
      }
      // Consumed whether or not it verifies. A challenge that survived a failed
      // attempt would be one an attacker could keep guessing against.
      challenges.delete(characterId)

      if (!proof || !isAddress(proof.address)) {
        return refuse('unproven', 'That is not a Kei address.')
      }
      if (proof.challenge !== expected) {
        return refuse('unproven', 'That signature is for a different challenge.')
      }
      if (!(await verify(proof, expected))) {
        return refuse(
          'unproven',
          'This world has no way to check that the wallet is yours yet, so it will not take your word for it.',
        )
      }

      bound.set(characterId, proof.address)
      return { bound: true, address: proof.address }
    },

    addressOf(characterId) {
      return bound.get(characterId)
    },

    release(characterId) {
      bound.delete(characterId)
      challenges.delete(characterId)
    },

    async holdings(characterId) {
      const address = bound.get(characterId)
      if (address === undefined) return {}
      return economy.inventoryOf(address)
    },

    async purse(characterId) {
      const address = bound.get(characterId)
      if (address === undefined) return 0
      return economy.goldOf(address)
    },

    async authorize(characterId, key, qty = 1) {
      const address = bound.get(characterId)
      if (address === undefined) return refuse('unbound', UNBOUND_REASON)

      // Asked every time rather than cached. A cache would have to carry the
      // height it was read at and would still be wrong the moment the same
      // wallet sells the item from another tab, which is exactly the case this
      // check exists for.
      const held = (await economy.inventoryOf(address))[key] ?? 0
      if (held < qty) {
        return refuse(
          'not-held',
          held === 0
            ? 'The chain does not show you holding that. If you have just listed it in the auction house, it is locked until the offer settles or you cancel it.'
            : `You hold ${held} of those and this needs ${qty}.`,
        )
      }

      return { allowed: true, address, held }
    },

    async pay(characterId, reward) {
      const address = bound.get(characterId)
      if (address === undefined) return refuse('unbound', UNBOUND_REASON)

      const gold = Math.max(0, Math.floor(reward.gold ?? 0))
      const items = (reward.items ?? []).filter((item) => item.key !== '' && item.qty > 0)
      if (gold === 0 && items.length === 0) {
        return refuse('nothing-to-pay', 'There was nothing to pay out.')
      }

      // Claimed synchronously, before anything is awaited. Asking the database
      // first would yield, and two completion messages in the same tick would
      // both be told the reward was unpaid before either wrote a row.
      if (settling.has(reward.id)) {
        return refuse('already-paid', 'That reward has already been paid.')
      }
      settling.add(reward.id)

      try {
        if (await payments.paid(reward.id)) {
          return refuse('already-paid', 'That reward has already been paid.')
        }

        // Recorded before the mint, so a crash between the two leaves a reward
        // unpaid rather than payable twice. Under-paying is a support question;
        // over-paying is an unbounded mint of this world's currency.
        await payments.record({
          id: reward.id,
          characterId,
          address,
          gold,
          items: items.map((item) => `${item.key}x${item.qty}`).join(','),
        })

        if (gold > 0) await economy.grant(address, gold)
        for (const item of items) await economy.deliver(address, item.key, item.qty)

        return { paid: true, address, gold, items }
      } finally {
        settling.delete(reward.id)
      }
    },
  }
}

/**
 * The one this process uses, set once at startup.
 *
 * A module-level handle rather than a constructor argument because a Colyseus
 * room is built by the matchmaker from options that get serialised into room
 * metadata, and a live service is not something to put there. `GameData` in this
 * codebase is reached the same way for the same reason.
 */
let current: InventoryAuthority | undefined

export function useInventoryAuthority(authority: InventoryAuthority): void {
  current = authority
}

export function inventoryAuthority(): InventoryAuthority | undefined {
  return current
}

/** A reason to refuse when the room asks and startup never wired one up. */
export const NO_AUTHORITY_REASON =
  'This world has no inventory authority configured, so it will not hand out anything it cannot prove you own.'

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
