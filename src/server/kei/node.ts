/**
 * Which chain this world runs against, and which account issues its money.
 *
 * Both are environment, not settings in `Config.ts`: they differ per deployment
 * and one of them is a secret.
 */

import { Kei, MockNode, mockRpcHandler, type KeiNode } from 'kei-transaction'
import Logger from '../utils/Logger'

export interface Chain {
  node: KeiNode | string
  /**
   * The mock, when we made one. It has to be served over HTTP as well as used
   * in process, because the player's wallet lives in a browser and cannot reach
   * an object on this heap.
   */
  mock?: MockNode
}

/**
 * `KEI_NODE` is a node URL. With none set the world runs against a mock this
 * process creates and then serves at `/rpc`, which is what lets the template be
 * cloned and run with no chain to install — the same trade Button makes at M1.
 * Nothing on a mock is worth anything, and it dies with the process.
 */
export async function openChain(): Promise<Chain> {
  const url = process.env.KEI_NODE
  if (url) {
    Logger.info('[kei] node ' + url)
    return { node: url }
  }

  Logger.warning('[kei] no KEI_NODE set — serving an in-process mock chain at /rpc, which dies with this process')
  const mock = await MockNode.create()
  return { node: mock, mock }
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
