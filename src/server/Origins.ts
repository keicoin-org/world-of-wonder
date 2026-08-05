/**
 * Which browsers may call this server, and why the answer is not "all of them".
 *
 * `app.use(cors())` with no options answers every preflight with the caller's
 * own origin, so any page a player had open could call the economy routes from
 * inside their browser. #13 already made that unable to steal a purchase — an
 * order is named by 24 CSPRNG bytes and settles only against its own price — so
 * what is left is blast radius rather than a specific theft: it is a widening
 * factor on every route this server will ever mount, which is exactly the kind
 * of thing that is cheap now and archaeology later.
 *
 * The awkward part, and the reason it was left alone once already, is that this
 * template documents a split deployment: keicoin.org serves the client and
 * mmo.keicoin.org runs the rooms (see `client/Utils/index.ts`). A naive
 * same-origin rule breaks precisely the arrangement the README recommends. So
 * the split is configuration here rather than an accident of permissiveness.
 *
 * Nothing in this file is a defence against a program. CORS is a rule browsers
 * apply to themselves; curl ignores it and always will. What it defends against
 * is a *page* — somebody else's page, running in a player's browser, spending
 * the player's session. Every route still has to be safe on its own, and the
 * ones that matter are: `/kei/order` is authorized by the id it returns, and
 * nothing here mints to an address a client merely named.
 */

/**
 * Where a fresh clone develops.
 *
 * `npm run client-dev` serves the page from webpack at 8080 and the server runs
 * at 3000, so out of the box every request a developer makes is cross-origin.
 * Getting this wrong turns "clone and run" into a CORS error in the console,
 * which is why the default is these two rather than nothing.
 */
export const DEVELOPMENT_ORIGINS = ['http://localhost:8080', 'http://127.0.0.1:8080'] as const

/** How a deployment names the pages allowed to call it. */
export const ORIGINS_ENV = 'KEI_ALLOWED_ORIGINS'

/**
 * Read the allow-list out of the environment.
 *
 * Refuses rather than shrugs. A misspelt entry is silent — the browser reports
 * a CORS failure and the operator has no reason to suspect a trailing slash —
 * so an entry that could never match anything is a startup error naming itself,
 * in the same spirit as the seed check in `kei/node.ts`.
 */
export function readAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env[ORIGINS_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

  for (const entry of configured) {
    if (entry === '*') {
      throw new Error(
        `${ORIGINS_ENV}=* is the thing this replaced: it lets any page a player visits call this server on their behalf. List the origins that serve your client instead — for the deployment this template documents, that is https://keicoin.org.`,
      )
    }
    if (entry !== normalizeOrigin(entry)) {
      throw new Error(
        `${ORIGINS_ENV} takes origins and "${entry}" is not one. An origin is scheme://host[:port] with no path and no trailing slash — a browser sends "${normalizeOrigin(entry) || 'nothing that looks like this'}", and an entry it never sends can never match.`,
      )
    }
  }

  if (configured.length > 0) return configured
  // Production gets nothing by default. Same-origin still works — see
  // `originAllowed` — so a deployment that serves its own client is unaffected,
  // and one that serves it from somewhere else has to say where.
  return env.NODE_ENV === 'production' ? [] : [...DEVELOPMENT_ORIGINS]
}

/**
 * `scheme://host[:port]`, or `''` for anything that is not an origin at all.
 *
 * Used both to check configuration and to compare a request's `Origin` against
 * the host it was addressed to, so the two agree by construction.
 */
export function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}

/**
 * May a browser at `origin` call a request addressed to `host`?
 *
 * Three answers, in the order they matter.
 *
 * **No `Origin` header is not a cross-origin request.** curl, a native client,
 * another server, and an ordinary same-origin navigation all send none. Refusing
 * those would break the end-to-end test and every non-browser caller while
 * defending against nobody: a program that wants to send an `Origin` can.
 *
 * **`Origin: null` is refused.** That is what a sandboxed iframe and a `file://`
 * page send, which is to say a caller that deliberately has no origin to name.
 *
 * **Same-origin is always allowed.** A deployment that serves its own client —
 * which is what this repo does by default, `Api.ts` mounting `dist/client` on
 * the same express app — would otherwise need configuration to talk to itself.
 * `Host` carries no scheme, so the comparison is host and port; that is enough
 * to tell "this page came from us" from "this page came from someone else",
 * which is the question being asked.
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined || origin === '') return true
  if (allowed.includes(origin)) return true
  if (host === undefined || host === '') return false

  const normalized = normalizeOrigin(origin)
  if (normalized === '') return false
  return new URL(normalized).host === host
}

/** What to log at startup, so an operator can see the policy rather than infer it. */
export function describeOrigins(allowed: readonly string[]): string {
  if (allowed.length === 0) {
    return 'cross-origin requests are refused; only pages served by this server may call it. ' +
      `Set ${ORIGINS_ENV} if your client is hosted elsewhere.`
  }
  return `cross-origin requests are allowed from ${allowed.join(', ')} (and from this server's own origin).`
}
