/**
 * 公司 kling-3.0 首尾帧 + OutputConfig.Duration 绕行探测（会产生一条真实付费任务，
 * 需用户明确授权后运行）。
 *
 * 背景（2026-08-18 证据链）：
 *   - 腾讯 VOD CreateAigcVideoTask 的时长字段是 OutputConfig.Duration（Kling 3-15，默认 5）；
 *   - 实测无尾帧 seconds="10" → 10.042s（网关映射正确），
 *     带 LastFrameUrl seconds="10" → 5.042s（恰好是缺省值 5，网关该分支疑似漏映射）；
 *   - 网关会把 OutputConfig 里的字段原样透传给腾讯（AspectRatio/Resolution 已验证）。
 *
 * 本探测在与 company-kling-tailframe-e2e.ts 完全相同的字段基础上，只给
 * OutputConfig 增加 Duration: 10：
 *   - 产出 ≈10s → 客户端可绕行：适配器在可灵尾帧模式补 OutputConfig.Duration；
 *   - 产出 ≈5s  → 网关在该分支覆盖/丢弃 Duration，只能等网关修复。
 *
 * 密钥/COS 配置从本机文件读取，不打印；产物存 outputs/（gitignored）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import ffprobe from 'ffprobe-static';

const FIRST_FRAME = 'storage/outputs/分镜-PK26A-E-模特图-普通床-(1)-4bfe24.png';
const TAIL_FRAME = 'storage/processed/inputs/d1f5e62a-faa7-4f2b-bcd6-3e52147dd36e_p1536.jpg';
const OUT_VIDEO = 'outputs/probe-kling-tailframe-duration-10s.mp4';
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

console.log('上传首帧/尾帧到 COS…');
const videoOptions = getCosVideoCompressOptions();
const firstUrl = await tryUploadToCosAndSign(FIRST_FRAME, undefined, videoOptions);
const tailUrl = await tryUploadToCosAndSign(TAIL_FRAME, undefined, videoOptions);
if (!firstUrl || !tailUrl) throw new Error('COS 未配置或上传失败');

// 与适配器可灵尾帧路径完全一致，仅 OutputConfig 增加 Duration。
const body = {
  model: 'kling-3.0',
  prompt: '镜头缓慢推进，聚焦床品与卧室细节',
  seconds: String(REQUESTED_SEC),
  images: [firstUrl],
  LastFrameUrl: tailUrl,
  OutputConfig: { AspectRatio: '3:4', Resolution: '1080P', Duration: REQUESTED_SEC },
  response_format: 'mp4',
  multi_shot: true,
  shot_type: 'intelligence',
};

console.log(`提交 kling-3.0 首尾帧任务（seconds=${REQUESTED_SEC} + OutputConfig.Duration=${REQUESTED_SEC}）…`);
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
  console.log('结论：OutputConfig.Duration 被透传生效 —— 客户端可在可灵尾帧模式补该字段绕行，无需等网关修复。');
} else {
  console.log('结论：OutputConfig.Duration 未生效（网关覆盖或丢弃）—— 只能由网关修复 LastFrameUrl 分支的 seconds 映射。');
}
