import assert from 'node:assert/strict';
import sharp from 'sharp';
import { validateUploadedImageBuffer } from '../lib/image-upload-validation.ts';

const validPng = await sharp({
  create: {
    width: 2,
    height: 2,
    channels: 4,
    background: { r: 255, g: 0, b: 0, alpha: 1 },
  },
}).png().toBuffer();

assert.equal(await validateUploadedImageBuffer(validPng, 'image/png'), true);
assert.equal(
  await validateUploadedImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'),
  false,
  '只有 PNG 魔数的截断文件必须在写盘前拒绝',
);
assert.equal(
  await validateUploadedImageBuffer(validPng, 'image/jpeg'),
  false,
  '解码格式必须和魔数识别结果一致',
);

console.log('image upload validation tests passed');
