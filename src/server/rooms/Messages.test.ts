/**
 * What a client message is allowed to cause. Run with `npm run test:room`.
 *
 * The rule under test is one sentence from issue #10: a room message may express
 * what a player wants to do, and may not be the reason a reward exists. The room
 * used to break it with a debug hotkey — `PLAYER_HOTBAR_ACTIVATED { digit: 6 }`
 * spawned a loot entity at the sender's feet, and a loot entity is a thing the
 * issuer signs a mint for when somebody walks into it. Nothing rate-limited it
 * and nothing checked who was asking.
 *
 * These tests drive the real `GameRoomState.processMessage`, the real
 * `PlayerSchema.pickupItem`, and the real `dropCTRL.dropItems` against counting
 * stubs, rather than asserting on the source text. A Colyseus room needs a
 * navmesh, game data and a database to stand up, none of which the handler reads,
 * so the state object is built from the prototype and given only what the handler
 * actually touches.
 *
 * Deliberately not covered here: the chain. Whether a payment settles is
 * `Inventory.test.ts`'s question. This file only asks whether one was ever asked
 * for.
 */

import { MapSchema } from '@colyseus/schema'

import { GameRoomState } from './state/GameRoomState'
import { PlayerSchema } from './schema/PlayerSchema'
import { LootSchema } from './schema/LootSchema'
import { spawnCTRL } from './controllers/spawnCTRL'
import { dropCTRL } from './controllers/dropCTRL'
import { ServerMsg } from '../../shared/types'
import { useInventoryAuthority, type InventoryAuthority, type Reward } from '../kei/Inventory'

let failures = 0

function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** Records every reward it is asked to pay and pays none of them. */
function countingAuthority(): InventoryAuthority & { asked: Reward[] } {
  const asked: Reward[] = []
  return {
    asked,
    challenge: () => 'challenge',
    bind: async () => ({ bound: true, address: 'kei_test' }),
    addressOf: () => 'kei_test',
    release: () => {},
    holdings: async () => ({}),
    purse: async () => 0,
    authorize: async () => ({ allowed: true, address: 'kei_test', held: 1 }),
    async pay(_characterId, reward) {
      asked.push(reward)
      return { paid: true, address: 'kei_test', gold: reward.gold ?? 0, items: reward.items ?? [] }
    },
  }
}

interface Spawner {
  created: number
  bots: number
  removed: number
}

/**
 * A `GameRoomState` with the collaborators the message handler reaches for, and
 * nothing else. `createItem` exists on the stub on purpose: the assertion is that
 * the handler never calls it, which is only worth making if calling it would have
 * been observable.
 */
function room(): { state: GameRoomState; spawner: Spawner; player: any; client: any } {
  const spawner: Spawner = { created: 0, bots: 0, removed: 0 }
  const player: any = {
    id: 1,
    sessionId: 'player-1',
    isDead: false,
    said: [] as string[],
    player_data: { hotbar: new Map(), points: 0 },
    say(message: string) {
      this.said.push(message)
    },
    abilitiesCTRL: { addAbility: () => {} },
    statsCTRL: { updateBaseStats: () => {} },
    dynamicCTRL: { questUpdate: () => {} },
    moveCTRL: { processPlayerInput: () => {}, setTargetDestination: () => {} },
  }
  const client = { sessionId: 'player-1', sent: [] as any[], send(type: any, data: any) { this.sent.push({ type, data }) } }

  const state = Object.create(GameRoomState.prototype) as GameRoomState
  const entities = new MapSchema<any>()
  Object.assign(state, {
    entities,
    _gameroom: { roomId: 'test-room', clients: { getById: () => client }, database: {} },
    entityCTRL: {
      get: (sessionId: string) => (sessionId === player.sessionId ? player : entities.get(sessionId)),
      hasEntities: () => entities.size > 0,
      get all() {
        return [...entities.values()]
      },
    },
    gameData: { get: () => undefined, load: () => ({}) },
    spawnCTRL: {
      createItem: () => {
        spawner.created += 1
      },
      debug_bots: () => {
        spawner.bots += 1
      },
      removeEntity: () => {
        spawner.removed += 1
      },
    },
  })

  return { state, spawner, player, client }
}

////////////////////////////////////////////////////////////////////////////////
// The hotkey itself, in every shape a client can put it on the wire.

{
  const { state, spawner, client } = room()
  state.processMessage(client, ServerMsg.PLAYER_HOTBAR_ACTIVATED, { digit: 6 })
  check('digit 6 spawns nothing', spawner.created === 0)
  check('and leaves the room empty', state.entities.size === 0)
}

{
  const { state, spawner, client } = room()
  // The UI sends a number. Anything reaching the socket directly can send
  // whatever it likes, so the payloads that never come from the UI are the ones
  // worth trying.
  const payloads: any[] = [
    { digit: 6 },
    { digit: '6' },
    { digit: 6.0 },
    { digit: 6, admin: true },
    { digit: 6, targetId: 'player-1' },
    { digit: 06 },
    { digit: [6] },
    { digit: { valueOf: () => 6 } },
    { digit: 6, qty: 1000, key: 'sword_01' },
    {},
    null,
    undefined,
  ]
  for (const payload of payloads) {
    for (let i = 0; i < 100; i++) {
      try {
        state.processMessage(client, ServerMsg.PLAYER_HOTBAR_ACTIVATED, payload)
      } catch {
        // A malformed payload throwing is a robustness bug, not a mint. The
        // assertion below is the one that matters either way.
      }
    }
  }
  check('1200 messages across 12 payload shapes spawn nothing', spawner.created === 0, `${spawner.created} spawned`)
  check('and still leave the room empty', state.entities.size === 0)
}

