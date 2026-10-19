import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeVideoMedia, runFfmpeg } from '../lib/ffmpeg.ts';

// probeVideoMedia 的旋转归一测试（技术计划 §7.3 要求探测「时长、尺寸、帧率、旋转」）。
// 下游（视频分析/预览/缩略图/导入校验）统一消费显示尺寸：带 ±90/270° 旋转
// 元数据的竖拍视频必须交换宽高，否则后续 framing 全部按错误画幅计算。
//
// 注意：本机 ffmpeg 6.0 的 `-metadata:s:v rotate=90` 不会写出 display matrix，
// 所以 fixture 直接手工改写 tkhd 矩阵（等价于 iPhone 竖拍视频里的旋转元数据）。

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-video-media-'));

/** 把 mp4 第一个 tkhd box 的矩阵改写为 90° 旋转（{0,1,0,-1,0,0,0,0,1} 16.16 定点） */
function patchTkhdRotation90(filePath: string): void {
  const buffer = fs.readFileSync(filePath);
  const index = buffer.indexOf(Buffer.from('tkhd'));
  if (index < 0) throw new Error('tkhd box not found');
  if (buffer[index + 4] !== 0) throw new Error('fixture 只处理 version 0 的 tkhd');
  // version+flags(4) + creation(4)+modification(4)+trackId(4)+reserved(4)+duration(4)
  // +reserved(8)+layer(2)+alternateGroup(2)+volume(2)+reserved(2) = 40 字节之后是 36 字节矩阵
  const matrixOffset = index + 4 + 40;
  const matrix = [0x00000000, 0x00010000, 0x00000000, 0xffff0000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x40000000];
  matrix.forEach((value, offset) => buffer.writeUInt32BE(value >>> 0, matrixOffset + offset * 4));
  fs.writeFileSync(filePath, buffer);
}

const landscape = path.join(root, 'landscape.mp4');
await runFfmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=640x360:rate=24',
  '-pix_fmt', 'yuv420p', '-y', landscape,
]);

const rotated = path.join(root, 'rotated.mp4');
fs.copyFileSync(landscape, rotated);
patchTkhdRotation90(rotated);

const plain = await probeVideoMedia(landscape);
assert.equal(plain.width, 640);
assert.equal(plain.height, 360);
assert.ok(plain.durationUs > 900_000 && plain.durationUs < 1_100_000, `时长应接近 1s，实际 ${plain.durationUs}us`);
assert.equal(plain.fps, 24);
assert.ok(!plain.errorMessage, `正常视频不应有探测错误：${plain.errorMessage}`);

const spun = await probeVideoMedia(rotated);
assert.equal(spun.width, 360, '带 90° 旋转元数据的视频必须按显示尺寸交换宽高');
assert.equal(spun.height, 640);
assert.ok(spun.durationUs > 900_000 && spun.durationUs < 1_100_000);
assert.ok(!spun.errorMessage, `旋转视频不应有探测错误：${spun.errorMessage}`);

console.log('probe-video-media rotation tests passed');
