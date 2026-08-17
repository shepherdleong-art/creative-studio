/**
 * 公司可灵 3.0 尾帧真实任务验证（会产生一条真实付费任务，需用户明确授权后运行）。
 *
 * 验证字段（2026-08-17 免费识别探测确认网关透传腾讯原生 PascalCase 参数）：
 *   - LastFrameUrl：尾帧图 URL（须与 FileInfos 首帧同传，网关 images[0] 已映射首帧）；
 *   - OutputConfig.AspectRatio：输出比例（首尾帧模式网关忽略 size，实测落回 16:9）。
 *
 * 验收：成片比例应为 3:4 竖屏，且最后一帧朝尾帧图收束。
 * 密钥/COS 配置从本机文件读取，不打印；产物存 outputs/（gitignored）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import ffprobe from 'ffprobe-static';
import ffmpeg from 'ffmpeg-static';

const FIRST_FRAME = 'storage/outputs/分镜-PK26A-E-模特图-普通床-(1)-4bfe24.png';
const TAIL_FRAME = 'storage/processed/inputs/d1f5e62a-faa7-4f2b-bcd6-3e52147dd36e_p1536.jpg';
const OUT_VIDEO = 'outputs/probe-kling-tailframe.mp4';
const OUT_LASTFRAME = 'outputs/probe-kling-tailframe-last.png';
const ASPECT = process.argv[2] || '3:4';
const POLL_TIMEOUT_MS = 15 * 60_000;

// 从 .env.local 读 COS 配置（不打印）
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*(CREATIVE_STUDIO_COS_[A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m) process.env[m[1]] = m[2];
}

const { tryUploadToCosAndSign } = await import('../lib/cos-media.ts');

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
const firstUrl = await tryUploadToCosAndSign(FIRST_FRAME);
const tailUrl = await tryUploadToCosAndSign(TAIL_FRAME);
if (!firstUrl || !tailUrl) throw new Error('COS 未配置或上传失败');

const body = {
  model: 'kling-3.0',
  prompt: '镜头缓慢推进，聚焦床品与卧室细节',
  seconds: '5',
  images: [firstUrl],
  LastFrameUrl: tailUrl,
  OutputConfig: { AspectRatio: ASPECT, Resolution: '1080P' },
  response_format: 'mp4',
  multi_shot: true,
  shot_type: 'intelligence',
};

console.log(`提交 kling-3.0 尾帧任务（AspectRatio=${ASPECT}）…`);
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

const info = JSON.parse(execFileSync(ffprobe.path, ['-v', 'quiet', '-print_format', 'json', '-show_streams', OUT_VIDEO]).toString()) as { streams: Array<{ codec_type?: string; width?: number; height?: number }> };
const vs = info.streams.find((s: { codec_type?: string }) => s.codec_type === 'video');
if (!vs?.width || !vs.height) throw new Error('ffprobe 未读到视频流');
console.log(`成片尺寸：${vs.width}x${vs.height}（期望 3:4 竖屏）`);

if (!ffmpeg) throw new Error('ffmpeg-static 不可用');
execFileSync(ffmpeg, ['-y', '-sseof', '-0.1', '-i', OUT_VIDEO, '-frames:v', '1', '-update', '1', OUT_LASTFRAME], { stdio: 'pipe' });
console.log('末帧已抽取：', path.resolve(OUT_LASTFRAME));
console.log('成片：', path.resolve(OUT_VIDEO));
