/**
 * 公司 Seedance 1080P 尺寸合同探测（会产生真实付费任务，需用户明确授权后运行）。
 *
 * 已核验结论（2026-09-08）：
 *   - doubao-seedance-2-5-260628 接受官网 1080p 像素表：size=1080x1920 → 成片
 *     1080x1920 HEVC 10bit（yuv420p10le），产物在 outputs/probe-seedance-1080p-*.mp4。
 *   - doubao-seedance-2-0-fast-260128 传 1080p 在任务创建前 400：
 *     「the parameter resolution specified in the request is not valid for model
 *     doubao-seedance-2-0-fast in r2v」——fast 官方最高 720p，不支持 1080p。
 * 生产实现见 lib/company-gateway-size.ts（SEEDANCE_2_5_CAPS）与
 * lib/video-providers/openai-video.ts（response_format 仅可灵）。
 *
 * 用法：node scripts/company-seedance-1080p-probe.ts <model> [extraBodyJson]
 *   node scripts/company-seedance-1080p-probe.ts doubao-seedance-2-5-260628 '{"size":"1080x1920"}'
 *   node scripts/company-seedance-1080p-probe.ts doubao-seedance-2-5-260628 '{"size":"1080p"}'
 *   node scripts/company-seedance-1080p-probe.ts doubao-seedance-2-5-260628 '{"resolution":"1080p"}'
 * 参数错误应在任务创建前 400（免费）；任务被创建即产生费用（2.5 1080p 约 ¥2.7/秒）。
 * 密钥/COS 配置从本机文件读取，不打印；产物存 outputs/（gitignored）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import ffprobe from 'ffprobe-static';

const MODEL = process.argv[2] || 'doubao-seedance-2-5-260628';
const EXTRA_BODY: Record<string, unknown> = process.argv[3] ? JSON.parse(process.argv[3]) : { size: '1080x1920' };
const SAFE_NAME = `${MODEL.replace(/[^a-z0-9.-]+/gi, '_')}-${Buffer.from(JSON.stringify(EXTRA_BODY)).toString('hex').slice(0, 12)}`;
const OUT_VIDEO = `outputs/probe-seedance-1080p-${SAFE_NAME}.mp4`;
const FIRST_FRAME = `outputs/probe-seedance-1080p-firstframe.png`;
const POLL_TIMEOUT_MS = 15 * 60_000;

// 从 .env.local 读 COS 配置（不打印）
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*(CREATIVE_STUDIO_COS_[A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m) process.env[m[1]] = m[2];
}

const { tryUploadToCosAndSign, isCosMediaConfigured } = await import('../lib/cos-media.ts');
const { sanitizeGatewayMediaDiagnostic } = await import('../lib/gateway-media-url.ts');

if (!isCosMediaConfigured()) throw new Error('COS 未配置，无法给上游提供可访问的首帧 URL');

// 合成 720x1280（9:16）首帧：分辨率探测不关心内容，但给点渐变避免全黑被审核拦截
fs.mkdirSync('outputs', { recursive: true });
if (!fs.existsSync(FIRST_FRAME)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b6cb0"/><stop offset="1" stop-color="#d69e2e"/>
    </linearGradient></defs>
    <rect width="720" height="1280" fill="url(#g)"/>
    <circle cx="360" cy="560" r="180" fill="#ffffff" opacity="0.85"/>
    <rect x="240" y="820" width="240" height="120" rx="24" fill="#1a202c" opacity="0.8"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(FIRST_FRAME);
}

const base = 'http://127.0.0.1:4000';
const apiKey = 'litellm-local-passthrough';
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

console.log('上传首帧到 COS…');
const firstUrl = await tryUploadToCosAndSign(FIRST_FRAME);
if (!firstUrl) throw new Error('首帧上传 COS 失败');

const body: Record<string, unknown> = {
  model: MODEL,
  prompt: '镜头缓慢推进，展示静物细节，光线柔和',
  seconds: '4',
  images: [firstUrl],
  ...EXTRA_BODY,
};

console.log(`提交 ${MODEL}（seconds=4, extra=${JSON.stringify(EXTRA_BODY)}）…`);
const submitRes = await fetch(`${base}/v1/videos`, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
});
const submitText = await submitRes.text();
if (!submitRes.ok) {
  console.error('提交失败 HTTP', submitRes.status, sanitizeGatewayMediaDiagnostic(submitText, apiKey).slice(0, 500));
  process.exit(1);
}
const taskId = (JSON.parse(submitText) as { id: string }).id;
console.log('任务已创建（开始计费），id =', taskId);

const deadline = Date.now() + POLL_TIMEOUT_MS;
let videoUrl: string | undefined;
for (;;) {
  await new Promise((r) => setTimeout(r, 15_000));
  const pollRes = await fetch(`${base}/v1/videos/${taskId}`, { headers: { Authorization: headers.Authorization } });
  const pollText = await pollRes.text();
  let data: Record<string, any> = {};
  try { data = JSON.parse(pollText); } catch { /* keep raw */ }
  const status = data.status || 'unknown';
  console.log(`轮询：${status}`);
  if (status === 'completed') {
    videoUrl = data?.metadata?.url ?? data?.output?.url ?? data?.video?.url
      ?? data?.result?.video_url ?? data?.result?.url ?? data?.video_url ?? data?.url
      ?? `${base}/v1/videos/${taskId}/content`;
    break;
  }
  if (status === 'failed' || status === 'expired' || status === 'cancelled') {
    console.error('任务失败：', sanitizeGatewayMediaDiagnostic(pollText, apiKey).slice(0, 500));
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.error('轮询超时，任务仍在进行中；taskId =', taskId);
    process.exit(1);
  }
}

console.log('下载成片…');
if (!videoUrl) throw new Error('任务完成但未拿到成片地址');
const downloadRes = await fetch(videoUrl, {
  headers: videoUrl.startsWith(base) ? { Authorization: headers.Authorization } : {},
});
if (!downloadRes.ok) {
  console.error('下载失败 HTTP', downloadRes.status);
  process.exit(1);
}
fs.writeFileSync(OUT_VIDEO, Buffer.from(await downloadRes.arrayBuffer()));

const info = JSON.parse(
  execFileSync(ffprobe.path, ['-v', 'quiet', '-print_format', 'json', '-show_streams', OUT_VIDEO]).toString(),
) as { streams: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string }> };
const vs = info.streams.find((s) => s.codec_type === 'video');
if (!vs?.width || !vs.height) throw new Error('ffprobe 未读到视频流');
console.log(`成片：${vs.width}x${vs.height} codec=${vs.codec_name} pix_fmt=${vs.pix_fmt}（extra=${JSON.stringify(EXTRA_BODY)}）`);
console.log('文件：', path.resolve(OUT_VIDEO));
