import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  normalizeGeneratedImageToSize,
  parseImageTargetSize,
} from '../lib/image-output-normalize.ts';

assert.deepEqual(parseImageTargetSize('864x1152'), { width: 864, height: 1152 });
assert.deepEqual(parseImageTargetSize('1728x2304'), { width: 1728, height: 2304 });
assert.equal(parseImageTargetSize('auto'), null);
assert.equal(parseImageTargetSize('bad-size'), null);

const source = await sharp({
  create: {
    width: 832,
    height: 1248,
    channels: 3,
    background: '#ffffff',
  },
}).png().toBuffer();

const normalized = await normalizeGeneratedImageToSize(source, '864x1152');
assert.equal(normalized.changed, true);
assert.equal(normalized.width, 864);
assert.equal(normalized.height, 1152);
assert.match(normalized.reason || '', /832x1248 -> 864x1152/);

const metadata = await sharp(normalized.imageBuffer).metadata();
assert.equal(metadata.width, 864);
assert.equal(metadata.height, 1152);

const unchanged = await normalizeGeneratedImageToSize(normalized.imageBuffer, '864x1152');
assert.equal(unchanged.changed, false);
assert.equal(unchanged.width, 864);
assert.equal(unchanged.height, 1152);

console.log('image-output-normalize tests passed');
