/**
 * 一次性真机探测（对比实验）：七牛云 gpt-image-2-medium 安全系统拦截
 * 与「图片传输方式」的关系。
 *
 * 背景：job 797fe1ef（2026-09-08 10:17 截图）走 qiniuyun/* 内联 base64
 * 通道（gateway-task-image.ts 的 INLINE_DATAURL_MODEL），被上游安全系统
 * 拒绝（BadRequestError: rejected by the safety system）。开发建议改传 URL。
 *
 * 本脚本用同一个 job 的原图/参考图/提示词/尺寸，分别按两种方式提交到
 * 本机 LiteLLM（127.0.0.1:4000）：
 *   node scripts/probe-qiniuyun-cos-url.ts inline   # 现状复现（预期仍被拦截）
 *   node scripts/probe-qiniuyun-cos-url.ts cos      # COS 预签名 URL（观察是否放行）
 *   node scripts/probe-qiniuyun-cos-url.ts both     # 先 inline 后 cos（默认）
 * 除 images 字段的传输方式外，请求体其余字段与生产适配器完全一致。
 * 注意：真实调用公司网关，cos 成功出图会产生一次生图费用。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tryUploadToCosAndSign, isCosMediaConfigured } from '../lib/cos-media.ts';
import { companyImageCapsForModel, snapCompanyImageSize } from '../lib/company-gateway-size.ts';
import {
  pollGatewayTaskImage,
  downloadGatewayTaskImage,
  summarizeGatewayTaskResponse,
} from '../lib/providers/gateway-task-image.ts';
import { sanitizeGatewayMediaDiagnostic } from '../lib/gateway-media-url.ts';

// 静默加载 .env.local（COS 密钥等），不打印。
for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  const key = m[1];
  let val = m[2].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!(key in process.env)) process.env[key] = val;
}

const JOB_ID = process.argv[3] || '797fe1ef-276c-4eb3-bad3-cba404d7807e';
const MODE = (process.argv[2] || 'both') as 'inline' | 'cos' | 'both';

type JobRow = {
  id: string;
  model: string;
  prompt: string;
  size: string;
  quality: string;
  referenceGuidanceMode: string | null;
  inputImageId: string;
  referenceImageIds: string;
};
type AssetRow = { id: string; filename: string; path: string; mimeType: string };

const db = new Database('data/workbench.db', { readonly: true });
const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(JOB_ID) as JobRow | undefined;
if (!job) throw new Error(`job ${JOB_ID} 不存在`);
const refIds: string[] = JSON.parse(job.referenceImageIds || '[]');
const assetIds = [job.inputImageId, ...refIds];
const assets = assetIds.map(
  (id) => db.prepare('SELECT id, filename, path, mimeType FROM image_assets WHERE id = ?').get(id) as AssetRow
);
for (const a of assets) {
  if (!a) throw new Error('image_assets 记录缺失');
  if (!fs.existsSync(a.path)) throw new Error(`文件不存在: ${a.path}`);
}

const provider = db
  .prepare('SELECT baseUrl, apiKey FROM providers WHERE id = ?')
  .get('company-gateway-qiniuyun-gpt-image-2-medium') as { baseUrl: string; apiKey: string } | undefined;
const baseUrl = (provider?.baseUrl || 'http://127.0.0.1:4000').replace(/\/$/, '');
const apiKey = provider?.apiKey || 'sk-placeholder';

const caps = companyImageCapsForModel(job.model);
if (!caps) throw new Error(`模型 ${job.model} 无公司 caps`);
const snappedSize = snapCompanyImageSize(job.size, caps);

console.log('=== 探测对象 ===');
console.log(`job: ${job.id}  model: ${job.model}`);
console.log(`size: ${job.size} -> 吸附后 ${snappedSize}  quality: ${job.quality}  guidance: ${job.referenceGuidanceMode || 'none'}`);
assets.forEach((a, i) => {
  const st = fs.statSync(a.path);
  console.log(`图${i + 1} ${i === 0 ? '底图' : '参考'}: ${a.filename} (${a.mimeType}, ${(st.size / 1024).toFixed(0)}KB)`);
});
console.log(`COS 已配置: ${isCosMediaConfigured()}`);

// 与生产 toInlineDataUrl 一致：本批图片都远小于 20MB，直接 base64 内联，无压缩分支。
function toInline(filePath: string, mime: string): string {
  const buf = fs.readFileSync(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function buildRefs(transport: 'inline' | 'cos'): Promise<string[]> {
  const out: string[] = [];
  for (const a of assets) {
    if (transport === 'inline') {
      out.push(toInline(a.path, a.mimeType));
    } else {
      const url = await tryUploadToCosAndSign(a.path, a.mimeType);
      if (!url) throw new Error('COS 未配置或上传返回 null');
      const u = new URL(url);
      console.log(`  COS 已上传: ${u.origin}${u.pathname}（签名参数不打印）`);
      out.push(url);
    }
  }
  return out;
}

async function runOnce(transport: 'inline' | 'cos', jobRow: JobRow): Promise<{ status: string; error?: string }> {
  console.log(`\n=== 提交 (${transport}) ===`);
  const images = await buildRefs(transport);
  // guidance=none 时生产适配器原样发送 prompt（见 submitGatewayTaskImage）
  const body: Record<string, unknown> = {
    model: jobRow.model,
    prompt: jobRow.prompt,
    images,
    size: snappedSize,
    response_format: 'png',
  };
  const bodyBytes = Buffer.byteLength(JSON.stringify(body));
  console.log(`POST ${baseUrl}/v1/videos  body=${(bodyBytes / 1024 / 1024).toFixed(2)}MB  images=${images.length}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let taskId: string | undefined;
  try {
    const res = await fetch(`${baseUrl}/v1/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const msg = sanitizeGatewayMediaDiagnostic(text, apiKey).slice(0, 300);
      console.log(`提交即被拒: HTTP ${res.status} ${msg}`);
      return { status: 'submit_rejected', error: `HTTP ${res.status} ${msg}` };
    }
    const data = JSON.parse(text);
    taskId = data.id;
    console.log(`提交响应: ${summarizeGatewayTaskResponse(data, apiKey)}  taskId=${taskId}`);
  } finally {
    clearTimeout(timer);
  }
  if (!taskId) return { status: 'no_task_id' };

  const startedAt = Date.now();
  for (let i = 0; i < 120; i++) {
    const poll = await pollGatewayTaskImage(taskId, apiKey, baseUrl, startedAt);
    console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 轮询: ${poll.status} ${poll.errorMessage || ''}`);
    if (poll.status === 'succeeded') {
      const url = poll.imageUrl!;
      console.log(`成功，结果地址: ${url.startsWith(baseUrl) ? url : '[外部URL]'}`);
      const dl = await downloadGatewayTaskImage(url, baseUrl, apiKey);
      if (!dl.ok) {
        console.log(`结果下载失败: ${dl.errorMessage}`);
        return { status: 'succeeded', error: `下载失败: ${dl.errorMessage}` };
      }
      const outDir = path.resolve('outputs/probe-qiniuyun-cos');
      fs.mkdirSync(outDir, { recursive: true });
      const outFile = path.join(outDir, `${transport}-${taskId!.slice(-12)}.png`);
      fs.writeFileSync(outFile, dl.buffer);
      console.log(`结果已下载: ${outFile} (${(dl.buffer.byteLength / 1024).toFixed(0)}KB)`);
      return { status: 'succeeded' };
    }
    if (poll.status === 'failed') {
      return { status: 'failed', error: poll.errorMessage };
    }
  }
  return { status: 'poll_timeout' };
}

const results: Record<string, { status: string; error?: string }> = {};
if (MODE === 'inline' || MODE === 'both') results.inline = await runOnce('inline', job);
if (MODE === 'cos' || MODE === 'both') results.cos = await runOnce('cos', job);

console.log('\n=== 对比结论 ===');
for (const [k, v] of Object.entries(results)) {
  console.log(`${k}: ${v.status}${v.error ? ' — ' + v.error.slice(0, 200) : ''}`);
}
