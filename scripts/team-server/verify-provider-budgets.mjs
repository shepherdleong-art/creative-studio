#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (name !== '--input' && name !== '--output') throw new Error('仅支持 --input 与 --output 参数');
    if (!argv[index + 1]) throw new Error(`${name} 缺少路径`);
    args[name.slice(2)] = argv[index + 1];
  }
  if (!args.input || !args.output) throw new Error('必须提供 --input 与 --output');
  return args;
}

function writeReport(outputPath, report) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function findSecretMaterial(value, pathName = '$', errors = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => findSecretMaterial(entry, pathName, errors));
    return errors;
  }
  if (value && typeof value === 'object') {
    for (const [name, entry] of Object.entries(value)) {
      if (/(?:api.?key|secret|token|password|authorization|private.?key|access.?key|master.?key)/i.test(name) || /^key$/i.test(name)) {
        errors.push({ code: 'SECRET_MATERIAL_NOT_ALLOWED', path: pathName, message: '输入不得包含凭据字段' });
      }
      findSecretMaterial(entry, pathName, errors);
    }
    return errors;
  }
  if (typeof value === 'string' && (
    /(?:sk|pk)-[A-Za-z0-9_-]{8,}/i.test(value)
    || /Bearer\s+\S+/i.test(value)
    || /AKIA[0-9A-Z]{16}/.test(value)
    || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)
    || /https?:\/\/[^\s/]+:[^\s@]+@/i.test(value)
    || /[?&](?:sig|signature|token|key|credential)=/i.test(value)
  )) {
    errors.push({ code: 'SECRET_MATERIAL_NOT_ALLOWED', path: pathName, message: '输入不得包含疑似真实凭据或带签名 URL' });
  }
  return errors;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isValidEvidenceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let input;
  try {
    input = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  } catch {
    writeReport(args.output, {
      schemaVersion: 1,
      status: 'invalid',
      verificationScope: 'structured-input-only',
      errors: [{ code: 'INVALID_JSON', path: '$', message: '输入必须是有效 JSON；原始内容不会写入报告' }],
    });
    console.error('供应商预算核验失败：输入不是有效 JSON');
    process.exitCode = 1;
    return;
  }
  const errors = findSecretMaterial(input);
  const document = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.pools) || document.pools.length === 0) {
    errors.push({ code: 'INVALID_SCHEMA', path: 'pools', message: '输入必须包含 schemaVersion=1 和至少一个共享池' });
  }
  (Array.isArray(document?.pools) ? document.pools : []).forEach((pool, poolIndex) => {
    if (!pool || typeof pool !== 'object' || Array.isArray(pool)) {
      errors.push({ code: 'INVALID_SCHEMA', path: `pools[${poolIndex}]`, message: '共享池必须是对象' });
      return;
    }
    if (
      !isNonEmptyString(pool.poolId)
      || !isNonEmptyString(pool.platform)
      || !isNonEmptyString(pool.accountRef)
      || !isNonEmptyStringArray(pool.credentialRefs)
      || !isNonEmptyStringArray(pool.models)
    ) {
      errors.push({
        code: 'INVALID_MAPPING',
        path: `pools[${poolIndex}]`,
        message: '共享池必须包含非密钥的账户/凭据引用、模型与平台映射',
      });
    }
    if (!Array.isArray(pool.callers) || pool.callers.length === 0) {
      errors.push({ code: 'INVALID_SCHEMA', path: `pools[${poolIndex}].callers`, message: '共享池必须列出全部调用者' });
      return;
    }
    if (pool.evidence?.callerInventoryComplete !== true) {
      errors.push({
        code: 'INCOMPLETE_CALLER_INVENTORY',
        path: `pools[${poolIndex}].evidence.callerInventoryComplete`,
        message: '必须由证据明确确认调用者清单完整',
      });
    }
    if (!isValidEvidenceDate(pool.evidence?.observedOn)) {
      errors.push({
        code: 'INVALID_EVIDENCE_DATE',
        path: `pools[${poolIndex}].evidence.observedOn`,
        message: '证据日期必须是真实的 YYYY-MM-DD 日期',
      });
    }
    if (!Number.isSafeInteger(pool.capacity?.maxConcurrent) || pool.capacity.maxConcurrent < 1) {
      errors.push({
        code: 'INVALID_CAPACITY',
        path: `pools[${poolIndex}].capacity.maxConcurrent`,
        message: '共享池容量必须是正整数个在途名额',
      });
    }
    for (const name of ['observedOn', 'capacityRef', 'sharedMappingRef', 'callerInventoryRef']) {
      if (typeof pool.evidence?.[name] !== 'string' || !pool.evidence[name].trim()) {
        errors.push({
          code: 'MISSING_EVIDENCE',
          path: `pools[${poolIndex}].evidence.${name}`,
          message: '缺少必需的证据字段',
        });
      }
    }
    if (!Number.isSafeInteger(pool.conservativeReserve) || pool.conservativeReserve < 1) {
      errors.push({
        code: 'MISSING_CONSERVATIVE_RESERVE',
        path: `pools[${poolIndex}].conservativeReserve`,
        message: '必须显式保留至少一个在途名额作为保守余量',
      });
    }
    for (const side of ['server', 'local']) {
      if (!pool.callers.some((caller) => caller?.side === side)) {
        errors.push({
          code: 'MISSING_CALLER_SIDE',
          path: `pools[${poolIndex}].callers`,
          message: `缺少 ${side} 侧调用者与可执行预算`,
        });
      }
    }
    pool.callers.forEach((caller, callerIndex) => {
      if (!caller || typeof caller !== 'object' || Array.isArray(caller)) {
        errors.push({ code: 'INVALID_CALLER', path: `pools[${poolIndex}].callers[${callerIndex}]`, message: '调用者必须是结构化对象' });
        return;
      }
      if (
        !isNonEmptyString(caller.callerId)
        || !['server', 'local', 'other'].includes(caller.side)
        || !isNonEmptyStringArray(caller.projects)
      ) {
        errors.push({
          code: 'INVALID_CALLER',
          path: `pools[${poolIndex}].callers[${callerIndex}]`,
          message: '调用者必须包含稳定标识、两侧/其他分类及全部本地工程',
        });
      }
      if (!Number.isSafeInteger(caller.maxConcurrent) || caller.maxConcurrent < 1) {
        errors.push({
          code: 'INVALID_BUDGET',
          path: `pools[${poolIndex}].callers[${callerIndex}].maxConcurrent`,
          message: '每个调用者必须有正整数个可执行在途名额',
        });
      }
      if (caller.coversAllProcesses !== true || !isNonEmptyString(caller.limitEvidenceRef)) {
        errors.push({
          code: 'LIMIT_NOT_ENFORCED',
          path: `pools[${poolIndex}].callers[${callerIndex}]`,
          message: '调用者必须具有覆盖其全部工程与进程的限流证据',
        });
      }
    });
    const allocated = pool.callers.reduce((total, caller) => total + (Number.isSafeInteger(caller?.maxConcurrent) ? caller.maxConcurrent : 0), 0);
    const capacity = Number.isSafeInteger(pool.capacity?.maxConcurrent) ? pool.capacity.maxConcurrent : 0;
    const reserve = Number.isSafeInteger(pool.conservativeReserve) ? pool.conservativeReserve : 0;
    if (allocated + reserve > capacity) {
      errors.push({
        code: 'BUDGET_EXCEEDED',
        path: `pools[${poolIndex}].callers`,
        message: '全部调用者预算与保守余量之和超过共享池容量',
      });
    }
  });
  if (errors.length > 0) {
    writeReport(args.output, {
      schemaVersion: 1,
      status: 'invalid',
      verificationScope: 'structured-input-only',
      errors,
    });
    console.error('供应商预算核验失败：证据不完整');
    process.exitCode = 1;
    return;
  }
  const pools = document.pools.map((pool) => {
    const allocatedConcurrent = pool.callers.reduce((total, caller) => total + caller.maxConcurrent, 0);
    return {
      poolId: pool.poolId,
      platform: pool.platform,
      accountRef: pool.accountRef,
      credentialRefs: [...pool.credentialRefs],
      models: [...pool.models],
      evidence: {
        observedOn: pool.evidence.observedOn,
        capacityRef: pool.evidence.capacityRef,
        sharedMappingRef: pool.evidence.sharedMappingRef,
        callerInventoryRef: pool.evidence.callerInventoryRef,
        callerInventoryComplete: pool.evidence.callerInventoryComplete,
      },
      capacity: { maxConcurrent: pool.capacity.maxConcurrent },
      conservativeReserve: pool.conservativeReserve,
      allocatedConcurrent,
      unallocatedHeadroom: pool.capacity.maxConcurrent - pool.conservativeReserve - allocatedConcurrent,
      callers: pool.callers.map((caller) => ({
        callerId: caller.callerId,
        side: caller.side,
        projects: [...caller.projects],
        maxConcurrent: caller.maxConcurrent,
        coversAllProcesses: caller.coversAllProcesses,
        limitEvidenceRef: caller.limitEvidenceRef,
      })),
    };
  });
  writeReport(args.output, {
    schemaVersion: 1,
    status: 'valid',
    verificationScope: 'structured-input-only',
    pools,
  });
  console.log('供应商预算结构核验通过');
}

try {
  main();
} catch {
  console.error('供应商预算核验失败');
  process.exitCode = 1;
}
