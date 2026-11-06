import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(root, 'scripts', 'team-server', 'distribution-lock.json');

function readLock() {
  const bytes = fs.readFileSync(lockPath);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '受控 JSON 不得带 BOM');
  return JSON.parse(bytes.toString('utf8'));
}

function assertSha256(value, label) {
  assert.match(value ?? '', /^[0-9a-f]{64}$/, `${label} 必须锁定真实 SHA-256`);
}

test('server 运行时与媒体依赖锁定正式来源、精确版本和 SHA-256', () => {
  const lock = readLock();
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.platform, 'win32');
  assert.equal(lock.arch, 'x64');
  assert.equal(lock.node.version, '22.22.3');
  assert.equal(lock.node.abi, 127);
  assert.equal(lock.python.version, '3.12.10');
  assert.equal(lock.python.litellmVersion, '1.89.2');
  for (const [name, entry] of Object.entries({
    winsw: lock.winsw,
    caddy: lock.caddy,
    node: lock.node,
    python: lock.python,
  })) {
    const url = new URL(entry.url);
    assert.equal(url.protocol, 'https:', `${name} 下载源必须 HTTPS`);
    assert.ok(['github.com', 'nodejs.org'].includes(url.hostname), `${name} 必须是正式下载源`);
    assert.ok(entry.version, `${name} 缺精确版本`);
    assertSha256(entry.sha256, name);
  }
  assert.equal(lock.winsw.prerelease, false, 'WinSW 不得锁 alpha 版');
  assert.ok(lock.caddy.officialSha512, 'Caddy 需同时记录官方 SHA-512 校验证据');
  assert.ok(lock.media.length >= 4, '至少锁 FFmpeg、FFprobe、SQLite 和 sharp');
  for (const entry of lock.media) {
    assert.ok(entry.name && entry.version && entry.url, `媒体依赖缺名称/版本/来源：${entry.name}`);
    assert.equal(new URL(entry.url).protocol, 'https:');
    assertSha256(entry.sha256, entry.name);
    if (entry.npmIntegrity) assert.match(entry.npmIntegrity, /^sha512-[A-Za-z0-9+/=]+$/);
  }
  const byName = new Map(lock.media.map((entry) => [entry.name, entry]));
  assert.equal(byName.get('ffmpeg-static').version, '5.3.0');
  assert.equal(byName.get('ffmpeg-static').binaryVersion, 'b6.1.1');
  assert.equal(byName.get('@ffprobe-installer/win32-x64').version, '5.1.0');
  assert.equal(byName.get('better-sqlite3').version, '12.10.0');
  assert.equal(byName.get('@img/sharp-win32-x64').version, '0.34.5');
  for (const name of ['ffmpeg-static', '@ffprobe-installer/win32-x64', 'better-sqlite3', '@img/sharp-win32-x64']) {
    assert.ok(byName.get(name).files?.length > 0, `${name} 必须列出哈希对应的实际负载文件`);
  }
});

test('manifest 不允许浮动下载源、空哈希或未审核主机', () => {
  const lock = readLock();
  const serialized = JSON.stringify(lock);
  assert.doesNotMatch(serialized, /latest|example\.com|YOUR-|TODO|PLACEHOLDER/i);
  for (const entry of [lock.winsw, lock.caddy, lock.node, lock.python, ...lock.media]) {
    assert.ok(!/[\r\n]/.test(entry.url), 'URL 不得携带控制字符');
    assert.ok(!entry.url.includes('${'), 'URL 不得是运行时插值模板');
  }
});
