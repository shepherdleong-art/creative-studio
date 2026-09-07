import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

const relocationFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-storage-relocation-'));
try {
  const oldStorageRoot = path.join(relocationFixture, '创意工作台-0.5.2-免安装版', 'storage');
  const newStorageRoot = path.join(relocationFixture, '创意工作台-0.6.0-免安装版', 'storage');
  const relativeMediaPath = path.join('processed', 'inputs', 'thumb.png');
  const oldAbsolutePath = path.join(oldStorageRoot, relativeMediaPath);
  const relocatedFile = path.join(newStorageRoot, relativeMediaPath);
  fs.mkdirSync(path.dirname(relocatedFile), { recursive: true });
  fs.writeFileSync(relocatedFile, 'fixture');

  assert.equal(
    toStorageImageUrl(oldAbsolutePath, newStorageRoot),
    '/api/images/processed/inputs/thumb.png',
    '复制免安装版并迁移 storage 后，数据库中的旧绝对路径应解析到新目录',
  );
} finally {
  fs.rmSync(relocationFixture, { recursive: true, force: true });
}
