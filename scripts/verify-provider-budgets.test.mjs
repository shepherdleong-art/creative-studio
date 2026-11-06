import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolPath = path.join(root, 'scripts', 'team-server', 'verify-provider-budgets.mjs');

function validInput() {
  return {
    schemaVersion: 1,
    pools: [
      {
        poolId: 'qiniu-shared',
        platform: 'qiniu',
        accountRef: 'account-main',
        credentialRefs: ['key-ref-a', 'key-ref-b'],
        models: ['image2', 'video-main'],
        evidence: {
          observedOn: '2026-11-02',
          capacityRef: 'console-capacity-001',
          sharedMappingRef: 'owner-mapping-001',
          callerInventoryRef: 'inventory-001',
          callerInventoryComplete: true,
        },
        capacity: { maxConcurrent: 70 },
        conservativeReserve: 10,
        callers: [
          {
            callerId: 'server',
            side: 'server',
            projects: ['creative-studio-server'],
            maxConcurrent: 30,
            coversAllProcesses: true,
            limitEvidenceRef: 'server-limit-001',
          },
          {
            callerId: 'local',
            side: 'local',
            projects: ['reassembled-agent', 'm7-studio'],
            maxConcurrent: 20,
            coversAllProcesses: true,
            limitEvidenceRef: 'local-limit-001',
          },
          {
            callerId: 'partner',
            side: 'other',
            projects: ['partner-automation'],
            maxConcurrent: 5,
            coversAllProcesses: true,
            limitEvidenceRef: 'partner-limit-001',
          },
        ],
      },
    ],
  };
}

function runTool(t, input, { raw = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-budgets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'budgets.json');
  const outputPath = path.join(dir, 'report.json');
  fs.writeFileSync(inputPath, raw ? input : `${JSON.stringify(input, null, 2)}\n`, 'utf8');
  const result = spawnSync(process.execPath, [toolPath, '--input', inputPath, '--output', outputPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const report = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : null;
  return { result, report, outputPath };
}

test('有效共享池输入计算服务器、本地与其他调用者的总预算及保守余量', (t) => {
  const { result, report } = runTool(t, validInput());
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(report.status, 'valid');
  assert.equal(report.verificationScope, 'structured-input-only');
  assert.equal(report.pools[0].capacity.maxConcurrent, 70);
  assert.equal(report.pools[0].conservativeReserve, 10);
  assert.equal(report.pools[0].allocatedConcurrent, 55);
  assert.equal(report.pools[0].unallocatedHeadroom, 5);
  assert.deepEqual(
    report.pools[0].callers.map(({ callerId, maxConcurrent }) => ({ callerId, maxConcurrent })),
    [
      { callerId: 'server', maxConcurrent: 30 },
      { callerId: 'local', maxConcurrent: 20 },
      { callerId: 'partner', maxConcurrent: 5 },
    ],
  );
});

test('缺少额度共享关系证据时生成失败报告并非零退出', (t) => {
  const input = validInput();
  delete input.pools[0].evidence.sharedMappingRef;
  const { result, report } = runTool(t, input);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(report.status, 'invalid');
  assert.ok(
    report.errors.some((error) => error.code === 'MISSING_EVIDENCE' && error.path === 'pools[0].evidence.sharedMappingRef'),
    JSON.stringify(report.errors),
  );
});

test('容量、双边调用者和可执行限流缺一项都 fail closed', (t) => {
  const overallocated = validInput();
  overallocated.pools[0].callers[0].maxConcurrent = 61;
  const overResult = runTool(t, overallocated);
  assert.equal(overResult.result.status, 1);
  assert.ok(overResult.report.errors.some((error) => error.code === 'BUDGET_EXCEEDED'));

  const missingLocal = validInput();
  missingLocal.pools[0].callers = missingLocal.pools[0].callers.filter((caller) => caller.side !== 'local');
  const missingResult = runTool(t, missingLocal);
  assert.equal(missingResult.result.status, 1);
  assert.ok(missingResult.report.errors.some((error) => error.code === 'MISSING_CALLER_SIDE'));

  const unenforced = validInput();
  unenforced.pools[0].callers[1].coversAllProcesses = false;
  const unenforcedResult = runTool(t, unenforced);
  assert.equal(unenforcedResult.result.status, 1);
  assert.ok(unenforcedResult.report.errors.some((error) => error.code === 'LIMIT_NOT_ENFORCED'));

  const noReserve = validInput();
  noReserve.pools[0].conservativeReserve = 0;
  const reserveResult = runTool(t, noReserve);
  assert.equal(reserveResult.result.status, 1);
  assert.ok(reserveResult.report.errors.some((error) => error.code === 'MISSING_CONSERVATIVE_RESERVE'));
});

test('输入夹带 Key 字段或疑似真实 Key 时拒绝且任何输出均不回显', (t) => {
  const sentinel = 'sk-live-DO-NOT-ECHO-1234567890';
  const withKeyField = validInput();
  withKeyField.pools[0].apiKey = sentinel;
  const withKeyValue = validInput();
  withKeyValue.pools[0].credentialRefs[0] = sentinel;

  for (const input of [withKeyField, withKeyValue]) {
    const { result, report } = runTool(t, input);
    assert.equal(result.status, 1);
    assert.ok(report.errors.some((error) => error.code === 'SECRET_MATERIAL_NOT_ALLOWED'));
    const allOutput = result.stdout + result.stderr + JSON.stringify(report);
    assert.ok(!allOutput.includes(sentinel), '报告与控制台不得回显凭据明文');
  }
});

test('结构、证据日期、容量和调用者清单完整性不可用时均返回无效报告', (t) => {
  const missingCallers = validInput();
  delete missingCallers.pools[0].callers;
  const missingCallersResult = runTool(t, missingCallers);
  assert.equal(missingCallersResult.result.status, 1);
  assert.ok(missingCallersResult.report.errors.some((error) => error.code === 'INVALID_SCHEMA'));

  const badDate = validInput();
  badDate.pools[0].evidence.observedOn = '2026-02-30';
  const badDateResult = runTool(t, badDate);
  assert.equal(badDateResult.result.status, 1);
  assert.ok(badDateResult.report.errors.some((error) => error.code === 'INVALID_EVIDENCE_DATE'));

  const badCapacity = validInput();
  badCapacity.pools[0].capacity.maxConcurrent = 70.5;
  const badCapacityResult = runTool(t, badCapacity);
  assert.equal(badCapacityResult.result.status, 1);
  assert.ok(badCapacityResult.report.errors.some((error) => error.code === 'INVALID_CAPACITY'));

  const missingCapacity = validInput();
  delete missingCapacity.pools[0].capacity;
  const missingCapacityResult = runTool(t, missingCapacity);
  assert.equal(missingCapacityResult.result.status, 1);
  assert.ok(missingCapacityResult.report.errors.some((error) => error.code === 'INVALID_CAPACITY'));

  const incompleteInventory = validInput();
  incompleteInventory.pools[0].evidence.callerInventoryComplete = false;
  const inventoryResult = runTool(t, incompleteInventory);
  assert.equal(inventoryResult.result.status, 1);
  assert.ok(inventoryResult.report.errors.some((error) => error.code === 'INCOMPLETE_CALLER_INVENTORY'));
});

test('无效 JSON 的错误报告不包含输入片段或凭据', (t) => {
  const sentinel = 'sk-live-INVALID-JSON-DO-NOT-ECHO';
  const raw = `{"schemaVersion":1,"apiKey":"${sentinel}",`;
  const { result, report } = runTool(t, raw, { raw: true });
  assert.equal(result.status, 1);
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'INVALID_JSON'));
  assert.ok(!(result.stdout + result.stderr + JSON.stringify(report)).includes(sentinel));
});

