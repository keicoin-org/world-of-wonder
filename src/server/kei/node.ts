/**
 * Which chain this world runs against, and which account issues its money.
 *
 * Both are environment, not settings in `Config.ts`: they differ per deployment
 * and one of them is a secret.
 */

import { Kei, MockNode, mockRpcHandler, type KeiNode } from 'kei-transaction'
import Logger from '../utils/Logger'

/** What `KEI_NETWORK` accepts. The SDK's own spelling, passed straight through. */
export type Network = 'testnet' | 'mainnet' | 'mock'

const NETWORKS: readonly Network[] = ['testnet', 'mainnet', 'mock']

export interface Chain {
  /**
   * Undefined means "whichever public node the SDK picks for this network",
   * which is the normal case and the one that needs no configuration.
   */
  node?: KeiNode | string
  network: Network
  /**
   * The mock, when we made one. It has to be served over HTTP as well as used
   * in process, because the player's wallet lives in a browser and cannot reach
   * an object on this heap.
   */
  mock?: MockNode
}

/** Chain choices resolved without opening a node or touching persistent state. */
export interface ChainConfiguration {
  network: Network
  nodeUrl?: string
}

interface Environment {
  KEI_NETWORK?: string
  KEI_NODE?: string
  KEI_GAME_SEED?: string
}

/** Resolve deployment configuration before constructing anything with effects. */
export function resolveChainConfiguration(environment: Environment = process.env): ChainConfiguration {
  const network = resolveNetwork(environment.KEI_NETWORK)
  const nodeUrl = environment.KEI_NODE?.trim()
  return { network, ...(nodeUrl ? { nodeUrl } : {}) }
}

/**
 * `KEI_NETWORK` is `testnet` (the default), `mainnet`, or `mock`.
 * `KEI_NODE` overrides the URL for whichever of those is selected.
 *
 * The default is the real M3 testnet rather than a mock, because a world whose
 * economy only exists inside one process teaches the wrong thing about what
 * this template is for: the player's wallet is meant to outlive the server, and
 * on a mock it cannot. Testnet Kei is still worth nothing and the chain may
 * reset, which is the right amount of consequence while you are building.
 *
 * `mock` remains one variable away, and is the right choice offline or in a test
 * that must not touch the network.
 */
export async function openChain(configuration = resolveChainConfiguration()): Promise<Chain> {
  const { network, nodeUrl } = configuration

  if (nodeUrl) {
    // Node URLs can contain credentials, so do not copy the value into logs.
    Logger.info(`[kei] ${network} custom node from KEI_NODE`)
    return { node: nodeUrl, network }
  }

  if (network === 'mock') {
    Logger.warning('[kei] KEI_NETWORK=mock — serving an in-process mock chain at /rpc, which dies with this process')
    const mock = await MockNode.create()
    return { node: mock, network, mock }
  }

  // No URL: the SDK resolves the public node for this network, and says so
  // itself if there is not one yet. Mainnet is deliberately not open (SPEC §15),
  // so selecting it without a KEI_NODE is meant to stop here rather than
  // silently settle somewhere else.
  Logger.info(`[kei] ${network} — using the SDK's public node for it`)
  return { network }
}

export function resolveNetwork(configuredNetwork = process.env.KEI_NETWORK): Network {
  const raw = (configuredNetwork ?? '').trim().toLowerCase()
  if (raw === '') return 'testnet'
  if ((NETWORKS as readonly string[]).includes(raw)) return raw as Network

  throw new Error(`KEI_NETWORK must be one of ${NETWORKS.join(', ')}.`)
}

/** Only testnet hands out Kei. Mainnet has to be funded by a person (SPEC §5.6.5). */
export function hasFaucet(network: Network): boolean {
  return network !== 'mainnet'
}

/**
 * Serves the mock at `/rpc`.
 *
 * The SDK's handler is written against web `Request`/`Response` so it can go
 * straight into `Bun.serve`. Express predates both, so this converts in and out.
 * The body is already parsed by the time it arrives, hence re-serialising it.
 */
export function mountNodeRpc(app: any, mock: MockNode): void {
  const rpc = mockRpcHandler({ node: mock })

  const handle = async (request: any, response: any) => {
    const proxied = new Request('http://node.invalid/rpc', {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      ...(request.method === 'POST' ? { body: JSON.stringify(request.body ?? {}) } : {}),
    })

    const result = await rpc(proxied)
    result.headers.forEach((value: string, key: string) => response.setHeader(key, value))
    response.status(result.status)
    const text = await result.text()
    response.send(text)
  }

  app.post('/rpc', handle)
  app.options('/rpc', handle)
  Logger.info('[kei] mock node served at /rpc')
}

/**
 * The issuer seed is the whole economy: whoever holds it can mint this world's
 * currency without limit. It belongs in the environment and nowhere else.
 *
 * A fresh seed is allowed only for the in-process mock, whose ledger is born and
 * dies with this process. Public and custom nodes fail closed without a stable
 * seed because a new issuer means new asset ids and invisible prior property.
 */
export interface IssuerSeedOptions {
  network: Network
  customNode: boolean
  configuredSeed?: string
  /** Injectable so refusal tests can prove entropy was never requested. */
  generateSeed?: () => string
}

export function resolveIssuerSeed(options: IssuerSeedOptions): string {
  const seed = options.configuredSeed
  if (seed !== undefined && seed !== '') {
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new Error(
        'KEI_GAME_SEED is invalid; it must be exactly 64 hexadecimal characters. The configured value was not logged.',
      )
    }
    return seed
  }

  // A custom KEI_NODE may survive the process even when its network label is
  // `mock`, so only the MockNode constructed in this process is ephemeral.
  if (options.network === 'mock' && !options.customNode) {
    Logger.warning(
      '[kei] no KEI_GAME_SEED set — generated one for this in-process mock; it and its asset ids die with this process',
    )
    return (options.generateSeed ?? randomSeed)()
  }

  throw new Error(
    'KEI_GAME_SEED is required before opening a public or custom node. Changing this seed changes every asset ID and makes prior player property invisible to this world. Generate a stable 32-byte seed with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  )
}

export interface StartupChain {
  chain: Chain
  seed: string
}

export interface OpenStartupChainOptions {
  environment?: Environment
  generateSeed?: () => string
  /** Injectable so tests can prove refusal happens before any node call. */
  open?: (configuration: ChainConfiguration) => Promise<Chain>
}

/**
 * Fail-closed startup boundary. The caller invokes this before its database,
 * faucet, issuer, or listeners, and this function validates the seed before it
 * opens the node.
 */
export async function openStartupChain(options: OpenStartupChainOptions = {}): Promise<StartupChain> {
  const environment = options.environment ?? process.env
  const configuration = resolveChainConfiguration(environment)
  const seed = resolveIssuerSeed({
    network: configuration.network,
    customNode: configuration.nodeUrl !== undefined,
    configuredSeed: environment.KEI_GAME_SEED,
    ...(options.generateSeed ? { generateSeed: options.generateSeed } : {}),
  })
  const chain = await (options.open ?? openChain)(configuration)
  return { chain, seed }
}

function randomSeed(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
