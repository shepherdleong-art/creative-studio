// scripts/runtime/ports.mjs
// 端口探测共享工具：PS/bash 启停脚本以
//   node <repoRoot>/scripts/runtime/ports.mjs <verb> ...
// 调用，行为语义对齐 scripts/stop-stack.ps1 的 Get-ListenerPids 与 Wait-PortReleased。
// 零新增依赖；用 execFile 传参数数组，禁止字符串拼 shell。

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

/** 轮询间隔（毫秒），与 stop-windows.ps1 的 Wait-PortReleased 一致。 */
const POLL_INTERVAL_MS = 500;
/** 外部命令超时：端口表/进程表过大时防止探测无限期挂起。 */
const PROCESS_TIMEOUT_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 找出监听指定 TCP 端口的进程 PID（去重）。
 *
 * - Windows：`netstat -ano`。TCP 行固定 5 列（Proto/本地/远端/状态/PID）：
 *   本地地址列以 `:<port>` 结尾即命中。状态列不做字面比较，因为非英文
 *   Windows 的 netstat 状态名会被本地化（如 LISTENING 显示为德文 ABHÖREN），
 *   只要求它不含数字与下划线（排除 TIME_WAIT 等带下划线条目）；ESTABLISHED
 *   行本地地址恰好是监听端口时 PID 也是同一个服务进程，结果无副作用。
 * - 其余平台：`lsof -ti tcp:<port> -sTCP:LISTEN`，只输出 PID。
 *   探测命令失败（占用检查、无监听、lsof 不可用）一律按空结果处理。
 *
 * @param {number} port
 * @returns {Promise<number[]>}
 */
export async function findListenerPids(port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    return [];
  }
  const pids =
    process.platform === 'win32'
      ? await findListenerPidsWindows(numericPort)
      : await findListenerPidsUnix(numericPort);
  return [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function findListenerPidsWindows(port) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('netstat', ['-ano'], {
      windowsHide: true,
      timeout: PROCESS_TIMEOUT_MS,
    }));
  } catch {
    return [];
  }
  const suffix = `:${port}`;
  const pids = [];
  for (const line of stdout.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5 || tokens[0] !== 'TCP') continue;
    if (!String(tokens[1]).endsWith(suffix)) continue;
    const state = tokens[3];
    // 状态列只看形态：非数字、非下划线（TIME_WAIT/CLOSE_WAIT 一律排除）。
    if (state.length < 3 || /[\d_]/.test(state)) continue;
    const pid = Number.parseInt(tokens[4], 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

async function findListenerPidsUnix(port) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      timeout: PROCESS_TIMEOUT_MS,
    }));
  } catch {
    // lsof 无匹配时退出码为 1；没有探测权限或未安装也按空结果处理。
    return [];
  }
  const pids = [];
  // 某些平台上多个进程共享同一描述符时会以空格/逗号分隔。
  for (const token of stdout.split(/[\s,]+/)) {
    const pid = Number.parseInt(token, 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * 轮询等待端口不再被监听，最多等 timeoutMs 毫秒。
 * 返回 true 表示已释放（或一开始就没有监听），false 表示超时。
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function waitPortReleased(port, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if ((await findListenerPids(port)).length === 0) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return (await findListenerPids(port)).length === 0;
}

function usage() {
  process.stderr.write(
    '用法:\n' +
      '  node scripts/runtime/ports.mjs listeners <port>\n' +
      '  node scripts/runtime/ports.mjs released <port> [timeoutMs]\n',
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'listeners' && rest.length === 1) {
    const port = Number(rest[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      usage();
      process.exit(2);
    }
    for (const pid of await findListenerPids(port)) {
      process.stdout.write(`${pid}\n`);
    }
    return;
  }
  if (command === 'released' && (rest.length === 1 || rest.length === 2)) {
    const port = Number(rest[0]);
    const timeoutMs = rest[1] === undefined ? 10_000 : Number(rest[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      usage();
      process.exit(2);
    }
    process.exit((await waitPortReleased(port, timeoutMs)) ? 0 : 1);
    return;
  }
  usage();
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`[ports] ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
