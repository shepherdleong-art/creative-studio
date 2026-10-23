import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeFingerprintFromFile, computeFingerprintFromBuffer } from '../lib/batch-production/fingerprint.ts';
import { fingerprintsEqual, fingerprintHex } from '../lib/batch-production/fingerprint-format.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-fingerprint-'));
try {
  const bytes = Buffer.from('同一素材的浏览器与文件系统身份');
  const file = path.join(root, 'sample.bin');
  fs.writeFileSync(file, bytes);
  const stored = await computeFingerprintFromFile(file);
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  const browserHex = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  assert(fingerprintsEqual(stored, browserHex), '浏览器原始摘要与素材库带算法名的指纹须可比较');
  assert.equal(computeFingerprintFromBuffer(bytes), stored);
  assert.equal(fingerprintHex(stored), browserHex);
  assert.equal(fingerprintsEqual(stored, computeFingerprintFromBuffer(Buffer.from('另一素材'))), false);
  assert.equal(fingerprintsEqual('invalid', 'invalid'), false);
  console.log('batch-fingerprint: 浏览器/Node/旧裸摘要兼容及不同内容隔离通过');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
