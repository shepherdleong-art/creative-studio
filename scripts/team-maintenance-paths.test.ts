import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { removeDirectorySafely, writeJsonAtomic } = await import('../lib/team-service/maintenance/paths.ts');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-paths-'));
const root = path.join(fixture, 'backups');
const outside = path.join(fixture, 'outside');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');

try {
  await assert.rejects(() => removeDirectorySafely(root, root), /根目录/);
  await assert.rejects(() => removeDirectorySafely(root, outside), /根目录内/);
  const link = path.join(root, 'linked');
  fs.symlinkSync(outside, link, 'junction');
  await assert.rejects(() => removeDirectorySafely(root, link), /链接/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  const removable = path.join(root, 'daily-old');
  fs.mkdirSync(removable);
  fs.writeFileSync(path.join(removable, 'old.txt'), 'old');
  await removeDirectorySafely(root, removable);
  assert.equal(fs.existsSync(removable), false);

  const statePath = path.join(root, 'state.json');
  await writeJsonAtomic(statePath, { schemaVersion: 1, status: 'success' });
  const bytes = fs.readFileSync(statePath);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(JSON.parse(bytes.toString('utf8')).status, 'success');
  console.log('team maintenance safe cleanup tests passed');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
