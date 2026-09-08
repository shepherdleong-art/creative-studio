// scripts/runtime/process-tree.mjs
// 进程归属与进程树销毁共享工具。行为语义对齐：
// - scripts/stop-stack.ps1 的 Test-RootOwnedProcess / Test-OwnedProcess（CIM 命令行/可执行路径归属）
// - stop-desktop.command 的 cwd 校验（lsof / macOS 无 /proc）
// - desktop/service.ts 的停机树（Windows taskkill /T /F；unix 进程组 SIGTERM → 2s → SIGKILL）
// 零新增依赖；只用 execFile + 参数数组，禁止字符串拼 shell。

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

/** PowerShell CIM 查询超时：调用方在 node 里再起 powershell，单次 ~0.5-1.5s 属可接受。 */
const CIM_TIMEOUT_MS = 15_000;
const PS_TIMEOUT_MS = 10_000;
const LSOF_TIMEOUT_MS = 10_000;
const TASKKILL_TIMEOUT_MS = 20_000;
/** unix 下 SIGTERM 后等待退出的窗口，与 service.ts 的 FORCE_EXIT_TIMEOUT_MS 一致。 */
const TERM_WAIT_MS = 2_000;

const isWindows = process.platform === 'win32';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 路径分隔符归一到 `/` 并去掉尾部斜杠；Windows 下比较时统一转小写。 */
function normalizePath(value) {
  return String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

function compareRoot(rootDir) {
  const root = normalizePath(rootDir);
  return isWindows ? root.toLowerCase() : root;
}

/** candidate 是否位于 rootDir 之内（含相等）。有路径边界，避免 C:/foo 误判 C:/foobar。 */
function isUnderRoot(candidate, root) {
  const cand = normalizePath(candidate);
  const c = isWindows ? cand.toLowerCase() : cand;
  return c === root || c.startsWith(`${root}/`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 命令行归属检查：在命令行的「路径上下文」中找 rootDir。
 * 与参考实现的 indexOf 语义接近，但做边界约束（root 之后必须是路径延续、
 * 引号/空白/结尾），不会把 I:/m7-studio2 误判为 I:/m7-studio 下的路径。
 */
function commandLineContainsRoot(commandLine, root) {
  if (!commandLine) return false;
  const line = normalizePath(commandLine);
  const haystack = isWindows ? line.toLowerCase() : line;
  const pattern = new RegExp(`${escapeRegExp(root)}(?=[^A-Za-z0-9_.-]|$)`);
  return pattern.test(haystack);
}

function toNullableInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toNullableString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 获取进程信息：pid/ppid/executablePath/commandLine/cwd。
 * 进程不存在返回 null（探测失败也按不存在处理——调用方用于归属校验，
 * 失败时不做任何杀进程动作是安全的）。
 *
 * windows 语义：
 *   - PowerShell CIM：ExecutablePath/CommandLine/ParentProcessId。
 *   - 注意 Windows 的 Get-CimInstance 对高权限/系统进程可能拿不到
 *     ExecutablePath（置 null），此时只依赖 CommandLine 判定。
 *   - Windows 无 cwd 概念，返回 null。
 * unix 语义：
 *   - ps 取 pid/ppid/args；cwd 用 lsof -a -p <pid> -d cwd -Fn（macOS 无 /proc）。
 *
 * @param {number} pid
 * @returns {Promise<{pid:number, ppid:number|null, executablePath:string|null, commandLine:string|null, cwd:string|null}|null>}
 */
export async function getProcessInfo(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  return isWindows
    ? getProcessInfoWindows(numericPid)
    : getProcessInfoUnix(numericPid);
}

async function getProcessInfoWindows(pid) {
  let stdout;
  try {
    // 输出编码先固定为 UTF-8：PS 5.1 让 stdout 走管道时默认用 OEM 代码页，
    // 非 ASCII 的命令行（如中文路径）会被改写，导致归属校验失效。
    const script = [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
      `$proc = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue |
        Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine`,
      'if (-not $proc) { exit 0 }',
      'ConvertTo-Json -InputObject $proc -Compress',
    ].join('; ');
    ({ stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: CIM_TIMEOUT_MS },
    ));
  } catch {
    return null;
  }
  const text = stdout.trim();
  if (!text) return null;
  try {
    const raw = JSON.parse(text);
    const row = Array.isArray(raw) ? raw[0] : raw;
    if (!row || typeof row !== 'object') return null;
    return {
      pid,
      ppid: toNullableInt(row.ParentProcessId),
      executablePath: toNullableString(row.ExecutablePath),
      commandLine: toNullableString(row.CommandLine),
      cwd: null,
    };
  } catch {
    return null;
  }
}

async function getProcessInfoUnix(pid) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('ps', ['-o', 'pid=,ppid=,args=', '-p', String(pid)], {
      timeout: PS_TIMEOUT_MS,
    }));
  } catch {
    // ps 对不存在的进程通常退出码 1；其他失败同样按「不存在」处理。
    return null;
  }
  const text = stdout.trim();
  if (!text) return null;
  const firstLine = text.split(/\r?\n/, 1)[0];
  const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(firstLine ?? '');
  if (!match) return null;
  return {
    pid,
    ppid: toNullableInt(match[2]),
    executablePath: null,
    commandLine: match[3] || null,
    cwd: await getCwdUnix(pid),
  };
}

