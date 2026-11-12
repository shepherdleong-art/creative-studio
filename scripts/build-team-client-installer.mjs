import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertExactTopLevel, scanDistributionPayload, walkPayload, sha256File } from './team-server/distribution.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(`--${name}`) + 1];
const required = name => {
  if (!args.includes(`--${name}`) || !option(name)) throw Error(`Missing --${name}`);
  return path.resolve(option(name));
};
assert.equal(process.platform, 'win32', 'Windows installer requires Windows');
const payload = required('payload');
const certificate = required('certificate');
const out = args.includes('--output') ? required('output') : path.join(repo, 'outputs/02-客户端/分发压缩包');
const iscc = args.includes('--iscc') ? required('iscc') : path.join(process.env.LOCALAPPDATA, 'Programs/Inno Setup 6/ISCC.exe');
assertExactTopLevel(payload, 'teamClientWhitelistGuard');
scanDistributionPayload(payload, 'teamClient');
assert.deepEqual(walkPayload(path.join(payload, 'client-state')).map(f => path.relative(path.join(payload, 'client-state'), f).replaceAll('\\', '/')).sort(), ['run/transfer-gate.json', 'state.json'], 'Only pristine client state may be distributed');
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(payload, 'client-state/state.json'), 'utf8')), { schemaVersion: 1 });
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(payload, 'client-state/run/transfer-gate.json'), 'utf8')), { schemaVersion: 1, blocked: false });
const pointer = JSON.parse(fs.readFileSync(path.join(payload, 'current.json'), 'utf8'));
const installerVersion = args.includes('--installer-version') ? option('installer-version') : pointer.manifest.version;
assert.match(installerVersion ?? '', /^\d+\.\d+\.\d+$/, '--installer-version requires a numeric major.minor.patch version');
assert.match(pointer.releaseId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
assert.equal(pointer.directory, path.join('versions', pointer.releaseId));
for (const name of ['dist-desktop/main.js', 'dist-desktop/preload.js', 'electron/electron.exe']) {
  assert.ok(fs.statSync(path.join(payload, pointer.directory, name)).isFile(), `Missing client entry: ${name}`);
}
const config = JSON.parse(fs.readFileSync(path.join(payload, 'client-config.json'), 'utf8'));
const { verifyUpdateManifest } = await import(pathToFileURL(path.join(payload, 'helper/update-package.js')));
verifyUpdateManifest(pointer.manifest, fs.readFileSync(path.join(payload, 'update-public-key.pem'), 'utf8'), { platform: 'win32', arch: 'x64', trustedOrigins: [config.serverOrigin] });
assert.equal(sha256File(path.join(payload, 'updates', `${pointer.releaseId}.zip`)), pointer.manifest.sha256);
const cert = new crypto.X509Certificate(fs.readFileSync(certificate));
assert.equal(cert.ca, true);
assert.ok(Date.parse(cert.validTo) > Date.now());
const file = path.join(out, `LinsVision-Beta-Setup-${pointer.releaseId}.exe`);
assert.equal(fs.existsSync(file), false, 'Refuse to overwrite an existing installer');
fs.mkdirSync(out, { recursive: true });
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lins-installer-build-'));
try {
  fs.copyFileSync(path.join(repo, 'app/favicon.ico'), path.join(stage, 'app.ico'));
  fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(stage, 'LICENSE.txt'));
  fs.copyFileSync(certificate, path.join(stage, 'studio-root.cer'));
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile = spawnSync(compiler, ['/nologo', '/target:winexe', '/platform:anycpu', '/reference:System.Windows.Forms.dll',
    `/win32icon:${path.join(stage, 'app.ico')}`, `/out:${path.join(stage, 'Creative Studio.exe')}`, path.join(repo, 'installer/windows/team-client-launcher.cs')], { stdio: 'inherit', windowsHide: true });
  assert.equal(compile.status, 0, 'GUI launcher compilation failed');
  scanDistributionPayload(stage, 'teamClient');
  const build = spawnSync(iscc, ['/Qp', `/DPayloadRoot=${payload}`, `/DExtraRoot=${stage}`, `/DReleaseId=${pointer.releaseId}`,
    `/DAppVersion=${installerVersion}`, `/DOutputRoot=${out}`, path.join(repo, 'installer/windows/team-client.iss')], { stdio: 'inherit', windowsHide: true });
  assert.equal(build.status, 0, 'Installer compilation failed');
  const hash = sha256File(file);
  fs.writeFileSync(`${file}.sha256`, `${hash}  ${path.basename(file)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ file, bytes: fs.statSync(file).size, sha256: hash, releaseId: pointer.releaseId, installerVersion, certificateSha256: sha256File(certificate) }));
} finally {
  assert.equal(path.dirname(stage), path.resolve(os.tmpdir()));
  assert.ok(path.basename(stage).startsWith('lins-installer-build-'));
  fs.rmSync(stage, { recursive: true, force: true });
}
