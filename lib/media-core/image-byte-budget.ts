import sharp from 'sharp';

/** Keep the original dimensions when encoding alone meets the upload budget. */
export async function encodeImageWithinByteBudget(
  bytes: Buffer,
  mimeType: string,
  longestEdge: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer<ArrayBuffer>> {
  if (!longestEdge) throw new Error('missing image dimensions');
  const targetBytes = Math.floor(maxBytes * 0.95);
  for (let scale = 0; scale <= 10; scale++) {
    const qualities = mimeType === 'image/png' ? [95] : scale === 0 ? [95, 90, 82] : [90];
    for (const quality of qualities) {
      signal?.throwIfAborted();
      let pipeline = sharp(bytes).autoOrient();
      if (scale > 0) {
        const maxDim = Math.max(1, Math.floor(longestEdge * 0.75 ** scale));
        pipeline = pipeline.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
      }
      const candidate = await (mimeType === 'image/png'
        ? pipeline.png({ compressionLevel: 9 })
        : mimeType === 'image/webp' ? pipeline.webp({ quality }) : pipeline.jpeg({ quality, mozjpeg: true })
      ).toBuffer();
      signal?.throwIfAborted();
      if (candidate.length <= targetBytes) return candidate as Buffer<ArrayBuffer>;
    }
  }
  throw new Error('image still exceeds budget');
}
