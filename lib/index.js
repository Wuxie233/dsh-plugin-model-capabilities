/**
 * model-capabilities — a background daemon that completes capability fields
 * on `llm-pi-ai` model entries in user settings.
 *
 * When a route lists a model whose capability fields (contextWindow,
 * maxTokens, input, reasoningEfforts, compat) are missing, the daemon fills
 * exactly those fields from a source chain — local overrides file, the latest
 * pi-ai npm catalog, the installed pi-ai catalog, models.dev — and writes the
 * completed entries back through the settings service, so llm-pi-ai's own
 * `assertServiceable` validation gates every write and the running routes
 * hot-reload. Fields already present in settings are never touched.
 *
 * Triggers: startup (once the llm-pi-ai namespace registers), every
 * `settings/document-updated` for that namespace (debounced), and a slow
 * periodic rescan so newly catalogued models are picked up later.
 * @module dsh-plugin-model-capabilities
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace, SettingsConflictError } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { missingFields, fillMissing } from './capabilities.js'
import {
  fetchLatestPiAi,
  fetchModelsDev,
  readInstalledPiAi,
  readOverrides,
  resolveCapabilities,
} from './sources.js'

/** Plugin id (cordis patch-row `id`). */
export const name = 'model-capabilities'

/** The settings namespace this daemon reads and completes. */
const NS = settingsNamespace('llm-pi-ai')

/** Debounce between a settings event and the scan it schedules. */
const SCAN_DEBOUNCE_MS = 5000

/** Startup poll cadence while waiting for the llm-pi-ai namespace. */
const SETTLE_POLL_MS = 3000

/** Startup poll budget: ~5 minutes, then event/periodic triggers only. */
const SETTLE_POLL_MAX = 100

