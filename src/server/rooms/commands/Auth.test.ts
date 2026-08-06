/**
 * `Auth.check` is the entire authentication check for joining a game room.
 * Run with `npm run test:auth`.
 *
 * Issues #43 and #32, duplicates of the same root cause: `authData.token` —
 * sent by every client (`Network.ts`'s `joinRoom`) — was never read. The only
 * gate was "does this character id exist" and "is it not already online", and
 * both of those are readable unauthenticated via GET /get_character. Anyone
 * could join as any offline character by id, with any garbage string as a
 * token, and whatever `Auth.check` returned became `client.auth` — the
 * identity autosave, wallet-binding and reward idempotency all trust downstream.
 *
 * The fix reuses `Database.ownsCharacter`, the same token-to-account join
 * `/kei/purse` already relies on for the same reason (issue #24), rather than
 * inventing a second one. This file is a real sqlite database, the same as
 * `Outbox.test.ts`, because the claim being tested is a join across two real
 * tables and a fake would just be this file agreeing with itself.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Auth } from './Auth'
import { Database } from '../../Database'
import { Config } from '../../../shared/Config'

let failures = 0
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const directory = mkdtempSync(join(tmpdir(), 'wow-auth-'))
process.env.DATABASE_PATH = join(directory, 'test.db')

const database = new Database(new Config())
await database.init()
await database.create()
// `createDatabase()` fires its statements without awaiting them individually.
await new Promise((resolve) => setTimeout(resolve, 250))

//////////////////////////////////////////////////
// Two accounts, and a character belonging to each.
//////////////////////////////////////////////////

await database.saveUser('owner', 'pw', 'owner-token')
await database.saveUser('stranger', 'pw', 'stranger-token')

const character = await database.createCharacter('owner-token', 'Hero', 'humanoid', 'default', 'default')
check('the fixture character was created', !!character, JSON.stringify(character))

//////////////////////////////////////////////////
// The join, as every client actually attempts it.
//////////////////////////////////////////////////

const validJoin = await Auth.check(database, { character_id: character.id, token: 'owner-token' })
check("a valid token for the character's own account joins", !!validJoin && validJoin.id === character.id, JSON.stringify(validJoin))

const garbageToken = await Auth.check(database, { character_id: character.id, token: 'this-is-not-a-real-token' })
check('a garbage token for an otherwise-valid character is refused, not thrown', garbageToken === false, JSON.stringify(garbageToken))

const wrongAccount = await Auth.check(database, { character_id: character.id, token: 'stranger-token' })
check("a valid token for a DIFFERENT account cannot join someone else's character", wrongAccount === false, JSON.stringify(wrongAccount))

const unknownCharacter = await Auth.check(database, { character_id: 999999, token: 'owner-token' })
check('an unknown character id is refused as before', unknownCharacter === false, JSON.stringify(unknownCharacter))

//////////////////////////////////////////////////
// The duplicate-session guard, which is a different concern and must survive.
//////////////////////////////////////////////////

await database.toggleOnlineStatus(character.id, 1)
const alreadyOnline = await Auth.check(database, { character_id: character.id, token: 'owner-token' })
check('a character already online is refused even with the right token', alreadyOnline === false, JSON.stringify(alreadyOnline))

await database.toggleOnlineStatus(character.id, 0)
const rejoinsAfterLogout = await Auth.check(database, { character_id: character.id, token: 'owner-token' })
check('and the same account can join again once it is offline', !!rejoinsAfterLogout && rejoinsAfterLogout.id === character.id, JSON.stringify(rejoinsAfterLogout))

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
