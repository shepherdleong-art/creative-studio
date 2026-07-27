import sharp from 'sharp';

const OVERLAY_MEASUREMENT_TOLERANCE_PX = 4;

export async function alphaBoundsWidth(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let maxX = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] > 0) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
  }
  return maxX < minX ? 0 : maxX - minX + 1;
}

export function textInterval(width: number, x: number, align: 'left' | 'center' | 'right') {
  if (align === 'left') return [x, x + width] as const;
  if (align === 'right') return [x - width, x] as const;
  return [x - width / 2, x + width / 2] as const;
}

export function overlayMeasurementLimit(expectedWidth: number): number {
  return Math.ceil(expectedWidth) + OVERLAY_MEASUREMENT_TOLERANCE_PX;
}
