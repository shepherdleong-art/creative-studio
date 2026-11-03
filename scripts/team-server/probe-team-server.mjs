import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyReleaseManifest } from './distribution.mjs';

function run(executable, args, { timeout = 60_000, env = process.env } = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout, env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-4).join(' | ');
    throw new Error(`探针进程失败（${path.basename(executable)}:${result.status ?? result.signal}）${detail ? `：${detail}` : ''}`);
  }
  return result.stdout.trim();
}

export async function probeNativeRuntime({ appRoot, nodeExecutable, expectedNodeVersion, expectedAbi, ffmpegPath, ffprobePath, workDirectory }) {
  const script = String.raw`
    const path = require('node:path');
    const root = process.argv[1];
    if (process.versions.node !== process.argv[2]) throw new Error('Node version mismatch');
    if (process.versions.modules !== process.argv[3]) throw new Error('Node ABI mismatch');
    const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
    const db = new Database(':memory:');
    db.prepare('SELECT 1 AS value').get();
    db.close();
    const sharp = require(path.join(root, 'node_modules', 'sharp'));
    sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png().toBuffer().then((bytes) => {
        if (bytes.length < 32) throw new Error('sharp output invalid');
        process.stdout.write(JSON.stringify({
          version: 'v' + process.versions.node,
          abi: Number(process.versions.modules),
          sqlite: { loaded: true },
          sharp: { loaded: true, libvipsLoaded: true },
        }));
      });
  `;
  let node;
  try {
    node = JSON.parse(run(nodeExecutable, ['-e', script, appRoot, expectedNodeVersion, String(expectedAbi)]));
  } catch (error) {
    throw new Error(`SQLite/sharp 原生加载失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const ffmpegVersion = run(ffmpegPath, ['-version']).split(/\r?\n/, 1)[0];
  const ffprobeVersion = run(ffprobePath, ['-version']).split(/\r?\n/, 1)[0];
  const mediaPath = path.join(workDirectory, 'native-probe.mkv');
  if (fs.existsSync(mediaPath)) throw new Error('媒体探针目标已存在，拒绝覆盖');
  run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.1',
    '-frames:v', '1', '-c:v', 'ffv1', mediaPath,
  ], { timeout: 60_000 });
  const probe = JSON.parse(run(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'json', mediaPath,
  ]));
  const codecName = probe.streams?.[0]?.codec_name;
  if (codecName !== 'ffv1') throw new Error('FFmpeg/FFprobe 媒体往返结果不一致');
  return {
    node,
    sqlite: node.sqlite,
    sharp: node.sharp,
    ffmpeg: { version: ffmpegVersion },
    ffprobe: { version: ffprobeVersion },
    media: { container: { probeSucceeded: true, codecName }, nvenc: 'not_tested' },
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let workDirectory;
  try {
    const release = argument('--release');
    if (!release) throw new Error('必须提供 --release');
    const root = path.resolve(release);
    const manifest = verifyReleaseManifest(root);
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'service', 'distribution-lock.json'), 'utf8'));
    workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-server-probe-'));
    const native = await probeNativeRuntime({
      appRoot: path.join(root, 'app'),
      nodeExecutable: path.join(root, 'runtimes', 'node', 'node.exe'),
      expectedNodeVersion: lock.node.version,
      expectedAbi: lock.node.abi,
      ffmpegPath: path.join(root, 'app', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
      ffprobePath: path.join(root, 'app', 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
      workDirectory,
    });
    let python = { present: false };
    const pythonExe = path.join(root, 'runtimes', 'python', 'python.exe');
    if (fs.existsSync(pythonExe)) {
      const env = { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: 'True' };
      const version = run(pythonExe, ['--version'], { env });
      const litellm = run(pythonExe, ['-c', 'from importlib.metadata import version; from litellm import run_server; print(version("litellm"))'], { env });
      if (version !== `Python ${lock.python.version}` || litellm !== lock.python.litellmVersion) throw new Error('Python/LiteLLM 实际版本不符');
      python = { present: true, version, litellmVersion: litellm, runServerImported: true };
    }
    const caddyVersion = run(path.join(root, 'tools', 'caddy', 'caddy.exe'), ['version']);
    run(path.join(root, 'runtimes', 'node', 'node.exe'), [
      '--input-type=module', '-e', 'await import(process.argv[1])',
      pathToFileURL(path.join(root, 'app', 'lib', 'team-service', 'auth', 'local-command.ts')).href,
    ]);
    const report = {
      schemaVersion: 1,
      status: 'passed',
      releaseId: manifest.releaseId,
      scope: 'isolated-native-and-cpu-media-probe',
      ...native,
      python,
      caddy: { version: caddyVersion },
      managementCli: { moduleLoaded: true },
      onsiteAcceptance: { scm: 'not_tested', certificateTrust: 'not_tested', nvenc: 'not_tested' },
    };
    const output = argument('--output');
    if (output) {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`server 探针失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (workDirectory) fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}
