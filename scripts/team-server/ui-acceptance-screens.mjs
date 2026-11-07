/**
 * 按屏组织的界面尺寸验收清单（第 04 号票）。
 *
 * ===========================================================================
 * 后续 UI 票怎么往里加自己那一屏的检查（05–14 都看这里）
 * ===========================================================================
 *
 * 一条命令：
 *   node scripts/team-server/acceptance.mjs --level ui
 *   （等价的直接跑法：node scripts/ui-acceptance.playwright.test.mjs）
 *
 * 这是「一屏 = 一个对象」的清单。加一屏只需要两步，都在本文件里：
 *
 * 1) 在 `SCREENS` 里加/改一条记录：
 *
 *    {
 *      id: 'project-video',                       // 唯一、稳定；出现在报告与证据文件名里
 *      title: '项目工作台 · 第 4 步 视频生成',      // 报告里给人看的名字
 *      owner: 'ui-08',                            // 哪张票负责这一屏（改坏了找谁）
 *      audience: 'employee',                      // 'employee' | 'admin'，决定用哪个账号登录
 *      href: ({ project }) => `/projects/${project.id}?tab=video`,
 *      ready: async (page) => {                   // 必须等到「这一屏真的画出来了」再量
 *        await page.getByRole('heading', { name: '视频生成', exact: true }).waitFor({ timeout: 60_000 });
 *      },
 *      actions: [                                 // 可选：每弹窗都量，就把「怎么打开它」写在这里
 *        async (page) => {
 *          await page.getByRole('button', { name: '项目信息', exact: true }).first().click();
 *          await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
 *        },
 *      ],
 *      checks: ALL_CHECKS,                        // 想只量某项就写 ['horizontalScroll']
 *      // 当前已知问题（例如 ui-09 修好前混剪页横向溢出）：
 *      // knownFailure: 'ui-09',
 *      // knownFailureChecks: ['horizontalScroll'],
 *      // knownFailureReason: '混剪工作台宽 min(1440px, 100vw-48px) 无视口居中，1536 宽多出 61px',
 *    }
 *
 * 2) 这一屏需要的数据如果基础夹具没有（分镜组、视频、混剪批次……），
 *    在 `FIXTURE_HOOKS` 里加一个钩子（见下方说明），并在屏幕上写 `skipUnless: '你的钩子 id'`。
 *
 * 判定规则（改成 Playwright 断言的是原型三个脚本的意图，阈值不放宽）：
 *   - horizontalScroll      整页 scrollWidth > 视口宽 + 1px 即失败；
 *   - clippedControls       按钮/标签/输入框被祖先或视口横向切掉一截即失败
 *                           （被 auto/scroll 祖先包住的、用户能滚到的，不算切掉）；
 *   - hiddenOverflowContent 能横向滚动但滚动条不可见、内容比可视区宽 = 内容被藏起来，失败；
 *   - mediaFrames           `<video>` / 带 data-output-preset、data-preset、data-media-frame 的画面
 *                           必须比例对（±2%）、宽 ≥ 100px、不越出窗口。
 *
 * 加屏守则（别学坏）：
 *   - `ready` 里必须有一个「这一屏特有」的可断言落点（标题/行/按钮），不要用 sleep 顶替。
 *   - 不要为了让检查通过去改界面 —— 界面归对应 UI 票，本清单只负责量出来。
 *   - 已知问题只能用 `knownFailure: '<票号>'` 标记；对应票修好后必须删掉标记让它变回硬失败。
 */

import { CHECK_KEYS } from './ui-acceptance-checks.mjs';

export const ALL_CHECKS = [...CHECK_KEYS];

const base = (id, title, owner, extra) => ({
  id,
  title,
  owner,
  audience: 'employee',
  checks: ALL_CHECKS,
  ...extra,
});

// 已知问题：混剪工作台横向溢出（09 号票修）。修好后删掉这两条 knownFailure。
const MIXCUT_KNOWN_FAILURE = 'ui-09';
const MIXCUT_KNOWN_REASON = '混剪工作台固定为 min(1440px, 100vw-48px) 并按视口居中，凌驾于全局 980px 主栏之上，'
  + '窗口越靠近 1440 越溢出：1536 宽多出 61px、1440/1280/1024 宽多出 85px（批量模式再宽 8px，1536 宽时宽 32px）。'
  + '连带后果同属这个根因：顶栏「画幅 3:4 / 9:16」按钮被推到视口右边界外，被切掉一截。'
  + '09 号票把工作台改成占满内容区后，横向滚动与按钮被切两项必须一起改回硬失败。';
const MIXCUT_KNOWN_CHECKS = ['horizontalScroll', 'clippedControls'];

