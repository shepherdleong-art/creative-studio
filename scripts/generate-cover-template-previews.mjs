// scripts/generate-cover-template-previews.mjs
// 用法：node scripts/generate-cover-template-previews.mjs
// 为每个封面模板预渲染一张 public/cover-templates/<id>.jpg 示例图，供面板卡片选择器展示。
// 依赖 lib/ffmpeg.ts 的 runFfmpeg（env → ffmpeg-static → PATH），与实际渲染同源，保证所见即所得。
// 复用 lib/final-video/cover.ts 的 buildCoverArgs：先用 ffmpeg lavfi 造一段 1s 渐变视频当底图，
// 再喂给 buildCoverArgs 抽帧+排版，零改动 cover.ts。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COVER_TEMPLATES } from '../lib/final-video/cover-templates.ts';
import { buildCoverArgs } from '../lib/final-video/cover.ts';
import { resolveFontFile } from '../lib/final-video/subtitles.ts';
import { runFfmpeg } from '../lib/ffmpeg.ts';

const OUT_DIR = path.resolve(process.cwd(), 'public/cover-templates');
const W = 1080;
const H = 1920; // 与竖版一致，保证版式所见即所得
const SAMPLE = { title: '三大亮点一次看完', points: ['亲肤面料透气', '十年质保放心', '环保板材无醛'] };

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-preview-'));
  const bg = path.join(tmp, 'bg.mp4');
  try {
    // 渐变底图（无需外部素材）；换成真实样片时把 -f lavfi 段替换为 -i sample.jpg 即可
    await runFfmpeg(
      ['-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=0x2b2b3c:c1=0x0b0b14:d=1`, '-t', '1', '-y', bg],
      { timeoutMs: 30_000 }
    );

    const fontFile = resolveFontFile();
    for (const t of Object.values(COVER_TEMPLATES)) {
      const out = path.join(OUT_DIR, `${t.id}.jpg`);
      await runFfmpeg(
        buildCoverArgs({
          sourceVideoPath: bg,
          titleText: SAMPLE.title,
          titleSize: 72,
          titleColor: '#ffffff',
          width: W,
          height: H,
          fontFile,
          outJpgPath: out,
          templateId: t.id,
          sellingPoints: SAMPLE.points,
        }),
        { timeoutMs: 60_000 }
      );
      console.log('wrote', out);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
