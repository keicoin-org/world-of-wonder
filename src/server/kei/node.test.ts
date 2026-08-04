/**
 * Startup identity policy, with no real node or database involved.
 *
 * The injected entropy and node opener are counters on purpose: a refusal is
 * only safe if it happens before either path can run.
 */

import { openStartupChain, type Chain, type ChainConfiguration } from './node'
import { DB_MYSQL } from '../utils/database/mysql'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const VALID_SEED = 'a5'.repeat(32)
const GENERATED_SEED = 'c3'.repeat(32)

let failures = 0

function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

interface Probe {
  entropyCalls: number
  nodeCalls: number
  configurations: ChainConfiguration[]
  generateSeed(): string
  open(configuration: ChainConfiguration): Promise<Chain>
}

function probe(): Probe {
  return {
    entropyCalls: 0,
    nodeCalls: 0,
    configurations: [],
    generateSeed() {
      this.entropyCalls += 1
      return GENERATED_SEED
    },
    async open(configuration) {
      this.nodeCalls += 1
      this.configurations.push(configuration)
      return {
        network: configuration.network,
        ...(configuration.nodeUrl ? { node: configuration.nodeUrl } : {}),
      }
    },
  }
}

async function refusal(
  what: string,
  environment: { KEI_NETWORK?: string; KEI_NODE?: string; KEI_GAME_SEED?: string },
): Promise<string> {
  const observed = probe()
  let message = ''
  try {
    await openStartupChain({
      environment,
      generateSeed: observed.generateSeed.bind(observed),
      open: observed.open.bind(observed),
    })
  } catch (error) {
    message = (error as Error).message
  }

  check(`${what} refuses startup`, message.includes('KEI_GAME_SEED is required'), message)
  check(`${what} requests no random seed`, observed.entropyCalls === 0, `${observed.entropyCalls} entropy calls`)
  check(`${what} opens no node or persistent write path`, observed.nodeCalls === 0, `${observed.nodeCalls} node calls`)
  return message
}

const ephemeral = probe()
const mock = await openStartupChain({
  environment: { KEI_NETWORK: 'mock' },
  generateSeed: ephemeral.generateSeed.bind(ephemeral),
  open: ephemeral.open.bind(ephemeral),
})
check('missing seed + in-process mock generates a valid seed', /^[0-9a-f]{64}$/.test(mock.seed))
check('in-process mock generates exactly once', ephemeral.entropyCalls === 1, `${ephemeral.entropyCalls}`)
check('in-process mock opens only after identity resolution', ephemeral.nodeCalls === 1, `${ephemeral.nodeCalls}`)

const defaultMessage = await refusal('missing seed + default testnet', {})
check('persistent refusal explains asset-ID consequence', defaultMessage.includes('every asset ID'), defaultMessage)
check('persistent refusal includes the generation command', defaultMessage.includes("randomBytes(32)"), defaultMessage)
await refusal('missing seed + explicit testnet', { KEI_NETWORK: 'testnet' })
await refusal('missing seed + mainnet', { KEI_NETWORK: 'mainnet' })
await refusal('missing seed + custom node labelled mock', {
  KEI_NETWORK: 'mock',
  KEI_NODE: 'https://custom.invalid/rpc',
})

for (const environment of [
  {},
  { KEI_NETWORK: 'testnet' },
  { KEI_NETWORK: 'mainnet' },
  { KEI_NETWORK: 'mock' },
  { KEI_NETWORK: 'mock', KEI_NODE: 'https://custom.invalid/rpc' },
]) {
  const observed = probe()
  const first = await openStartupChain({
    environment: { ...environment, KEI_GAME_SEED: VALID_SEED },
    generateSeed: observed.generateSeed.bind(observed),
    open: observed.open.bind(observed),
  })
  const second = await openStartupChain({
    environment: { ...environment, KEI_GAME_SEED: VALID_SEED },
    generateSeed: observed.generateSeed.bind(observed),
    open: observed.open.bind(observed),
  })
  const label = JSON.stringify(environment)
  check(`configured seed starts deterministically for ${label}`, first.seed === VALID_SEED && second.seed === VALID_SEED)
  check(`configured seed never requests entropy for ${label}`, observed.entropyCalls === 0, `${observed.entropyCalls}`)
}

