// 统一子进程入口（§10 ③ CMD 弹窗治理收口）。
// 规则：lib/app 内所有 node:child_process 的 spawn/spawnSync/execFile/execFileSync
// 一律改走本封装——强制 windowsHide:true，杜绝 Windows 下弹出黑色 CMD 窗口。
// 防回归：开发期（NODE_ENV!=='production'）断言调用方显式声明了 windowsHide，
// 让「漏写 windowsHide」在开发阶段直接抛错，而不是等用户桌面弹窗才发现。
// 例外（故意开窗、不经本封装）：文件管理器 reveal
//（lib/final-edit/desktop-reveal.ts、app/api/batch-production/batches/[id]/exports/reveal/route.ts）。

import {
  spawn,
  spawnSync,
  execFile,
  execFileSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type ExecFileOptionsWithStringEncoding,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithBufferEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnOptionsWithoutStdio,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';

/** 开发期断言：options 必须显式包含 windowsHide 字段（封装最终都会强制 true，断言只为防回归）。 */
function assertWindowsHideDeclared(options: unknown, api: string): void {
  if (process.env.NODE_ENV === 'production') return;
  const declared = options !== null && typeof options === 'object' && 'windowsHide' in options;
  if (!declared) {
    throw new Error(
      `${api} 调用缺少显式 windowsHide 声明。统一子进程入口要求调用方显式写出 windowsHide: true（§10 ③ 防回归断言，仅开发期触发）。`,
    );
  }
}

/** 默认 pipe 保留非空流类型；文件描述符重定向返回可空流的 ChildProcess。 */
export function spawnHidden(command: string, args?: readonly string[], options?: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
export function spawnHidden(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
export function spawnHidden(command: string, args: readonly string[] = [], options?: SpawnOptions): ChildProcess {
  assertWindowsHideDeclared(options, 'spawn');
  return spawn(command, args, { ...options, windowsHide: true });
}

export function spawnSyncHidden(command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function spawnSyncHidden(command: string, args: readonly string[], options: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
export function spawnSyncHidden(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
export function spawnSyncHidden(
  command: string,
  args: readonly string[] = [],
  options?: SpawnSyncOptionsWithStringEncoding | SpawnSyncOptionsWithBufferEncoding | SpawnSyncOptions,
): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  assertWindowsHideDeclared(options, 'spawnSync');
  return spawnSync(command, args, { ...(options as SpawnSyncOptions | undefined), windowsHide: true } as SpawnSyncOptions) as SpawnSyncReturns<string> | SpawnSyncReturns<Buffer>;
}

type ExecFileStringCallback = (error: Error | null, stdout: string, stderr: string) => void;

export function execFileHidden(command: string, options: ExecFileOptionsWithStringEncoding, callback: ExecFileStringCallback): ChildProcess;
export function execFileHidden(command: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding, callback: ExecFileStringCallback): ChildProcess;
export function execFileHidden(
  command: string,
  argsOrOptions: readonly string[] | ExecFileOptionsWithStringEncoding,
  optionsOrCallback: ExecFileOptionsWithStringEncoding | ExecFileStringCallback,
  maybeCallback?: ExecFileStringCallback,
): ChildProcess {
  const hasArgs = Array.isArray(argsOrOptions);
  const options = (hasArgs ? optionsOrCallback : argsOrOptions) as ExecFileOptionsWithStringEncoding;
  const callback = (hasArgs ? maybeCallback : optionsOrCallback) as ExecFileStringCallback;
  assertWindowsHideDeclared(options, 'execFile');
  const merged = { ...(options as ExecFileOptionsWithStringEncoding | undefined), windowsHide: true };
  return hasArgs
    ? execFile(command, argsOrOptions as readonly string[], merged, callback)
    : execFile(command, undefined, merged, callback);
}

export function execFileSyncHidden(command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function execFileSyncHidden(command: string, args?: readonly string[], options?: ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function execFileSyncHidden(command: string, args?: readonly string[], options?: ExecFileSyncOptions): Buffer;
export function execFileSyncHidden(
  command: string,
  args: readonly string[] = [],
  options?: ExecFileSyncOptionsWithStringEncoding | ExecFileSyncOptionsWithBufferEncoding | ExecFileSyncOptions,
): string | Buffer {
  assertWindowsHideDeclared(options, 'execFileSync');
  return execFileSync(command, args, { ...(options as ExecFileSyncOptions | undefined), windowsHide: true } as ExecFileSyncOptions) as string | Buffer;
}
