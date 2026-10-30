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
  const { videoReferenceCapability, validateVideoReferenceRequest } = await import('../lib/video-reference-contract.ts');
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
    provider('h3', 'openai-video', 'minimax-h3'),
    provider('wan', 'openai-video', 'wan-3.0'),
    provider('future', 'openai-video', 'kling-3.0-future'),
  ].map(p => ({ ...p, id: p.id!, name: p.name! }));
  for (const id of ['h3', 'wan']) {
    assert.equal(resolveVideoGenerationSelection(providers, '', { providerId: id }).generationMode, 'reference-to-video');
    assert.equal(resolveVideoGenerationSelection(providers, id, { providerId: '' }).generationMode, 'reference-to-video', 'Bulk defaults use the same mode');
  }
  for (const id of ['sd20', 'sd25', 'k25', 'q30', 'future']) {
    assert.equal(resolveVideoGenerationSelection(providers, 'h3', { providerId: id }).generationMode, 'image-to-video', 'Switching back restores first/tail mode');
  }
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
  assert.equal(resolveVideoGenerationSelection([...providers].reverse(), '', { providerId: '' }).providerId, 'k25',
    'Kling 2.5 remains the initial default regardless of provider listing order');
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
  for (const [type, model, imageCount, mediaCount, minSegment, maxSegment, total, audioOnly, resolution] of [
    ['openai-video', 'minimax-h3', 9, 3, 2, 15, 15, true, '2K'],
    ['openai-video', 'wan-3.0', 10, 5, 1, 15, 15, true, '1080P'],
    ['openai-video', 'doubao-seedance-2-0-260128', 9, 3, 2, 15, 15, false, '1080p'],
    ['openai-video', 'doubao-seedance-2-0-fast-260128', 9, 3, 2, 15, 15, false, '720p'],
    ['openai-video', 'doubao-seedance-2-5-260628', 30, 10, 2, 30, 30, true, '1080p'],
    ['jimeng', 'doubao-seedance-2-0-260128', 9, 3, 2, 15, 15, false, '1080p'],
    ['jimeng', 'doubao-seedance-2-0-fast-260128', 9, 3, 2, 15, 15, false, '720p'],
    ['jimeng', 'doubao-seedance-2-5-260628', 30, 10, 2, 30, 30, true, '1080p'],
  ] as const) {
    const reference = videoReferenceCapability(type, model);
    assert.ok(reference.supported, `${type}/${model}`);
    assert.equal(reference.image.maxCount, imageCount);
    assert.equal(reference.video.maxCount, mediaCount);
    assert.equal(reference.audio.maxCount, mediaCount);
    assert.equal(reference.video.minDurationSec, minSegment);
    assert.equal(reference.video.maxDurationSec, maxSegment);
    assert.equal(reference.video.maxTotalDurationSec, total);
    assert.equal(reference.audio.maxTotalDurationSec, total);
    assert.equal(reference.allowsAudioOnly, audioOnly);
    assert.equal(reference.defaultResolution, resolution);
    assert.deepEqual(JSON.parse(JSON.stringify(reference)), reference, 'reference capability must be serializable');
    assert.deepEqual(getVideoModelCapabilities(type, model).reference, reference);
  }
  const wanReference = videoReferenceCapability('openai-video', 'wan-3.0');
  assert.ok(wanReference.supported);
  assert.deepEqual(wanReference.aspectRatios, ['16:9', '1:1', '3:4', '4:3', '9:16']);
  assert.equal(wanReference.maxReferenceVideoPlusOutputDurationSec, 30);
  assert.deepEqual(wanReference.image.mimeTypes, ['image/jpeg', 'image/png']);
  assert.equal(wanReference.image.maxBytes, 10 * 1024 * 1024);
  for (const [type, model] of [
    ['openai-video', 'kling-2.5'], ['openai-video', 'minimax-h3-max'],
    ['openai-video', 'doubao-seedance-2-0-mini-260128'], ['jimeng', 'kling-v3'],
    ['jimeng', 'doubao-seedance-2-5'], ['kling', 'minimax-h3'], ['unknown', 'wan-3.0'],
  ] as const) {
    assert.equal(videoReferenceCapability(type, model).supported, false, `${type}/${model}`);
    assert.equal(getVideoModelCapabilities(type, model).reference.supported, false);
  }

  const visualAndAudio = [
    { id: 'i', kind: 'image' as const, mimeType: 'image/png', byteSize: 1024, durationSec: null },
    { id: 'v', kind: 'video' as const, mimeType: 'video/mp4', byteSize: 1024, durationSec: 4 },
    { id: 'a', kind: 'audio' as const, mimeType: 'audio/mpeg', byteSize: 1024, durationSec: 3 },
  ];
  assert.deepEqual(validateVideoReferenceRequest({
    providerType: 'openai-video', model: 'minimax-h3', references: visualAndAudio,
    durationSec: 5, aspectRatio: '16:9', resolution: '2K',
  }), []);
  assert.match(validateVideoReferenceRequest({
    providerType: 'openai-video', model: 'wan-3.0',
    references: [{ id: 'v', kind: 'video', mimeType: 'video/mp4', byteSize: 1, durationSec: 14 }],
    durationSec: 20, aspectRatio: '16:9',
  }).join('；'), /输入视频加输出不能超过 30 秒/);
  assert.match(validateVideoReferenceRequest({
    providerType: 'jimeng', model: 'doubao-seedance-2-0-260128',
    references: [{ id: 'a', kind: 'audio', mimeType: 'audio/mpeg', byteSize: 1, durationSec: 3 }], durationSec: 5,
  }).join('；'), /必须搭配/);
  assert.deepEqual(validateVideoReferenceRequest({
    providerType: 'jimeng', model: 'doubao-seedance-2-5-260628',
    references: [{ id: 'a', kind: 'audio', mimeType: 'audio/mpeg', byteSize: 1, durationSec: 3 }], durationSec: 5,
  }), []);
  assert.match(validateVideoReferenceRequest({
    providerType: 'jimeng', model: 'doubao-seedance-2-0-260128',
    references: [
      { id: 'v1', kind: 'video', mimeType: 'video/mp4', byteSize: 1, durationSec: 8 },
      { id: 'v2', kind: 'video', mimeType: 'video/mp4', byteSize: 1, durationSec: 8 },
    ], durationSec: 5,
  }).join('；'), /分类总时长/);
  const invalidMedia = validateVideoReferenceRequest({
    providerType: 'openai-video', model: 'minimax-h3',
    references: [{ id: 'i', kind: 'image', mimeType: 'image/webp', byteSize: 10 * 1024 * 1024 + 1 }],
    durationSec: -1, aspectRatio: '2:3', resolution: '4K',
  }).join('；');
  assert.match(invalidMedia, /MIME/);
  assert.match(invalidMedia, /10 MiB/);
  assert.match(invalidMedia, /视频时长/);
  assert.match(invalidMedia, /输出比例/);
  assert.match(invalidMedia, /输出清晰度/);

  const tailDraft = { ...createVideoMotionRow('row', 30), prompt: 'test', tailImageId: 'tail' };
  assert.equal(getVideoMotionRowIssue(tailDraft, resolve('k25', 30).capabilities.tailFrame), null);
  assert.match(getVideoMotionRowIssue(tailDraft, resolve('future', 30).capabilities.tailFrame)!, /尚未核验/);
  assert.equal(tailDraft.tailImageId, 'tail', 'switching never deletes the human-selected tail frame');

  // Old GET data is still understood without the new snapshot. Reference always fails closed.
  for (const current of providers) {
    const { capabilities: _capabilities, ...legacy } = current;
    void _capabilities;
    const old = resolveVideoGenerationSelection([legacy], '', { providerId: legacy.id, durationSec: 30, multiShot: false });
    const selection = resolveVideoGenerationSelection([current], '', { providerId: current.id, durationSec: 30, multiShot: false });
    assert.equal(old.durationSec, selection.durationSec);
    assert.deepEqual(old.requestOptions, selection.requestOptions);
    assert.deepEqual(old.capabilities.tailFrame, selection.capabilities.tailFrame);
    assert.deepEqual(old.capabilities.multiShot, selection.capabilities.multiShot);
    assert.deepEqual(old.capabilities.reference, { supported: false, reason: 'unsupported_model' });
  }
  const currentSeedance = providers.find((item) => item.id === 'sd25')!;
  const { reference: _reference, ...previousCapabilities } = currentSeedance.capabilities!;
  void _reference;
  const previousSnapshot = resolveVideoGenerationSelection([
    { ...currentSeedance, capabilities: previousCapabilities as typeof currentSeedance.capabilities },
  ], '', { providerId: 'sd25', durationSec: 5 });
  assert.deepEqual(previousSnapshot.capabilities.reference, { supported: false, reason: 'unsupported_model' });
  const noCaps = { id: 'old', name: 'old', type: 'openai-video', defaultModel: 'kling-2.5' };
  const oldSelection = resolveVideoGenerationSelection([noCaps], '', { providerId: 'old', durationSec: 30 });
  assert.equal(oldSelection.durationSec, 10);
  assert.equal(oldSelection.capabilities.tailFrame.supported, false);
  assert.equal(oldSelection.capabilities.reference.supported, false);
  assert.equal('multiShot' in oldSelection.requestOptions, false);
  assert.equal(resolveVideoGenerationSelection([], '', { providerId: '', durationSec: 30 }).durationSec, 15);

  // Import and execute the browser module with a loader that forbids all non-client dependencies.
  execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (!specifier.endsWith('/video-generation-options.ts')
        && !specifier.endsWith('/video-reference-contract.ts')
        && !['./video-duration.ts', './company-gateway-video-models.ts', './video-providers/seedance-contract.ts'].includes(specifier)) {
        throw new Error('Unexpected client runtime dependency: ' + specifier);
      }
      return nextResolve(specifier, context);
    }});
    const { resolveVideoGenerationSelection } = await import('./lib/video-generation-options.ts');
    const { videoReferenceCapability } = await import('./lib/video-reference-contract.ts');
    if (resolveVideoGenerationSelection([], '', { providerId: '' }).durationSec !== 5) throw new Error('Bad draft');
    if (videoReferenceCapability('openai-video', 'kling-2.5').supported) throw new Error('Kling reference must fail closed');
    if (!videoReferenceCapability('jimeng', 'doubao-seedance-2-5-260628').supported) throw new Error('Exact Seedance reference missing');
  `], { cwd: process.cwd(), stdio: 'pipe' });
  console.log('video model capabilities tests passed');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