async function getCwdUnix(pid) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      timeout: LSOF_TIMEOUT_MS,
    });
    for (const line of stdout.split(/\r?\n/)) {
      // -Fn 的输出形如: p<pid> / n<cwd>；n 行即工作目录。
      if (line.startsWith('n')) {
        const cwd = toNullableString(line.slice(1));
        if (cwd) return cwd;
      }
    }
  } catch {
    // lsof 无结果退出码 1；未安装或无权限时无法取得 cwd，按 null 处理。
  }
  return null;
}

/**
 * pid 进程是否属于 rootDir 下的项目进程：可执行路径、工作目录、命令行
 * 三者任一解析后位于 rootDir 内即视为属于（路径分隔符归一；Windows 大小写不敏感）。
 * 进程不存在或信息不可得返回 false——用于 fail-closed 语义：归属存疑即不杀。
 *
 * @param {number} pid
 * @param {string} rootDir
 * @returns {Promise<boolean>}
 */
export async function isOwnedByRoot(pid, rootDir) {
  const info = await getProcessInfo(pid);
  if (!info) return false;
  const root = compareRoot(rootDir);
  if (!root) return false;
  if (info.cwd && isUnderRoot(info.cwd, root)) return true;
  if (info.executablePath && isUnderRoot(info.executablePath, root)) return true;
  return commandLineContainsRoot(info.commandLine, root);
}

/**
 * 销毁 pid 的进程树。返回 true 表示已发出终止信号（或确认进程中止），
 * false 表示目标在动手前已经不存在（调用方可视为已停止）。
 * 其他失败原样抛出，由调用方决定是否升级处理。
 *
 * windows：taskkill /PID <pid> /T /F（一次到位，与 stop-*.ps1 一致）。
 * unix：优先按进程组 SIGTERM（桌面服务是 detached 启动的独立进程组），
 *       进程组不存在（ESRCH/EPERM）时退化到单进程；2s 后仍存活补 SIGKILL。
 *
 * @param {number} pid
 * @returns {Promise<boolean>}
 */
export async function killTree(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  return isWindows ? killTreeWindows(numericPid) : killTreeUnix(numericPid);
}

async function killTreeWindows(pid) {
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: TASKKILL_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    // taskkill 的报错文本是本地化的（中文 Windows 输出 GBK，无法按关键字判断），
    // 因此用进程存在性探针区分「已不在」（正常，视为已停止）与真实失败。
    try {
      process.kill(pid, 0);
    } catch (probeError) {
      if (probeError.code === 'ESRCH') return false;
    }
    throw error;
  }
}

async function killTreeUnix(pid) {
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH' || error.code === 'EPERM') {
        // 该 PID 不是进程组组长：退化到单进程信号。
        try {
          process.kill(pid, sig);
          return true;
        } catch (directError) {
          if (directError.code === 'ESRCH') return false;
          throw directError;
        }
      }
      throw error;
    }
  };
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal('SIGTERM')) return false;
  await sleep(TERM_WAIT_MS);
  if (!alive()) return true;
  signal('SIGKILL');
  return true;
}

function usage() {
  process.stderr.write(
    '用法:\n' +
      '  node scripts/runtime/process-tree.mjs check-owner <pid> <rootDir>\n' +
      '  node scripts/runtime/process-tree.mjs kill-tree <pid>\n',
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'check-owner' && rest.length === 2) {
    const pid = Number(rest[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
      usage();
      process.exit(2);
    }
    process.exit((await isOwnedByRoot(pid, rest[1])) ? 0 : 1);
    return;
  }
  if (command === 'kill-tree' && rest.length === 1) {
    const pid = Number(rest[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
      usage();
      process.exit(2);
    }
    // 信号已发出（true）或目标本就已不存在（false）都算成功；其他错误 throw 后走 exit 1。
    await killTree(pid);
    process.exit(0);
    return;
  }
  usage();
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`[process-tree] ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
