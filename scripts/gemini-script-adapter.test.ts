import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-gemini-script-'));
try {
  const childPath = path.join(tempRoot, 'gemini-script-check.mjs');
  const adapterUrl = pathToFileURL(path.resolve('lib/script-providers/gemini.ts')).href;
  fs.writeFileSync(childPath, `
    import assert from 'node:assert/strict';
    const { geminiCompleteJson } = await import(${JSON.stringify(adapterUrl)});
    const runtime = {
      id: 'gemini', name: 'Gemini', apiStyle: 'native-gemini',
      baseUrl: 'https://example.test', apiKey: 'secret', model: 'gemini-3.6-flash',
      maxTokens: 8192, enabled: true, configured: true, missing: [], hasApiKey: true,
      supportsVision: true, visionCostPerRequest: 0,
    };
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    await assert.rejects(
      geminiCompleteJson({ systemPrompt: 'system', userPrompt: 'user', timeoutMs: 20 }, runtime),
      /请求超时/,
    );

    const cancellation = new AbortController();
    const cancelledRequest = geminiCompleteJson({
      systemPrompt: 'system', userPrompt: 'user', timeoutMs: 100, signal: cancellation.signal,
    }, runtime);
    cancellation.abort();
    await assert.rejects(cancelledRequest, /脚本生成已取消/);
  `);

  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-loader', pathToFileURL(path.resolve('scripts/typescript-extension-loader.mjs')).href,
    '--experimental-strip-types',
    childPath,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `Gemini 脚本适配器测试失败：\n${result.stderr}\n${result.stdout}`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('gemini script adapter tests passed');
