import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'film-access-')));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DESKTOP = '1';
process.env.CREATIVE_STUDIO_INSTANCE_ID = 'isolated-access';
fs.mkdirSync(path.join(root, 'storage/run'), { recursive: true });
fs.writeFileSync(path.join(root, 'storage/run/electron-service.json'), JSON.stringify({ origin: 'http://127.0.0.1:32123', instanceId: 'isolated-access' }));
const { desktopFilmIdentity, checkLocalRequest, agentToken, assertAgentRequest, filmWriteActor } = await import('../lib/final-edit/reassembled/access.ts');
try {
  const identity = desktopFilmIdentity();
  const headers = { host: '127.0.0.1:32123', origin: identity.origin, 'x-reassembled-token': agentToken(), 'x-desktop-instance': identity.instanceId, 'x-data-identity': identity.dataIdentity };
  const request = (override: Record<string, string> = {}) => new Request('http://localhost:32123/api/reassembled-films/import', { headers: { ...headers, ...override } });
  assert.deepEqual(assertAgentRequest(request()), identity, 'Next reconstructed localhost URL must accept the exact browser Host');
  assert.equal(filmWriteActor(request()), 'agent');
  assert.equal(filmWriteActor(new Request(identity.origin, { headers: { origin: identity.origin, 'sec-fetch-site': 'same-origin' } })), 'human');
  assert.throws(() => filmWriteActor(new Request(identity.origin)), { code: 'film_actor_required' });
  assert.throws(() => filmWriteActor(request({ 'x-reassembled-token': '' })), { code: 'film_agent_identity' });
  const badOrigins: Record<string, string>[] = [{ host: '127.0.0.1:32124' }, { origin: 'https://foreign.invalid' }, { host: 'foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }];
  for (const override of badOrigins) assert.throws(() => checkLocalRequest(request(override)), { code: 'film_origin_denied' });
  const badIdentity: Record<string, string>[] = [{ 'x-reassembled-token': '' }, { 'x-desktop-instance': 'another' }, { 'x-data-identity': 'another' }];
  for (const override of badIdentity) assert.throws(() => assertAgentRequest(request(override)), { code: 'film_agent_identity' });
  assert.equal(checkLocalRequest(request({ origin: 'null', 'sec-fetch-site': 'cross-site' }), true).instanceId, identity.instanceId, 'token-bound navigation separately validates its review identity');
  assert.match(agentToken(), /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(root, 'storage/run/reassembled-agent-token')).mode & 0o077, 0);
  } else {
    console.log('SKIP POSIX permission bits: Windows access is governed by NTFS ACLs');
  }
  console.log('PASS exact desktop Host, cross-origin denial, stale instance/data/token rejection, local token');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
