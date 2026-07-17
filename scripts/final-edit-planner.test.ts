import assert from 'node:assert/strict';
import { FinalEditError, planTimeline, validateNarrationAlignment } from '../lib/final-edit/workspace.ts';
import { clipFilter } from '../lib/final-edit/renderer.ts';
import { createOpenAiAlignmentAdapter } from '../lib/final-edit/adapters/alignment.ts';

const vapiAlignment = createOpenAiAlignmentAdapter({}, {
  baseUrl: 'https://api.v3.cm',
  apiKey: 'configured-vapi-key',
  model: 'whisper-1',
});
assert.equal(vapiAlignment.configured, true, 'V-API provider config should enable Whisper alignment without duplicate env settings');

const incompleteOverride = createOpenAiAlignmentAdapter({
  FINAL_EDIT_ALIGNMENT_BASE_URL: 'https://dedicated-alignment.example.com',
}, {
  baseUrl: 'https://api.v3.cm',
  apiKey: 'configured-vapi-key',
  model: 'whisper-1',
});
assert.equal(incompleteOverride.configured, false, 'partial dedicated alignment settings must not mix credentials with the V-API fallback');

async function testTransientAlignmentRetry() {
  const originalFetch = globalThis.fetch;
  let alignmentRequestCount = 0;
  globalThis.fetch = async () => {
    alignmentRequestCount += 1;
    if (alignmentRequestCount < 3) {
      return new Response('{"error":{"message":"busy"}}', { status: 429, headers: { 'Retry-After': '0' } });
    }
    return Response.json({ words: [{ word: '你好', start: 0, end: 0.5 }] });
  };
  try {
    const retryingAlignment = createOpenAiAlignmentAdapter({}, {
      baseUrl: 'https://api.v3.cm',
      apiKey: 'configured-vapi-key',
      model: 'whisper-1',
    });
    const words = await retryingAlignment.align({ audioPath: new URL(import.meta.url).pathname, text: '你好' });
    assert.equal(alignmentRequestCount, 3, 'transient alignment rate limits should be retried');
    assert.deepEqual(words, [{ text: '你好', startUs: 0, endUs: 500_000 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const assets = [
  {
    videoJobId: 'direct', shotSetId: 'set', shotId: 'shot-1', filename: 'direct.mp4', localVideoPath: '/storage/direct.mp4', durationSec: 10,
    durationUs: 10_000_000, fingerprint: 'direct-fingerprint', autoUseDisabled: false, existingUsageCount: 0,
    analysis: { summary: '', sellingPoints: [], semanticTags: [], usableRanges: [{ startUs: 2_000_000, endUs: 6_000_000, qualityScore: 0.8 }], qualityIssues: [], coverFrameTimesUs: [] },
  },
  {
    videoJobId: 'disabled', shotSetId: 'set', shotId: 'shot-1', filename: 'disabled.mp4', localVideoPath: '/storage/disabled.mp4', durationSec: 10,
    durationUs: 10_000_000, fingerprint: 'disabled-fingerprint', autoUseDisabled: true, existingUsageCount: 0,
    analysis: { summary: '', sellingPoints: [], semanticTags: [], usableRanges: [{ startUs: 0, endUs: 10_000_000, qualityScore: 1 }], qualityIssues: [], coverFrameTimesUs: [] },
  },
  {
    videoJobId: 'limited', shotSetId: 'set', shotId: 'shot-2', filename: 'limited.mp4', localVideoPath: '/storage/limited.mp4', durationSec: 10,
    durationUs: 10_000_000, fingerprint: 'limited-fingerprint', autoUseDisabled: false, existingUsageCount: 2,
    analysis: { summary: '', sellingPoints: [], semanticTags: [], usableRanges: [{ startUs: 0, endUs: 10_000_000, qualityScore: 1 }], qualityIssues: [], coverFrameTimesUs: [] },
  },
];

const timeline = planTimeline(assets, 72, 0, [{ id: 'segment-1', shotId: 'shot-1', narration: '这是口播', subtitle: '这是字幕' }], 2);
assert.ok(timeline.clips.length > 0);
assert.ok(timeline.clips.every((clip) => clip.videoJobId === 'direct'));
assert.ok(timeline.clips.every((clip) => clip.sourceInFrame >= 48 && clip.sourceOutFrame <= 144));

validateNarrationAlignment({
  relativePath: 'narration.wav', durationUs: 1_000_000,
  segmentTimings: [{ segmentId: 'segment-1', startUs: 0, endUs: 1_000_000 }],
  wordTimings: [{ text: '这是', startUs: 0, endUs: 400_000 }, { text: '口播', startUs: 400_000, endUs: 1_000_000 }],
}, '这是口播');
assert.throws(() => validateNarrationAlignment({
  relativePath: 'narration.wav', durationUs: 1_000_000,
  segmentTimings: [{ segmentId: 'segment-1', startUs: 0, endUs: 1_000_000 }],
  wordTimings: [{ text: '完全不同', startUs: 0, endUs: 1_000_000 }],
}, '这是口播'), (error: unknown) => error instanceof FinalEditError && error.code === 'alignment_failed');

const framingFilter = clipFilter(1, '3x4', { scale: 1.5, offsetX: 0.25, offsetY: -0.5 });
assert.match(framingFilter, /scale=iw\*1\.5000:ih\*1\.5000/);
assert.match(framingFilter, /0\.2500/);
assert.match(framingFilter, /-0\.5000/);

void testTransientAlignmentRetry()
  .then(() => console.log('final-edit planner, alignment, and framing tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
