/**
 * 检查器的自测（第 04 号票）——「证明检查真的有效」。
 *
 * 光靠现有页面通过并不能证明检查有效：一个永远返回 passed 的检查器也会通过。
 * 这里用 `page.setContent` 造一小张已知好/已知坏的 HTML，逐条确认：
 *   - 干净的页面：三项尺寸检查都通过；
 *   - 横向溢出的页面：检查一必须报错；
 *   - 按钮被切掉一截：检查二必须报错；
 *   - 能横向滚但滚动条被隐藏：检查三必须报错；
 *   - 画面比例错 / 画面太小 / 越出窗口：检查四必须逐条报错。
 *
 * 这段不碰产品界面，也不碰真实数据，纯几何。两个内核各跑一次。
 */

import {
  evaluateClippedControls,
  evaluateHiddenOverflowContent,
  evaluateHorizontalOverflow,
  evaluateMediaFrames,
} from './ui-acceptance-checks.mjs';

const STYLE = `
  <style>
    html, body { margin: 0; padding: 0; }
    body { width: 100%; }
    .clip-outer { width: 200px; height: 60px; overflow: hidden; }
    .clip-inner { width: 260px; height: 40px; background: #ddd; }
    .hidden-scroll { width: 200px; height: 40px; overflow-x: auto; overflow-y: hidden; }
    .hidden-scroll::-webkit-scrollbar { display: none; }
    .hidden-scroll { scrollbar-width: none; }
    .hidden-scroll > div { width: 320px; height: 40px; background: #ccc; }
    .frame { display: inline-block; background: #bbb; vertical-align: top; }
  </style>
`;

/**
 * 每个用例都是相对视口构造的（视口最小 1024×720）：
 *   - 横向溢出用 2400px，任何一档窗口都撑得开；
 *   - 干净用例里的画面都放进 200px 高、视口左上方，既不横向也不纵向越界。
 */
const CASES = [
  {
    id: 'clean',
    expectation: 'all-pass',
    html: `<div style="width: 300px; height: 40px">干净页面</div>
      <button style="width: 120px; height: 32px">按钮</button>
      <div class="frame" data-output-preset="3x4" style="width: 150px; height: 200px"></div>
      <div class="frame" data-output-preset="9x16" style="width: 112.5px; height: 200px"></div>`,
  },
  {
    id: 'horizontal-overflow',
    expectation: 'horizontalScroll-fails',
    html: `<div style="width: 2400px; height: 40px; background: #eee">这一块比任何一档窗口都宽</div>`,
  },
  {
    id: 'clipped-button',
    expectation: 'clippedControls-fails',
    // 按钮左边越出视口（负 left 不会撑大 scrollWidth）：
    // 只触发「控件被视口切掉」，不触发横向滚动，也不触发容器藏内容。
    html: `<button style="position: absolute; left: -30px; top: 20px; width: 120px; height: 32px">被左边切掉的按钮</button>`,
  },
  {
    id: 'hidden-overflow',
    expectation: 'hiddenOverflowContent-fails',
    html: `<div class="hidden-scroll"><div>被藏起来的工具栏内容</div></div>`,
  },
  {
    id: 'clipped-overflow',
    expectation: 'hiddenOverflowContent-fails',
    html: `<div class="clip-outer"><div style="width: 320px; height: 40px; background: #ccc">被裁掉且滚不到的工具栏</div></div>`,
  },
  {
    id: 'ellipsis-ok',
    expectation: 'all-pass',
    // 单行截断带省略号是设计上有意的，不算藏内容。
    html: `<div class="clip-outer" style="white-space: nowrap; text-overflow: ellipsis"><span>这是一段很长很长、被省略号截断的说明文字</span></div>`,
  },
  {
    id: 'plain-scroll-ok',
    expectation: 'all-pass',
    html: `<div style="width: 200px; height: 40px; overflow-x: auto"><div style="width: 320px; height: 20px; background: #ccc"></div></div>`,
  },
  {
    id: 'media-wrong-ratio',
    expectation: 'mediaFrames-fails',
    html: `<div class="frame" data-output-preset="9x16" style="width: 300px; height: 400px"></div>`,
  },
  {
    id: 'media-too-small',
    expectation: 'mediaFrames-fails',
    html: `<div class="frame" data-output-preset="3x4" style="width: 60px; height: 80px"></div>`,
  },
  {
    id: 'media-offscreen',
    expectation: 'mediaFrames-fails',
    html: `<div class="frame" data-output-preset="3x4" style="position: absolute; top: 2400px; left: 300px; width: 150px; height: 200px"></div>`,
  },
];

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ collectAllChecks: Function, engine: string }} options
 * @returns 自测记录
 */
export async function runCheckSelfTest(page, { collectAllChecks, engine, viewport }) {
  const rows = [];
  for (const testCase of CASES) {
    await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${STYLE}</head><body>${testCase.html}</body></html>`, { waitUntil: 'load' });
    await page.waitForTimeout(60);
    const measurement = await page.evaluate(collectAllChecks);
    const outcomes = {
      horizontalScroll: evaluateHorizontalOverflow(measurement.horizontalScroll),
      clippedControls: evaluateClippedControls(measurement.clippedControls),
      hiddenOverflowContent: evaluateHiddenOverflowContent(measurement.hiddenOverflowContent),
      mediaFrames: evaluateMediaFrames(measurement.mediaFrames),
    };
    const expectedChecker = testCase.expectation.replace(/-fails$/, '');
    let passed;
    if (testCase.expectation === 'all-pass') {
      passed = Object.values(outcomes).every((outcome) => outcome.passed);
    } else {
      passed = outcomes[expectedChecker]?.passed === false
        && Object.entries(outcomes).every(([key, outcome]) => key === expectedChecker || outcome.passed);
    }
    rows.push({
      case: testCase.id,
      expectation: testCase.expectation,
      passed,
      details: Object.fromEntries(Object.entries(outcomes).map(([key, outcome]) => [key, { passed: outcome.passed, detail: outcome.detail }])),
    });
  }
  return {
    screen: 'selftest',
    screenTitle: '检查器自测（已知好/已知坏页面）',
    owner: 'ui-04',
    audience: 'n/a',
    engine,
    viewport: viewport.label,
    theme: 'n/a',
    outcomes: { selftest: { passed: rows.every((row) => row.passed), detail: `${rows.filter((row) => row.passed).length}/${rows.length} 个自测用例判定正确` } },
    selftest: rows,
    evidence: [],
    result: rows.every((row) => row.passed) ? 'passed' : 'failed',
    ...(rows.every((row) => row.passed) ? {} : { error: `检查器自测失败：${rows.filter((row) => !row.passed).map((row) => row.case).join('、')}` }),
  };
}
