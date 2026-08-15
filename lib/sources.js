/**
 * The capability source chain: local overrides file → latest pi-ai npm
 * catalog → installed pi-ai catalog → models.dev aggregate.
 *
 * Every source is optional and cached: the chain answers with the first
 * source that has data for a model id, and a source that fails (network,
 * parse, permission) logs once and stays silent for this scan — a missing
 * fact never takes the settings namespace down with it.
 *
 * Network sources persist under a cache directory with a TTL so a scan does
 * not refetch a catalog that is already fresh; failures write a short-lived
 * negative marker so a down endpoint is not hammered on every scan.
 * @module dsh-plugin-model-capabilities/sources
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  matchById,
  modelsDevEntryToCapabilities,
  piAiEntryToCapabilities,
} from './capabilities.js'

const run = promisify(execFile)

/** Default TTL for a fetched catalog (24h), in ms. */
export const CATALOG_TTL_MS = 24 * 3600 * 1000

/** Negative-result TTL (1h): a source that just failed is not retried sooner. */
export const FAILURE_TTL_MS = 3600 * 1000

/**
 * Read the local overrides file: `{ "<modelId>": {capability fields...} }`.
 * This is the user's authoritative manual layer — highest priority, never
 * written by the plugin.
 * @param {string} path - overrides JSON path.
 * @param {import('@deepseek-ai/cordis').Logger} log
 * @returns {Map<string, import('./capabilities.js').ModelCapabilities>}
 */
export function readOverrides(path, log) {
  const map = new Map()
  if (!existsSync(path)) return map
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    log.warn(`model-capabilities: overrides file ${path} is not valid JSON (${error.message}); ignored`)
    return map
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn(`model-capabilities: overrides file ${path} must be a JSON object of modelId → capabilities; ignored`)
    return map
  }
  for (const [id, caps] of Object.entries(parsed)) {
    if (typeof caps !== 'object' || caps === null) continue
    map.set(id, { ...caps, source: 'overrides' })
  }
  return map
}

/**
 * Read the pi-ai catalog shipped inside the running deployment. Zero network;
 * the version matches whatever dsh was last upgraded to.
 * @param {import('@deepseek-ai/cordis').Logger} log
 * @returns {Map<string, import('./capabilities.js').ModelCapabilities>} by exact model id.
 */
export function readInstalledPiAi(log) {
  const dataDir = resolveInstalledPiAiDataDir(log)
  if (dataDir === undefined) return new Map()
  return readPiAiDataDir(dataDir, 'pi-ai(installed)', log)
}

/** Locate `dist/providers/data` of the pi-ai package the profile resolves to. */
function resolveInstalledPiAiDataDir(log) {
  // pi-ai's exports map declares neither ./package.json nor a require
  // condition, so CJS require.resolve fails both spellings; ESM resolution
  // honors the import condition and lands on dist/index.js.
  for (const spec of ['@earendil-works/pi-ai', '@earendil-works/pi-ai/compat']) {
    try {
      const resolved = import.meta.resolve(spec)
      const url = new URL(resolved)
      if (!url.pathname.endsWith('.js')) continue
      const dir = join(fileURLToPath(new URL('.', url)), 'providers', 'data')
      if (existsSync(dir)) return dir
    } catch {
      // try the next specifier shape
    }
  }
  log.warn('model-capabilities: could not locate the installed pi-ai catalog; that source stays silent')
  return undefined
}

/**
 * Read every provider JSON in a pi-ai `providers/data` directory into one
 * id-keyed capabilities table. File shape: `{ "<api>": { "<modelId>": entry } }`.
 * @param {string} dir
 * @param {string} sourceLabel
 * @param {import('@deepseek-ai/cordis').Logger} log
 */
function readPiAiDataDir(dir, sourceLabel, log) {
  const byId = new Map()
  let files = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch (error) {
    log.warn(`model-capabilities: cannot list ${dir} (${error.message}); ${sourceLabel} silent`)
    return byId
  }
  for (const file of files) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    for (const models of Object.values(parsed)) {
      if (typeof models !== 'object' || models === null) continue
      for (const [id, entry] of Object.entries(models)) {
        if (typeof entry !== 'object' || entry === null) continue
        const caps = piAiEntryToCapabilities(entry, sourceLabel)
        if (caps === undefined) continue
        // Aggregators (opencode.json, token-plan files) shadow upstream ids
        // with sparse gateway entries; when an id repeats, keep whichever
        // entry carries more capability fields. Ties keep the first.
        const incumbent = byId.get(id)
        if (incumbent === undefined || capabilityScore(caps) > capabilityScore(incumbent)) {
          byId.set(id, caps)
        }
      }
    }
  }
  return byId
}

/** How many capability fields one converted entry actually carries. */
function capabilityScore(caps) {
  let score = 0
  for (const field of ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat']) {
    if (caps[field] !== undefined) score += 1
  }
  return score
}

/**
 * Fetch the latest pi-ai catalog from npmmirror into the cache dir and read
 * it. Cached by version + fetch time; failures negative-cached for an hour.
 * @param {string} cacheDir
 * @param {import('@deepseek-ai/cordis').Logger} log
 * @returns {Promise<Map<string, import('./capabilities.js').ModelCapabilities>>}
 */
