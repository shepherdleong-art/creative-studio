/**
 * 公司 kling-3.0 时长对照探测（会产生一条真实付费任务，需用户明确授权后运行）。
 *
 * 背景（2026-08-18）：应用侧已证实提交 seconds="10"（DB + 日志），产出却是
 * 5.042s。腾讯公开文档称 kling-3.0 支持 3-15s。本探测在**不带尾帧**的条件下
 * 提交 seconds="10"，其余字段与适配器非尾帧路径完全一致：
 *   - 产出 ≈10s → 网关会透传 seconds，10s 失效是首尾帧（LastFrameUrl）模式的限制；
 *   - 产出 ≈5s  → 网关整体丢弃/忽略 seconds，与尾帧无关。
 *
 * 密钥/COS 配置从本机文件读取，不打印；产物存 outputs/（gitignored）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import ffprobe from 'ffprobe-static';

const FIRST_FRAME = 'storage/outputs/分镜-PK26A-E-模特图-普通床-(1)-4bfe24.png';
const OUT_VIDEO = 'outputs/probe-kling-duration-10s.mp4';
const REQUESTED_SEC = 10;
const POLL_TIMEOUT_MS = 15 * 60_000;

// 从 .env.local 读 COS 配置（不打印）
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*(CREATIVE_STUDIO_COS_[A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m) process.env[m[1]] = m[2];
}

const { tryUploadToCosAndSign, getCosVideoCompressOptions } = await import('../lib/cos-media.ts');

const db = new Database('data/workbench.db', { readonly: true });
const provider = db
  .prepare("SELECT apiKey, baseUrl FROM video_providers WHERE defaultModel = 'kling-3.0' AND type = 'openai-video'")
  .get() as { apiKey?: string; baseUrl?: string } | undefined;
db.close();
if (!provider?.apiKey || !provider.baseUrl) throw new Error('未找到公司可灵供应商配置');
const base = provider.baseUrl.replace(/\/$/, '');
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${provider.apiKey}`,
};

console.log('上传首帧到 COS…');
const firstUrl = await tryUploadToCosAndSign(FIRST_FRAME, undefined, getCosVideoCompressOptions());
if (!firstUrl) throw new Error('COS 未配置或上传失败');

// 与 openai-video.ts 非尾帧路径完全一致的字段：size 按首帧 1728x2304(3:4) 吸附 1K 档。
const body = {
  model: 'kling-3.0',
  prompt: '镜头缓慢推进，聚焦床品与卧室细节',
  seconds: String(REQUESTED_SEC),
  images: [firstUrl],
  response_format: 'mp4',
  size: '1024x1366',
  multi_shot: true,
  shot_type: 'intelligence',
};

console.log(`提交 kling-3.0 无尾帧任务（seconds=${REQUESTED_SEC}）…`);
const submitRes = await fetch(`${base}/v1/videos`, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
});
const submitText = await submitRes.text();
if (!submitRes.ok) {
  console.error('提交失败 HTTP', submitRes.status, submitText.slice(0, 500));
  process.exit(1);
}
const taskId = JSON.parse(submitText).id;
console.log('任务已创建，id =', taskId);

const deadline = Date.now() + POLL_TIMEOUT_MS;
let videoUrl;
for (;;) {
  await new Promise((r) => setTimeout(r, 15_000));
  const pollRes = await fetch(`${base}/v1/videos/${taskId}`, { headers: { Authorization: headers.Authorization } });
  const pollText = await pollRes.text();
  let data;
  try { data = JSON.parse(pollText); } catch { data = {}; }
  const status = data.status || 'unknown';
  console.log(`轮询：${status}`);
  if (status === 'completed') {
    videoUrl = data?.metadata?.url ?? data?.output?.url ?? data?.video?.url
      ?? data?.result?.video_url ?? data?.result?.url ?? data?.video_url ?? data?.url
      ?? `${base}/v1/videos/${taskId}/content`;
    break;
  }
  if (status === 'failed' || status === 'expired' || status === 'cancelled') {
    console.error('任务失败：', pollText.slice(0, 500));
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.error('轮询超时，任务仍在进行中；taskId =', taskId);
    process.exit(1);
  }
}

console.log('下载成片…');
const downloadRes = await fetch(videoUrl, {
  headers: videoUrl.startsWith(base) ? { Authorization: headers.Authorization } : {},
});
if (!downloadRes.ok) {
  console.error('下载失败 HTTP', downloadRes.status);
  process.exit(1);
}
fs.mkdirSync('outputs', { recursive: true });
fs.writeFileSync(OUT_VIDEO, Buffer.from(await downloadRes.arrayBuffer()));

const info = JSON.parse(execFileSync(ffprobe.path, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', OUT_VIDEO]).toString()) as {
  format?: { duration?: string };
  streams: Array<{ codec_type?: string; width?: number; height?: number }>;
};
const vs = info.streams.find((s) => s.codec_type === 'video');
const actual = Number(info.format?.duration ?? 0);
console.log(`成片：${vs?.width}x${vs?.height}，时长 ${actual.toFixed(3)}s（请求 ${REQUESTED_SEC}s）`);
console.log('产物：', path.resolve(OUT_VIDEO));

if (actual >= REQUESTED_SEC - 0.5) {
  console.log('结论：网关会透传 seconds —— 10s 失效是首尾帧（LastFrameUrl）模式的限制，需网关/上游在尾帧模式支持时长。');
} else {
  console.log('结论：网关整体忽略 seconds（无尾帧也只出 5s）—— 与尾帧无关，需网关修复 seconds→Duration 映射。');
}
