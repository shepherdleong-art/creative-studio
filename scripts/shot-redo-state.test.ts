import assert from 'node:assert/strict';
import {
  getRedoFormDefaults,
  getRedoInitKey,
  shouldInitializeRedoForm,
} from '../lib/shot-redo-state.ts';

const firstShot = {
  id: 'shot-1',
  sourceImageId: 'source-1',
  latestJobId: 'job-1',
  referenceImageIds: JSON.stringify(['source-1', 'ref-1', 'ref-2']),
  providerId: 'provider-a',
  jobPrompt: 'first prompt',
};

const firstKey = getRedoInitKey('set-1', firstShot);

assert.equal(shouldInitializeRedoForm('', firstKey), true);
assert.equal(shouldInitializeRedoForm(firstKey, firstKey), false);
assert.equal(
  shouldInitializeRedoForm(firstKey, getRedoInitKey('set-1', { ...firstShot, latestJobId: 'job-2' })),
  true,
);
assert.equal(
  shouldInitializeRedoForm(firstKey, getRedoInitKey('set-1', { ...firstShot, id: 'shot-2' })),
  true,
);

assert.deepEqual(getRedoFormDefaults(firstShot, 'fallback-provider'), {
  inputSource: 'original',
  referenceIds: ['ref-1', 'ref-2'],
  providerId: 'provider-a',
  prompt: 'first prompt',
});

assert.deepEqual(
  getRedoFormDefaults(
    {
      id: 'shot-2',
      sourceImageId: 'source-2',
      latestJobId: 'job-3',
      referenceImageIds: 'not json',
      providerId: '',
      jobPrompt: '',
    },
    'fallback-provider',
  ),
  {
    inputSource: 'original',
    referenceIds: [],
    providerId: 'fallback-provider',
    prompt: '',
  },
);

console.log('shot-redo-state tests passed');
