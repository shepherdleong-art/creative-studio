// 应用图标资源：新标志必须真的产出到每一档尺寸，且不是空文件/全透明。
//
// 生成流程是 `npm run icons`（scripts/generate-app-icons.mjs，源图 app/icon.svg）。
// 这条测试不需要重新生成，只校验产物；源图特征单独断言，防止有人把源图换回
// 深底白 C 的旧图标。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath));

// ---------- 源图：叶子形眼睛 + 绿色渐变 ----------

const sourceSvg = read('app/icon.svg').toString('utf8');
assert.match(sourceSvg, /viewBox="0 0 100 100"/, '源图必须是 100×100 视图框');
assert.match(sourceSvg, /<linearGradient/, '标志必须在渐变圆角方块里');
assert.match(sourceSvg, /#46A97B/, '渐变起点色 #46A97B');
assert.match(sourceSvg, /#1D6A4B/, '渐变终点色 #1D6A4B');
assert.match(sourceSvg, /rotate\(-45 50 50\)/, '叶子必须旋转 −45°');
// 叶子形眼睛：两段贝塞尔围出的梭形 + 中间圆形瞳孔（evenodd 挖空）。
assert.match(sourceSvg, /M12 50C28 20 72 20 88 50/, '缺少叶子形外轮廓');
assert.match(sourceSvg, /a11 11 0 100 22/, '缺少圆形瞳孔');
assert.match(sourceSvg, /fill-rule="evenodd"/, '瞳孔必须是挖空而不是叠色');

// 公共图标副本必须与源图一致（脚本会 copy app/icon.svg → public/icons/app-icon.svg）。
assert.equal(
  read('public/icons/app-icon.svg').toString('utf8'),
  sourceSvg,
  'public/icons/app-icon.svg 应与 app/icon.svg 一致，跑 npm run icons 重新产出',
);

// ---------- 位图产物：每一档都存在、尺寸正确、有实际内容 ----------

const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
for (const size of PNG_SIZES) {
  const file = path.join(root, 'public', 'icons', `app-icon-${size}.png`);
  assert.ok(fs.existsSync(file), `缺少 public/icons/app-icon-${size}.png`);
  const bytes = fs.statSync(file).size;
  assert.ok(bytes > 0, `public/icons/app-icon-${size}.png 是空文件`);
  const metadata = await sharp(file).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, size);
  assert.equal(metadata.height, size);
  // 纯透明或单色图会被压得极小；叶子标志在 16px 上仍有 300 字节以上。
  assert.ok(bytes > 120, `public/icons/app-icon-${size}.png 内容可疑（${bytes} 字节）`);
}

// Apple 触摸图标（Next 约定：app/apple-icon.png 以 /apple-icon.png 提供）。
const appleFile = path.join(root, 'app', 'apple-icon.png');
assert.ok(fs.existsSync(appleFile), '缺少 app/apple-icon.png');
const apple = await sharp(appleFile).metadata();
assert.equal(apple.format, 'png');
assert.equal(apple.width, 180);
assert.equal(apple.height, 180);

// favicon.ico：ICO 头 + 至少 6 档（16/32/48/64/128/256）。
const ico = read('app/favicon.ico');
assert.ok(ico.length > 0, 'app/favicon.ico 是空文件');
assert.equal(ico.readUInt16LE(0), 0, 'ICO 保留字段必须为 0');
assert.equal(ico.readUInt16LE(2), 1, 'ICO 类型必须为 1（图标）');
const icoCount = ico.readUInt16LE(4);
assert.equal(icoCount, 6, 'favicon.ico 应包含 6 档尺寸');
const declaredSizes = [];
for (let index = 0; index < icoCount; index += 1) {
  const entry = 6 + index * 16;
  // 目录里 256 记作 0。
  declaredSizes.push(ico.readUInt8(entry) === 0 ? 256 : ico.readUInt8(entry));
  assert.ok(ico.readUInt32LE(entry + 8) > 0, `favicon.ico 第 ${index + 1} 档长度为 0`);
}
assert.deepEqual(declaredSizes, [16, 32, 48, 64, 128, 256]);

// 标志确实是绿色系：圆角方块内部的采样点，绿色分量必须明显高于蓝色。
const { data, info } = await sharp(path.join(root, 'public', 'icons', 'app-icon-256.png'))
  .raw()
  .toBuffer({ resolveWithObject: true });
// 圆角之外是透明的，沿中轴往下取点，跳过透明像素。
const samplePoints: Array<[number, number]> = [
  [0.5, 0.08], [0.5, 0.15], [0.15, 0.5], [0.85, 0.5], [0.5, 0.92],
];
const opaqueSamples = samplePoints
  .map(([x, y]) => [
    Math.round(info.width * x),
    Math.round(info.height * y),
  ] as const)
  .map(([x, y]) => {
    const offset = (y * info.width + x) * info.channels;
    return { alpha: info.channels === 4 ? data[offset + 3] : 255, r: data[offset], g: data[offset + 1], b: data[offset + 2] };
  })
  .filter((sample) => sample.alpha > 200);
assert.ok(opaqueSamples.length > 0, '图标采样点全透明，产物可疑');
const greenest = opaqueSamples.find((sample) => sample.g > sample.r && sample.g > sample.b);
assert.ok(
  greenest !== undefined,
  `标志应为绿色系，实测 ${opaqueSamples.map((s) => `rgb(${s.r},${s.g},${s.b})`).join(' ')}`,
);

console.log(`app icon asset tests passed (${PNG_SIZES.length} png + ico + apple)`);
