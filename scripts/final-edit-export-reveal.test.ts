import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const publishedPath = 'projects/example/成片/包装成片.mp4';
const renderJob = { id: 'render-1', status: 'succeeded', output: { packagingDeferred: true, packagingJobId: 'packaging-1' } };
const packagingJob = { id: 'packaging-1', status: 'succeeded', output: { publishedVideoRelativePath: publishedPath } };

// Exercise the actual route without opening Explorer or connecting to the user's database.
const routeSource = fs.readFileSync('app/api/final-edit-jobs/[id]/reveal/route.ts', 'utf8');
const routeModule: { exports: { POST?: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> } } = { exports: {} };
const revealed: string[] = [];
const routeRequire = (id: string): unknown => {
  if (id === 'next/server') return { NextResponse: Response };
  // 只有任务表能查到这条包装任务；实拍交付表查不到，走普通成片的定位路径。
  if (id === '@/lib/db') return { getDb: () => ({ prepare: (sql: string) => ({ get: (jobId: string) => sql.includes('FROM final_edit_jobs') && jobId === packagingJob.id
    ? { status: 'succeeded', outputJson: JSON.stringify(packagingJob.output) }
    : undefined }) }) };
  if (id === '@/lib/data-root') return { dataRoot: () => path.resolve('outputs/reveal-test') };
  if (id === '@/lib/final-edit/desktop-reveal') return {
    desktopRevealAvailable: () => true,
    resolvePublishedVideoForReveal: (_root: string, json: string) => JSON.parse(json).publishedVideoRelativePath,
    revealPublishedVideo: async (file: string) => { revealed.push(file); },
  };
  return require(id.startsWith('@/') ? path.resolve(`${id.slice(2)}.ts`) : id);
};
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
vm.runInNewContext(compile(routeSource), { require: routeRequire, module: routeModule, exports: routeModule.exports, URL });
const post = routeModule.exports.POST!;
const context = { params: Promise.resolve({ id: packagingJob.id }) };
const request = (origin: string | null, host = '127.0.0.1:2464', action = 'reveal') => new Request('http://localhost:2464/api/final-edit-jobs/packaging-1/reveal', {
  method: 'POST', headers: { host, 'x-creative-studio-action': action, ...(origin === null ? {} : { origin }) },
});
const local = await post(request('http://127.0.0.1:2464'), context);
assert.equal(local.status, 200, `桌面同源请求不应被 Next 内部 localhost URL 误拒：${await local.text()}`);
assert.deepEqual(revealed, [publishedPath]);
for (const origin of ['http://localhost:2464', 'http://127.0.0.1:9999', 'https://127.0.0.1:2464', 'https://example.com', 'null', 'invalid-origin']) {
  assert.equal((await post(request(origin), context)).status, 403, `拒绝非同源或非法来源：${origin}`);
}
assert.equal((await post(request('http://127.0.0.1:2464', '127.0.0.1:2464', ''), context)).status, 403);
assert.equal((await post(request(null), context)).status, 200, '保留带工作台标记的无 Origin 本地调用');

// Run the real click handler with both desktop IPC and HTTP fallback, including the two-job chain.
const source = fs.readFileSync('components/mixcut/ExportStep.tsx', 'utf8');
const start = source.indexOf('  const reveal = async () => {');
const end = source.indexOf('\n  const effectiveTarget', start);
assert.ok(start >= 0 && end > start, '定位导出页面的真实文件定位回调');
const handler = compile(`${source.slice(start, end)}\nreveal();`);
async function clickReveal(job: unknown, packaged: unknown, desktop: boolean) {
  const nativePaths: string[] = [];
  const requests: string[] = [];
  let error = '';
  await vm.runInNewContext(handler, {
    job, packagingJob: packaged,
    window: desktop ? { desktopBridge: { revealItem: async (file: string) => { nativePaths.push(file); return { revealed: true }; } } } : {},
    setRevealError: (value: string) => { error = value; },
    fetch: async (url: string) => { requests.push(url); return Response.json({ revealed: true }); },
    readJson: async (response: Response) => response.json(),
    encodeURIComponent,
  });
  assert.equal(error, '');
  return { nativePaths, requests };
}
assert.deepEqual(await clickReveal(renderJob, packagingJob, true), { nativePaths: [`storage/${publishedPath}`], requests: [] });
assert.deepEqual(await clickReveal(renderJob, packagingJob, false), { nativePaths: [], requests: ['/api/final-edit-jobs/packaging-1/reveal'] });
const original = { id: 'original-1', status: 'succeeded', output: { publishedVideoRelativePath: 'projects/example/成片/原片.mp4' } };
assert.deepEqual(await clickReveal(original, packagingJob, false), { nativePaths: [], requests: ['/api/final-edit-jobs/original-1/reveal'] }, '切换导出后不能沿用旧包装任务');
assert.deepEqual(await clickReveal(original, null, true), { nativePaths: ['storage/projects/example/成片/原片.mp4'], requests: [] });
console.log('final-edit export reveal: same-origin route, cross-origin rejection, packaged IPC/HTTP and original export passed');
