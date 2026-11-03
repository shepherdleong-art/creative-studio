import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvidenceRun, redactEvidence } from './acceptance-lib.mjs';
import {
  L1_SUITE,
  L2_SUITE,
  LOCAL_CHECKS,
  MATRIX_IDS,
  ONSITE_GAPS,
} from './acceptance-manifest.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const networkGuard = path.join(repoRoot, 'scripts', 'team-server', 'no-external-network.cjs');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const level = argument('--level', 'all');
if (!['L1', 'L2', 'checks', 'all', 'onsite'].includes(level)) throw new Error('--level 只支持 L1/L2/checks/all/onsite');
const configPath = argument('--config');
const smokeConfig = {
  schemaVersion: 1,
  users: 20,
  concurrency: 20,
  durationSeconds: 10,
  requestDelayMs: 25,
  sampleIntervalMs: 1000,
  largeFileMiB: 8,
  targets: { apiP95Ms: 2000, acceptP95Ms: 3000, serverErrorRateBelow: 0.001 },
};
const config = configPath
  ? JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'))
  : smokeConfig;
if (argument('--duration')) config.durationSeconds = Number(argument('--duration'));
if (argument('--concurrency')) config.concurrency = Number(argument('--concurrency'));
if (!Number.isInteger(config.users) || config.users < 1 || !Number.isInteger(config.concurrency) || config.concurrency < 1
  || !Number.isFinite(config.durationSeconds) || config.durationSeconds <= 0) {
  throw new Error('users/concurrency/durationSeconds 配置无效');
}
const release = {
  version: JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version,
  sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
};
const outputRoot = path.resolve(argument('--output', path.join(repoRoot, 'outputs', 'team-server-acceptance')));
fs.mkdirSync(outputRoot, { recursive: true });
const run = createEvidenceRun({
  outputRoot,
  level,
  release,
  config: { ...config, configPath: configPath ? path.relative(repoRoot, path.resolve(configPath)) : 'built-in-smoke', capacityDurationTargetMet: config.durationSeconds >= 3600, capacitySignoff: false },
  dataRoots: [{ kind: '每项测试独立临时数据根', exactPath: '[redacted]', reused: false }],
  redactionRoots: [repoRoot],
  runId: argument('--runId') ?? undefined,
});
const temporaryDataRoots = [];
let failed = false;

function safeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
}
function stopTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}
async function execute(entry) {
  const started = performance.now();
  const evidenceName = `${safeName(entry.name)}-${randomUUID().slice(0, 8)}.log`;
  const evidencePath = path.join(run.runDirectory, evidenceName);
  const metricPath = entry.name.includes('http.playwright')
    ? path.join(run.runDirectory, 'http-metrics.json')
    : entry.name.includes('fairness') ? path.join(run.runDirectory, 'fairness.json') : null;
  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(networkGuard)}`.trim(),
    TEAM_ACCEPTANCE_EVIDENCE_DIR: path.join(run.runDirectory, 'http'),
    ...(metricPath ? { TEAM_ACCEPTANCE_RESULT_PATH: metricPath } : {}),
    TEAM_ACCEPTANCE_USERS: String(config.users),
    TEAM_ACCEPTANCE_CONCURRENCY: String(config.concurrency),
    TEAM_ACCEPTANCE_DURATION_SECONDS: String(config.durationSeconds),
    TEAM_ACCEPTANCE_REQUEST_DELAY_MS: String(config.requestDelayMs),
    TEAM_ACCEPTANCE_SAMPLE_INTERVAL_MS: String(config.sampleIntervalMs),
    TEAM_ACCEPTANCE_LARGE_FILE_MIB: String(config.largeFileMiB),
    TEAM_ACCEPTANCE_API_P95_MS: String(config.targets.apiP95Ms),
    TEAM_ACCEPTANCE_ACCEPT_P95_MS: String(config.targets.acceptP95Ms),
    TEAM_ACCEPTANCE_5XX_RATE_BELOW: String(config.targets.serverErrorRateBelow),
  };
  const child = spawn(entry.command[0], entry.command.slice(1), {
    cwd: repoRoot,
    env,
    windowsHide: true,
    shell: process.platform === 'win32' && entry.command[0] === 'npm.cmd',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const outcome = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      stopTree(child);
      resolve({ code: null, timedOut: true });
    }, entry.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      resolve({ code: null, timedOut: false, error });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, timedOut: false });
    });
  });
  const durationMs = Math.round(performance.now() - started);
  const safeOutput = redactEvidence(output.slice(-2_000_000), [repoRoot, ...temporaryDataRoots]);
  fs.writeFileSync(evidencePath, `${entry.displayCommand}\n\n${safeOutput}\n`, 'utf8');
  const passed = outcome.code === 0 && !outcome.timedOut;
  if (!passed) failed = true;
  let metrics = null;
  if (metricPath && fs.existsSync(metricPath)) {
    metrics = JSON.parse(fs.readFileSync(metricPath, 'utf8'));
  }
  const assertion = passed
    ? `实际进程退出码 0；完整输出见 ${evidenceName}`
    : `实际进程${outcome.timedOut ? `超过 ${entry.timeoutMs}ms 被终止` : `退出码 ${outcome.code ?? 'unknown'}${outcome.signal ? `/${outcome.signal}` : ''}`}；不得视为通过`;
  for (const matrixId of entry.matrixIds) {
    run.record({
      matrixIds: [matrixId],
      name: entry.name,
      command: entry.displayCommand,
      assertions: [assertion, ...(metrics?.assertions ?? [])],
      evidence: [evidenceName, ...(metricPath && metrics ? [path.basename(metricPath)] : []), ...(metrics?.evidence ?? [])],
      result: passed ? 'passed' : 'failed',
      reason: passed ? null : String(outcome.error ?? outcome.signal ?? `exit ${outcome.code}`),
      durationMs,
      details: metrics ? {
        ...metrics,
        capacityDurationTargetMet: config.durationSeconds >= 3600,
        capacitySignoff: false,
        scope: entry.realMedia ? '本机 HTTP/浏览器与真实临时媒体' : '隔离原生测试',
      } : { scope: entry.realMedia ? '真实临时媒体' : '隔离原生测试' },
    });
  }
  console.log(`${passed ? 'PASS' : 'FAIL'} ${entry.displayCommand} (${durationMs}ms)`);
}

try {
  const suites = level === 'L1' ? L1_SUITE
    : level === 'L2' ? L2_SUITE
      : level === 'checks' ? LOCAL_CHECKS
        : level === 'all' ? [...L1_SUITE, ...L2_SUITE, ...LOCAL_CHECKS]
          : [];
  for (const entry of suites) {
    if (entry.command.some((part) => part.startsWith('scripts/') && !fs.existsSync(path.join(repoRoot, part)))) {
      failed = true;
      for (const matrixId of entry.matrixIds) run.record({
        matrixIds: [matrixId], name: entry.name, command: entry.displayCommand,
        assertions: ['测试文件必须存在'], evidence: [], result: 'failed', reason: '测试文件不存在',
      });
      continue;
    }
    await execute(entry);
  }
  const covered = new Set(suites.flatMap((entry) => entry.matrixIds));
  if (level !== 'onsite') {
    for (const matrixId of MATRIX_IDS.filter((id) => !covered.has(id))) {
      run.record({
        matrixIds: [matrixId], name: '本次层级未覆盖', steps: [],
        assertions: [], evidence: [], result: 'not_run', reason: `本次 --level ${level} 未执行该矩阵项；空项不作为通过`,
      });
    }
  }
  for (const gap of ONSITE_GAPS) {
    run.record({
      level: gap.level,
      matrixIds: gap.matrixIds,
      name: gap.name,
      steps: [gap.entry],
      assertions: ['现场证据必须由实际目标环境和人员产生'],
      evidence: [],
      result: 'blocked',
      reason: gap.reason,
    });
  }
} finally {
  const summary = run.finish();
  console.log(`验收证据：${run.runDirectory}`);
  console.log(`汇总：${summary}`);
}
process.exitCode = failed ? 1 : 0;