/**
 * 团队版外壳（05 号票）在两处固定被判失败，**每一屏都中**（07 号票实测：
 * 连 ui-06 的 `projects` 屏也一样，数值逐字相同），所以不是 07 页面的问题：
 *
 * 1. `clippedControls`：侧栏底部头像按钮 247px 塞进 224px 宽的侧栏，右边被切 23px；
 * 2. `hiddenOverflowContent`：① 同一个侧栏 `overflow-x: hidden`、内容 247px 可见 223px；
 *    ② `components/team/PageToolbar.tsx` 为「返回」渲染的 `a.sr-only`（1px 可见区装 27px 文本）。
 *
 * 07 的两屏 42 次测量里 `horizontalScroll` 与 `mediaFrames` 全过，唯二失败就是这两条。
 * 05 修好后本标记会自动触发 `known-failure-not-reproduced`，逼着删掉它。
 */
const SHELL_KNOWN_FAILURE = 'ui-05';
const SHELL_KNOWN_CHECKS = ['clippedControls', 'hiddenOverflowContent'];

/** 新项目每一步的空状态落点：工具栏 + 五步切换 + data-testid="step-empty"。
 * 第 1/2 步的空状态在中间栏，第 3/4/5 步是内容组件上面的提示条，两者同一个 testid。 */
const emptyStepReady = async (page) => {
  await page.getByTestId('page-toolbar').first().waitFor({ timeout: 60_000 });
  await page.getByRole('tab', { name: '场景图', exact: true }).waitFor({ timeout: 60_000 });
  await page.getByTestId('step-empty').first().waitFor({ timeout: 60_000 });
};
const SHELL_KNOWN_REASON = '团队版外壳（05 号票）：侧栏底部头像按钮 247px 超出 224px 侧栏被切；'
  + '侧栏 overflow-x:hidden 藏住 24px 内容；PageToolbar 的 a.sr-only 把 27px 文本压进 1px。'
  + '07 号票已实测同一失败在 ui-06 的 projects 屏上逐字复现，与本票页面无关。';

/**
 * 一屏一个对象。改这一屏的选择器/等待点 = 改这一屏的「怎么算画出来了」，
 * 不是放宽断言；尺寸判定本身在 ui-acceptance-checks.mjs，不要在这里写阈值。
 */
