import assert from 'node:assert/strict';
import {
  audioAudibleAt,
  editAudioClip,
  trimAudioClip,
  moveAudioClip,
  parseAudioEdits,
  isAudioClipsMoved,
  normalizeAudioClip,
  type AudioClip,
  type AudioEdits,
} from '../lib/media-core/audio-edit.ts';

// 1. normalizeAudioClip backward compatibility
{
  const legacy: AudioClip = { id: 'c1', startUs: 1_000_000, endUs: 4_000_000 } as AudioClip;
  const normalized = normalizeAudioClip(legacy);
  assert.equal(normalized.id, 'c1');
  assert.equal(normalized.timelineStartUs, 1_000_000);
  assert.equal(normalized.timelineEndUs, 4_000_000);
  assert.equal(normalized.sourceStartUs, 1_000_000);
  assert.equal(normalized.sourceEndUs, 4_000_000);
  assert.equal(normalized.startUs, 1_000_000);
  assert.equal(normalized.endUs, 4_000_000);
}

// 2. parseAudioEdits with legacy and new formats
{
  const legacyJson = {
    narration: [
      { id: 'n1', startUs: 0, endUs: 2_000_000 },
      { id: 'n2', startUs: 2_500_000, endUs: 5_000_000 },
    ],
  };
  const parsed = parseAudioEdits(legacyJson);
  assert.ok(parsed?.narration);
  assert.equal(parsed.narration.length, 2);
  assert.equal(parsed.narration[0].timelineStartUs, 0);
  assert.equal(parsed.narration[0].sourceStartUs, 0);
  assert.equal(parsed.narration[1].timelineStartUs, 2_500_000);
  assert.equal(parsed.narration[1].sourceStartUs, 2_500_000);

  const newJson = {
    bgm: [
      { id: 'b1', timelineStartUs: 500_000, timelineEndUs: 3_500_000, sourceStartUs: 10_000_000, sourceEndUs: 13_000_000 },
    ],
  };
  const parsedNew = parseAudioEdits(newJson);
  assert.ok(parsedNew?.bgm);
  assert.equal(parsedNew.bgm[0].timelineStartUs, 500_000);
  assert.equal(parsedNew.bgm[0].timelineEndUs, 3_500_000);
  assert.equal(parsedNew.bgm[0].sourceStartUs, 10_000_000);
  assert.equal(parsedNew.bgm[0].sourceEndUs, 13_000_000);
  assert.equal(isAudioClipsMoved(parsedNew.bgm), true);
  assert.equal(isAudioClipsMoved(parsed.narration), false);
}

// 3. editAudioClip: split preserves proportional source interval
{
  const state: { audio?: AudioEdits } = {
    audio: {
      narration: [
        { id: 'c1', timelineStartUs: 1_000_000, timelineEndUs: 5_000_000, sourceStartUs: 2_000_000, sourceEndUs: 6_000_000 },
      ],
    },
  };
  // Split at timeline 3.0s (offset 2.0s from start)
  editAudioClip(state, 'narration', 10_000_000, 'c1', 3_000_000);
  const clips = state.audio?.narration;
  assert.ok(clips && clips.length === 2);
  const [left, right] = clips;

  // Left segment
  assert.equal(left.id, 'c1');
  assert.equal(left.timelineStartUs, 1_000_000);
  assert.equal(left.timelineEndUs, 3_000_000);
  assert.equal(left.sourceStartUs, 2_000_000);
  assert.equal(left.sourceEndUs, 4_000_000);

  // Right segment
  assert.equal(right.id, 'c1-3000000');
  assert.equal(right.timelineStartUs, 3_000_000);
  assert.equal(right.timelineEndUs, 5_000_000);
  assert.equal(right.sourceStartUs, 4_000_000);
  assert.equal(right.sourceEndUs, 6_000_000);
}

// 4. trimAudioClip: modify source range and timeline range within limits
{
  const state: { audio?: AudioEdits } = {
    audio: {
      bgm: [
        { id: 'b1', timelineStartUs: 0, timelineEndUs: 3_000_000, sourceStartUs: 1_000_000, sourceEndUs: 4_000_000 },
        { id: 'b2', timelineStartUs: 4_000_000, timelineEndUs: 7_000_000, sourceStartUs: 4_000_000, sourceEndUs: 7_000_000 },
      ],
    },
  };

  // Trim b1 to shorter source
  trimAudioClip(state, 'bgm', 10_000_000, 'b1', {
    sourceStartUs: 1_500_000,
    sourceEndUs: 3_500_000,
    timelineStartUs: 0,
    timelineEndUs: 2_000_000,
    sourceDurationUs: 10_000_000,
  });

  const b1 = state.audio!.bgm![0];
  assert.equal(b1.timelineStartUs, 0);
  assert.equal(b1.timelineEndUs, 2_000_000);
  assert.equal(b1.sourceStartUs, 1_500_000);
  assert.equal(b1.sourceEndUs, 3_500_000);

  // Collision with b2 should throw
  assert.throws(
    () => trimAudioClip(state, 'bgm', 10_000_000, 'b1', {
      sourceStartUs: 1_000_000,
      sourceEndUs: 6_000_000,
      timelineStartUs: 0,
      timelineEndUs: 5_000_000, // overlaps b2 at 4s
    }),
    /覆盖相邻音频片段/,
  );
}

// 5. moveAudioClip: shifts timeline, keeps source intact
{
  const state: { audio?: AudioEdits } = {
    audio: {
      bgm: [
        { id: 'b1', timelineStartUs: 0, timelineEndUs: 2_000_000, sourceStartUs: 5_000_000, sourceEndUs: 7_000_000 },
        { id: 'b2', timelineStartUs: 5_000_000, timelineEndUs: 8_000_000, sourceStartUs: 8_000_000, sourceEndUs: 11_000_000 },
      ],
    },
  };

  // Move b1 from 0 to 1.5s
  moveAudioClip(state, 'bgm', 10_000_000, 'b1', 1_500_000);
  const b1 = state.audio!.bgm![0];
  assert.equal(b1.timelineStartUs, 1_500_000);
  assert.equal(b1.timelineEndUs, 3_500_000);
  assert.equal(b1.sourceStartUs, 5_000_000);
  assert.equal(b1.sourceEndUs, 7_000_000);

  // Move b1 to overlap b2 should throw
  assert.throws(
    () => moveAudioClip(state, 'bgm', 10_000_000, 'b1', 4_000_000), // 4s to 6s overlaps b2 at 5s
    /覆盖相邻音频片段/,
  );
}

// 6. deleteAudioClip
{
  const state: { audio?: AudioEdits } = {
    audio: {
      narration: [
        { id: 'n1', timelineStartUs: 0, timelineEndUs: 2_000_000, sourceStartUs: 0, sourceEndUs: 2_000_000 },
      ],
    },
  };
  editAudioClip(state, 'narration', 5_000_000, 'n1'); // undefined splitUs deletes
  assert.equal(state.audio?.narration?.length, 0);
  // Entirely deleted track is silent
  assert.equal(audioAudibleAt(state.audio?.narration, 1_000_000), false);
}

console.log('✓ All audio-edit unit tests passed');
