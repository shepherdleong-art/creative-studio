// 封面 JPG 合成（单实现）：renderer 渲染封面片头与 packaging 包装封面覆盖共用，禁止双实现（§13.2 吸色双实现教训）。
// 管线：底图 .rotate() → coverFramingGeometry 取景 resize/extract → 按序 composite 叠加层 PNG →（可选中间 PNG）→ JPG q92。
import sharp from 'sharp';
import { coverFramingGeometry } from './cover-framing.ts';
import type { CoverFraming } from './cover-types.ts';

export interface ComposeCoverInput {
  /** 封面底图绝对路径。 */
  coverSourcePath: string;
  /** 取景（缺省 scale=1 居中）。 */
  framing?: CoverFraming | null;
  /** 输出画幅（与成片一致）。 */
  output: { width: number; height: number };
  /** 叠加层 PNG 绝对路径，按序合成（旧 title.png、包装封面帧等）。 */
  overlays?: string[];
  /** 输出 JPG 绝对路径（quality 92）。 */
  jpgPath: string;
  /** 中间 PNG 绝对路径（视频片头静帧输入需要时传；不传则不落 PNG）。 */
  pngPath?: string;
}

export async function composeCoverJpg(input: ComposeCoverInput): Promise<void> {
  const framing: CoverFraming = input.framing ?? { scale: 1, offsetX: 0, offsetY: 0 };
  const source = sharp(input.coverSourcePath).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error('封面底图尺寸无效');
  const { resizedWidth, resizedHeight, left, top } = coverFramingGeometry({
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    outputWidth: input.output.width,
    outputHeight: input.output.height,
    framing,
  });
  let pipeline = source
    .resize(resizedWidth, resizedHeight, { fit: 'fill' })
    .extract({ left, top, width: input.output.width, height: input.output.height });
  const overlays = (input.overlays ?? []).filter((file): file is string => typeof file === 'string' && file.length > 0);
  if (overlays.length > 0) pipeline = pipeline.composite(overlays.map((file) => ({ input: file })));
  const pngInput = input.pngPath
    ? await pipeline.png().toFile(input.pngPath).then(() => input.pngPath as string)
    : await pipeline.png().toBuffer();
  await sharp(pngInput).jpeg({ quality: 92 }).toFile(input.jpgPath);
}
