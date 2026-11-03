import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { probeNativeRuntime } from './team-server/probe-team-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('真实加载 SQLite/sharp 并以随包 FFmpeg/FFprobe 完成 CPU 媒体往返', { skip: process.platform !== 'win32' }, async (t) => {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-native-probe-'));
  t.after(() => fs.rmSync(workDirectory, { recursive: true, force: true }));
  const report = await probeNativeRuntime({
    appRoot: root,
    nodeExecutable: process.execPath,
    expectedNodeVersion: '22.22.3',
    expectedAbi: 127,
    ffmpegPath: path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    ffprobePath: path.join(root, 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
    workDirectory,
  });
  assert.equal(report.node.version, 'v22.22.3');
  assert.equal(report.node.abi, 127);
  assert.equal(report.sqlite.loaded, true);
  assert.equal(report.sharp.loaded, true);
  assert.equal(report.sharp.libvipsLoaded, true);
  assert.equal(report.ffmpeg.version.startsWith('ffmpeg version'), true);
  assert.equal(report.ffprobe.version.startsWith('ffprobe version'), true);
  assert.equal(report.media.container.probeSucceeded, true);
  assert.equal(report.media.container.codecName, 'ffv1');
  assert.equal(report.media.nvenc, 'not_tested');
});

test('原生加载失败不得伪装成媒体或 GPU 验收通过', { skip: process.platform !== 'win32' }, async (t) => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-native-missing-'));
  t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
  await assert.rejects(probeNativeRuntime({
    appRoot,
    nodeExecutable: process.execPath,
    expectedNodeVersion: '22.22.3',
    expectedAbi: 127,
    ffmpegPath: path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    ffprobePath: path.join(root, 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
    workDirectory: appRoot,
  }), /better-sqlite3|原生|SQLite/i);
});
