import { spawnHidden, spawnSyncHidden } from '../spawn-hidden.ts';
import fs from 'node:fs';
import { FilmRenderError } from './errors.ts';

export interface ProcessOptions { signal?: AbortSignal; timeoutMs?: number }

/** Bounded diagnostics and cancellation; resolve only after the child has exited. */
export function runCaptured(command: string, args: string[], options: ProcessOptions & {
  outputFiles?: { stdout: string; stderr: string };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  killTree?: boolean;
  onOutput?: (text: string) => void;
} = {}): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const handles: number[] = [];
    let child;
    try {
      if (options.outputFiles) {
        handles.push(fs.openSync(options.outputFiles.stdout, 'wx'));
        handles.push(fs.openSync(options.outputFiles.stderr, 'wx'));
      }
      const common = { windowsHide: true, cwd: options.cwd, env: options.env, detached: !!options.killTree && process.platform !== 'win32' };
      child = handles.length ? spawnHidden(command, args, { ...common, stdio: ['ignore', handles[0], handles[1]] })
        : spawnHidden(command, args, common);
    } catch (error) {
      handles.forEach(fd => fs.closeSync(fd));
      reject(error);
      return;
    }
    let stdout = '', stderr = '', timedOut = false, aborted = false;
    const kill = () => {
      if (options.killTree && child.pid) {
        if (process.platform === 'win32') spawnSyncHidden('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      } else child.kill('SIGKILL');
    };
    const abort = () => { aborted = true; kill(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? 300_000);
    child.stdin?.end();
    child.stdout?.on('data', (data: Buffer) => { const text = data.toString(); stdout = (stdout + text).slice(-131072); options.onOutput?.(text); });
    child.stderr?.on('data', (data: Buffer) => { const text = data.toString(); stderr = (stderr + text).slice(-131072); options.onOutput?.(text); });
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.on('close', code => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      handles.forEach(fd => fs.closeSync(fd));
      if (options.outputFiles) {
        try {
          for (const file of Object.values(options.outputFiles)) {
            if (fs.statSync(file).size > 16 * 1024 * 1024) throw new FilmRenderError('PROBE_OUTPUT_TOO_LARGE', '探针输出超过 16MB', 4);
          }
          stdout = fs.readFileSync(options.outputFiles.stdout, 'utf8');
          stderr = fs.readFileSync(options.outputFiles.stderr, 'utf8');
        } catch (error) { reject(error); return; }
      }
      if (aborted) { const error = new Error('媒体处理已中止'); error.name = 'AbortError'; reject(error); }
      else if (spawnError) reject(new FilmRenderError('TOOL_FAILED', spawnError.message, 3));
      else if (timedOut || code !== 0) reject(new FilmRenderError(timedOut ? 'PROCESS_TIMEOUT' : 'PROCESS_FAILED',
        `${command}: ${timedOut ? 'timeout' : `exit ${code}`}\n${(stdout + '\n' + stderr).trim().split('\n').slice(-40).join('\n')}`, 4));
      else resolve({ stdout, stderr });
    });
  });
}