export async function fetchLatestPiAi(cacheDir, log) {
  const manifestPath = join(cacheDir, 'pi-ai-latest.json')
  const manifest = readJson(manifestPath)
  const now = Date.now()
  if (manifest !== undefined && typeof manifest.fetchedAt === 'number') {
    if (manifest.failed === true) {
      if (now - manifest.fetchedAt < FAILURE_TTL_MS) return new Map()
    } else if (now - manifest.fetchedAt < CATALOG_TTL_MS && existsSync(manifest.dataDir)) {
      return readPiAiDataDir(manifest.dataDir, `pi-ai ${manifest.version ?? ''}`.trim(), log)
    }
  }
  try {
    mkdirSync(cacheDir, { recursive: true })
    const { stdout } = await run('curl', ['-sSL', '--max-time', '30',
      'https://registry.npmmirror.com/@earendil-works/pi-ai/latest'], { maxBuffer: 1 << 20 })
    const meta = JSON.parse(stdout)
    const version = meta.version
    const tarball = meta.dist?.tarball
    if (typeof version !== 'string' || typeof tarball !== 'string') throw new Error('registry metadata incomplete')
    const extractDir = join(cacheDir, `pi-ai-${version}`)
    if (!existsSync(join(extractDir, 'package', 'dist', 'providers', 'data'))) {
      const tgz = join(cacheDir, `pi-ai-${version}.tgz`)
      await run('curl', ['-sSL', '--max-time', '180', '-o', tgz, tarball])
      mkdirSync(extractDir, { recursive: true })
      await run('tar', ['-xzf', tgz, '-C', extractDir,
        'package/dist/providers/data'], { cwd: cacheDir })
    }
    writeJson(manifestPath, { fetchedAt: now, version, dataDir: join(extractDir, 'package', 'dist', 'providers', 'data') })
    return readPiAiDataDir(join(extractDir, 'package', 'dist', 'providers', 'data'), `pi-ai ${version}`, log)
  } catch (error) {
    writeJson(manifestPath, { fetchedAt: now, failed: true, error: String(error.message ?? error).slice(0, 200) })
    log.warn(`model-capabilities: latest pi-ai catalog unavailable (${error.message}); source silent this scan`)
    return new Map()
  }
}

/**
 * Fetch the models.dev aggregate model list (single JSON, cached 24h).
 * @param {string} cacheDir
 * @param {import('@deepseek-ai/cordis').Logger} log
 * @returns {Promise<Map<string, import('./capabilities.js').ModelCapabilities>>}
 */
export async function fetchModelsDev(cacheDir, log) {
  const dataPath = join(cacheDir, 'models-dev.json')
  const manifestPath = join(cacheDir, 'models-dev.meta.json')
  const manifest = readJson(manifestPath)
  const now = Date.now()
  const fresh = manifest !== undefined && typeof manifest.fetchedAt === 'number'
    && (manifest.failed === true ? now - manifest.fetchedAt < FAILURE_TTL_MS : now - manifest.fetchedAt < CATALOG_TTL_MS)
    && (manifest.failed === true || existsSync(dataPath))
  if (fresh) {
    if (manifest.failed === true) return new Map()
    return buildModelsDevTable(readJson(dataPath))
  }
  try {
    mkdirSync(cacheDir, { recursive: true })
    const { stdout } = await run('gh', ['api', 'repos/sst/models.dev/contents/models.json',
      '-H', 'Accept: application/vnd.github.raw'], { maxBuffer: 16 << 20 })
    const parsed = JSON.parse(stdout)
    writeFileSync(dataPath, JSON.stringify(parsed))
    writeJson(manifestPath, { fetchedAt: now })
    return buildModelsDevTable(parsed)
  } catch (error) {
    writeJson(manifestPath, { fetchedAt: now, failed: true, error: String(error.message ?? error).slice(0, 200) })
    log.warn(`model-capabilities: models.dev unavailable (${error.message}); source silent this scan`)
    return new Map()
  }
}

/** models.dev aggregate → id-keyed table keyed by the bare model id (slug suffix). */
function buildModelsDevTable(parsed) {
  const byId = new Map()
  const data = typeof parsed === 'object' && parsed !== null ? parsed.data : undefined
  if (!Array.isArray(data)) return byId
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string') continue
    const bare = entry.id.includes('/') ? entry.id.slice(entry.id.indexOf('/') + 1) : entry.id
    const caps = modelsDevEntryToCapabilities(entry)
    if (caps !== undefined && !byId.has(bare)) byId.set(bare, caps)
  }
  return byId
}

/**
 * The whole chain for one model id, in priority order. Sources arrive as a
 * lazy factory so network tiers are only touched when a gap actually needs
 * them and an earlier tier did not answer.
 * @param {string} id - configured model id.
 * @param {Map<string, import('./capabilities.js').ModelCapabilities>} overrides
 * @param {(tier: 'latest-pi-ai'|'models-dev') => Promise<Map<string, import('./capabilities.js').ModelCapabilities>>} lazy
 *   factory for the network tiers; called at most once per tier per scan.
 * @param {import('@deepseek-ai/cordis').Logger} log
 * @returns {Promise<import('./capabilities.js').ModelCapabilities|undefined>}
 */
export async function resolveCapabilities(id, overrides, lazy, log) {
  const hit = matchById(overrides, id)
  if (hit !== undefined) return hit
  const latest = await lazy('latest-pi-ai')
  const latestHit = matchById(latest, id)
  if (latestHit !== undefined) return latestHit
  const modelsDev = await lazy('models-dev')
  const devHit = matchById(modelsDev, id)
  if (devHit !== undefined) return devHit
  return undefined
}

/** Read JSON, or undefined for absent/corrupt. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Best-effort JSON write; cache write failures are non-fatal. */
function writeJson(path, value) {
  try {
    writeFileSync(path, JSON.stringify(value))
  } catch {
    // Cache persistence is best-effort; the in-memory answer still serves.
  }
}
