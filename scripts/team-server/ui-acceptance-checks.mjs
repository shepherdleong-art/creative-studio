/**
 * 界面尺寸检查（第 04 号票）—— 原型三个检查脚本的 Playwright 改写。
 *
 * 原型依据：
 *   docs/superpowers/specs/2026-11-07-林视界面重设计-原型/tools/checks/按钮被切.py
 *   docs/superpowers/specs/2026-11-07-林视界面重设计-原型/tools/checks/工具栏藏内容.py
 *   docs/superpowers/specs/2026-11-07-林视界面重设计-原型/tools/checks/画面比例.py
 *
 * 本文件分两层，便于不启浏览器就单测判定规则：
 *   1. `collect*` —— 在浏览器里跑（page.evaluate），只做测量，返回原始几何。
 *      这些函数**不能引用模块级常量**：Playwright 会把函数体序列化后送进页面，
 *      外部引用拿不到。需要的值一律通过参数传，或在函数体内写字面量。
 *   2. `evaluate*` —— 在 Node 里跑，只吃测量结果，给出 passed/failed 与原因。
 *
 * 尺寸要求本身就是需求（规格 Testing Decisions / V04 / V05），所以：
 *   - 判定阈值不因为「当前实现做不到」而放宽；
 *   - 已知问题只能通过 `knownFailure` 标记（见 ui-acceptance-screens.mjs），修好后必须删标记。
 */

/** 与原型一致的容差：1.5px 几何误差、2% 比例误差、100px 最小画面宽。 */
export const TOLERANCE = Object.freeze({ clipPx: 1.5, ratio: 0.02, minMediaWidth: 100 });

/** 输出画幅比：data 属性值 → 数值比例。原型 3:4 / 9:16，另外兼容 16:9、4:3、1:1。 */
export const PRESET_RATIOS = Object.freeze({ '3x4': 3 / 4, '9x16': 9 / 16, '16x9': 16 / 9, '4x3': 4 / 3, '1x1': 1 });

/** 会被判“被切掉一截”的控件。原型只查 button/input/label/.tag，这里补上同等的交互控件。 */
export const CONTROL_SELECTOR = 'button, input, select, textarea, label, [role="button"], [role="tab"], [role="option"], [role="switch"], [role="radio"], [role="checkbox"]';

/** 四个检查的稳定键名；屏幕清单里用这些键开关。 */
export const CHECK_KEYS = Object.freeze(['horizontalScroll', 'clippedControls', 'hiddenOverflowContent', 'mediaFrames']);

/**
 * 共享外壳（每屏都长同一样的那部分）的选择器。
 *
 * 为什么要有它：左侧栏这种外壳在每一屏都出现，它坏了会让全部屏幕同时红，
 * 掩盖掉「这一屏自己」的问题（比如混剪页溢出 61px 就分不出来了）。所以：
 *   - 普通屏幕只量「自己的内容区」，跳过外壳子树；
 *   - 外壳单独由 `workspace-sidebar` 屏来量（owner 就是改外壳的那张票）。
 * 这只改变「在哪一屏量」，不改变「量什么」—— 外壳的缺陷照样会被抓出来。
 */
export const SHELL_SELECTOR = "aside[data-testid='workspace-sidebar'], header[data-team-shell], [data-testid='page-toolbar']";

const inShell = (element) => Boolean(element.closest && element.closest("aside[data-testid='workspace-sidebar']"));

// ---------------------------------------------------------------------------
// 检查一：页面有没有横向滚动
// ---------------------------------------------------------------------------

/** 浏览器侧测量：整页 scrollWidth 与视口之差，并列出越界元素，便于定位是谁撑开的。 */
export function collectHorizontalOverflow(options = {}) {
  const limit = options.limit ?? 8;
  const innerWidth = window.innerWidth;
  const bodyWidth = document.body ? document.body.scrollWidth : 0;
  const scrollWidth = Math.max(document.documentElement.scrollWidth, bodyWidth);
  const overflowPx = Math.max(0, scrollWidth - innerWidth);
  const offenders = [];
  if (overflowPx > 0) {
    for (const element of document.querySelectorAll('body *')) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (rect.right <= innerWidth + 1) continue;
      offenders.push({
        signature: `${element.tagName.toLowerCase()}${String(element.className ?? '').split(' ')[0] ? `.${String(element.className).split(' ')[0]}` : ''}`,
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 24),
      });
      if (offenders.length >= limit) break;
    }
  }
  return { innerWidth, scrollWidth, overflowPx, offenders };
}

