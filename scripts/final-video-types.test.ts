import assert from 'node:assert/strict';
import {
  defaultPackageConfig,
  mergePackageConfig,
  parseArrangementPlanJson,
  parseClipPoolJson,
  parseFinalVideoWorkflowConfigJson,
  parseNarrationBeatsJson,
  parseTimelineIssuesJson,
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
