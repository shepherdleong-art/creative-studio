import assert from 'node:assert/strict';
import {
  defaultPackageConfig,
  mergePackageConfig,
  parseArrangementPlanJson,
  parseClipPoolJson,
  parseFinalVideoWorkflowConfigJson,
  parseFinalVideoJobSnapshotJson,
  parseNarrationBeatsJson,
  parsePackageConfigJson,
  parseTimelineIssuesJson,
  validatePackageConfigRequest,
} from '../lib/final-video/types.ts';

const oldTts = mergePackageConfig({
  outputName: 'old-tts',
  narration: { mode: 'tts', providerId: 'tts-provider', voice: 'Cherry', speed: 1.2 },
} as never);
assert.equal(oldTts.mode, 'narration');
assert.deepEqual(oldTts.narration, { mode: 'tts', providerId: 'tts-provider', voice: 'Cherry', speed: 1.2 });

const oldNone = mergePackageConfig({
  outputName: 'old-none',
  narration: { mode: 'none', voice: 'Cherry', speed: 1, providerId: '' },
} as never);
assert.equal(oldNone.mode, 'bgm-only');
assert.deepEqual(oldNone.narration, { mode: 'none' });
assert.equal(oldNone.targetDurationSec, 15);
assert.equal(oldNone.durationTolerancePct, 0.2);
assert.equal(oldNone.maxClipSeconds, 4);
assert.equal(defaultPackageConfig().mode, 'bgm-only');

const validPackage = {
  mode: 'bgm-only', outputName: 'valid', width: 1080, height: 1920, fps: 30,
  targetDurationSec: 15, durationTolerancePct: 0.2, maxClipSeconds: 4,
  narration: { mode: 'none' }, bgm: null,
  cover: { titleText: '', titleSize: 72, titleColor: '#fff', introDurationSec: 0, templateId: 'minimal-01' },
  subtitle: { enabled: true, fontSize: 56, color: '#fff', strokeColor: '#000', strokeWidth: 2, marginBottomPct: 18 },
};
const invalidPackages = [
  { ...validPackage, mode: 'invalid' },
  { ...validPackage, width: '1080' },
  { ...validPackage, targetDurationSec: '15' },
  { ...validPackage, narration: { mode: 'tts', providerId: 7, voice: 'Cherry', speed: 1 } },
  { ...validPackage, bgm: { path: '/music.mp3', volume: 'loud', ducking: true } },
  { ...validPackage, cover: { ...validPackage.cover, introDurationSec: '0' } },
  { ...validPackage, subtitle: { ...validPackage.subtitle, enabled: 'yes' } },
];
for (const invalid of invalidPackages) {
  assert.throws(() => parsePackageConfigJson(JSON.stringify(invalid)), /packageJson/i);
}
const invalidRequestResult = validatePackageConfigRequest({ ...validPackage, mode: 'invalid' });
assert.equal(invalidRequestResult.ok, false);
if (!invalidRequestResult.ok) assert.match(invalidRequestResult.error, /packageConfig\.mode/i);
const validRequestResult = validatePackageConfigRequest(validPackage);
assert.equal(validRequestResult.ok, true);

const validWorkflow = {
  packageConfig: validPackage,
  narrationScriptProviderId: 'script', visionProviderId: 'vision', orchestrationProviderId: 'orchestrator',
  selectedClipIds: ['clip-1'],
};
assert.throws(
  () => parseFinalVideoWorkflowConfigJson(JSON.stringify({ ...validWorkflow, packageConfig: { ...validPackage, fps: '30' } })),
  /workflowConfigJson\.packageConfig/i,
);

const validSnapshot = {
  kind: 'final', draftId: 'draft-1', draftRevision: 3, packageConfig: validPackage,
  narrationBeats: [], clipPool: [], arrangement: { assignments: [], gaps: [] }, issues: [], solverVersion: 2,
};
assert.deepEqual(parseFinalVideoJobSnapshotJson(JSON.stringify(validSnapshot)), validSnapshot);
assert.throws(
  () => parseFinalVideoJobSnapshotJson(JSON.stringify({ ...validSnapshot, packageConfig: { ...validPackage, height: '1920' } })),
  /jobSnapshotJson\.packageConfig/i,
);
assert.throws(() => parseFinalVideoJobSnapshotJson(JSON.stringify({ ...validSnapshot, solverVersion: 1 })), /solverVersion/i);

const expectCorruptJsonError = (parser: (value: string) => unknown, label: string) => {
  assert.throws(() => parser('{broken'), new RegExp(`${label}.*invalid JSON`, 'i'));
};

expectCorruptJsonError(parseFinalVideoWorkflowConfigJson, 'workflowConfigJson');
expectCorruptJsonError(parseNarrationBeatsJson, 'narrationBeatsJson');
expectCorruptJsonError(parseClipPoolJson, 'clipPoolJson');
expectCorruptJsonError(parseArrangementPlanJson, 'arrangementJson');
expectCorruptJsonError(parseTimelineIssuesJson, 'issuesJson');

assert.deepEqual(parseArrangementPlanJson('{"assignments":[],"gaps":[],"ignored":true}'), {
  assignments: [], gaps: [],
});
assert.throws(() => parseNarrationBeatsJson('[{"beatId":"b1"}]'), /narrationBeatsJson/i);
assert.throws(() => parseClipPoolJson('{}'), /clipPoolJson/i);

console.log('final-video-types tests passed');