export const Config = z.object({
  /** Hours between periodic rescans (pick up newly catalogued models). */
  scanIntervalHours: z.number().default(12),
  /** Overrides file: highest-priority manual capability facts, JSON. */
  overridesPath: z.string().default(join(homedir(), '.dsh', 'model-capabilities.overrides.json')),
  /** Cache directory for fetched catalogs (large-disk path recommended). */
  cacheDir: z.string().default('/flyshop/opencode/cache/dsh-model-caps'),
  /** Whether the network tiers (latest pi-ai, models.dev) may fetch. */
  enableNetworkSources: z.boolean().default(true),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{scanIntervalHours: number, overridesPath: string, cacheDir: string, enableNetworkSources: boolean}} config
 */
export function apply(ctx, config) {
  const overridesPath = config?.overridesPath ?? join(homedir(), '.dsh', 'model-capabilities.overrides.json')
  const cacheDir = config?.cacheDir ?? '/flyshop/opencode/cache/dsh-model-caps'
  const enableNetworkSources = config?.enableNetworkSources !== false
  const scanIntervalHours = Number(config?.scanIntervalHours) > 0 ? Number(config.scanIntervalHours) : 12
  ctx.inject(['settings'], (settingsCtx) => {
    const log = ctx.logger
    let inFlight = false
    let retryOnce = true
    let pending = undefined

    /** Current raw llm-pi-ai descriptor, when the namespace is registered. */
    const descriptor = () => settingsCtx.settings.describe().find(d => d.ns === NS)

    const schedule = (reason) => {
      if (pending !== undefined) return
      pending = setTimeout(() => {
        pending = undefined
        void scan(reason)
      }, SCAN_DEBOUNCE_MS)
      pending.unref?.()
    }
    ctx.effect(() => () => { if (pending !== undefined) clearTimeout(pending) }, 'model-capabilities: debounce timer')

    /**
     * One scan: read the raw user section, fill missing capability fields,
     * write back through the settings service when anything changed.
     * @param {string} reason - trigger label for the log.
     */
    const scan = async (reason) => {
      if (inFlight) {
        schedule(`${reason} (busy)`)
        return
      }
      inFlight = true
      try {
        const desc = descriptor()
        const user = desc?.user
        if (desc === undefined || typeof user !== 'object' || user === null) return
        const providers = user.providers
        if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return

        const overrides = readOverrides(overridesPath, log)
        const installed = readInstalledPiAi(log)
        const tiers = new Map()
        /**
         * Lazy tier loader; network tiers are only touched when a gap reaches
         * them. The pi-ai tier merges latest-over-installed per model id, so
         * the chain reads overrides → pi-ai (newest first) → models.dev.
         */
        const lazy = async (tier) => {
          if (tiers.has(tier)) return tiers.get(tier)
          let table = new Map()
          if (enableNetworkSources) {
            table = tier === 'latest-pi-ai'
              ? await fetchLatestPiAi(cacheDir, log)
              : await fetchModelsDev(cacheDir, log)
          }
          if (tier === 'latest-pi-ai') {
            for (const [id, caps] of installed) {
              if (!table.has(id)) table.set(id, caps)
            }
          }
          tiers.set(tier, table)
          return table
        }

        const nextProviders = { ...providers }
        let changed = false
        for (const [route, sectionRaw] of Object.entries(providers)) {
          if (typeof sectionRaw !== 'object' || sectionRaw === null) continue
          const models = sectionRaw.models
          if (!Array.isArray(models)) continue
          const routeApi = typeof sectionRaw.api === 'string' ? sectionRaw.api : undefined
          let routeChanged = false
          const nextModels = await Promise.all(models.map(async model => {
            if (typeof model !== 'object' || model === null || typeof model.id !== 'string' || model.id === '') return model
            const miss = missingFields(model, routeApi)
            if (miss.length === 0) return model
            const caps = await resolveCapabilities(model.id, overrides, lazy, log)
            if (caps === undefined) return model
            const { model: next, filled } = fillMissing(model, caps, miss)
            if (filled.length === 0) return model
            routeChanged = true
            log.info(`model-capabilities: ${route}/${model.id} <- ${caps.source}: ${filled.join(', ')}`)
            return next
          }))
          if (routeChanged) {
            nextProviders[route] = { ...sectionRaw, models: nextModels }
            changed = true
          }
        }
        if (!changed) return

        try {
          await settingsCtx.settings.mutate(NS,
            [{ op: 'set', path: ['providers'], value: nextProviders }], desc.revision)
        } catch (error) {
          if (error instanceof SettingsConflictError) {
            // Another writer moved the namespace between read and write; one
            // immediate rescan converges on the newer document.
            if (retryOnce) {
              retryOnce = false
              schedule(`${reason} (conflict)`)
            } else {
              log.warn('model-capabilities: write conflicted twice; waiting for next event')
            }
            return
          }
          log.error(`model-capabilities: write refused (${error.message}); nothing stored`)
          return
        }
        retryOnce = true
      } catch (error) {
        log.error(`model-capabilities: scan failed (${error.message})`)
      } finally {
        inFlight = false
      }
    }

    // Startup: wait for the llm-pi-ai namespace to register (load order
    // between plugins is unconstrained), then run the first scan.
    let polls = 0
    const settle = setInterval(() => {
      polls += 1
      if (descriptor() !== undefined) {
        clearInterval(settle)
        void scan('startup')
      } else if (polls >= SETTLE_POLL_MAX) {
        clearInterval(settle)
      }
    }, SETTLE_POLL_MS)
    settle.unref?.()
    ctx.effect(() => () => clearInterval(settle), 'model-capabilities: settle poll')

    // Live changes: any llm-pi-ai document update (user edit, web Models
    // page, our own write) re-scans; our writes converge to a no-op.
    ctx.effect(() => settingsCtx.on('settings/document-updated', (ns) => {
      if (ns === NS) schedule('settings-updated')
    }), 'model-capabilities: settings listener')

    // Slow periodic rescan: picks up models whose sources gained data later.
    const period = setInterval(() => { void scan('periodic') },
      scanIntervalHours * 3600 * 1000)
    period.unref?.()
    ctx.effect(() => () => clearInterval(period), 'model-capabilities: periodic scan')
  })
}
