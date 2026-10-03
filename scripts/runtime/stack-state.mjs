// scripts/runtime/stack-state.mjs
// stack.json 读/写/清/规整共享工具。字段语义对齐 scripts/start-stack.ps1：
//   litellmPid / proxyPort / appPort / litellmRuntime / litellmInterpreter /
//   stopScript / startedAt
// 统一 schema（均可选，读取方必须容忍缺字段）：
//   { version: 1, appPid?, appPort?, appCmdPid?, litellmPid?, litellmPort?,
//     proxyPort?, litellmRuntime?, litellmInterpreter?, stopScript?, startedAt? }
// 注意：现有 PS 写入的是 proxyPort（保留键），litellmPort 为本题 schema 的规范名，
// 两者并存，读取方缺字段容忍即可。
// 原子写（同目录 tmp + rename）、无 BOM UTF-8；读取剥离 BOM（lib/shutdown.ts 既有处理）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STACK_FILENAME = 'stack.json';

/** 整数类字段：写了但无法解析成非负整数时丢弃。 */
const INT_KEYS = ['appPid', 'appPort', 'appCmdPid', 'litellmPid', 'litellmPort', 'proxyPort'];
/** 字符串类字段：只接受非空字符串（数字/布尔按 String 纠偏）。 */
const STRING_KEYS = ['litellmRuntime', 'litellmInterpreter', 'stopScript', 'startedAt'];

/** 状态文件路径。所有本地路径一律基于调用方传入的 dataRoot。 */
export function stackFilePath(rootDir) {
  return path.join(rootDir, 'storage', 'run', STACK_FILENAME);
}

/**
 * 读取 stack.json。文件不存在返回 null；JSON 损坏返回 null 并 console.warn
 * （调用方按「无状态」兜底，绝不因损坏文件轰炸停机链）。
 */
export function readStackState(rootDir) {
  const filePath = stackFilePath(rootDir);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    console.warn(`[stack-state] 无法解析 ${filePath}，按无状态处理`);
    return null;
  }
}

export function clearStackState(rootDir) {
  try {
    fs.unlinkSync(stackFilePath(rootDir));
  } catch {
    // 文件不存在或已清理：幂等。
  }
}

/**
 * 只保留已知键并按类型纠偏，剥掉未知/损坏字段。
 * 输入不是普通对象时返回 null。
 */
export function normalizeStackState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const normalized = {};
  const version = Number(input.version);
  if (version === 1) normalized.version = 1;
  for (const key of INT_KEYS) {
    const value = input[key];
    if (value === null || value === undefined) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) normalized[key] = Math.trunc(n);
  }
  for (const key of STRING_KEYS) {
    const value = input[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      if (value.length > 0) normalized[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = String(value);
    }
  }
  return normalized;
}

/**
 * 原子写 stack.json：同目录 tmp 文件 + rename，无 BOM UTF-8。
 * version 缺失时补为 1。写失败原样抛出（调用方决定是否让停机链继续）。
 */
export function writeStackState(rootDir, state) {
  const normalized = normalizeStackState(state) ?? {};
  if (normalized.version !== 1) normalized.version = 1;
  const filePath = stackFilePath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  // payload 不写 BOM：utf8 编码天然无 BOM。
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Windows 的 rename 无法覆盖已存在目标；该路径是确定受控的状态文件，
    // 只为这次原子更新移除旧目标。
    try {
      fs.unlinkSync(filePath);
    } catch {
      // 旧文件可能已不存在。
    }
    fs.renameSync(tmpPath, filePath);
  }
}

function usage() {
  process.stderr.write(
    '用法:\n' +
      '  node scripts/runtime/stack-state.mjs read <dataRoot>\n' +
      '  node scripts/runtime/stack-state.mjs clear <dataRoot>\n' +
      '  node scripts/runtime/stack-state.mjs write <dataRoot>   # JSON 从 stdin 读入\n',
  );
}

function main() {
  const [command, rootDir] = process.argv.slice(2);
  if (!rootDir) {
    usage();
    process.exit(2);
  }
  if (command === 'read') {
    // 文件不存在或损坏都打印 null 并退出 0：调用方按「无状态」兜底。
    process.stdout.write(`${JSON.stringify(readStackState(rootDir))}\n`);
    return;
  }
  if (command === 'clear') {
    clearStackState(rootDir);
    return;
  }
  if (command === 'write') {
    // 剥离 BOM：PowerShell 管道按 $OutputEncoding 写 stdin，UTF8Encoding 默认构造带 BOM，
    // JSON.parse 不接受 \uFEFF 前缀（与 readStackState 的 BOM 容忍对齐）。
    const text = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      process.stderr.write('[stack-state] stdin 不是合法 JSON\n');
      process.exit(1);
    }
    writeStackState(rootDir, parsed);
    return;
  }
  usage();
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