test('共享池映射、调用者工程或预算数值不完整时不得产出有效预算', (t) => {
  const missingMapping = validInput();
  missingMapping.pools[0].credentialRefs = [];
  const mappingResult = runTool(t, missingMapping);
  assert.equal(mappingResult.result.status, 1);
  assert.ok(mappingResult.report.errors.some((error) => error.code === 'INVALID_MAPPING'));

  const missingProjects = validInput();
  missingProjects.pools[0].callers[1].projects = [];
  const projectsResult = runTool(t, missingProjects);
  assert.equal(projectsResult.result.status, 1);
  assert.ok(projectsResult.report.errors.some((error) => error.code === 'INVALID_CALLER'));

  const badBudget = validInput();
  badBudget.pools[0].callers[0].maxConcurrent = 0;
  const budgetResult = runTool(t, badBudget);
  assert.equal(budgetResult.result.status, 1);
  assert.ok(budgetResult.report.errors.some((error) => error.code === 'INVALID_BUDGET'));

  const nullRootResult = runTool(t, 'null', { raw: true });
  assert.equal(nullRootResult.result.status, 1);
  assert.ok(nullRootResult.report.errors.some((error) => error.code === 'INVALID_SCHEMA'));
});

test('有效报告只复制约定字段，不转发多余原始载荷', (t) => {
  const input = validInput();
  input.pools[0].evidence.unrequestedPayload = 'DO-NOT-COPY-EVIDENCE';
  input.pools[0].callers[0].unrequestedPayload = 'DO-NOT-COPY-CALLER';
  const { result, report } = runTool(t, input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('DO-NOT-COPY-EVIDENCE'));
  assert.ok(!serialized.includes('DO-NOT-COPY-CALLER'));
});
