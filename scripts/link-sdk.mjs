/**
 * Puts the SDK from a sibling `kei-transaction` checkout into `node_modules`.
 *
 * SPEC §10.5 wants the template consuming the SDK through a link while it is
 * developed alongside the chain, and the published package in CI. This is the
 * first half. Once `kei-transaction` is on npm, delete this script and the
 * `link-sdk` step — `npm install kei-transaction` is then the whole story.
 *
 *   npm run link-sdk        # after `bun run build` next door
 *
 * It copies rather than symlinks, and that is deliberate. `kei-transaction` is a
 * bun workspace, so a symlink into it leads npm's dependency walker through
 * `node_modules/.bun/`, a store layout it does not understand — every later
 * `npm install` here then dies on "Cannot read properties of null". A copy is a
 * plain directory, which npm is content to ignore.
 */

import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const template = dirname(dirname(fileURLToPath(import.meta.url)))

/** The umbrella plus everything it re-exports; `@keicoin/core` anchors the tree. */
const PACKAGES = {
  'kei-transaction': 'kei',
  '@keicoin/core': 'core',
  '@keicoin/tokens': 'tokens',
  '@keicoin/claims': 'claims',
  '@keicoin/work': 'work',
  '@keicoin/wallet': 'wallet',
}

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Walk up looking for the checkout rather than assuming `../kei-transaction`.
 * A git worktree puts this file several levels below the directory the sibling
 * actually sits next to, and hard-coding one `..` breaks the moment anybody
 * works in one.
 */
async function findSdk() {
  let directory = template
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, '..', 'kei-transaction', 'packages')
    if (await exists(candidate)) return resolve(candidate)
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

const sdk = await findSdk()
if (!sdk) {
  console.error('No kei-transaction checkout found in any parent directory.\nExpected it beside this one.')
  process.exit(1)
}

for (const [name, directory] of Object.entries(PACKAGES)) {
  const from = join(sdk, directory)
  const dist = join(from, 'dist')

  // A source-only checkout links to nothing useful: each package's `exports`
  // map points at dist/, so a missing build surfaces much later as a module
  // resolution error that says nothing about this script.
  if (!(await exists(dist))) {
    console.error(`${name}: no dist/ in ${from}\nRun \`bun run build\` in kei-transaction first.`)
    process.exit(1)
  }

  const to = join(template, 'node_modules', name)
  await rm(to, { recursive: true, force: true })
  await mkdir(dirname(to), { recursive: true })
  await cp(dist, join(to, 'dist'), { recursive: true })
  await cp(join(from, 'src'), join(to, 'src'), { recursive: true })
  await cp(join(from, 'package.json'), join(to, 'package.json'))

  const { version } = JSON.parse(await readFile(join(from, 'package.json'), 'utf8'))
  console.log(`  ${name}@${version}`)
}

console.log(`\n  linked ${Object.keys(PACKAGES).length} packages from ${sdk}\n`)
