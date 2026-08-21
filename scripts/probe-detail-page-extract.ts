/**
 * 诊断探针：详情页卖点提取 PoC。
 * 验证设计文档 docs/superpowers/specs/2026-08-20-detail-page-selling-point-extraction-design.md
 * 待验证清单 #3（单次请求图片张数上限）、#4（中文 OCR 质量）、#6（token 计费）、#7（端到端耗时）。
 *
 * 按设计参数切片（宽>1024 缩到 1024、片高 1024、重叠 12%、JPEG q88、raw 单次解码逐片 extract），
 * 一次请求塞全部切片，走公司 scope（Luna / GPT-5-6-Luna-Standard，适配器强制 temperature=1，
 * 图片经 COS 预签名 URL 传输）。真实调用公司网关并上传 COS，会产生费用。
 *
 * 产物落 outputs/detail-page-probe/（gitignored）：切片 JPEG、提示词、模型原始返回、摘要。
 * 只读数据库（供应商配置 + 用量记录），不写入任何业务数据。
 *
 * 注意：lib/script-providers 内部存在无扩展名导入，必须带仓库的 TS 扩展加载器运行：
 *   node --no-warnings --experimental-loader "$PWD/scripts/typescript-extension-loader.mjs" \
 *     --experimental-strip-types scripts/probe-detail-page-extract.ts
 * 可选环境变量：
 *   PROBE_MAX_TILES=3     只取每张图前 N 片（冒烟用）
 *   PROBE_PAGES=1         只跑第 1 页（默认 1,2）
 *   PROBE_PROVIDER_ID=…   覆盖供应商 id（默认本机公司 GPT-5-5）
 *   PROBE_DIRECT=kimi     不落库直连模式：手工构造 Kimi-K3 的 company 运行时，
 *                         绕开供应商配置表（该行缺 API Key），验证其视觉能力
 *
 * 2026-08-21 实测备注：设计稿假设的 Luna（GPT-5-6-Luna-Standard）本机最初缺失——
 * config.yaml 只有 Kimi-K3（非视觉）与 GPT-5-5，且公司 token 对两者均无访问权限。
 * 已按用户指示把 config.yaml 的 GPT-5-5 条目替换为 GPT-5-6-Luna-Standard，并把供应商表
 * 「公司 LiteLLM · GPT-5-5」一行（id a94f6d47-4266-4b06-bbd4-89d273f06dbc）改名改模型，
 * 最小请求验证 200。本探针默认走该供应商；temperature=1 由适配器对 GPT-5-6-Luna 前缀强制。
 */
import fs from 'node:fs';
import path from 'node:path';

// 静默加载 .env.local（COS 密钥等），不打印。
for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const { default: sharp } = await import('sharp');
const { completeJson } = await import('../lib/script-providers/index.ts');
const { isCosMediaConfigured } = await import('../lib/cos-media.ts');

const MAX_TILE_EDGE = 1024;
const OVERLAP_RATIO = 0.12;
const TILE_HEIGHT = 1024;
const STRIDE = Math.round(TILE_HEIGHT * (1 - OVERLAP_RATIO));
const JPEG_QUALITY = 88;

const PROVIDER_ID = process.env.PROBE_PROVIDER_ID || 'a94f6d47-4266-4b06-bbd4-89d273f06dbc';
const SOURCES = [
  { page: 1, file: '/Volumes/ITGZ-1G/0605/PK4X-A组合-商品详情1200-四件套-(1).jpg' },
  { page: 2, file: '/Volumes/ITGZ-1G/0605/PK4X-A组合-商品详情1200-四件套-(2).jpg' },
];

const maxTilesPerPage = process.env.PROBE_MAX_TILES ? Number(process.env.PROBE_MAX_TILES) : Infinity;
const pagesFilter = new Set((process.env.PROBE_PAGES || '1,2').split(',').map((s) => Number(s.trim())));

const outDir = path.resolve(`outputs/detail-page-probe${process.env.PROBE_OUT_SUFFIX || ''}`);
fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true });

function tileTops(height: number): number[] {
  if (height <= TILE_HEIGHT) return [0];
  const count = Math.ceil((height - TILE_HEIGHT) / STRIDE) + 1;
  return Array.from({ length: count }, (_, i) => Math.min(i * STRIDE, height - TILE_HEIGHT));
}

type Tile = { id: string; page: number; top: number; buffer: Buffer };

