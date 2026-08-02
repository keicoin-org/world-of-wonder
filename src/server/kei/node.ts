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
export async function openChain(): Promise<Chain> {
  const network = resolveNetwork()
  const url = process.env.KEI_NODE

  if (url) {
    Logger.info(`[kei] ${network} node ${url}`)
    return { node: url, network }
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

function resolveNetwork(): Network {
  const raw = (process.env.KEI_NETWORK ?? '').trim().toLowerCase()
  if (raw === '') return 'testnet'
  if ((NETWORKS as readonly string[]).includes(raw)) return raw as Network

  throw new Error(`KEI_NETWORK must be one of ${NETWORKS.join(', ')} — got "${process.env.KEI_NETWORK}".`)
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
 * Without one a fresh seed is generated per run. That is fine against a mock,
 * where the ledger is new too, and wrong anywhere else — a new issuer means new
 * asset ids, so every balance and every item from the last run is unreachable.
 * On the default testnet it also re-burns the issuance cost (SPEC §5.6.5) every
 * restart, against a ledger that remembers, so set one before you play twice.
 */
export function resolveIssuerSeed(): string {
  const seed = process.env.KEI_GAME_SEED
  if (seed) {
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new Error('KEI_GAME_SEED must be 64 hex characters.')
    }
    return seed
  }

  Logger.warning('[kei] no KEI_GAME_SEED set — generated one for this run, so every asset id changes on restart')
  return randomSeed()
}

function randomSeed(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
