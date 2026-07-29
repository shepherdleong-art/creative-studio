import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  SCRIPT_VISION_IMAGE_MAX_BYTES,
  SCRIPT_VISION_IMAGE_MAX_SIDE,
  prepareScriptVisionImage,
} from '../lib/script-vision-image.ts';

const width = 1800;
const height = 1400;
const pixels = Buffer.allocUnsafe(width * height * 3);
for (let offset = 0; offset < pixels.length; offset += 3) {
  const pixel = offset / 3;
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  pixels[offset] = (x * 17 + y * 13) % 256;
  pixels[offset + 1] = (x * 7 + y * 23) % 256;
  pixels[offset + 2] = (x * 29 + y * 5) % 256;
}

const original = await sharp(pixels, { raw: { width, height, channels: 3 } })
  .png({ compressionLevel: 0 })
  .toBuffer();
const prepared = await prepareScriptVisionImage({
  imageBuffer: original,
  mimeType: 'image/png',
});

assert.equal(prepared.mimeType, 'image/jpeg');
assert.ok(prepared.imageBuffer.length <= SCRIPT_VISION_IMAGE_MAX_BYTES);
assert.ok(Math.max(prepared.width, prepared.height) <= SCRIPT_VISION_IMAGE_MAX_SIDE);
assert.ok(prepared.imageBuffer.length < original.length / 4, '视觉请求图片应显著小于原始 PNG');

const metadata = await sharp(prepared.imageBuffer).metadata();
assert.equal(metadata.format, 'jpeg');
assert.equal(metadata.width, prepared.width);
assert.equal(metadata.height, prepared.height);

console.log('script vision image tests passed');