/** 判定：允许 1px 取整误差，与原型 `scrollWidth > W + 1` 一致。 */
export function evaluateHorizontalOverflow(measurement, options = {}) {
  const tolerance = options.tolerance ?? 1;
  if (!measurement) return { passed: false, detail: '没有拿到整页宽度测量结果' };
  const overflowPx = measurement.overflowPx ?? 0;
  if (overflowPx <= tolerance) {
    return { passed: true, detail: `整页 ${measurement.scrollWidth}px = 视口 ${measurement.innerWidth}px，没有横向滚动` };
  }
  const where = (measurement.offenders ?? []).slice(0, 3)
    .map((item) => `${item.signature}${item.text ? `「${item.text}」` : ''} 右到 ${item.right}px`)
    .join('；');
  return {
    passed: false,
    detail: `整页横向多出 ${overflowPx}px（${measurement.scrollWidth}px > 视口 ${measurement.innerWidth}px）${where ? `；越界元素：${where}` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// 检查二：按钮、标签、输入框有没有被切掉一截
// ---------------------------------------------------------------------------

/**
 * 浏览器侧测量。规则照原型：只看横向；被 auto/scroll 祖先包着的可以滚动看到，不算切掉；
 * 其余情况下元素超出「祖先可见边界 ∩ 视口」即记为被切。
 */
export function collectClippedControls(options = {}) {
  const selector = options.selector ?? 'button, input, select, textarea, label, [role="button"], [role="tab"], [role="option"], [role="switch"], [role="radio"], [role="checkbox"]';
  const limit = options.limit ?? 12;
  const innerWidth = window.innerWidth;
  const results = [];
  const seen = new Set();
  for (const element of document.querySelectorAll(selector)) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (Number(style.opacity) === 0) continue;
    if (element.closest('[inert]')) continue;
    let clipper = null;
    let clipperOverflowX = '';
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (/(hidden|clip|auto|scroll)/.test(parentStyle.overflowX)) {
        clipper = parent;
        clipperOverflowX = parentStyle.overflowX;
        break;
      }
    }
    if (clipperOverflowX === 'auto' || clipperOverflowX === 'scroll') continue;
    const band = clipper ? clipper.getBoundingClientRect() : { left: 0, right: innerWidth };
    const visibleLeft = Math.max(0, band.left);
    const visibleRight = Math.min(innerWidth, band.right);
    const clippedRight = rect.right > visibleRight + 1.5 && rect.left < visibleRight - 2;
    const clippedLeft = rect.left < visibleLeft - 1.5 && rect.right > visibleLeft + 2;
    if (!clippedRight && !clippedLeft) continue;
    const text = (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().slice(0, 20);
    const role = element.getAttribute('role');
    const signature = `${element.tagName.toLowerCase()}${role ? `[${role}]` : ''}「${text}」`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    results.push({
      signature,
      tag: element.tagName.toLowerCase(),
      text,
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      visibleLeft: Math.round(visibleLeft),
      visibleRight: Math.round(visibleRight),
      clipped: clippedRight ? 'right' : 'left',
      className: String(element.className ?? '').slice(0, 80),
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** 判定：任一条被切即失败。 */
export function evaluateClippedControls(items) {
  if (!Array.isArray(items)) return { passed: false, detail: '没有拿到控件几何测量结果' };
  if (items.length === 0) return { passed: true, detail: '所有按钮、标签、输入框都完整可见' };
  const detail = items.slice(0, 4)
    .map((item) => `${item.signature} 被${item.clipped === 'right' ? '右' : '左'}边切掉（${item.left}–${item.right}px，可见到 ${item.visibleRight}px）`)
    .join('；');
  return { passed: false, detail: `${items.length} 个控件被切掉一截：${detail}` };
}

// ---------------------------------------------------------------------------
// 检查三：工具栏放不下时有没有偷偷藏内容
// ---------------------------------------------------------------------------

/**
 * 浏览器侧测量。原型判据是「横向可滚动但滚动条被隐藏、内容比可视区宽」，意图是
 * 「内容被藏起来、用户看不到也点不到」。
 *
 * 原型原写法有两处不能照搬：
 *   - 判定字段 `getComputedStyle(el).scrollbarWidth === 'none'` 在 Chromium 里永远不成立
 *     （那是 Firefox 属性，Chromium 只作 legacy 别名返回 `auto`）；
 *   - headless Chromium 用 overlay 滚动条，`offsetHeight - clientHeight` 恒为 0
 *     （本票实测确认），「没有滚动条槽位」不能当作滚动条被隐藏的证据。
 *
 * 所以改成测两种真正「内容不可达」的情形：
 *   1. `overflow-x: auto|scroll` 且显式关掉滚动条（`scrollbar-width: none`）——
 *      能滚但没有可见提示，按原型意图算藏内容；
 *   2. `overflow-x: hidden|clip` 且内容比可视区宽 —— 内容被裁掉且滚不到。
 *      例外：单行截断（`text-overflow: ellipsis`，即 Tailwind `truncate`）是设计上有意的省略号，
 *      用户看得见「…」，不算藏内容。表单控件（input/textarea/select）自己的内部横向滚动是
 *      浏览器原生行为（输入长了就能左右看），也不属于「工具栏藏内容」；控件本身被切掉由
 *      检查二（clippedControls）单独负责。
 */
const FORM_CONTROL_TAGS = 'input, textarea, select';

export function collectHiddenOverflowContent(options = {}) {
  const limit = options.limit ?? 12;
  const results = [];
  for (const element of document.querySelectorAll('body *')) {
    if (element.matches(FORM_CONTROL_TAGS)) continue;
    const style = getComputedStyle(element);
    const overflowX = style.overflowX;
    if (!/^(auto|scroll|hidden|clip)$/.test(overflowX)) continue;
    const overflowPx = element.scrollWidth - element.clientWidth;
    if (overflowPx <= 1) continue;
    const explicitlyScrollable = overflowX === 'auto' || overflowX === 'scroll';
    const scrollbarSuppressed = style.scrollbarWidth === 'none';
    const ellipsisTruncated = style.textOverflow === 'ellipsis';
    let reason = null;
    if (explicitlyScrollable) {
      if (scrollbarSuppressed) reason = 'overflow-x 可滚动但滚动条被显式隐藏（scrollbar-width: none）';
    } else if (!ellipsisTruncated) {
      reason = `overflow-x: ${overflowX}，内容被裁掉且滚不到，也没有省略号提示`;
    }
    if (!reason) continue;
    const text = (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const firstClass = String(element.className ?? '').split(' ')[0];
    results.push({
      signature: `${element.tagName.toLowerCase()}${firstClass ? `.${firstClass}` : ''}「${text}」`,
      overflowX,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      overflowPx,
      reason,
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** 判定：发现即失败（内容不可达就是不可达）。 */
export function evaluateHiddenOverflowContent(items) {
  if (!Array.isArray(items)) return { passed: false, detail: '没有拿到滚动容器测量结果' };
  if (items.length === 0) return { passed: true, detail: '没有「内容被裁掉或藏起来且用户够不到」的容器' };
  const detail = items.slice(0, 4)
    .map((item) => `${item.signature} 内容 ${item.scrollWidth}px / 可见 ${item.clientWidth}px（${item.reason}）`)
    .join('；');
  return { passed: false, detail: `${items.length} 处内容被藏起来：${detail}` };
}

// ---------------------------------------------------------------------------
// 检查四：视频/成片画面比例对不对、够不够大
// ---------------------------------------------------------------------------

/**
 * 浏览器侧测量。对象：`<video>`、带画幅标记的容器（data-output-preset / data-preset / data-media-frame）。
 * 期望比例优先取 data 标注，其次取视频固有尺寸；两者都没有就记为「无期望比例」并在判定里跳过。
 */
export function collectMediaFrames(options = {}) {
  const limit = options.limit ?? 24;
  const innerWidth = window.innerWidth;
  const innerHeight = window.innerHeight;
  const results = [];
  const seen = new Set();
  for (const element of document.querySelectorAll('video, [data-output-preset], [data-preset], [data-media-frame]')) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const isVideo = element.tagName.toLowerCase() === 'video';
    const presetAttr = element.getAttribute('data-output-preset') || element.getAttribute('data-preset') || '';
    const declared = /^(\d+)x(\d+)$/.exec(presetAttr);
    let expected = declared ? Number(declared[1]) / Number(declared[2]) : null;
    let source = declared ? `data 标注 ${presetAttr}` : '';
    if (expected === null && isVideo) {
      const videoWidth = Number(element.videoWidth ?? 0);
      const videoHeight = Number(element.videoHeight ?? 0);
      if (videoWidth > 0 && videoHeight > 0) {
        expected = videoWidth / videoHeight;
        source = `视频固有尺寸 ${videoWidth}×${videoHeight}`;
      }
    }
    if (expected === null) source = '没有画幅标记，也没有视频固有尺寸';
    const aria = element.getAttribute('aria-label');
    const signature = `${element.tagName.toLowerCase()}${aria ? `「${aria}」` : ''}${presetAttr ? `[${presetAttr}]` : ''}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    results.push({
      signature,
      isVideo,
      expected,
      source,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      ratio: rect.height > 0 ? Number((rect.width / rect.height).toFixed(4)) : null,
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      innerWidth,
      innerHeight,
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** 判定：比例 ±2%、宽 ≥ 100px、不越出视口 —— 原型 画面比例.py 的 ok 条件。 */
export function evaluateMediaFrames(frames, options = {}) {
  const ratioTolerance = options.ratioTolerance ?? TOLERANCE.ratio;
  const minWidth = options.minWidth ?? TOLERANCE.minMediaWidth;
  if (!Array.isArray(frames)) return { passed: false, detail: '没有拿到画面测量结果', measured: 0, problems: [] };
  const problems = [];
  let measured = 0;
  for (const frame of frames) {
    if (frame.expected === null || !Number.isFinite(frame.expected)) continue;
    measured += 1;
    const label = `${frame.signature}（${frame.source}）`;
    if (!(frame.height > 0)) {
      problems.push(`${label} 高度为 0，画面没有渲染`);
      continue;
    }
    if (Math.abs(frame.ratio - frame.expected) >= ratioTolerance) {
      problems.push(`${label} 比例 ${frame.ratio.toFixed(3)}，应为 ${frame.expected.toFixed(3)}（${frame.width}×${frame.height}）`);
    }
    if (frame.width < minWidth) {
      problems.push(`${label} 宽 ${frame.width}px，小于 ${minWidth}px，画面太小`);
    }
    if (frame.bottom > frame.innerHeight + 1 || frame.right > frame.innerWidth + 1 || frame.top < -1) {
      problems.push(`${label} 超出窗口（top ${frame.top}、right ${frame.right}、bottom ${frame.bottom}，窗口 ${frame.innerWidth}×${frame.innerHeight}）`);
    }
  }
  if (problems.length) return { passed: false, detail: problems.slice(0, 4).join('；'), measured, problems };
  if (measured === 0) {
    return {
      passed: true,
      detail: '本屏没有可测画面（无 <video>、无画幅标记容器）；该屏的后续票用数据钩子补出画面后自动开始量',
      measured: 0,
      problems: [],
    };
  }
  return { passed: true, detail: `${measured} 处画面的比例、尺寸与窗口内位置全部正确`, measured, problems: [] };
}

/**
 * 一次把四项测量在同一帧里取回：避免主题切换/重排让四次测量落在不同状态。
 *
 * `scope` 决定量哪些元素（跨不进 page.evaluate 的闭包，所以用字符串表达）：
 *   - 'page'（默认）：跳过共享外壳子树（`SHELL_SELECTOR`）。左侧栏这种每屏都在的外壳
 *     坏了不该让 27 屏同时红，那样就看不出「这一屏自己」的问题了；外壳由
 *     `workspace-sidebar` 屏单独量。
 *   - 'shell'：只量共享外壳子树（侧栏、顶栏、页工具条）。
 *   - 'all'：全量，含外壳。
 * 整页横向滚动始终按整页量 —— 那是页面级事实，和量哪个子树无关。
 */
export function collectAllChecks(scope = 'page') {
  const shellOf = (element) => element.closest("aside[data-testid='workspace-sidebar'], header[data-team-shell], [data-testid='page-toolbar']");
  const included = (element) => {
    const shell = shellOf(element);
    if (scope === 'shell') return Boolean(shell);
    if (scope === 'all') return true;
    return !shell;
  };
  const innerWidth = window.innerWidth;
  const bodyWidth = document.body ? document.body.scrollWidth : 0;
  const scrollWidth = Math.max(document.documentElement.scrollWidth, bodyWidth);
  const overflowPx = Math.max(0, scrollWidth - innerWidth);
  const offenders = [];
  if (overflowPx > 0) {
    for (const element of document.querySelectorAll('body *')) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (rect.right <= innerWidth + 1) continue;
      const firstClass = String(element.className ?? '').split(' ')[0];
      offenders.push({
        signature: `${element.tagName.toLowerCase()}${firstClass ? `.${firstClass}` : ''}`,
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 24),
      });
      if (offenders.length >= 8) break;
    }
  }

  const selector = 'button, input, select, textarea, label, [role="button"], [role="tab"], [role="option"], [role="switch"], [role="radio"], [role="checkbox"]';
  const clipped = [];
  const seenClip = new Set();
  for (const element of document.querySelectorAll(selector)) {
    if (!included(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (Number(style.opacity) === 0) continue;
    if (element.closest('[inert]')) continue;
    let clipper = null;
    let clipperOverflowX = '';
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (/(hidden|clip|auto|scroll)/.test(parentStyle.overflowX)) {
        clipper = parent;
        clipperOverflowX = parentStyle.overflowX;
        break;
      }
    }
    if (clipperOverflowX === 'auto' || clipperOverflowX === 'scroll') continue;
    const band = clipper ? clipper.getBoundingClientRect() : { left: 0, right: innerWidth };
    const visibleLeft = Math.max(0, band.left);
    const visibleRight = Math.min(innerWidth, band.right);
    const clippedRight = rect.right > visibleRight + 1.5 && rect.left < visibleRight - 2;
    const clippedLeft = rect.left < visibleLeft - 1.5 && rect.right > visibleLeft + 2;
    if (!clippedRight && !clippedLeft) continue;
    const text = (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().slice(0, 20);
    const role = element.getAttribute('role');
    const signature = `${element.tagName.toLowerCase()}${role ? `[${role}]` : ''}「${text}」`;
    if (seenClip.has(signature)) continue;
    seenClip.add(signature);
    clipped.push({
      signature, tag: element.tagName.toLowerCase(), text,
      left: Math.round(rect.left), right: Math.round(rect.right),
      visibleLeft: Math.round(visibleLeft), visibleRight: Math.round(visibleRight),
      clipped: clippedRight ? 'right' : 'left',
      className: String(element.className ?? '').slice(0, 80),
    });
    if (clipped.length >= 12) break;
  }

  const hidden = [];
  for (const element of document.querySelectorAll('body *')) {
    if (!included(element)) continue;
    if (element.matches('input, textarea, select')) continue;
    const style = getComputedStyle(element);
    const overflowX = style.overflowX;
    if (!/^(auto|scroll|hidden|clip)$/.test(overflowX)) continue;
    const elementOverflow = element.scrollWidth - element.clientWidth;
    if (elementOverflow <= 1) continue;
    const explicitlyScrollable = overflowX === 'auto' || overflowX === 'scroll';
    const scrollbarSuppressed = style.scrollbarWidth === 'none';
    const ellipsisTruncated = style.textOverflow === 'ellipsis';
    let reason = null;
    if (explicitlyScrollable) {
      if (scrollbarSuppressed) reason = 'overflow-x 可滚动但滚动条被显式隐藏（scrollbar-width: none）';
    } else if (!ellipsisTruncated) {
      reason = `overflow-x: ${overflowX}，内容被裁掉且滚不到，也没有省略号提示`;
    }
    if (!reason) continue;
    const text = (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const firstClass = String(element.className ?? '').split(' ')[0];
    hidden.push({
      signature: `${element.tagName.toLowerCase()}${firstClass ? `.${firstClass}` : ''}「${text}」`,
      overflowX, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      overflowPx: elementOverflow, reason,
    });
    if (hidden.length >= 12) break;
  }

  const innerHeight = window.innerHeight;
  const media = [];
  const seenMedia = new Set();
  for (const element of document.querySelectorAll('video, [data-output-preset], [data-preset], [data-media-frame]')) {
    if (!included(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const isVideo = element.tagName.toLowerCase() === 'video';
    const presetAttr = element.getAttribute('data-output-preset') || element.getAttribute('data-preset') || '';
    const declared = /^(\d+)x(\d+)$/.exec(presetAttr);
    let expected = declared ? Number(declared[1]) / Number(declared[2]) : null;
    let source = declared ? `data 标注 ${presetAttr}` : '';
    if (expected === null && isVideo) {
      const videoWidth = Number(element.videoWidth ?? 0);
      const videoHeight = Number(element.videoHeight ?? 0);
      if (videoWidth > 0 && videoHeight > 0) {
        expected = videoWidth / videoHeight;
        source = `视频固有尺寸 ${videoWidth}×${videoHeight}`;
      }
    }
    if (expected === null) source = '没有画幅标记，也没有视频固有尺寸';
    const aria = element.getAttribute('aria-label');
    const signature = `${element.tagName.toLowerCase()}${aria ? `「${aria}」` : ''}${presetAttr ? `[${presetAttr}]` : ''}`;
    if (seenMedia.has(signature)) continue;
    seenMedia.add(signature);
    media.push({
      signature, isVideo, expected, source,
      width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10,
      ratio: rect.height > 0 ? Number((rect.width / rect.height).toFixed(4)) : null,
      top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom),
      innerWidth, innerHeight,
    });
    if (media.length >= 24) break;
  }

  return {
    horizontalScroll: { innerWidth, scrollWidth, overflowPx, offenders },
    clippedControls: clipped,
    hiddenOverflowContent: hidden,
    mediaFrames: media,
  };
}
