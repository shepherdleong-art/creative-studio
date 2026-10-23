import assert from 'node:assert/strict';
import { parseFormulaSettings } from '../lib/batch-production/formula/settings.ts';

const basic = { selections: [{ key: '1:2', copies: 1 }], bgm: { mode: 'none', trackIds: [] } };
const defaults = parseFormulaSettings(basic, ['1:2']);
assert.deepEqual(defaults.timing, { mode: 'reference', scope: 'total', overrideDurationSec: null, speechMarginMs: 120 },
  '旧设置沿用 Excel 参考总长，原声前后默认保留 120ms');
for (const mode of ['reference', 'strict_max', 'fixed'] as const) {
  const timing = { mode, scope: 'body', overrideDurationSec: 16.5, speechMarginMs: 0 };
  assert.deepEqual(parseFormulaSettings({ ...basic, timing }, ['1:2']).timing, timing);
}
for (const timing of [null, { ...defaults.timing, mode: 'unknown' }, { ...defaults.timing, scope: 'clip' },
  { ...defaults.timing, overrideDurationSec: 0 }, { ...defaults.timing, overrideDurationSec: '16' },
  { ...defaults.timing, speechMarginMs: -1 }, { ...defaults.timing, speechMarginMs: 1.5 }, { ...defaults.timing, speed: 2 }]) {
  assert.throws(() => parseFormulaSettings({ ...basic, timing }, ['1:2']), /时长|边距/);
}
console.log('formula timing settings tests passed');
