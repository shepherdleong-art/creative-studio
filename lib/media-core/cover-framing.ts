import type { CoverFraming } from './cover-types.ts';

export interface CoverFramingGeometry {
  resizedWidth: number;
  resizedHeight: number;
  left: number;
  top: number;
}

export function coverFramingGeometry({ sourceWidth, sourceHeight, outputWidth, outputHeight, framing }: {
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  framing: CoverFraming;
}): CoverFramingGeometry {
  if (![sourceWidth, sourceHeight, outputWidth, outputHeight].every((value) => Number.isFinite(value) && value > 0)) throw new Error('封面尺寸无效');
  const scale = Math.max(1, Math.min(3, Number(framing.scale) || 1));
  const offsetX = Math.max(-1, Math.min(1, Number(framing.offsetX) || 0));
  const offsetY = Math.max(-1, Math.min(1, Number(framing.offsetY) || 0));
  const fitScale = Math.max(outputWidth / sourceWidth, outputHeight / sourceHeight) * scale;
  const resizedWidth = Math.max(outputWidth, Math.ceil(sourceWidth * fitScale));
  const resizedHeight = Math.max(outputHeight, Math.ceil(sourceHeight * fitScale));
  return {
    resizedWidth,
    resizedHeight,
    left: Math.round((resizedWidth - outputWidth) * (offsetX + 1) / 2),
    top: Math.round((resizedHeight - outputHeight) * (offsetY + 1) / 2),
  };
}

export function coverSafeAreaRect(width: number, height: number) {
  const x = width * 0.04;
  const y = height * 0.04;
  return { x, y, width: width - x * 2, height: height - y * 2 };
}

export function drawFramedImage(ctx: CanvasRenderingContext2D, image: CanvasImageSource & { width: number; height: number }, framing: CoverFraming) {
  const geometry = coverFramingGeometry({
    sourceWidth: image.width,
    sourceHeight: image.height,
    outputWidth: ctx.canvas.width,
    outputHeight: ctx.canvas.height,
    framing,
  });
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(image, -geometry.left, -geometry.top, geometry.resizedWidth, geometry.resizedHeight);
}
