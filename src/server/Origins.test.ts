/**
 * Who may call this server from a browser. Run with `npm run test:origins`.
 *
 * The interesting cases are not "a stranger is refused" — they are the four
 * places a naive allow-list breaks something that has to keep working: the
 * split deployment this template documents, a server that serves its own
 * client, a developer who has just cloned it, and every non-browser caller.
 */

import { DEVELOPMENT_ORIGINS, ORIGINS_ENV, describeOrigins, normalizeOrigin, originAllowed, readAllowedOrigins } from './Origins'

let failures = 0
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function refuses(env: NodeJS.ProcessEnv, why: string): string {
  try {
    readAllowedOrigins(env)
  } catch (error) {
    return (error as Error).message
  }
  check(why, false, 'it was accepted')
  return ''
}

// ------------------------------------------------------------ configuration

const production = readAllowedOrigins({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
check('a production deployment allows no other origin by default', production.length === 0, JSON.stringify(production))

const development = readAllowedOrigins({} as NodeJS.ProcessEnv)
check(
  'and a clone that has just been run allows the webpack dev server',
  DEVELOPMENT_ORIGINS.every((origin) => development.includes(origin)),
  JSON.stringify(development),
)
check(
  'which production does not inherit',
  !production.includes(DEVELOPMENT_ORIGINS[0]),
  JSON.stringify(production),
)

const configured = readAllowedOrigins({
  NODE_ENV: 'production',
  [ORIGINS_ENV]: ' https://keicoin.org , https://www.keicoin.org ',
} as NodeJS.ProcessEnv)
check(
  'a configured list is taken whitespace and all',
  configured.length === 2 && configured[0] === 'https://keicoin.org' && configured[1] === 'https://www.keicoin.org',
  JSON.stringify(configured),
)

// The bug this replaces, spelled out loud rather than honoured quietly. Someone
// reaching for `*` is reaching for the behaviour that was removed.
const wildcard = refuses({ [ORIGINS_ENV]: '*' } as NodeJS.ProcessEnv, 'a wildcard is refused')
check('a wildcard is refused, and says what to write instead', wildcard.includes('keicoin.org'), wildcard)

// A trailing slash is the mistake that costs an afternoon: browsers never send
// one, so the entry silently matches nothing and the only symptom is a CORS
// error on a machine you do not have.
const slashed = refuses({ [ORIGINS_ENV]: 'https://keicoin.org/' } as NodeJS.ProcessEnv, 'a trailing slash is refused')
check('a trailing slash is refused at startup, not in a browser console', slashed.includes('trailing slash'), slashed)

const pathed = refuses({ [ORIGINS_ENV]: 'https://keicoin.org/game' } as NodeJS.ProcessEnv, 'a path is refused')
check('so is a path', pathed.includes('no path'), pathed)

const bare = refuses({ [ORIGINS_ENV]: 'keicoin.org' } as NodeJS.ProcessEnv, 'a bare hostname is refused')
check('and a bare hostname, which has no scheme to compare', bare.includes('scheme://host'), bare)

check('an origin keeps its port', normalizeOrigin('http://localhost:8080') === 'http://localhost:8080')
check('and a default port is dropped, the way a browser drops it', normalizeOrigin('https://keicoin.org:443') === 'https://keicoin.org')

// ----------------------------------------------------------------- requests

const SPLIT = ['https://keicoin.org']
const HOST = 'mmo.keicoin.org'

check(
  'the documented split works, as configuration rather than permissiveness',
  originAllowed('https://keicoin.org', HOST, SPLIT),
)
check('a stranger does not', !originAllowed('https://evil.example', HOST, SPLIT))
check(
  'and neither does a lookalike of the configured one',
  !originAllowed('https://keicoin.org.evil.example', HOST, SPLIT),
)
check('nor the same host over http', !originAllowed('http://keicoin.org', HOST, SPLIT))

// The case that would otherwise need configuration to talk to itself: this repo
// serves `dist/client` off the same express app.
check('a server that serves its own client needs no allow-list', originAllowed(`https://${HOST}`, HOST, []))
check('down to the port', originAllowed('http://localhost:3000', 'localhost:3000', []))
check('and a different port on the same host is still somebody else', !originAllowed('http://localhost:8080', 'localhost:3000', []))

// Not a cross-origin request at all. Refusing these would break the end-to-end
// test, every native client, and every server-to-server call, while defending
// against nobody — a program that wants to send an `Origin` header can.
check('a caller with no Origin is not a browser being tricked', originAllowed(undefined, HOST, []))
// A sandboxed iframe and a file:// page send this, which is a caller that has
// deliberately no origin to name.
check('but a null origin is', !originAllowed('null', HOST, []))
check('and so is one that is not a URL', !originAllowed('not an origin', HOST, []))
check('a request with an Origin and no Host cannot be same-origin', !originAllowed('https://keicoin.org', undefined, []))

// Out of the box, a developer's two ports.
check('a fresh clone can call itself from webpack', originAllowed('http://localhost:8080', 'localhost:3000', development))

check('the startup line says which policy is in force', describeOrigins(SPLIT).includes('https://keicoin.org'))
check(
  'and an empty list says what to do about it',
  describeOrigins([]).includes(ORIGINS_ENV) && describeOrigins([]).includes('refused'),
  describeOrigins([]),
)

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
