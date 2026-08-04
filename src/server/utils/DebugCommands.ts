/**
 * Whether this process answers the room's debug messages at all.
 *
 * `DEBUG_BOTS` and `DEBUG_REMOVE_ENTITIES` were registered unconditionally, so
 * every client had them whether or not the deployment wanted them. Neither one
 * mints, so neither is the hole issue #10 is about — but they are reachable by
 * the same route the hole was, and a handler that is on by default is how the
 * next one gets written.
 *
 * The gate is two facts about the server and none about the client. There is no
 * message, field, or flag a player can send that turns it on, and there is no
 * value of `KEI_DEBUG_COMMANDS` that turns it on in a production build — a
 * deployment that sets it by accident still refuses.
 */

import Logger from './Logger'

/**
 * Read every time rather than once at import, so a test can set the variable and
 * a refusal cannot be baked into a bundle that outlives the reason for it.
 */
export function debugCommandsEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return process.env.KEI_DEBUG_COMMANDS === 'on'
}

/**
 * Refuse out loud, in the log, and say nothing to the client.
 *
 * The player is told nothing on purpose: a refusal that reaches chat is a
 * refusal an attacker can enumerate against, and a room message nobody sent
 * through the UI has no player to apologise to.
 */
export function refuseDebugCommand(name: string, sessionId: string): void {
  Logger.warning(`[debug] refused ${name} from ${sessionId}: debug commands are off in this deployment`)
}
