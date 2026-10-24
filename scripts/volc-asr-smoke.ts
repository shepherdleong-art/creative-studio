// 火山原声识别冒烟：拿一条真实素材调一次火山，看台词和逐字时间对不对。
// 会把这条素材的声音发给火山。需要 CREATIVE_STUDIO_VOLC_ASR_API_KEY。
// 用法：node --env-file=.env.local scripts/volc-asr-smoke.ts <视频或音频文件>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeDurationSec, runFfmpeg } from '../lib/ffmpeg.ts';
import { createVolcFlashAsrAdapter } from '../lib/media-core/adapters/volc-asr.ts';

const input = process.argv[2];
if (!input || !fs.existsSync(input)) {
  console.error('用法：node --env-file=.env.local scripts/volc-asr-smoke.ts <视频或音频文件>');
  process.exit(1);
}
const adapter = createVolcFlashAsrAdapter();
if (!adapter.configured) {
  console.error('没有找到 CREATIVE_STUDIO_VOLC_ASR_API_KEY');
  process.exit(1);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'volc-asr-smoke-'));
const wav = path.join(directory, 'source.wav');
try {
  // 和正式流程一样转成 16kHz 单声道 PCM。
  await runFfmpeg(['-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav], { timeoutMs: 90_000 });
  const durationUs = Math.round((await probeDurationSec(wav)) * 1_000_000);
  const result = await adapter.transcribe({ audioPath: wav, durationUs });
  console.log(`素材时长：${(durationUs / 1e6).toFixed(2)} 秒`);
  console.log(`台词：${result.text}`);
  console.log(`逐字：${result.words.length} 个；首字「${result.words[0].text}」${(result.words[0].startUs / 1e6).toFixed(2)} 秒；末字「${result.words.at(-1)!.text}」${(result.words.at(-1)!.endUs / 1e6).toFixed(2)} 秒`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
