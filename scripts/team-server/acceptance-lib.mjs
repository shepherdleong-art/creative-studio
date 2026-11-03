import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RESULTS = new Set(['passed', 'failed', 'blocked', 'not_run']);
const SECRET_KEY = /(?:password|passwd|secret|credential|authorization|api[-_]?key|access[-_]?key|cookie|csrf|token|private[-_]?key)/i;

function rootLabel(root) {
  return `[data-root:${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12)}]`;
}

export function redactEvidence(value, dataRoots = [], key = '') {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    let text = value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/(?:__Host-team_(?:session|csrf)|x-csrf-token)=[^\s;]+/gi, '[redacted-cookie]');
    const roots = [...dataRoots].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const root of roots) {
      const resolved = path.resolve(root);
      text = text.split(resolved).join(rootLabel(resolved));
      text = text.split(resolved.replaceAll('\\', '/')).join(rootLabel(resolved));
    }
    return text;
  }
  if (Array.isArray(value)) return value.map((entry) => redactEvidence(entry, dataRoots));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      redactEvidence(entry, dataRoots, entryKey),
    ]));
  }
  return value;
}

export function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summarizeKind(entries) {
  const durations = entries.map((entry) => entry.durationMs);
  return {
    count: entries.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    serverErrors: entries.filter((entry) => entry.status >= 500).length,
  };
}

export function summarizeRequests(entries) {
  const byKind = {};
  for (const kind of new Set(entries.map((entry) => entry.kind))) {
    byKind[kind] = summarizeKind(entries.filter((entry) => entry.kind === kind));
  }
  return {
    ...summarizeKind(entries),
    serverErrorRate: entries.length ? summarizeKind(entries).serverErrors / entries.length : 0,
    byKind,
  };
}

export function createEvidenceRun({ outputRoot, level, release, config, dataRoots = [], redactionRoots = [], runId }) {
  const id = runId ?? `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('runId 只能包含字母、数字、下划线和连字符');
  const runDirectory = path.join(outputRoot, id);
  fs.mkdirSync(runDirectory, { recursive: false });
  const resultsPath = path.join(runDirectory, 'results.jsonl');
  const records = [];
  let finished = false;
  const roots = [...dataRoots.filter((root) => typeof root === 'string'), ...redactionRoots, runDirectory];
  const rootViews = () => dataRoots.map((root) => typeof root === 'string' ? rootLabel(root) : redactEvidence(root, roots));
  const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(redactEvidence(value, roots), null, 2)}\n`, 'utf8');

  return {
    runId: id,
    runDirectory,
    record(input) {
      if (finished) throw new Error('验收运行已结束');
      if (!RESULTS.has(input.result)) throw new Error(`未知验收结果：${input.result}`);
      if (!Array.isArray(input.matrixIds) || !input.matrixIds.length) throw new Error('每项证据必须关联矩阵 ID');
      if (input.result === 'passed') {
        if (!input.assertions?.length || !input.evidence?.length) throw new Error('passed 必须有非空 assertions 和 evidence');
        if (!input.command && !input.steps?.length) throw new Error('passed 必须记录实际命令或步骤');
      }
      if (['blocked', 'not_run'].includes(input.result) && !input.reason) throw new Error(`${input.result} 必须说明原因`);
      const record = redactEvidence({
        schemaVersion: 1,
        runId: id,
        level: input.level ?? level,
        matrixIds: input.matrixIds,
        name: input.name,
        at: new Date().toISOString(),
        release,
        config,
        dataRoots: rootViews(),
        command: input.command ?? null,
        steps: input.steps ?? [],
        assertions: input.assertions ?? [],
        evidence: input.evidence ?? [],
        result: input.result,
        reason: input.reason ?? null,
        durationMs: input.durationMs ?? null,
        details: input.details ?? null,
      }, roots);
      fs.appendFileSync(resultsPath, `${JSON.stringify(record)}\n`, 'utf8');
      records.push(record);
      return record;
    },
    finish() {
      if (finished) throw new Error('验收运行已结束');
      finished = true;
      const counts = { passed: 0, failed: 0, blocked: 0, not_run: 0 };
      const byLevel = {};
      for (const record of records) {
        counts[record.result] += 1;
        byLevel[record.level] ??= { passed: 0, failed: 0, blocked: 0, not_run: 0 };
        byLevel[record.level][record.result] += 1;
      }
      const summaryPath = path.join(runDirectory, 'summary.json');
      writeJson(summaryPath, {
        schemaVersion: 1,
        runId: id,
        level,
        startedAt: records[0]?.at ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        release,
        config,
        dataRoots: rootViews(),
        counts,
        byLevel,
        signedOff: counts.failed === 0 && counts.blocked === 0 && counts.not_run === 0,
        records,
      });
      return summaryPath;
    },
  };
}
