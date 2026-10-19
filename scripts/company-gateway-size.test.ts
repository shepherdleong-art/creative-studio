import assert from 'node:assert/strict';
import {
  companyImageCapsForModel,
  companyVideoCapsForModel,
  snapCompanyImageSize,
  snapCompanyVideoSize,
} from '../lib/company-gateway-size.ts';

// ── 模型能力识别 ──
assert.ok(companyImageCapsForModel('image2-medium'));
assert.ok(companyImageCapsForModel('image2-high'));
assert.ok(companyImageCapsForModel('doubao-seedream-5-0-image'));
assert.ok(companyImageCapsForModel('doubao-seedream-5-0-pro-image'));
assert.equal(companyImageCapsForModel('gpt-image-2'), null);
assert.equal(companyImageCapsForModel('nano-banana-2.5'), null);

assert.ok(companyVideoCapsForModel('kling-3.0'));
assert.ok(companyVideoCapsForModel('kling-3.0-Omni'));
// seedance 省略 size（上游对 Kling 表尺寸 400），由网关按首帧默认处理
assert.equal(companyVideoCapsForModel('doubao-seedance-2-0-260128'), null);
assert.equal(companyVideoCapsForModel('doubao-seedance-2-0-fast-260128'), null);
assert.equal(companyVideoCapsForModel('sora-2'), null);

// ── 图片 size 吸附 ──
const image2Caps = companyImageCapsForModel('image2-medium')!;
// 应用预设 2K 4:3（2304x1728，非白名单）→ 公司 2K 4:3
assert.equal(snapCompanyImageSize('2304x1728', image2Caps), '1920x1440');
// 应用预设 2K 3:4 → 公司 2K 3:4
assert.equal(snapCompanyImageSize('1728x2304', image2Caps), '1440x1920');
// 1K 1:1 恰好在白名单 → 原样
assert.equal(snapCompanyImageSize('1024x1024', image2Caps), '1024x1024');
// image2 不支持 9:16：应用预设 2K 9:16（1440x2560）→ 就近比例 2:3 的 2K
assert.equal(snapCompanyImageSize('1440x2560', image2Caps), '1440x2160');
// 应用预设 4K 16:9（3840x2160，在白名单）→ 原样
assert.equal(snapCompanyImageSize('3840x2160', image2Caps), '3840x2160');
// auto → 默认 1:1 2K
assert.equal(snapCompanyImageSize('auto', image2Caps), '1440x1440');
// 非预设尺寸按像素就近选档：≈1K 量级 → 1K
assert.equal(snapCompanyImageSize('1000x1000', image2Caps), '1024x1024');

// seedream-lite 最低 2K：应用 1K 预设被钳制到 2K
const seedreamLiteCaps = companyImageCapsForModel('doubao-seedream-5-0-image')!;
assert.equal(snapCompanyImageSize('1024x1024', seedreamLiteCaps), '1440x1440');
// seedream-lite 支持 9:16 → 保持 9:16
assert.equal(snapCompanyImageSize('1440x2560', seedreamLiteCaps), '1440x2560');
// seedream-pro 最高 2K：应用 4K 预设被钳制到 2K
const seedreamProCaps = companyImageCapsForModel('doubao-seedream-5-0-pro-image')!;
assert.equal(snapCompanyImageSize('2880x2880', seedreamProCaps), '1440x1440');

// ── 视频 size 吸附 ──
const klingCaps = companyVideoCapsForModel('kling-3.0')!;
// 4:3 源图 → 1K 4:3（档位偏好 1K，不随源图分辨率上浮）
assert.equal(snapCompanyVideoSize(2304, 1728, klingCaps), '1366x1024');
// 9:16 源图 → 1K 9:16
assert.equal(snapCompanyVideoSize(720, 1280, klingCaps), '1024x1820');
// Omni 只支持 3:4/4:3：16:9 源图吸附到最近的 4:3，档位 1K
const omniCaps = companyVideoCapsForModel('kling-3.0-Omni')!;
assert.equal(snapCompanyVideoSize(1920, 1080, omniCaps), '1366x1024');
// 正方形源图：3:4 与 4:3 等距，偏好横向 4:3
assert.equal(snapCompanyVideoSize(1000, 1000, klingCaps), '1366x1024');
// 非法输入 → null
assert.equal(snapCompanyVideoSize(0, 100, klingCaps), null);

console.log('company-gateway-size tests passed');
