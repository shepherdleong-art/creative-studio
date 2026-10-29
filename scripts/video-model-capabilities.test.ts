import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-model-capabilities-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Capability resolution must not perform network I/O'); };
try {
  const { getVideoModelCapabilities, describeVideoProvider } = await import('../lib/video-model-capabilities.ts');
  const { resolveVideoGenerationSelection } = await import('../lib/video-generation-options.ts');
  const { getVideoMotionRowIssue, createVideoMotionRow } = await import('../components/video-tail-frame-state.ts');
  const provider = (id: string, type: string, model: string) => describeVideoProvider({
    id, name: id, type, defaultModel: model, defaultDurationSec: 10,
    baseUrlEnv: '', apiKeyEnv: '', baseUrl: 'http://invalid.test', apiKey: 'test-key',
  });
  // All provider fixtures have IDs/names; the projection deliberately also supports partial configs.
  const providers = [
    provider('sd25', 'openai-video', 'doubao-seedance-2-5-260628'),
    provider('sd20', 'openai-video', 'doubao-seedance-2-0-260128'),
    provider('k25', 'openai-video', 'kling-2.5'),
    provider('q30', 'openai-video', 'qiniuyun/kling-3.0'),
    provider('future', 'openai-video', 'kling-3.0-future'),
  ].map(p => ({ ...p, id: p.id!, name: p.name! }));
  const resolve = (providerId: string, durationSec: number, multiShot = false) =>
    resolveVideoGenerationSelection(providers, '', { providerId, durationSec, multiShot });
  for (const [id, duration] of [['sd25', 30], ['sd20', 15], ['k25', 10], ['q30', 15], ['future', 15]] as const) {
    const selected = resolve(id, 30);
    assert.equal(selected.durationSec, duration);
    assert.ok(selected.capabilities.durations.includes(selected.durationSec));
  }
  assert.equal(resolve('k25', 7.5).durationSec, 5, 'ties retain the lower legal duration');
  assert.equal(resolve('k25', NaN).durationSec, 5);
  assert.equal(resolveVideoGenerationSelection(providers, '', { providerId: 'sd25' }).durationSec, 5,
    'panel draft default remains five seconds even with a ten-second provider setting');
  assert.deepEqual(resolve('q30', 5).requestOptions, { durationSec: 5, multiShot: false });
  assert.deepEqual(resolveVideoGenerationSelection(providers, '', { providerId: 'q30' }).requestOptions,
    { durationSec: 5, multiShot: true });
  assert.equal('multiShot' in resolve('sd20', 5).requestOptions, false);
  // A false preference survives switching away and back; unsupported requests omit the field.
  const draft = { providerId: 'q30', durationSec: 30, multiShot: false };
  for (const id of ['k25', 'q30']) {
    draft.providerId = id;
    const selection = resolveVideoGenerationSelection(providers, '', draft);
    draft.durationSec = selection.durationSec;
    if (id === 'q30') assert.equal(selection.requestOptions.multiShot, false);
    else assert.equal('multiShot' in selection.requestOptions, false);
  }
  assert.equal(resolveVideoGenerationSelection(providers, 'sd25', { providerId: '' }).providerId, 'sd25');
  assert.equal(resolveVideoGenerationSelection(providers, '', { providerId: '' }).providerId, 'k25');
  assert.equal(resolveVideoGenerationSelection(providers, 'sd25', { providerId: 'removed' }).providerId, 'removed');
  assert.equal(resolveVideoGenerationSelection(providers.map(p => ({ ...p, configured: false })), 'sd25', { providerId: 'q30' }).providerId, 'q30');

  for (const [type, model, expected, protocol] of [
    ['jimeng', 'doubao-seedance-2-0-260128', true, 'ark-content-roles'],
    ['jimeng', 'doubao-seedance-2-0-260128-fast', false, undefined],
    ['openai-video', 'kling-2.5', true, 'company-gateway-kling'],
    ['openai-video', 'kling-3.0', true, 'company-gateway-kling'],
    ['openai-video', 'qiniuyun/kling-3.0', true, 'company-gateway-qiniuyun-kling'],
    ['openai-video', 'kling-3.0-future', false, undefined],
    ['openai-video', 'KLING-3.0', false, undefined],
    ['openai-video', 'qiniuyun/kling-3.0-future', false, undefined],
    ['kling', 'kling-3.0', false, undefined],
    ['unknown', 'kling-3.0', false, undefined],
  ] as const) {
    const caps = getVideoModelCapabilities(type, model);
    assert.equal(caps.tailFrame.supported, expected, `${type}/${model}`);
    assert.equal(caps.tailFrame.protocol, protocol);
  }
  const tailDraft = { ...createVideoMotionRow('row', 30), prompt: 'test', tailImageId: 'tail' };
  assert.equal(getVideoMotionRowIssue(tailDraft, resolve('k25', 30).capabilities.tailFrame), null);
  assert.match(getVideoMotionRowIssue(tailDraft, resolve('future', 30).capabilities.tailFrame)!, /尚未核验/);
  assert.equal(tailDraft.tailImageId, 'tail', 'switching never deletes the human-selected tail frame');

  // Old GET data is still understood without the new snapshot. No model-based tail inference.
  for (const current of providers) {
    const { capabilities: _capabilities, ...legacy } = current;
    void _capabilities;
    const old = resolveVideoGenerationSelection([legacy], '', { providerId: legacy.id, durationSec: 30, multiShot: false });
    assert.deepEqual(old, resolveVideoGenerationSelection([current], '', { providerId: current.id, durationSec: 30, multiShot: false }));
  }
  const noCaps = { id: 'old', name: 'old', type: 'openai-video', defaultModel: 'kling-2.5' };
  const oldSelection = resolveVideoGenerationSelection([noCaps], '', { providerId: 'old', durationSec: 30 });
  assert.equal(oldSelection.durationSec, 10);
  assert.equal(oldSelection.capabilities.tailFrame.supported, false);
  assert.equal('multiShot' in oldSelection.requestOptions, false);
  assert.equal(resolveVideoGenerationSelection([], '', { providerId: '', durationSec: 30 }).durationSec, 15);

  // Import and execute the browser module with a loader that forbids all non-client dependencies.
  execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (!specifier.endsWith('/video-generation-options.ts')
        && !['./video-duration.ts', './company-gateway-video-models.ts'].includes(specifier)) {
        throw new Error('Unexpected client runtime dependency: ' + specifier);
      }
      return nextResolve(specifier, context);
    }});
    const { resolveVideoGenerationSelection } = await import('./lib/video-generation-options.ts');
    if (resolveVideoGenerationSelection([], '', { providerId: '' }).durationSec !== 5) throw new Error('Bad draft');
  `], { cwd: process.cwd(), stdio: 'pipe' });
  console.log('video model capabilities tests passed');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