check('the spawn controller has no item spawner left to call', (spawnCTRL.prototype as any).createItem === undefined)

////////////////////////////////////////////////////////////////////////////////
// The adjacent debug handlers. Neither mints; both were registered in
// production, which is the mistake that let the spawner ship.

function debugRun(env: { node?: string; debug?: string }): { spawner: Spawner } {
  const before = { node: process.env.NODE_ENV, debug: process.env.KEI_DEBUG_COMMANDS }
  if (env.node === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = env.node
  if (env.debug === undefined) delete process.env.KEI_DEBUG_COMMANDS
  else process.env.KEI_DEBUG_COMMANDS = env.debug

  const { state, spawner, client } = room()
  state.entities.set('mob-1', { type: 'entity', sessionId: 'mob-1' } as any)
  state.processMessage(client, ServerMsg.DEBUG_BOTS, {})
  state.processMessage(client, ServerMsg.DEBUG_REMOVE_ENTITIES, {})

  if (before.node === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = before.node
  if (before.debug === undefined) delete process.env.KEI_DEBUG_COMMANDS
  else process.env.KEI_DEBUG_COMMANDS = before.debug
  return { spawner }
}

{
  const off = debugRun({})
  check('debug commands are off when nothing asked for them', off.spawner.bots === 0 && off.spawner.removed === 0)

  const production = debugRun({ node: 'production', debug: 'on' })
  check('and stay off in production however the server is configured', production.spawner.bots === 0 && production.spawner.removed === 0)

  const claimed = debugRun({ node: 'production', debug: 'true' })
  check('an almost-right value does not open them either', claimed.spawner.bots === 0 && claimed.spawner.removed === 0)

  const development = debugRun({ node: 'development', debug: 'on' })
  check('a developer who asks for them gets them', development.spawner.bots === 1 && development.spawner.removed === 1)
}

////////////////////////////////////////////////////////////////////////////////
// Provenance. A loot entity is payable only if a gameplay event says it exists.

function ground(source?: string): { loot: LootSchema; state: any } {
  const state: any = { gameData: { get: () => ({}) }, entities: new MapSchema<any>() }
  const loot = new LootSchema(state, {
    key: 'sword_01',
    sessionId: 'loot-1',
    x: 0,
    y: 0,
    z: 0,
    qty: 1,
    ...(source === undefined ? {} : { source }),
  })
  state.entities.set('loot-1', loot)
  return { loot, state }
}

{
  const authority = countingAuthority()
  useInventoryAuthority(authority)

  const orphan = ground()
  const said: string[] = []
  const picker: any = {
    id: 1,
    _state: orphan.state,
    say: (message: string) => said.push(message),
    AI_TARGET: orphan.loot,
  }
  PlayerSchema.prototype.pickupItem.call(picker, orphan.loot)

  check('loot with no provenance asks for no payment', authority.asked.length === 0)
  check('and is left where it is', orphan.state.entities.size === 1)
  check('and the player is told why', said.length === 1 && said[0].includes('not yours'))

  const dropped = ground('kill:mob-9:0')
  const picker2: any = { id: 1, _state: dropped.state, say: () => {}, AI_TARGET: dropped.loot }
  PlayerSchema.prototype.pickupItem.call(picker2, dropped.loot)
  check('loot a mob dropped does ask for payment', authority.asked.length === 1)
  check(
    'keyed by the death rather than by the entity',
    authority.asked[0]?.id === 'loot:kill:mob-9:0',
    authority.asked[0]?.id,
  )

  // Two clients walking into the same drop, or one entity somehow recreated.
  const twin = ground('kill:mob-9:0')
  const picker3: any = { id: 2, _state: twin.state, say: () => {}, AI_TARGET: twin.loot }
  PlayerSchema.prototype.pickupItem.call(picker3, twin.loot)
  check(
    'a second entity for the same drop reuses the same reward id',
    authority.asked.length === 2 && authority.asked[1]?.id === authority.asked[0]?.id,
    authority.asked[1]?.id,
  )
}

////////////////////////////////////////////////////////////////////////////////
// The one thing left that creates loot stamps every drop it makes.

{
  const entities = new MapSchema<any>()
  const owner: any = { _state: { gameData: { get: () => ({}) }, entities } }
  const controller = Object.create(dropCTRL.prototype)
  Object.assign(controller, { _owner: owner, _client: { send: () => {} } })

  const target = {
    sessionId: 'mob-42',
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    AI_SPAWN_INFO: { drops: [{ id: 'sword_01', weight: 1, min: 1, max: 1, group: 1 }] },
  }
  controller.dropItems(target)

  const drops = [...entities.values()] as LootSchema[]
  check('a mob death puts its drop table on the ground', drops.length === 1)
  check('and every entity names the death it came from', drops.every((drop) => drop.source.startsWith('kill:mob-42:')), drops[0]?.source)
}

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
