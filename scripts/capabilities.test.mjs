/**
 * Keyless regression for capability merge: an existing openai-completions
 * compat that names thinkingFormat zai but omits supportsDeveloperRole must
 * receive false without replacing the rest of the object.
 */
import { missingFields, fillMissing, piAiEntryToCapabilities } from '../lib/capabilities.js'

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const glm = {
  id: 'glm-5.3-flash',
  name: 'GLM-5.3-Flash',
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  input: ['text', 'image'],
  reasoningEfforts: { max: 'max' },
  compat: { thinkingFormat: 'zai', supportsReasoningEffort: true },
}

const miss = missingFields(glm, 'openai-completions')
assert(miss.includes('compat.supportsDeveloperRole'), `expected developer-role gap, got ${miss.join(',')}`)
assert(!miss.includes('compat'), 'whole compat object is already present')

const { model, filled } = fillMissing(glm, { source: 'implied-zai' }, miss)
assert(filled.includes('compat.supportsDeveloperRole'), `filled ${filled.join(',')}`)
assert(model.compat.thinkingFormat === 'zai', 'must keep thinkingFormat')
assert(model.compat.supportsReasoningEffort === true, 'must keep supportsReasoningEffort')
assert(model.compat.supportsDeveloperRole === false, 'zai implies no developer role')

const whole = fillMissing(
  { id: 'glm-new', name: 'GLM', contextWindow: 1, maxTokens: 1, input: ['text'], reasoningEfforts: { max: 'max' } },
  { source: 'pi-ai', compat: { thinkingFormat: 'zai', supportsReasoningEffort: true } },
  ['compat'],
)
assert(whole.model.compat.thinkingFormat === 'zai', 'whole-compat fill keeps thinkingFormat')
assert(whole.model.compat.supportsDeveloperRole === false, 'whole-compat zai fill also sets developer-role false')

const catalog = piAiEntryToCapabilities({
  id: 'glm-5.2',
  api: 'openai-completions',
  name: 'GLM-5.2',
  compat: { thinkingFormat: 'zai', supportsDeveloperRole: false, supportsReasoningEffort: true },
}, 'pi-ai(installed)')
assert(catalog?.compat?.supportsDeveloperRole === false, 'catalog conversion must carry the switch')

const explicitTrue = fillMissing(
  glm,
  { source: 'overrides', compat: { thinkingFormat: 'zai', supportsDeveloperRole: true } },
  miss,
)
assert(explicitTrue.model.compat.supportsDeveloperRole === true, 'explicit true still wins')

const grok = {
  id: 'grok-4.6',
  name: 'Grok 4.6',
  contextWindow: 500_000,
  maxTokens: 500_000,
  input: ['text', 'image'],
  reasoningEfforts: { xhigh: 'xhigh' },
  compat: { supportsReasoningEffort: true },
}
const grokMiss = missingFields(grok, 'openai-completions')
assert(grokMiss.includes('compat.supportsDeveloperRole'), 'grok still reports the gap')
const grokFill = fillMissing(grok, { source: 'overrides', compat: { supportsReasoningEffort: true } }, grokMiss)
assert(grokFill.filled.length === 0, 'non-zai gap without a source fact stays untouched')

console.log('ok')
