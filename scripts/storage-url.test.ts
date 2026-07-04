import assert from 'node:assert/strict';
import path from 'node:path';
import { toStorageImageUrl } from '../lib/storage-url.ts';

const storageRoot = path.resolve('/repo/storage');

assert.equal(
  toStorageImageUrl(path.join(storageRoot, 'outputs', 'scene 01.png'), storageRoot),
  '/api/images/outputs/scene%2001.png'
);

assert.equal(
  toStorageImageUrl(path.join(storageRoot, 'processed', 'nested', 'poster.webp'), storageRoot),
  '/api/images/processed/nested/poster.webp'
);

assert.equal(toStorageImageUrl('', storageRoot), '');
assert.equal(toStorageImageUrl(null, storageRoot), '');

import { toStorageVideoUrl } from '../lib/storage-url.ts';

assert.equal(
  toStorageVideoUrl(path.join(storageRoot, 'final-videos', 'j1', 'final 01.mp4'), storageRoot),
  '/api/videos/final-videos/j1/final%2001.mp4'
);
assert.equal(toStorageVideoUrl('/etc/passwd', storageRoot), '');
