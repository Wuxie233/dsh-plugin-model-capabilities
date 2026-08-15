/**
 * Pure capability-facts logic: what "missing" means on a configured model
 * entry, how a source's facts fill exactly those missing fields, and how each
 * source's native entry shape converts to the common capabilities record.
 *
 * Everything here is side-effect free; the daemon in index.js owns IO.
 * @module dsh-plugin-model-capabilities/capabilities
 */

/** Capability fields this plugin may fill (everything on a model entry but `id`). */
export const CAPABILITY_FIELDS = ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat']

/** Request modalities the llm-pi-ai schema accepts. */
const KNOWN_MODALITIES = new Set(['text', 'image'])

/**
 * One model's capability facts in settings.yaml `models[]` entry shape.
 * `source` is provenance for the log line, never written to settings.
 * @typedef {Object} ModelCapabilities
 * @property {string} [name]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {string[]} [input]
 * @property {Record<string, string>} [reasoningEfforts]
 * @property {{thinkingFormat?: string, supportsReasoningEffort?: boolean}} [compat]
 * @property {string} source
 */

/**
 * Capability fields missing (absent or empty) on one configured model entry.
 *
 * `compat` is reported missing only for openai-completions routes: the
 * llm-pi-ai config resolution rejects a model-level compat switch on any other
 * protocol, so filling it there would break the whole write.
 * @param {Record<string, unknown>} model - raw user-layer model entry.
 * @param {string|undefined} routeApi - the route's `api` protocol, when set.
 * @returns {string[]} missing capability field names.
 */
export function missingFields(model, routeApi) {
  const missing = []
  if (typeof model.name !== 'string' || model.name === '') missing.push('name')
  if (typeof model.contextWindow !== 'number') missing.push('contextWindow')
  if (typeof model.maxTokens !== 'number') missing.push('maxTokens')
  if (!Array.isArray(model.input) || model.input.length === 0) missing.push('input')
  const efforts = model.reasoningEfforts
  if (efforts !== false && (efforts === undefined || efforts === null
    || (typeof efforts === 'object' && !Array.isArray(efforts) && Object.keys(efforts).length === 0))) {
    missing.push('reasoningEfforts')
  }
  if (model.compat === undefined || model.compat === null) {
    if (routeApi === undefined || routeApi === 'openai-completions') missing.push('compat')
  }
  return missing
}

/**
 * Fill only the wanted missing fields from source capabilities. Fields the
 * entry already carries are never overwritten — the plugin's core safety
 * property: user-written values always win over source data.
 * @param {Record<string, unknown>} model - raw user-layer model entry.
 * @param {ModelCapabilities} caps - source facts.
 * @param {readonly string[]} wantMissing - fields to fill, from {@link missingFields} on the same entry.
 * @returns {{model: Record<string, unknown>, filled: string[]}} next entry (same reference when
 *   nothing changed) plus the field names actually filled.
 */
export function fillMissing(model, caps, wantMissing) {
  const filled = []
  let next = model
  const set = (field, value) => {
    if (value === undefined || !wantMissing.includes(field)) return
    if (field === 'reasoningEfforts' && !hasUsableEfforts(value)) return
    if (field === 'compat' && Object.keys(value).length === 0) return
    if (next === model) next = { ...model }
    next[field] = value
    filled.push(field)
  }
  set('name', caps.name)
  set('contextWindow', caps.contextWindow)
  set('maxTokens', caps.maxTokens)
  set('input', caps.input)
  set('reasoningEfforts', caps.reasoningEfforts)
  set('compat', caps.compat)
  return { model: next, filled }
}

/**
 * A reasoning-efforts dict must offer at least one level besides `off` with a
 * non-empty string wire value — the llm-pi-ai schema refuses anything less.
 * @param {Record<string, unknown>} efforts
 * @returns {boolean}
 */
function hasUsableEfforts(efforts) {
  if (efforts === undefined || typeof efforts !== 'object' || efforts === null) return false
  return Object.entries(efforts).some(([level, wire]) =>
    level !== 'off' && typeof wire === 'string' && wire.length > 0)
}

/**
 * Convert one pi-ai catalog model entry (dist/providers/data/*.json) into
 * capabilities. Only `openai-completions` entries yield `compat` — those
 * switches are protocol-specific and meaningless (or rejected) elsewhere.
 * @param {Record<string, unknown>} entry - pi-ai catalog model entry.
 * @param {string} sourceLabel - provenance label for logs.
 * @returns {ModelCapabilities|undefined} capabilities with at least one fillable field.
 */
