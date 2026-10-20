// Discovery only: temporary data root, local HTTP capabilities, no database or supplier.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'film-doctor-中文 空格-')));
const run = promisify(execFile);
const cli = path.resolve(process.env.FILM_DOCTOR_CLI || 'scripts/reassembled-workbench.mjs');
const doctor = async () => {
  try { const result = await run(process.execPath, [cli, 'doctor', root], { timeout: 20000, windowsHide: true }); return { ...result, code: 0 }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
};
let result = await doctor();
assert.equal(result.code, 1); assert.match(result.stderr, /请先安装或启动桌面版/); assert.doesNotMatch(result.stderr, /ENOENT/);
assert.deepEqual(fs.readdirSync(root), []);
const stateFile = path.join(root, 'storage/run/electron-service.json');
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
for (const state of ['{broken', 'null', '{}']) {
  fs.writeFileSync(stateFile, state); result = await doctor();
  assert.equal(result.code, 1); assert.match(result.stderr, /重新启动桌面版后运行 doctor/);
}
const identity = { instanceId: 'doctor-test', apiVersion: 1, dataIdentity: createHash('sha256').update(root).digest('hex'), capabilities: ['film-production-sync/1'] };
let response = identity, requests = 0;
const server = http.createServer((req, res) => {
  requests++; assert.equal(req.method, 'GET'); assert.equal(req.url, '/api/reassembled-films/capabilities');
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const state = { origin: `http://127.0.0.1:${server.address().port}`, instanceId: identity.instanceId };
try {
  fs.writeFileSync(stateFile, JSON.stringify(state));
  result = await doctor(); assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), identity);
  for (const changed of [{ dataIdentity: 'wrong-root' }, { instanceId: 'stale-instance' }, { apiVersion: 2 }]) {
    response = { ...identity, ...changed }; result = await doctor();
    assert.equal(result.code, 1); assert.match(result.stderr, /实例或数据目录身份不匹配/);
  }
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, origin: 'https://example.invalid' }));
  result = await doctor(); assert.equal(result.code, 1); assert.match(result.stderr, /不是本机地址/);
  assert.equal(requests, 4);
} finally { await new Promise(resolve => server.close(resolve)); }
fs.writeFileSync(stateFile, JSON.stringify(state));
result = await doctor(); assert.equal(result.code, 1); assert.match(result.stderr, /无法连接该桌面实例/);
assert.ok(!fs.existsSync(path.join(root, 'data')));
assert.deepEqual(fs.readdirSync(path.dirname(stateFile)), ['electron-service.json']);
console.log('PASS offline guidance, invalid state, live discovery, wrong identity/version, local-only and stale service; no writes or submissions');
