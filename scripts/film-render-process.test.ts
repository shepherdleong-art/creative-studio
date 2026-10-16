import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCaptured } from '../lib/film-render/process.ts';
import { probeMedia } from '../lib/film-render/media.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-process-中文 空格-'));
const files = (id: string) => ({ stdout: path.join(root, id + '.out'), stderr: path.join(root, id + '.err') });
try {
  const script = 'process.stdout.write("output");process.stderr.write("diagnostic");';
  assert.deepEqual(await runCaptured(process.execPath, ['-e', script]), { stdout: 'output', stderr: 'diagnostic' });
  assert.deepEqual(await runCaptured(process.execPath, ['-e', script], { outputFiles: files('ok') }), { stdout: 'output', stderr: 'diagnostic' });
  assert.equal(fs.readFileSync(files('ok').stdout, 'utf8'), 'output');
  await assert.rejects(runCaptured(process.execPath, ['-e', script], { outputFiles: files('ok') }), /EEXIST/);
  assert.equal(fs.readFileSync(files('ok').stdout, 'utf8'), 'output', 'exclusive diagnostics must not overwrite an existing file');
  await assert.rejects(runCaptured(process.execPath, ['-e', 'process.stderr.write("real failure");process.exit(7)'], { outputFiles: files('fail') }), /exit 7\nreal failure/);
  await assert.rejects(runCaptured(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { outputFiles: files('timeout'), timeoutMs: 100 }), /timeout/);
  const active = new AbortController();
  const pending = runCaptured(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { outputFiles: files('abort'), signal: active.signal });
  const timer = setTimeout(() => active.abort(), 100);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  const treeAbort = new AbortController();
  let descendant = 0;
  const tree = runCaptured(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true}); console.log(child.pid); setInterval(()=>{},1000);`],
    { signal: treeAbort.signal, killTree: true, timeoutMs: 10_000, onOutput: text => {
      descendant = Number(text.trim()); if (descendant > 0) treeAbort.abort();
    } });
  await assert.rejects(tree, { name: 'AbortError' });
  assert.ok(descendant > 0, 'child process started');
  assert.throws(() => process.kill(descendant, 0), 'cancellation must terminate the descendant before returning');
  await assert.rejects(probeMedia(path.join(root, 'missing-file.mp4'), root), /PROCESS|No such file|不存在/i);
  assert.ok(fs.readdirSync(root).every(name => !name.startsWith('probe-')), 'probe scratch files are cleaned after failure');
  // On Windows these removals also establish that the parent file handles were closed.
  for (const name of fs.readdirSync(root)) fs.unlinkSync(path.join(root, name));
  console.log('film-render processes passed: pipes, file descriptors, real errors, timeout, cancellation and cleanup');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