async function cutTiles(page: number, file: string): Promise<Tile[]> {
  const meta = await sharp(file).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  if (!srcW || !srcH) throw new Error(`无法读取图片尺寸: ${file}`);
  const scale = srcW > MAX_TILE_EDGE ? MAX_TILE_EDGE / srcW : 1;
  // 先等比缩放（如需要），再一次解码成 raw，逐片 extract，避免把长图重复解码 N 次。
  const { data, info } = await sharp(file)
    .resize({ width: scale < 1 ? MAX_TILE_EDGE : srcW, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  console.log(`第 ${page} 页：原生 ${srcW}×${srcH} → 切片坐标系 ${info.width}×${info.height}（缩放 ${scale.toFixed(3)}）`);
  let tops = tileTops(info.height);
  if (tops.length > maxTilesPerPage) {
    console.log(`  PROBE_MAX_TILES=${maxTilesPerPage}，只取前 ${maxTilesPerPage} 片`);
    tops = tops.slice(0, maxTilesPerPage);
  }
  const tiles: Tile[] = [];
  for (const [index, top] of tops.entries()) {
    const height = Math.min(TILE_HEIGHT, info.height - top);
    const buffer = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .extract({ left: 0, top, width: info.width, height })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    const id = `p${page}-t${String(index + 1).padStart(2, '0')}`;
    fs.writeFileSync(path.join(outDir, 'tiles', `${id}.jpg`), buffer);
    tiles.push({ id, page, top, buffer });
  }
  console.log(`  切出 ${tiles.length} 片（步进 ${STRIDE}，末片 top=${tops[tops.length - 1]}）`);
  return tiles;
}

const allTiles: Tile[] = [];
for (const source of SOURCES) {
  if (!pagesFilter.has(source.page)) continue;
  allTiles.push(...await cutTiles(source.page, source.file));
}
const totalBytes = allTiles.reduce((sum, t) => sum + t.buffer.length, 0);
console.log(`共 ${allTiles.length} 片，切片总体积 ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`);

if (!isCosMediaConfigured()) {
  throw new Error('COS 未配置（CREATIVE_STUDIO_COS_*），公司 scope 媒体传输不可用');
}

const rangeText = [1, 2]
  .filter((p) => allTiles.some((t) => t.page === p))
  .map((p) => {
    const count = allTiles.filter((t) => t.page === p).length;
    return `第 ${p} 页：p${p}-t01 … p${p}-t${String(count).padStart(2, '0')}（共 ${count} 张）`;
  })
  .join('；');

const systemPrompt = '你是电商详情页信息提取专家。只输出合法 JSON，不要使用 markdown 代码块。';
const userPrompt = `我上传了一组电商详情页的纵向切片图片，共 ${allTiles.length} 张，按上传顺序排列：${rangeText}。
相邻切片之间有约 12% 的垂直重叠，被切断的文字行会在下一片顶部完整出现。${pagesFilter.size > 1 ? '两页是同一产品详情页的上下两部分。' : ''}

任务：从详情页中提取该产品的卖点候选。

要求：
1. 每条卖点包含：id（sp-1 起递增）、title（12 字以内的卖点短句）、evidence（详情页上看得见的原文片段，必须逐字照抄，禁止改写、禁止推断）、tileRefs（该卖点出现的切片编号列表）、kind（spec | material | function | scene | service | promo 之一）、confidence（high | medium | low）、riskFlags（数组，可为空）。
2. evidence 必须是图片中真实可见的文字，看不见的信息一律不得编造。例如图上只写「钢板加厚」，不得推断为「承重 300kg」。
3. 同一卖点在多张切片中重复出现时合并为一条，tileRefs 列全。
4. 促销、物流、售后类信息（包邮、七天无理由、赠品等）标 kind="promo"。
5. 含极限词（最、第一、顶级、国家级等）的条目，riskFlags 加 "absolute_term"；无法核实的宣称加 "unverifiable_claim"。
6. 最多输出 30 条，按详情页中的显著程度排序。

输出 JSON 结构（严格遵守）：
{
  "productGuess": { "name": "string", "category": "string" },
  "audienceHint": "string",
  "candidates": [
    {
      "id": "sp-1",
      "title": "string，12 字以内",
      "evidence": "string，详情页上的原文片段",
      "tileRefs": ["p1-t03", "p1-t04"],
      "kind": "spec | material | function | scene | service | promo",
      "confidence": "high | medium | low",
      "riskFlags": ["absolute_term", "unverifiable_claim"]
    }
  ]
}`;

fs.writeFileSync(path.join(outDir, 'prompt.txt'), `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}\n`);

type ExtractionResult = {
  productGuess?: { name?: string; category?: string };
  audienceHint?: string;
  candidates?: Array<{
    id?: string; title?: string; evidence?: string; tileRefs?: string[];
    kind?: string; confidence?: string; riskFlags?: string[];
  }>;
};

const directKimi = process.env.PROBE_DIRECT === 'kimi';
const rawMode = process.env.PROBE_RAW === '1';
console.log(`\n→ 提交 ${directKimi ? 'Kimi-K3（探针直连运行时，不落库）' : `公司 Luna（GPT-5-6-Luna-Standard${rawMode ? '，RAW 模式直读 usage' : ''}）`}（${allTiles.length} 张图片，temperature=1，maxTokens=16000，超时 10 分钟）…`);
const startedAt = Date.now();
let result: ExtractionResult;
if (rawMode) {
  // RAW 模式：绕过适配器直接 fetch，只为拿到响应里的 usage 计费明细（适配器路径会把 usage 交给
  // usage-pricing 的精确身份匹配，本机 Luna 行 id 不是 'gpt'，匹配不上、不落表）。
  const { extractJson } = await import('../lib/script-providers/openai-compatible.ts');
  const { tryUploadBufferToCosAndSign } = await import('../lib/cos-media.ts');
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.resolve('data/workbench.db'), { readonly: true, fileMustExist: true });
  const row = db.prepare('SELECT baseUrl, apiKey, model FROM script_providers WHERE id = ?').get(PROVIDER_ID) as { baseUrl: string; apiKey: string; model: string };
  db.close();
  const imageUrls = await Promise.all(allTiles.map(async (tile) => {
    const url = await tryUploadBufferToCosAndSign(tile.buffer, 'image/jpeg');
    if (!url) throw new Error('COS 上传失败');
    return url;
  }));
  const response = await fetch(`${row.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${row.apiKey}` },
    body: JSON.stringify({
      model: row.model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
      max_tokens: 16000,
      temperature: 1,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(600_000),
  });
  const rawResponse = await response.text();
  if (!response.ok) throw new Error(`RAW 请求失败（HTTP ${response.status}）：${rawResponse.slice(0, 300)}`);
  const parsed = JSON.parse(rawResponse) as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
  console.log('usage（原始）：', JSON.stringify(parsed.usage));
  result = JSON.parse(extractJson(parsed.choices?.[0]?.message?.content ?? '')) as ExtractionResult;
} else if (directKimi) {
  const { chatCompletion, extractJson } = await import('../lib/script-providers/openai-compatible.ts');
  const { tryUploadBufferToCosAndSign } = await import('../lib/cos-media.ts');
  const images = await Promise.all(allTiles.map(async (tile) => {
    const imageUrl = await tryUploadBufferToCosAndSign(tile.buffer, 'image/jpeg');
    if (!imageUrl) throw new Error('COS 上传失败');
    return { mimeType: 'image/jpeg', imageUrl };
  }));
  const rawText = await chatCompletion(
    { name: 'Kimi-K3（探针）', defaultBaseUrl: 'http://127.0.0.1:4000', defaultModel: 'Kimi-K3', maxTokens: 16000 } as never,
    { systemPrompt, userPrompt, temperature: 1, maxTokens: 16000, timeoutMs: 600_000, responseFormat: 'json_object', images },
    {
      id: 'probe-kimi-k3', name: 'Kimi-K3（探针）', apiStyle: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:4000', apiKey: 'probe-placeholder', model: 'Kimi-K3',
      maxTokens: 16000, enabled: true, configured: true, missing: [], hasApiKey: true,
      supportsVision: true, visionCostPerRequest: 0, executionScope: 'company',
    },
  );
  result = JSON.parse(extractJson(rawText)) as ExtractionResult;
} else {
  result = await completeJson<ExtractionResult>({
    providerId: PROVIDER_ID,
    systemPrompt,
    userPrompt,
    temperature: 1,
    maxTokens: 16000,
    timeoutMs: 600_000,
    images: allTiles.map((t) => ({ mimeType: 'image/jpeg', imageBase64: t.buffer.toString('base64') })),
    usageContext: { refType: 'detail-page-probe', refId: `pk4x-a${process.env.PROBE_OUT_SUFFIX || ''}` },
  });
}
const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`← 返回，端到端耗时 ${elapsedSec}s（含 COS 上传与排队）`);

fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));

// 设计 D 节的轻量校验：空字段、tileRefs 越界、标题归一化去重。
const validIds = new Set(allTiles.map((t) => t.id));
const issues: string[] = [];
const seenTitles = new Map<string, string>();
for (const c of result.candidates ?? []) {
  if (!c.title?.trim()) issues.push(`${c.id ?? '?'}: title 为空`);
  if (!c.evidence?.trim()) issues.push(`${c.id ?? '?'}: evidence 为空`);
  for (const ref of c.tileRefs ?? []) {
    if (!validIds.has(ref)) issues.push(`${c.id ?? '?'}: tileRef 越界 ${ref}`);
  }
  const normalized = (c.title ?? '').normalize('NFKC').replace(/[\s\p{P}]/gu, '');
  if (normalized) {
    const dup = seenTitles.get(normalized);
    if (dup) issues.push(`${c.id ?? '?'}: 标题与 ${dup} 重复`);
    else seenTitles.set(normalized, c.id ?? '?');
  }
}

const summary = {
  elapsedSec: Number(elapsedSec),
  tileCount: allTiles.length,
  totalMiB: Number((totalBytes / 1024 / 1024).toFixed(2)),
  candidateCount: result.candidates?.length ?? 0,
  productGuess: result.productGuess,
  audienceHint: result.audienceHint,
  validationIssues: issues,
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

console.log(`\n产品猜测：${result.productGuess?.name ?? '?'} / ${result.productGuess?.category ?? '?'}`);
console.log(`人群提示：${result.audienceHint ?? '?'}`);
console.log(`候选 ${summary.candidateCount} 条，校验问题 ${issues.length} 条`);
for (const issue of issues) console.log(`  - ${issue}`);
console.log(`\n产物：${outDir}/（tiles/、prompt.txt、result.json、summary.json）`);
console.log('token 用量可查用量表（refType=detail-page-probe）。');
