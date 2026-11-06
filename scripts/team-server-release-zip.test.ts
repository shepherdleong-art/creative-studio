import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractServerZipSafely } from '../lib/team-service/maintenance/safe-zip.ts';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries: Array<{ name: string; data?: string; symlink?: boolean; external?: number }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const input = Buffer.from(entry.data ?? '');
    const data = zlib.deflateRawSync(input);
    const checksum = crc32(input);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(input.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(3 << 8, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(input.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(entry.external ?? (entry.symlink ? ((0o120777 << 16) >>> 0) : (0o100644 << 16) >>> 0), 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-server-release-zip-'));
try {
  for (const [index, entries] of [
    [{ name: '../outside.txt', data: 'escape' }],
    [{ name: 'release/link', data: 'target', symlink: true }],
    [{ name: 'nested/release-manifest.json', data: '{}' }],
    [{ name: 'C:/absolute.txt', data: 'absolute' }],
    [{ name: 'release/file', data: 'duplicate' }, { name: 'RELEASE/FILE', data: 'conflict' }],
  ].entries()) {
    const file = path.join(root, `bad-${index}.zip`);
    fs.writeFileSync(file, zip(entries));
    assert.throws(() => extractServerZipSafely(file, path.join(root, `bad-${index}`)));
  }
  const tooMany = path.join(root, 'too-many.zip');
  fs.writeFileSync(tooMany, zip([{ name: 'app/server.js', data: 'entry' }, { name: 'app/extra.js', data: 'extra' }]));
  assert.throws(() => extractServerZipSafely(tooMany, path.join(root, 'too-many'), { maxEntries: 1 }), /上限/);
  const tooLarge = path.join(root, 'too-large.zip');
  fs.writeFileSync(tooLarge, zip([{ name: 'app/server.js', data: 'larger than limit' }]));
  assert.throws(() => extractServerZipSafely(tooLarge, path.join(root, 'too-large'), { maxTotalBytes: 2 }), /上限/);
  const truncated = path.join(root, 'truncated.zip');
  fs.writeFileSync(truncated, zip([{ name: 'app/server.js', data: 'entry' }]).subarray(0, 20));
  assert.throws(() => extractServerZipSafely(truncated, path.join(root, 'truncated')));
  const good = path.join(root, 'good.zip');
  fs.writeFileSync(good, zip([{ name: 'app/server.js', data: 'server' }, { name: 'release-manifest.json', data: '{}' }]));
  extractServerZipSafely(good, path.join(root, 'good'));
  assert.equal(fs.readFileSync(path.join(root, 'good', 'app', 'server.js'), 'utf8'), 'server');
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false);
  console.log('team server release ZIP boundary tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