const invalidSecret = 'not-a-seed-super-secret-value'
const invalid = probe()
let invalidMessage = ''
try {
  await openStartupChain({
    environment: { KEI_NETWORK: 'testnet', KEI_GAME_SEED: invalidSecret },
    generateSeed: invalid.generateSeed.bind(invalid),
    open: invalid.open.bind(invalid),
  })
} catch (error) {
  invalidMessage = (error as Error).message
}
check('invalid seed says how to fix its shape', invalidMessage.includes('64 hexadecimal characters'), invalidMessage)
check('invalid seed diagnostic does not echo the credential', !invalidMessage.includes(invalidSecret), invalidMessage)
check('invalid seed requests no entropy', invalid.entropyCalls === 0, `${invalid.entropyCalls}`)
check('invalid seed opens no node', invalid.nodeCalls === 0, `${invalid.nodeCalls}`)

// Exercise the real entry point as a separate process. This pins the ordering
// contract in index.ts: issuer refusal happens before Database.create() can
// create its default SQLite file. `spawnSync` and an explicit env object keep
// this test identical on Windows and Linux (no shell-specific assignment).
const workingDirectory = mkdtempSync(resolve(tmpdir(), 'wonder-stable-issuer-'))
const serverEntry = resolve(process.cwd(), 'dist/server/index.mjs')
const environment = { ...process.env }
delete environment.KEI_GAME_SEED
delete environment.KEI_NETWORK
delete environment.KEI_NODE
delete environment.DATABASE_PATH
const started = spawnSync(process.execPath, [serverEntry], {
  cwd: workingDirectory,
  env: environment,
  encoding: 'utf8',
  timeout: 15_000,
})
const diagnostic = `${started.stdout ?? ''}\n${started.stderr ?? ''}`
check('real server exits nonzero without a persistent-network seed', started.status !== 0, `${started.status}`)
check('real server emits the actionable refusal', diagnostic.includes('KEI_GAME_SEED is required'))
check('real server refuses before creating its SQLite database', !existsSync(resolve(workingDirectory, 'database.db')))
rmSync(workingDirectory, { recursive: true, force: true })

// The MySQL adapter builds its schema by splitting database/mysql.sql on `;` and
// executing every fragment, so a semicolon anywhere in that file — including
// prose inside a `--` comment — becomes a statement boundary, and the statement
// that follows it is swallowed into a fragment that cannot parse. Drive the real
// createDatabase() over the real file with a connection that only records: no
// MySQL server needed, but the splitter and the schema are both the live ones.
const issued: string[] = []
const adapter = new DB_MYSQL()
adapter.db = {
    async query(sql: string) {
        issued.push(sql)
        return [[]]
    },
}
await adapter.createDatabase()

const statementOf = (fragment: string): string =>
    fragment
        .split('\n')
        .filter((line) => !/^\s*--/.test(line))
        .join('\n')
        .replace(/;\s*$/, '')
        .trim()

const unrunnable = issued.filter((fragment) => {
    const statement = statementOf(fragment)
    return statement === '' || !/^(DROP|CREATE|ALTER|INSERT|SET|USE)\b/i.test(statement)
})
check(
    'every mysql.sql fragment the adapter executes is a statement',
    unrunnable.length === 0,
    unrunnable.map((fragment) => JSON.stringify(statementOf(fragment).slice(0, 60))).join(' | ')
)
check(
    'the reward ledger survives the split it is documented in',
    issued.some((fragment) => /^CREATE TABLE IF NOT EXISTS `reward_payments`/i.test(statementOf(fragment))),
    `${issued.length} fragments`
)

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
