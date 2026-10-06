import assert from 'node:assert/strict';
import { addUsageDays, usagePresetRange } from '../lib/usage-date-range.ts';

// UTC+8 midnight already belongs to October, even though the UTC date is September.
const now = new Date('2026-09-30T16:30:00Z');
assert.deepEqual(usagePresetRange('today', now), { from: '2026-10-01', to: '2026-10-01' });
assert.deepEqual(usagePresetRange('last7', now), { from: '2026-09-25', to: '2026-10-01' });
assert.deepEqual(usagePresetRange('last30', now), { from: '2026-09-02', to: '2026-10-01' });
assert.deepEqual(usagePresetRange('week', now), { from: '2026-09-28', to: '2026-10-01' });
assert.deepEqual(usagePresetRange('month', now), { from: '2026-10-01', to: '2026-10-01' });
assert.deepEqual(usagePresetRange('week', new Date('2026-10-04T12:00:00Z')), { from: '2026-09-28', to: '2026-10-04' });
assert.deepEqual(usagePresetRange('week', new Date('2026-10-05T00:00:00Z')), { from: '2026-10-05', to: '2026-10-05' });
assert.deepEqual(usagePresetRange('last7', new Date('2027-01-02T00:00:00Z')), { from: '2026-12-27', to: '2027-01-02' });
assert.equal(addUsageDays('2028-02-28', 1), '2028-02-29');
assert.equal(addUsageDays('2026-09-30', 1), '2026-10-01', 'inclusive end becomes next midnight for the API');
console.log('usage date range tests passed');
