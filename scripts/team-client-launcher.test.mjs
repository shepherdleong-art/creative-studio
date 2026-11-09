// Windows native launcher check: actual CMD or --gui-launcher <EXE|source>, with an isolated Electron GUI.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') {
  console.log('SKIP: Windows client launcher test');
  process.exit(0);
}
const repo = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { signUpdateManifest } = require('../dist-desktop/client/update-package.js');
const electronFlag = process.argv.indexOf('--electron-dist');
assert.ok(electronFlag < 0 || process.argv[electronFlag + 1], '--electron-dist requires a runtime directory');
const electron = electronFlag >= 0 ? path.resolve(process.argv[electronFlag + 1]) : path.join(repo, 'node_modules', 'electron', 'dist');
assert.ok(fs.existsSync(path.join(electron, 'electron.exe')), 'Requires the installed Electron runtime');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-client-中文 launch-'));
const version = path.join(root, 'versions', 'fixture');
const reportPath = path.join(root, 'window.json');
const stopPath = path.join(root, 'stop');
// Exercise the outer Windows GUI launcher too; the CMD alone cannot verify
// process flags and environment passed by the EXE distributed to users.
const guiFlag = process.argv.indexOf('--gui-launcher');
let guiLauncher = guiFlag >= 0 ? process.argv[guiFlag + 1] : undefined;
assert.ok(guiFlag < 0 || guiLauncher, '--gui-launcher requires an EXE path or "source"');
const deadlineWait = async (predicate, message, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
};
let cmd;
let guiPid;
try {
  fs.mkdirSync(version, { recursive: true });
  fs.mkdirSync(path.join(root, 'helper'));
  // Junctions are only fixture runtime references; the installed runtime is never modified.
  fs.symlinkSync(electron, path.join(root, 'runtime'), 'junction');
  fs.symlinkSync(electron, path.join(version, 'electron'), 'junction');
  for (const file of ['launcher.mjs', 'start-client.cmd']) {
    fs.copyFileSync(path.join(repo, 'scripts', 'team-client', file), path.join(root, file));
  }
  fs.copyFileSync(path.join(repo, 'dist-desktop', 'client', 'update-package.js'), path.join(root, 'helper', 'update-package.js'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(root, 'update-public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  const manifest = signUpdateManifest({ schemaVersion: 1, releaseId: 'fixture', platform: 'win32', arch: process.arch,
    size: 0, sha256: crypto.createHash('sha256').update('').digest('hex'), version: '0.7.1',
    api: { min: 1, max: 1 }, clientStateSchema: { min: 1, max: 1 },
    packageUrl: 'https://studio.example.test/client-updates/fixture.zip', entry: 'app.cjs',
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'fixture', directory: path.join('versions', 'fixture'), manifest }));
  fs.writeFileSync(path.join(root, 'client-config.json'), JSON.stringify({ serverOrigin: 'https://studio.example.test' }));
  fs.writeFileSync(path.join(version, 'release.json'), JSON.stringify({ releaseId: 'fixture', version: '0.7.1' }));
  fs.writeFileSync(path.join(version, 'package.json'), JSON.stringify({ name: 'client-launch-fixture', main: 'app.cjs', version: '0.7.1' }));
  fs.writeFileSync(path.join(version, 'app.cjs'), `
    const { app, BrowserWindow } = require('electron');
    const fs = require('node:fs');
    const path = require('node:path');
    const root = process.env.CREATIVE_STUDIO_CLIENT_INSTALL_ROOT;
    app.setPath('userData', path.join(root, 'user-data'));
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ width: 500, height: 200, show: false, title: '客户端启动验证' });
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h2>客户端启动验证</h2><input aria-label="工号"><input aria-label="密码" type="password">'));
      win.show();
      console.log('fixture stdout');
      console.error('fixture stderr');
      fs.writeFileSync(path.join(root, 'window.json'), JSON.stringify({ pid: process.pid, visible: win.isVisible(), nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null }));
      setInterval(() => { if (fs.existsSync(path.join(root, 'stop'))) app.quit(); }, 100);
      setTimeout(() => app.quit(), 25_000);
    });
  `);
  if (guiLauncher) {
    const destination = path.join(root, 'Creative Studio.exe');
    if (guiLauncher === 'source') {
      const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
      const built = spawnSync(compiler, ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll',
        `/out:${destination}`, path.join(repo, 'installer/windows/team-client-launcher.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(built.status, 0, built.stdout + built.stderr);
    } else {
      fs.copyFileSync(path.resolve(guiLauncher), destination);
    }
    guiLauncher = destination;
  }
  cmd = guiLauncher
    ? spawn(guiLauncher, [], { cwd: root, windowsHide: false, stdio: 'ignore' })
    : spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'start-client.cmd'], {
      cwd: root, windowsHide: true, stdio: 'ignore',
    });
  let spawnError;
  cmd.once('error', error => { spawnError = error; });
  await deadlineWait(() => cmd.exitCode !== null || spawnError, 'Launcher must exit without waiting for the GUI');
  if (spawnError) throw spawnError;
  assert.equal(cmd.exitCode, 0);
  await deadlineWait(() => fs.existsSync(reportPath), 'Electron must create a visible window after the launcher exits');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  guiPid = report.pid;
  assert.equal(report.visible, true, 'The first launch must show its native window without a second invocation');
  assert.equal(report.nodeMode, null, 'GUI must not inherit ELECTRON_RUN_AS_NODE');
  process.kill(guiPid, 0);
  const log = fs.readFileSync(path.join(root, 'client-state', 'logs', 'client.log'), 'utf8');
  assert.match(log, /fixture stdout/);
  assert.match(log, /fixture stderr/);
  fs.writeFileSync(stopPath, 'stop');
  await deadlineWait(() => { try { process.kill(guiPid, 0); return false; } catch { return true; } }, 'Fixture GUI must exit independently');

  fs.unlinkSync(path.join(version, 'electron'));
  const missing = spawnSync(process.execPath, [path.join(root, 'launcher.mjs'), '--root', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 2, 'Missing executable must still fail, rather than report successful detachment');
  assert.match(missing.stderr, /启动失败/);
  console.log(`PASS: actual ${guiLauncher ? 'EXE' : 'CMD'} exits; detached native Electron stays visible; stdout/stderr go to file; missing executable fails`);
} finally {
  fs.writeFileSync(stopPath, 'stop');
  if (cmd?.exitCode === null) cmd.kill();
  if (!guiPid && fs.existsSync(reportPath)) guiPid = JSON.parse(fs.readFileSync(reportPath, 'utf8')).pid;
  if (guiPid) {
    await deadlineWait(() => { try { process.kill(guiPid, 0); return false; } catch { return true; } }, 'Fixture cleanup', 5_000)
      .catch(() => { try { process.kill(guiPid); } catch { /* already exited */ } });
  }
  for (const junction of [path.join(root, 'runtime'), path.join(version, 'electron')]) {
    if (fs.existsSync(junction)) fs.unlinkSync(junction);
  }
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
