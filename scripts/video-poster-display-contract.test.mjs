// 视频缩略图展示契约（票 02 / 规格 §4）。
//
// 缺陷：components/VideoGenerationResults.tsx 用 Next 默认图片优化。优化器是服务端
// 内部请求，不带入站 Cookie，而 /api/images/[...path] 在 server 模式要求会话 ——
// 受保护海报在优化器里 401，浏览器显示破图。修复方式必须同时满足：
//   - 走浏览器带会话的同源请求（unoptimized 或等效），不是公开文件接口；
//   - 不取消服务端鉴权、不在 URL 里塞会话凭据；
//   - 只修直接相关的调用点，不全局关闭下一整站的图片优化；
//   - 失败有占位、无破图、无无界重试；海报/布局/播放/下载保持。
//
// 本文件只看静态契约（快、随组件改动即失败）；真实渲染由
// scripts/video-poster-auth.playwright.test.mjs 用真会话浏览器断言。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const results = fs.readFileSync('components/VideoGenerationResults.tsx', 'utf8');
const nextConfig = fs.readFileSync('next.config.ts', 'utf8');

// ── 1. 海报必须绕过服务端图片优化 ────────────────────────────────────────
assert.doesNotMatch(
  results,
  /<Image\s+src=\{job\.posterImageUrl\}\s+alt="视频缩略图"\s+fill/,
  '海报不得继续用默认优化的 next/image：优化器不带入站 Cookie，受保护图片会 401 破图',
);

// 受保护海报的展示组件必须显式 unoptimized。允许实现把它抽到独立组件或内联，
// 但渲染 job.posterImageUrl 的那段必须带上 unoptimized（跨组件扫描在下面统一兜底）。
assert.match(
  results,
  /<Image\b(?=[\s\S]*?src=\{url\})(?=[\s\S]*?\bunoptimized\b)[\s\S]*?\/>/,
  '海报缩略图必须以 unoptimized 渲染：默认优化器不带入站 Cookie，受保护图片会 401 破图',
);
assert.match(
  results,
  /job\.posterImageUrl\s*\?[\s\S]{0,120}?<PosterThumb\s+url=\{job\.posterImageUrl\}/,
  '结果卡必须通过具名海报组件渲染 posterImageUrl，失败占位才能挂在该组件上',
);

// ── 2. 不全局关闭图片优化 ────────────────────────────────────────────────
assert.doesNotMatch(
  nextConfig,
  /images\s*:\s*\{[^}]*unoptimized\s*:\s*true/s,
  '不得在 next.config 全局关闭图片优化：只修这张票直接相关的受保护媒体路径',
);

// ── 3. 直接相关的受保护媒体 Image 调用点：必须逐个 unoptimized ────────────
// 扫描所有客户端组件里的 next/image 调用，凡 src 来自受保护的 /api/ 媒体
// （job.posterImageUrl、material.thumbnailUrl 等）都必须 unoptimized。
// 断言的是「直接相关的路径已修复」，不是全站开关。
const componentFiles = fs.readdirSync('components', { recursive: true })
  .filter((entry) => typeof entry === 'string' && entry.endsWith('.tsx'));

function imageTags(source) {
  return source.match(/<Image\b[\s\S]*?\/>/g) ?? [];
}

const optimizedProtectedMedia = [];
for (const relative of componentFiles) {
  const file = `components/${relative.split('\\').join('/')}`;
  const source = fs.readFileSync(file, 'utf8');
  for (const tag of imageTags(source)) {
    const protectedMedia = /src=\{[^}]*(?:posterUrl|PosterUrl|thumbnailUrl|imageUrl)[^}]*\}/.test(tag);
    if (protectedMedia && !/\bunoptimized\b/.test(tag)) {
      optimizedProtectedMedia.push(`${file}: ${tag.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
}
assert.deepEqual(
  optimizedProtectedMedia,
  [],
  '受保护媒体（/api/ 下的会话鉴权图片）不得交给 Next 图片优化器；'
  + '优化器的服务端内部请求不带 Cookie，会 401 破图。逐个加 unoptimized：\n'
  + optimizedProtectedMedia.join('\n'),
);

// ── 4. 失败占位，且不是无界重试 ──────────────────────────────────────────
assert.match(results, /onError=/, '海报加载失败必须有失败处理，否则留下破图图标');
assert.doesNotMatch(
  results,
  /onError=\{[\s\S]{0,200}?set[A-Za-z]*(?:Retry|Attempt|Count)[\s\S]{0,80}?\+\s*1/,
  '失败不得自增重试计数重发请求：会产生无界请求循环',
);
assert.match(
  results,
  /缩略图不可用|海报不可用/,
  '失败占位必须有明确中文文案，而不是只隐藏图片',
);

// ── 5. 播放与下载保持可用 ────────────────────────────────────────────────
assert.match(results, /download=\{job\.displayName \|\| job\.filename\}/, '下载入口必须保持');
assert.match(results, /onPreview\(job\.id\)/, '播放入口必须保持');
assert.match(results, /play-overlay/, '缩略图上的播放遮罩必须保持');

// ── 6. 不得用 URL 凭据或公开接口绕开鉴权 ─────────────────────────────────
assert.doesNotMatch(results, /[?&](?:token|session|csrf|cookie)=/i, '不得把会话凭据塞进图片 URL');
assert.doesNotMatch(results, /\/api\/team\/files\/|publicUrl|public-url/, '不得改用公开文件接口替代受保护图片鉴权');

console.log('video poster display contract tests passed');
