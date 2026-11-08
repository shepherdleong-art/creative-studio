import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const page = readFileSync(new URL('../app/(workspace)/projects/[id]/page.tsx', import.meta.url), 'utf8');

// 08 号票：第 4 步改为占满「侧栏右边的整块内容区」。原来的
// `.video-generation-section` 按 100vw 算宽再左移 50% 居中，会越过侧栏，
// 1280/1024 窗口下把「选择分镜组」整块推到视口外（04 工具实测横向多出 62–96px）。
// 断言仍是「第 4 步有一个专属外壳类、不是通用嵌套卡片、三栏几何成立」。
assert.match(page, /video-generation-section/, 'video tab should use its dedicated app-like section class');
assert.doesNotMatch(page, /video-generation-section card p-5/, 'video tab should not render as a generic nested card');
assert.doesNotMatch(
  css,
  /\.video-generation-section\s*\{[^}]*transform:\s*translateX\(-50%\)/s,
  '第 4 步外壳不得再用 100vw + translateX 的整页宽布局（会越过侧栏溢出）',
);
assert.doesNotMatch(
  css,
  /\.video-generation-section\s*\{[^}]*width:\s*min\(calc\(100vw/s,
  '第 4 步外壳宽度必须由内容区决定，不能按 100vw 另算',
);

assert.match(css, /\.video-workspace\s*{[^}]*display:\s*grid/s, 'video workspace should use explicit grid columns');
// 三栏：左（首尾帧编辑）/ 中（预览，必须最宽）/ 右（结果与「这条视频用的设置」）。
assert.match(
  css,
  /grid-template-columns:\s*minmax\(320px,\s*400px\)\s*minmax\(0,\s*1fr\)\s*minmax\(220px,\s*280px\)/s,
  'video workspace should reserve room for the paired first/tail-frame editor and a dominant center preview',
);
assert.doesNotMatch(css, /left-col\s*{[^}]*max-width:\s*230px/s, 'left video editor must not be capped at 230px');
assert.match(css, /\.video-preview-fit\s*{[^}]*max-width:\s*100%/s, 'center preview should be allowed to fill its dominant column');
assert.match(css, /\.video-workspace\s+\.video-prompt-field\.input-field\s*{[^}]*min-height:\s*150px/s, 'motion prompt textarea should be tall enough for real descriptions');
assert.match(css, /\.video-workspace\s*>\s*\.video-preview-col\s*{[^}]*background:\s*rgba\(255,255,255,\.48\)/s, 'preview column should use a light canvas instead of a black frame');
assert.doesNotMatch(css, /\.video-workspace\s*>\s*\.video-preview-col\s*{[^}]*linear-gradient\(180deg,\s*#2c2c2e,\s*#111113\)/s, 'preview column should not render a dark box around the video');
assert.match(css, /\.stage-controls\s*{[^}]*background:\s*rgba\(252,\s*252,\s*254,\s*0\.94\)/s, 'preview controls should use a light glass bar');

console.log('video workspace layout contract tests passed');
