import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-release-upload-limits-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';
process.env.CREATIVE_STUDIO_PORT = '3399';
process.env.CREATIVE_STUDIO_DEPLOYMENT_ID = 'upload-limits';
process.env.CREATIVE_STUDIO_TRUSTED_ORIGIN = 'http://127.0.0.1:3399';
process.env.CREATIVE_STUDIO_TEAM_RELEASE_FIXTURE_UPLOAD = '1';
try {
  const { assertFixtureReleaseUploadAllowed, receiveTeamReleaseArchive } = await import('../lib/team-service/release-candidates.ts');
  assert.equal(assertFixtureReleaseUploadAllowed({ ...process.env, NODE_ENV: 'production' }), false);
  assert.equal(assertFixtureReleaseUploadAllowed({ ...process.env, NODE_ENV: 'development' }), true);
  const interrupted = new Request('http://127.0.0.1:3399/api/team/release-candidates', {
    method: 'POST', headers: { 'Content-Type': 'application/zip', 'Content-Length': '100' },
    body: Buffer.from('not-a-complete-zip'),
  });
  await assert.rejects(() => receiveTeamReleaseArchive(interrupted), /上传中断/);
  const incoming = path.join(root, 'storage', 'maintenance', 'release-candidates', '.incoming');
  assert.equal(fs.readdirSync(incoming).length, 0, '中断上传不得留下半截暂存');
  console.log('team release upload interruption and production trust tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
