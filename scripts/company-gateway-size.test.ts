import assert from 'node:assert/strict';
import {
  companyImageCapsForModel,
  companyImageDeliverySize,
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

// qiniuyun/gpt-image-2-medium：逐格实测放行 2K×{1:1,3:4,4:3,16:9,9:16} + 4K×{1:1,4:3,16:9,9:16}
// （1K 档被网关映射成 1080 类坏尺寸、3K 与 3:2/2:3/21:9 被拒、4K 3:4 映射坏被单格排除）
const qiniuyunCaps = companyImageCapsForModel('qiniuyun/gpt-image-2-medium')!;
assert.ok(qiniuyunCaps);
// 应用 1K 预设 → 钳制到 2K，避开网关 1K 下游映射 bug
assert.equal(snapCompanyImageSize('1024x1024', qiniuyunCaps), '1440x1440');
// 2K 4:3 恰好在白名单 → 原样
assert.equal(snapCompanyImageSize('1920x1440', qiniuyunCaps), '1920x1440');
// 应用 4K 9:16 预设 → 原样（4K 9:16 实测可用）
assert.equal(snapCompanyImageSize('2160x3840', qiniuyunCaps), '2160x3840');
// 应用 4K 1:1 预设 → 4K 1:1
assert.equal(snapCompanyImageSize('2880x2880', qiniuyunCaps), '2160x2160');
// 应用 4K 3:4 预设 → 坏格排除，优先裁切映射到同档位 4K 9:16（2160x3840 可完整
// 居中裁出 2160x2880，真 4K 级画质；交付端 normalize 按 companyImageDeliverySize
// 名义格裁回 3:4）
assert.equal(snapCompanyImageSize('2448x3264', qiniuyunCaps), '2160x3840');
// 应用 2K 3:2 预设 → 比例吸附到最近的 4:3
assert.equal(snapCompanyImageSize('2496x1664', qiniuyunCaps), '1920x1440');
// 应用 4K 21:9 预设 → 比例吸附到 16:9、保持 4K
assert.equal(snapCompanyImageSize('3696x1584', qiniuyunCaps), '3840x2160');
// auto → 默认 1:1 2K
assert.equal(snapCompanyImageSize('auto', qiniuyunCaps), '1440x1440');

// ── 公司模型交付尺寸（2026-08-21 起按网关原生像素交付，不再放大回应用预设）──
// 原生交付开关：qiniuyun（逐格实测按名义格出图）与 image2（实测返回更大尺寸，
// 白赚像素，比例偏差由交付端裁齐）都开启；其余公司模型（seedream 等）保持默认
assert.equal(qiniuyunCaps.nativeDelivery, true);
assert.equal(image2Caps.nativeDelivery, true);
assert.ok(!companyImageCapsForModel('doubao-seedream-5-0-image')!.nativeDelivery);
// 同比例：交付尺寸 = 生成原尺寸，交付端规整为 no-op
assert.equal(companyImageDeliverySize('1728x2304', qiniuyunCaps), '1440x1920');
assert.equal(companyImageDeliverySize('2048x2048', qiniuyunCaps), '1440x1440');
// 排除格：交付尺寸 = 名义格子（生成 donor 2160x3840 居中裁回 2160x2880，零放大）
assert.equal(companyImageDeliverySize('2448x3264', qiniuyunCaps), '2160x2880');
// 档位钳制：应用 1K 预设交付 2K 格（避开网关 1K 下游映射 bug）
assert.equal(companyImageDeliverySize('1024x1024', qiniuyunCaps), '1440x1440');
// image2-medium：应用 4K 4:3 预设 → 公司 4K 4:3 格
assert.equal(companyImageDeliverySize('3264x2448', image2Caps), '2880x2160');
// auto → 默认 1:1 2K 格
assert.equal(companyImageDeliverySize('auto', qiniuyunCaps), '1440x1440');

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
