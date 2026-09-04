import assert from 'node:assert/strict';
import { getImageJobDisplayName } from '../lib/image-job-display-name.ts';
import {
  getGptImage2AspectRatio,
  resolveGptImage2Size,
} from '../lib/gpt-image-2-size-presets.ts';
import {
  getSupportedImageAspectRatios,
  validateImageAspectRatio,
} from '../lib/image-generation-settings.ts';

// 比例选择必须落成目标尺寸，不能退回默认 1:1。
assert.equal(resolveGptImage2Size('3:4', '1k'), '864x1152');
assert.equal(resolveGptImage2Size('16:9', '2k'), '2560x1440');
assert.equal(getGptImage2AspectRatio('864x1152'), '3:4');
assert.equal(getGptImage2AspectRatio('1024x1024'), '1:1');
assert.equal(getGptImage2AspectRatio('1024x1366'), '3:4', '公司网关取整尺寸仍应显示为 3:4');
assert.equal(getGptImage2AspectRatio('auto'), 'auto');
assert.equal(getGptImage2AspectRatio('custom'), null);

// image2-medium 的网关白名单不含 9:16；UI 不应让用户选到，接口也不能静默吸附成别的比例。
assert.ok(getSupportedImageAspectRatios('image2-medium').includes('3:4'));
assert.equal(getSupportedImageAspectRatios('image2-medium').includes('9:16'), false);
assert.equal(validateImageAspectRatio('image2-medium', '3:4'), null);
assert.match(validateImageAspectRatio('image2-medium', '9:16') || '', /不支持/);
assert.equal(validateImageAspectRatio('custom-image-model', '9:16'), null);

// 成功结果的产出名优先，避免 UUID 输入名占据结果标题；未完成任务仍保留输入名。
assert.equal(
  getImageJobDisplayName({
    id: 'job-1',
    inputFilename: '469bcd79-6e26-4deb-bb9e-5b60852e9881.jpg',
    outputFilename: '场景-469bcd79-6e26-4deb-bb9e-5b60852e9881.jpg',
  }),
  '场景-469bcd79-6e26-4deb-bb9e-5b60852e9881.jpg',
);
assert.equal(getImageJobDisplayName({ id: 'job-2', inputFilename: '原图.png' }), '原图.png');
assert.equal(getImageJobDisplayName({ id: '1234567890' }), '图片任务-12345678');

console.log('image-generation contract tests passed');
