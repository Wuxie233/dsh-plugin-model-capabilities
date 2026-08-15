/**
 * Ad-hoc end-to-end pre-deploy check: drives the daemon's startup scan with a
 * fake settings service carrying the REAL llm-pi-ai user section (read-only)
 * and prints the path-ops the daemon would write. Run from the repo root:
 *
 *   node scripts/smoke-scan.mjs
 *
 * Exits non-zero if the scan writes nothing (when gaps exist) or throws.
 * @module dsh-plugin-model-capabilities/scripts/smoke-scan
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import YAML from '/opt/opencode-runtime/deployments/deepseek-harness/node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js'

// Drive the DEPLOYED copy (deps resolve from the profile), not the repo source.
const { apply } = await import(pathToFileURL(
  `${homedir()}/.dsh/profiles/node_modules/dsh-plugin-model-capabilities/lib/index.js`).href)

const doc = YAML.parse(readFileSync(`${homedir()}/.dsh/settings.yaml`, 'utf8'))
const user = { llm: { ...(doc['llm-pi-ai'] ?? {}) } }
const fakeDescriptor = { ns: 'llm-pi-ai', user: user.llm, revision: 42 }

let wrote
const settingsCtx = {
  settings: {
    describe: () => [fakeDescriptor],
    mutate: async (ns, ops, revision) => {
      wrote = { ns: String(ns), ops, revision }
    },
  },
  on: () => () => {},
}

const ctx = {
  logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a), error: (...a) => console.log('[error]', ...a) },
  inject: (names, fn) => fn(settingsCtx),
  effect: () => () => {},
}

apply(ctx, {
  scanIntervalHours: 12,
  overridesPath: `${homedir()}/.dsh/model-capabilities.overrides.json`,
  cacheDir: '/tmp/dsh-mc-test-cache',
  enableNetworkSources: true,
})

setTimeout(() => {
  if (wrote === undefined) {
    console.error('SMOKE FAIL: daemon wrote nothing (gaps exist but no mutate)')
    process.exit(1)
  }
  console.log('\nmutate ns:', wrote.ns, '| revision:', wrote.revision)
  for (const op of wrote.ops) {
    console.log('op:', op.op, op.path.join('.'), '| providers routes:', Object.keys(op.value))
    for (const [route, section] of Object.entries(op.value)) {
      for (const m of section.models) {
        console.log(`  ${route}/${m.id}:`, JSON.stringify(m))
      }
    }
  }
  process.exit(0)
}, 12000)
