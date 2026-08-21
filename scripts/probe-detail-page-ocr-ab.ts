/**
 * 诊断探针：详情页 OCR 分辨率 A/B 实验。
 * 针对全量提取中「朦胧美感」被误读为「膨胀美感」的真实案例，验证提高输入分辨率
 * （或模型侧 detail 档位）能否消除该类误读。
 *
 * 变体：
 *   A1/A2 = 现行管线（缩到 1024 宽，JPEG q88），跑两次观察 temperature=1 的随机性
 *   B     = 原生 1200 宽不缩放（用户提问的「不压缩」方案）
 *   C     = 1024 宽 + image_url.detail='high'（模型侧处理档位，成本更高）
 *
 * 真实调用公司 Luna（GPT-5-6-Luna-Standard），会产生少量调用。
 * 运行：node --no-warnings --experimental-loader "$PWD/scripts/typescript-extension-loader.mjs" \
 *        --experimental-strip-types scripts/probe-detail-page-ocr-ab.ts
 */
import fs from 'node:fs';
import path from 'node:path';

for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const { default: sharp } = await import('sharp');
const { tryUploadBufferToCosAndSign } = await import('../lib/cos-media.ts');
const { default: Database } = await import('better-sqlite3');

// 「长虹玻璃趟门 / 防尘挡灰 朦胧美感」标题区域（原生坐标，2026-08-21 目视定位）。
const SRC = '/Volumes/ITGZ-1G/0605/PK4X-A组合-商品详情1200-四件套-(1).jpg';
const REGION = { left: 0, top: 23550, width: 1200, height: 550 };

const native = await sharp(SRC).extract(REGION).jpeg({ quality: 88 }).toBuffer();
const scaled = await sharp(native).resize(1024).jpeg({ quality: 88 }).toBuffer();

const db = new Database(path.resolve('data/workbench.db'), { readonly: true, fileMustExist: true });
const provider = db.prepare('SELECT baseUrl, apiKey, model FROM script_providers WHERE id = ?')
  .get('a94f6d47-4266-4b06-bbd4-89d273f06dbc') as { baseUrl: string; apiKey: string; model: string };
db.close();

const PROMPT = '请逐字转写这张图片里的所有中文文字，不要遗漏、不要改写、不要推断。只输出转写结果。';

async function transcribe(label: string, image: Buffer, detail?: 'high'): Promise<void> {
  const url = await tryUploadBufferToCosAndSign(image as Buffer<ArrayBuffer>, 'image/jpeg');
  if (!url) throw new Error('COS 上传失败');
  const startedAt = Date.now();
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: detail ? { url, detail } : { url } },
        ],
      }],
      max_tokens: 1000,
      temperature: 1,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
  const content = parsed.choices?.[0]?.message?.content ?? '';
  console.log(`--- ${label}（${((Date.now() - startedAt) / 1000).toFixed(1)}s，total_tokens=${parsed.usage?.total_tokens ?? '?'}）`);
  console.log(content.trim());
  console.log();
}

await transcribe('A1：1024 宽（现行管线）· 第 1 次', scaled);
await transcribe('A2：1024 宽（现行管线）· 第 2 次', scaled);
await transcribe('B：原生 1200 宽不缩放', native);
await transcribe('C：1024 宽 + detail=high', scaled, 'high');
