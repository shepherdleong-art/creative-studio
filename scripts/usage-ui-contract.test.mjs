import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const header = read('components/Header.tsx');
const page = read('app/usage/page.tsx');
const dashboard = read('components/UsageDashboard.tsx');
const settings = read('app/settings/page.tsx');
const imageUpdate = read('app/api/providers/[id]/route.ts');
const scriptUpdate = read('app/api/providers/script/[id]/route.ts');
const ttsUpdate = read('app/api/providers/tts/[id]/route.ts');

assert.match(header, /href=["']\/usage["'][^>]*>消耗</, 'top navigation must expose the usage dashboard');
assert.match(page, /UsageDashboard/, '/usage must render the dashboard client');

for (const label of ['今日', '本周', '本月', '模型消耗排行', '近 30 天', '调用流水']) {
  assert.ok(dashboard.includes(label), `dashboard must include ${label}`);
}
assert.match(dashboard, /非上游真实账单/, 'dashboard must keep the fixed estimate disclaimer');
assert.match(dashboard, /\/api\/usage(?:\?|['"`])/, 'dashboard must load the aggregate API');
assert.match(dashboard, /\/api\/usage\/records/, 'dashboard must load paged records');
assert.match(dashboard, /type=["']date["']/, 'dashboard must provide a date filter');
assert.match(dashboard, /coreModelKey/, 'dashboard must provide a core-model filter');
assert.match(dashboard, /category/, 'dashboard must provide a category filter');
assert.match(dashboard, /<svg/, '30-day trend must use dependency-free SVG');
assert.match(dashboard, /input_token|inputTokens/, 'LLM rows must expose input token details');
assert.match(dashboard, /cached_input_token|cachedReadTokens/, 'LLM rows must expose cached token details');
assert.match(dashboard, /uncachedInputTokens/, 'LLM input details must prefer billable uncached input tokens');
assert.match(dashboard, /reloadNonce|setReloadNonce/, 'reload must force a fresh request even when filters are unchanged');
assert.match(dashboard, /minimumFractionDigits:\s*2/, 'RMB formatting must keep at least two decimals');
assert.match(dashboard, /maximumFractionDigits:\s*6/, 'RMB formatting must preserve micro-costs up to six decimals');

assert.doesNotMatch(settings, /usageTrackingEnabled|计入消耗看板/, 'settings must not expose a tracking switch');
assert.match(settings, /company-gateway-image2-medium/, 'settings must recognize the fixed-price company image provider');
assert.match(settings, /doubao-seed-tts-2/, 'settings must recognize fixed-price Doubao TTS');
assert.match(settings, /providerId/, 'provider edit form must know which stable provider is being edited');
assert.match(settings, /固定单价由后台计算/, 'core cards must explain that price is backend-managed');

const imageIdentityHelper = settings.match(/function isFixedImageProvider[\s\S]*?\n}/)?.[0] || '';
assert.match(imageIdentityHelper, /type/, 'image fixed-price UI must inspect effective provider type');
assert.match(imageIdentityHelper, /model/, 'image fixed-price UI must inspect effective provider model');

const lunaIdentityHelper = settings.match(/function isFixedCompanyLuna[\s\S]*?\n}/)?.[0] || '';
assert.match(lunaIdentityHelper, /apiStyle/, 'company Luna UI identity must inspect effective API style');
assert.match(lunaIdentityHelper, /type/, 'company Luna UI identity must inspect effective provider type');
assert.match(lunaIdentityHelper, /openai-compatible/, 'company Luna UI identity must require the canonical protocol');

const ttsIdentityHelper = settings.match(/function isFixedDoubaoTts[\s\S]*?\n}/)?.[0] || '';
assert.match(ttsIdentityHelper, /type/, 'Doubao fixed-price UI must inspect effective provider type');
assert.match(ttsIdentityHelper, /model/, 'Doubao fixed-price UI must inspect effective provider model');

assert.match(imageUpdate, /isFixedImageIdentity/, 'image update API must gate manual prices by the complete image identity');
assert.match(imageUpdate, /effectiveType/, 'image update API must evaluate the effective provider type');
assert.match(imageUpdate, /effectiveModel/, 'image update API must evaluate the effective provider model');
assert.match(imageUpdate, /effectiveType\s*===\s*['"]gateway-task-image['"]/, 'image update API must require the canonical image adapter');
assert.match(imageUpdate, /effectiveModel\s*===\s*['"]image2-medium['"]/, 'image update API must require the canonical image model');
assert.match(scriptUpdate, /id\s*!==\s*['"]gpt['"]/, 'non-core GPT providers must keep the legacy editable cost field');
assert.match(scriptUpdate, /effectiveExecutionScope/, 'script update must use the request/current effective execution scope');
assert.match(scriptUpdate, /effectiveApiStyle/, 'script update must use the request/current effective API style');
assert.match(scriptUpdate, /effectiveModel/, 'script update must use the request/current effective model');
assert.match(scriptUpdate, /isFixedCompanyLuna/, 'only the complete company Luna identity may ignore vision cost');
assert.match(ttsUpdate, /isFixedDoubaoIdentity/, 'Doubao update API must gate manual prices by the complete TTS identity');
assert.match(ttsUpdate, /current\.type\s*===\s*['"]doubao-http-chunked['"]/, 'Doubao update API must require the canonical adapter');
assert.match(ttsUpdate, /current\.model\s*===\s*['"]seed-tts-2\.0['"]/, 'Doubao update API must require the canonical model');
assert.doesNotMatch(dashboard, /等待后台对账/, 'uncertain calls are terminal and must not be described as awaiting reconciliation');
assert.match(dashboard, /无法确认，未计入金额/, 'dashboard must explain that uncertain calls are excluded from totals');

console.log('usage UI contract tests passed');