export function piAiEntryToCapabilities(entry, sourceLabel) {
  const caps = { source: sourceLabel }
  if (typeof entry.name === 'string' && entry.name.length > 0) caps.name = entry.name
  if (positiveInt(entry.contextWindow)) caps.contextWindow = entry.contextWindow
  if (positiveInt(entry.maxTokens)) caps.maxTokens = entry.maxTokens
  const input = filterModalities(entry.input)
  if (input.length > 0) caps.input = input
  const efforts = effortsFromThinkingLevelMap(entry.thinkingLevelMap, entry.reasoning === true)
  if (efforts !== undefined) caps.reasoningEfforts = efforts
  if (entry.api === 'openai-completions' && isPlainObject(entry.compat)) {
    const compat = {}
    if (typeof entry.compat.thinkingFormat === 'string') compat.thinkingFormat = entry.compat.thinkingFormat
    if (typeof entry.compat.supportsReasoningEffort === 'boolean') {
      compat.supportsReasoningEffort = entry.compat.supportsReasoningEffort
    }
    if (Object.keys(compat).length > 0) caps.compat = compat
  }
  // Self-consistency: an entry whose compat says the endpoint takes no
  // `reasoning_effort` must not also offer effort levels — the picker would
  // show levels dispatch never sends.
  if (caps.compat?.supportsReasoningEffort === false) delete caps.reasoningEfforts
  const fillable = CAPABILITY_FIELDS.some(field => caps[field] !== undefined)
  return fillable ? caps : undefined
}

/**
 * Translate a pi-ai `thinkingLevelMap` into the settings `reasoningEfforts`
 * spelling: pi-ai null pins a level as unsupported (absent from the dict we
 * emit), string values carry their wire spelling. Entries whose map is absent
 * yield nothing — levels are a fact we refuse to guess.
 * @param {unknown} map - raw thinkingLevelMap.
 * @param {boolean} reasoning - whether the catalog marks the model as reasoning.
 * @returns {Record<string, string>|undefined}
 */
function effortsFromThinkingLevelMap(map, reasoning) {
  if (!reasoning || !isPlainObject(map)) return undefined
  const efforts = {}
  for (const [level, wire] of Object.entries(map)) {
    if (typeof wire === 'string' && wire.length > 0) efforts[level] = wire
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined
}

/**
 * Convert one models.dev aggregate entry (models.json `data[]`) into
 * capabilities. The aggregate carries no reasoning-effort wiring and no
 * protocol compat — those come only from pi-ai or local overrides.
 * @param {Record<string, unknown>} entry - models.dev aggregate model entry.
 * @returns {ModelCapabilities|undefined}
 */
export function modelsDevEntryToCapabilities(entry) {
  const caps = { source: 'models.dev' }
  if (typeof entry.name === 'string' && entry.name.length > 0) {
    caps.name = entry.name.replace(/^[^:]+:\s*/, '')
  }
  const top = isPlainObject(entry.top_provider) ? entry.top_provider : {}
  if (positiveInt(entry.context_length)) caps.contextWindow = entry.context_length
  else if (positiveInt(top.context_length)) caps.contextWindow = top.context_length
  if (positiveInt(top.max_completion_tokens)) caps.maxTokens = top.max_completion_tokens
  const arch = isPlainObject(entry.architecture) ? entry.architecture : {}
  const input = filterModalities(arch.input_modalities)
  if (input.length > 0) caps.input = input
  const fillable = CAPABILITY_FIELDS.some(field => caps[field] !== undefined)
  return fillable ? caps : undefined
}

/**
 * Find entries for one model id in an id-keyed source table: exact match
 * first, then a unique case-insensitive match. Ambiguous matches answer
 * undefined — the caller logs and treats the source as silent.
 * @param {Map<string, T>} byId - source table keyed by exact id.
 * @param {string} id - configured model id.
 * @returns {T|undefined}
 * @template T
 */
export function matchById(byId, id) {
  const exact = byId.get(id)
  if (exact !== undefined) return exact
  const lower = id.toLowerCase()
  let found
  let hits = 0
  for (const [key, value] of byId) {
    if (key.toLowerCase() === lower) {
      found = value
      hits += 1
      if (hits > 1) return undefined
    }
  }
  return hits === 1 ? found : undefined
}

/** Keep only known request modalities from a raw list. */
function filterModalities(raw) {
  if (!Array.isArray(raw)) return []
  const kept = raw.filter(m => typeof m === 'string' && KNOWN_MODALITIES.has(m))
  return kept.length > 0 ? kept : []
}

/** A positive integer, or undefined. */
function positiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Plain-object check shared by all converters. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