export const SCREENS = [
  // ---------- 员工侧 ----------
  base('home', '首页 · 运行总览（员工）', 'ui-06', {
    href: () => '/',
    ready: async (page) => { await page.getByRole('heading', { name: '让今天的灵感，成为作品。' }).waitFor({ timeout: 60_000 }); },
  }),
  base('projects', '项目空间', 'ui-06', {
    href: () => '/projects',
    ready: async (page) => { await page.getByRole('heading', { name: '项目空间', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('projects-new', '新建项目', 'ui-06', {
    href: () => '/projects/new',
    ready: async (page) => { await page.getByRole('heading', { name: '新建项目', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('canvas', '创作画布列表', 'ui-14', {
    href: () => '/canvas',
    ready: async (page) => { await page.getByRole('heading', { name: '创作画布', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('tasks-employee', '我的任务', 'ui-12', {
    href: () => '/team/tasks',
    ready: async (page) => { await page.getByRole('heading', { name: '团队任务', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('downloads', '下载与交付', 'ui-14', {
    href: () => '/team/downloads',
    ready: async (page) => { await page.getByRole('heading', { name: '下载与交付', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('errors', '错误中心', 'ui-14', {
    href: () => '/team/errors',
    ready: async (page) => { await page.getByRole('heading', { name: '错误中心', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('usage-employee', '我的用量', 'ui-14', {
    href: () => '/usage',
    ready: async (page) => { await page.getByRole('heading', { name: '费用与用量', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('recycle-bin', '回收站', 'ui-14', {
    href: () => '/team/recycle-bin',
    ready: async (page) => { await page.getByRole('heading', { name: '回收站', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('account', '修改密码', 'ui-14', {
    href: () => '/team/account',
    ready: async (page) => { await page.getByRole('heading', { name: /设置新密码|修改密码/ }).first().waitFor({ timeout: 60_000 }); },
  }),

  // ---------- 项目工作台五步 ----------
  // 第 1/2 步（07 号票）：对照视图要求原图与结果**真的并排**，所以既量尺寸，
  // 也断言「这一屏的关键控件画出来了」。控件断言放在 ready / actions 里，
  // 尺寸判定仍旧只用 ui-acceptance-checks.mjs 的阈值。
  base('project-scene', '项目工作台 · 第 1 步 新场景图', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=scene`,
    skipUnless: 'workbenchAssets',
    ready: async (page) => {
      await page.getByTestId('workbench-scene').waitFor({ timeout: 60_000 });
      // 工具栏：返回 + 项目名 + 五步分段按钮 + 项目信息 + 导出项目包
      await page.getByTestId('page-toolbar').first().waitFor({ timeout: 60_000 });
      await page.getByRole('tab', { name: '场景图', exact: true }).waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: '项目信息', exact: true }).first().waitFor({ timeout: 30_000 });
      await page.getByRole('link', { name: /导出项目包/ }).first().waitFor({ timeout: 30_000 });
      // 默认就是对照视图：原图与结果并排两张
      await page.getByAltText('原始场景图', { exact: true }).first().waitFor({ timeout: 30_000 });
      // 右栏必须有「生成 N 张」按钮，且不能出现并发设置
      await page.getByRole('button', { name: /^生成 \d+ 张$/ }).first().waitFor({ timeout: 30_000 });
      if (await page.getByText('并发', { exact: false }).count() > 0) {
        throw new Error('第 1 步右栏不该再有并发设置');
      }
    },
    knownFailure: SHELL_KNOWN_FAILURE,
    knownFailureChecks: SHELL_KNOWN_CHECKS,
    knownFailureReason: SHELL_KNOWN_REASON,
  }),
  // 第 1 步的网格视图单独量一屏：网格是另一种排版，同样不能溢出/切控件。
  base('project-scene-grid', '项目工作台 · 第 1 步 网格视图', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=scene`,
    skipUnless: 'workbenchAssets',
    ready: async (page) => {
      await page.getByTestId('workbench-scene').waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: '网格', exact: true }).click();
      await page.locator('[data-testid="workbench-scene"][data-view="grid"]').waitFor({ timeout: 30_000 });
    },
    knownFailure: SHELL_KNOWN_FAILURE,
    knownFailureChecks: SHELL_KNOWN_CHECKS,
    knownFailureReason: SHELL_KNOWN_REASON,
  }),
  base('project-scene-project-info-dialog', '项目工作台 · 项目信息弹窗', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=scene`,
    skipUnless: 'workbenchAssets',
    ready: async (page) => { await page.getByTestId('workbench-scene').waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('button', { name: '项目信息', exact: true }).first().click();
      await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
    }],
    knownFailure: SHELL_KNOWN_FAILURE,
    knownFailureChecks: SHELL_KNOWN_CHECKS,
    knownFailureReason: SHELL_KNOWN_REASON,
  }),
  base('project-scene-log-drawer', '项目工作台 · 运行日志抽屉', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=scene`,
    skipUnless: 'workbenchAssets',
    ready: async (page) => { await page.getByTestId('workbench-scene').waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('button', { name: '运行日志', exact: true }).first().click();
      await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
    }],
    knownFailure: SHELL_KNOWN_FAILURE,
    knownFailureChecks: SHELL_KNOWN_CHECKS,
    knownFailureReason: SHELL_KNOWN_REASON,
  }),
  base('project-storyboard', '项目工作台 · 第 2 步 分镜生成', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=storyboard`,
    skipUnless: 'workbenchAssets',
    ready: async (page) => {
      await page.getByTestId('workbench-storyboard').waitFor({ timeout: 60_000 });
      // 「上传原始分镜图」是这一屏左栏独有的落点（同时用于拖入与多选）。
      await page.getByRole('button', { name: /上传原始分镜图/ }).first().waitFor({ timeout: 60_000 });
      // 默认对照：原图与结果并排（结果可能还没生成，但两个 figcaption 必须在）
      await page.getByAltText('原图', { exact: true }).first().waitFor({ timeout: 30_000 });
      await page.getByText('结果', { exact: true }).first().waitFor({ timeout: 30_000 });
      // 删除分镜组必须走确认：按钮在，点开后要有 dialog（由 actions 量）
      await page.getByRole('button', { name: '删除', exact: true }).first().waitFor({ timeout: 30_000 });
    },
    knownFailure: SHELL_KNOWN_FAILURE,
    knownFailureChecks: SHELL_KNOWN_CHECKS,
    knownFailureReason: SHELL_KNOWN_REASON,
  }),
  base('project-storyboard-new-set', '项目工作台 · 第 2 步 新建分镜组窗口', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=storyboard`,
    skipUnless: 'workbenchAssets',
    ready: async (page) => { await page.getByTestId('workbench-storyboard').waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('button', { name: /^新建分镜组$/ }).first().click();
      const dialog = page.getByRole('dialog').first();
      await dialog.waitFor({ timeout: 30_000 });
      // 全选 → 再点一次取消全选（这一屏的核心交互，窗口里必须真的能点）
      const selectAll = dialog.getByRole('button', { name: /^(全选|取消全选)$/ }).first();
      await selectAll.waitFor({ timeout: 30_000 });
      if (!/取消全选/.test(await selectAll.innerText())) {
        await selectAll.click();
        await dialog.getByRole('button', { name: '取消全选' }).waitFor({ timeout: 10_000 });
      }
      // 悬停出现「设为开场」，点一下把第二张移到第一位
      const picks = dialog.locator('[data-testid="shot-pick"][data-picked="true"]');
      if (await picks.count() > 1) {
        await dialog.locator('[data-testid="set-opening"]').first().click({ force: true });
      }
    }],
    knownFailure: SHELL_KNOWN_FAILURE,
    knownFailureChecks: SHELL_KNOWN_CHECKS,
    knownFailureReason: SHELL_KNOWN_REASON,
  }),
  base('project-storyboard-delete-dialog', '项目工作台 · 第 2 步 删除分镜组确认', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=storyboard`,
    skipUnless: 'workbenchAssets',
    ready: async (page) => { await page.getByTestId('workbench-storyboard').waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('button', { name: '删除', exact: true }).first().click();
      const dialog = page.getByRole('dialog', { name: '删除这个分镜组？' });
      await dialog.waitFor({ timeout: 30_000 });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await dialog.waitFor({ state: 'detached', timeout: 10_000 });
    }],
    knownFailure: SHELL_KNOWN_FAILURE,
    knownFailureChecks: SHELL_KNOWN_CHECKS,
    knownFailureReason: SHELL_KNOWN_REASON,
  }),
  // 新项目每一步都有空状态（07 号票）：用空项目夹具，断言空状态真的画出来。
  // 注意 checks 的差别：
  //   - 第 1/2/3 步：整页尺寸照量（外壳的已知失败只豁免 clippedControls / hiddenOverflowContent）；
  //   - 第 4/5 步：**只断言空状态存在**，不再量整页尺寸 —— 这两步的尺寸归 08/09
  //     （project-video 与 mixcut-single / mixcut-batch 已经在量同一页），
  //     这里重复量只会把别人的溢出记成 07 的失败。
  ...['scene', 'storyboard', 'script'].map((step) => base(
    `project-empty-${step}`,
    `项目工作台 · 新项目空状态（${step}）`,
    'ui-07',
    {
      href: ({ emptyProject }) => `/projects/${emptyProject.id}?tab=${step}`,
      skipUnless: 'emptyProject',
      ready: emptyStepReady,
      knownFailure: SHELL_KNOWN_FAILURE,
      knownFailureChecks: SHELL_KNOWN_CHECKS,
      knownFailureReason: SHELL_KNOWN_REASON,
    },
  )),
  ...['video', 'final-edit'].map((step) => base(
    `project-empty-${step}`,
    `项目工作台 · 新项目空状态（${step}）`,
    'ui-07',
    {
      href: ({ emptyProject }) => `/projects/${emptyProject.id}?tab=${step}`,
      skipUnless: 'emptyProject',
      ready: emptyStepReady,
      checks: [],
    },
  )),

  base('project-script', '项目工作台 · 第 3 步 脚本生成', 'ui-08', {
    href: ({ project }) => `/projects/${project.id}?tab=script`,
    ready: async (page) => { await page.getByRole('heading', { name: '详情页智能脚本生成', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('project-video', '项目工作台 · 第 4 步 视频生成', 'ui-08', {
    href: ({ project }) => `/projects/${project.id}?tab=video`,
    ready: async (page) => { await page.getByRole('heading', { name: '视频生成', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('mixcut-single', '项目工作台 · 第 5 步 智能混剪（单条精准混剪）', 'ui-09', {
    href: ({ project }) => `/projects/${project.id}?tab=final-edit`,
    ready: async (page) => { await page.getByText('当前素材组').first().waitFor({ timeout: 60_000 }); },
    knownFailure: MIXCUT_KNOWN_FAILURE,
    knownFailureChecks: MIXCUT_KNOWN_CHECKS,
    knownFailureReason: MIXCUT_KNOWN_REASON,
  }),
  base('mixcut-batch', '项目工作台 · 第 5 步 批量生产', 'ui-10', {
    href: ({ project }) => `/projects/${project.id}?tab=final-edit`,
    ready: async (page) => { await page.getByText('当前素材组').first().waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('tab', { name: '批量生产', exact: true }).click();
      await page.getByRole('tab', { name: '批量生产', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(1500);
    }],
    knownFailure: MIXCUT_KNOWN_FAILURE,
    knownFailureChecks: MIXCUT_KNOWN_CHECKS,
    knownFailureReason: `${MIXCUT_KNOWN_REASON}批量面板嵌在同一个工作台外壳里，根因相同；10/11 号票改批量外壳时一并确认。`,
  }),

  // ---------- 管理员侧 ----------
  base('admin-overview', '运行总览（管理员）', 'ui-12', {
    audience: 'admin',
    href: () => '/',
    ready: async (page) => { await page.getByText('生产有序，状态清楚。', { exact: false }).first().waitFor({ timeout: 60_000 }); },
  }),
  base('admin-tasks', '全员任务', 'ui-12', {
    audience: 'admin',
    href: () => '/team/tasks',
    ready: async (page) => { await page.getByRole('heading', { name: '团队任务', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('admin-pools', '模型与名额（资源池与共享预算）', 'ui-13', {
    audience: 'admin',
    href: () => '/team/admin/pools',
    ready: async (page) => { await page.getByRole('heading', { name: '资源池与共享预算', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('admin-users', '成员与账号', 'ui-13', {
    audience: 'admin',
    href: () => '/team/admin/users',
    ready: async (page) => { await page.getByRole('heading', { name: '账号与权限', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('admin-resources', '公共资源发布', 'ui-14', {
    audience: 'admin',
    href: () => '/team/admin/resources',
    ready: async (page) => { await page.getByRole('heading', { name: '公共资源发布', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('admin-operations', '版本与备份', 'ui-14', {
    audience: 'admin',
    href: () => '/team/admin/operations',
    ready: async (page) => { await page.getByRole('heading', { name: '备份与维护', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('admin-settings', '供应商配置', 'ui-14', {
    audience: 'admin',
    href: () => '/settings',
    ready: async (page) => { await page.getByRole('heading', { name: '供应商配置', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('admin-usage', '团队用量', 'ui-14', {
    audience: 'admin',
    href: () => '/usage',
    ready: async (page) => { await page.getByRole('heading', { name: '费用与用量', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
];

/** 只跑指定的屏：TEAM_ACCEPTANCE_UI_SCREENS=project-scene,mixcut-single */
export function selectScreens(ids) {
  if (!ids?.length) return SCREENS;
  const wanted = new Set(ids);
  const unknown = [...wanted].filter((id) => !SCREENS.some((screen) => screen.id === id));
  if (unknown.length) throw new Error(`未知的屏幕 id：${unknown.join(', ')}；可选：${SCREENS.map((screen) => screen.id).join(', ')}`);
  return SCREENS.filter((screen) => wanted.has(screen.id));
}

/** 屏幕声明自检：清单写错时在启动浏览器之前就报出来，而不是跑一半。 */
export function validateScreens(screens = SCREENS) {
  const seen = new Set();
  for (const screen of screens) {
    if (!screen.id || !/^[a-z0-9-]+$/.test(screen.id)) throw new Error(`屏幕 id 必须是 kebab-case：${screen.id}`);
    if (seen.has(screen.id)) throw new Error(`屏幕 id 重复：${screen.id}`);
    seen.add(screen.id);
    if (typeof screen.href !== 'function') throw new Error(`屏幕 ${screen.id} 缺少 href 函数`);
    if (typeof screen.ready !== 'function') throw new Error(`屏幕 ${screen.id} 缺少 ready 函数（必须等这一屏真的画出来）`);
    if (!['employee', 'admin'].includes(screen.audience)) throw new Error(`屏幕 ${screen.id} 的 audience 只能是 employee/admin`);
    const checks = Array.isArray(screen.checks) ? screen.checks : ALL_CHECKS;
    for (const key of checks) if (!CHECK_KEYS.includes(key)) throw new Error(`屏幕 ${screen.id} 用了未知检查：${key}`);
    for (const key of screen.knownFailureChecks ?? []) {
      if (!checks.includes(key) && checks !== ALL_CHECKS) throw new Error(`屏幕 ${screen.id} 的 knownFailureChecks 里的 ${key} 不在 checks 里`);
    }
    if (screen.knownFailure && !/^ui-\d{2}$/.test(screen.knownFailure)) {
      throw new Error(`屏幕 ${screen.id} 的 knownFailure 必须是票号（如 ui-09）：${screen.knownFailure}`);
    }
    if (screen.knownFailure && !screen.knownFailureReason) throw new Error(`屏幕 ${screen.id} 标记了已知失败但没写原因`);
    if (!screen.checks) screen.checks = ALL_CHECKS;
    if (!Array.isArray(screen.actions)) screen.actions = [];
  }
  return screens;
}
