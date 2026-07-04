// lib/final-video/cover.ts
/** 封面 = 首个片段 0.5s 处抽帧 + 可选居中标题。参考：混剪计划 §Task 4.2。 */
import { escapeDrawtext, escapeSubtitlePath } from './ffmpeg-graph.ts';

export interface CoverArgsInput {
  sourceVideoPath: string;
  titleText: string;
  titleSize: number;
  titleColor: string;
  width: number;
  height: number;
  fontFile: string;
  outJpgPath: string;
}

export function buildCoverArgs(input: CoverArgsInput): string[] {
  const { width: w, height: h } = input;
  const vfParts = [`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`];
  const title = input.titleText.trim();
  if (title) {
    const fontPart = input.fontFile ? `:fontfile='${escapeSubtitlePath(input.fontFile)}'` : '';
    vfParts.push(
      `drawtext=text='${escapeDrawtext(title)}':fontsize=${input.titleSize}:fontcolor=${input.titleColor}` +
        `:x=(w-text_w)/2:y=(h-text_h)/2:borderw=4:bordercolor=black${fontPart}`
    );
  }
  return [
    '-hide_banner',
    '-ss', '0.5',
    '-i', input.sourceVideoPath,
    '-vf', vfParts.join(','),
    '-frames:v', '1',
    '-q:v', '2',
    '-y', input.outJpgPath,
  ];
}
