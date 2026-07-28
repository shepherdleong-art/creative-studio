import assert from 'node:assert/strict';
import {
  acceptedDurationGateMatchesNarration,
  createUncheckedDurationGateState,
  evaluateFinalDurationGate,
  parseDurationGateState,
} from '../lib/final-edit/duration-gate.ts';

const within = evaluateFinalDurationGate({ targetTotalSec: 15, actualNarrationUs: 14_566_667 });
assert.equal(within.actualTotalUs, 15_400_000);
assert.equal(within.toleranceUs, 750_000);
assert.equal(within.status, 'within_tolerance');

const slightlyLong = evaluateFinalDurationGate({ targetTotalSec: 15, actualNarrationUs: 15_366_667 });
assert.equal(slightlyLong.actualTotalUs, 16_200_000);
assert.equal(slightlyLong.status, 'too_long');
assert.equal(slightlyLong.deltaUs, 1_200_000);

const muchTooLong = evaluateFinalDurationGate({ targetTotalSec: 15, actualNarrationUs: 24_766_667 });
assert.equal(muchTooLong.actualTotalUs, 25_600_000);
assert.equal(muchTooLong.status, 'too_long');

const shortTarget = evaluateFinalDurationGate({ targetTotalSec: 5, actualNarrationUs: 3_466_667 });
assert.equal(shortTarget.toleranceUs, 500_000, '短目标仍有 0.5 秒最低容差');
assert.equal(shortTarget.status, 'too_short');

const unchecked = createUncheckedDurationGateState({ narrationHash: 'hash-a', targetTotalSec: 15 });
assert.equal(unchecked.status, 'unchecked');
assert.equal(unchecked.targetNarrationUs, 14_166_667);
assert.deepEqual(parseDurationGateState('{broken'), null);

const accepted = {
  ...unchecked,
  status: 'accepted_actual' as const,
  actualNarrationUs: 24_766_667,
  actualTotalUs: 25_600_000,
  acceptedAt: '2026-07-28T00:00:00.000Z',
};
assert.equal(acceptedDurationGateMatchesNarration(accepted, 'hash-a'), true);
assert.equal(acceptedDurationGateMatchesNarration(accepted, 'hash-b'), false);

console.log('final-edit duration gate tests passed');
