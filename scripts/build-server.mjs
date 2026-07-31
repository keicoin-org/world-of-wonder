/**
 * Bundles the server with esbuild instead of compiling it with `tsc`.
 *
 * Upstream emitted CommonJS and ran it under ts-node. The SDK is ESM-only — its
 * `exports` map has no `require` condition — so a CommonJS server cannot load it
 * at all, and `require()` of it fails at runtime rather than at build time.
 *
 * The alternative was converting ~60 server files to ESM, which means adding
 * `.js` to every relative import for a change nobody asked for. Bundling instead
 * costs one script, leaves every existing file untouched, and has the side
 * benefit of producing a single artifact to copy to the host.
 *
 *   node scripts/build-server.mjs [--watch] [--entry FILE] [--out FILE]
 */

import { context, build } from 'esbuild'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}

const options = {
  absWorkingDir: root,
  entryPoints: [flag('--entry', 'src/server/index.ts')],
  outfile: flag('--out', 'dist/server/index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',

  // Native addons cannot be bundled, and neither can anything that reads its own
  // files off disk at runtime.
  //
  // @colyseus/monitor is the second kind: it resolves its static assets from
  // `__dirname`, which in a bundle would point at dist/server rather than at the
  // package. Defining `__dirname` in the banner would silence the crash and
  // leave it looking in the wrong directory, so it stays a real require instead.
  external: ['sqlite3', 'mysql2', 'better-sqlite3', '@colyseus/monitor'],

  // bananojs is CommonJS and reaches for `crypto` through a bare `require` that
  // survives bundling. ESM output has no `require`, so give it one.
  banner: {
    js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
  },
}

if (argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('  watching src/server')
} else {
  await build(options)
  console.log(`  ${options.outfile}`)
}
