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

const heading = (page, name) => page.getByRole('heading', { name, exact: true }).first().waitFor({ timeout: 60_000 });
const text = (page, value, exact = true) => page.getByText(value, { exact }).first().waitFor({ timeout: 60_000 });

/** 新项目每一步的空状态落点：工具栏 + 五步切换 + data-testid="step-empty"。
 * 第 1/2 步的空状态在中间栏，第 3/4/5 步是内容组件上面的提示条，两者同一个 testid。 */
const emptyStepReady = async (page) => {
  await page.getByTestId('page-toolbar').first().waitFor({ timeout: 60_000 });
  await page.getByRole('tab', { name: '场景图', exact: true }).waitFor({ timeout: 60_000 });
  await page.getByTestId('step-empty').first().waitFor({ timeout: 60_000 });
};

const base = (id, title, owner, extra) => ({
  id,
  title,
  owner,
  audience: 'employee',
  checks: ALL_CHECKS,
  // 量哪一块：'page'（默认，跳过共享外壳）/ 'shell'（只量外壳）/ 'all'（全量）。
  // 外壳单独成屏，所以普通屏默认跳过外壳 —— 否则侧栏一坏，27 屏同时红，
  // 就看不出「这一屏自己」的问题了。
  scope: 'page',
  ...extra,
});

// 09 号票：混剪页宽度已改成「团队版占满侧栏右侧内容区」，横向溢出与顶栏按钮被切
// 两项都真修好了 —— knownFailure 标记已删除，现在必须硬通过（再挂标记会触发
// known-failure-not-reproduced 让整轮失败）。

/**
 * 一屏一个对象。改这一屏的选择器/等待点 = 改这一屏的「怎么算画出来了」，
 * 不是放宽断言；尺寸判定本身在 ui-acceptance-checks.mjs，不要在这里写阈值。
 */
export const SCREENS = [
  // ---------- 员工侧 ----------
  // 06 号票：员工首页改版后标题是「问候语」，不再有「让今天的灵感，成为作品。」。
  // ready 等的是这一屏特有的落点：工具栏标题条 + 「接着做」里的项目卡片/空状态。
  base('home', '首页 · 工作台（员工）', 'ui-06', {
    href: () => '/',
    ready: async (page) => {
      await page.locator('[data-testid="page-toolbar"]').first().waitFor({ timeout: 60_000 });
      await page.getByTestId('workbench-production-line').first().waitFor({ timeout: 60_000 });
      // 「接着做」区块必须先画出来：有项目就是卡片，没项目就是空状态。
      await page.getByRole('link', { name: '新建项目', exact: true }).first().waitFor({ timeout: 60_000 });
      await page.getByText('接着做', { exact: true }).first().waitFor({ timeout: 60_000 });
    },
  }),
  base('projects', '项目空间', 'ui-06', {
    href: () => '/projects',
    ready: async (page) => { await page.getByRole('heading', { name: '项目空间', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  // 06 号票：新建项目页改版后不再有 h1（标题交给工具栏），ready 等生产身份表单的
  // 首个字段 + 项目名预览 + 创建按钮，三者都是这一屏特有的。
  base('projects-new', '新建项目', 'ui-06', {
    href: () => '/projects/new',
    ready: async (page) => {
      await page.getByLabel('店铺', { exact: true }).waitFor({ timeout: 60_000 });
      await page.getByTestId('project-name-preview').waitFor({ timeout: 60_000 });
      await page.getByTestId('new-project-submit').waitFor({ timeout: 60_000 });
    },
  }),
  base('canvas', '创作画布列表', 'ui-14', {
    href: () => '/canvas',
    // 14 号票起标题由每页工具栏渲染（= 导航名「创作画布」），不再是页内 h1。
    ready: async (page) => { await page.getByTestId('page-toolbar-title').first().waitFor({ timeout: 60_000 }); },
  }),
  base('tasks-employee', '我的任务', 'ui-12', {
    href: () => '/team/tasks',
    // 12 号票改版：员工页标题改由外壳工具栏按路径解析成「我的任务」，页面里不再有自己的 <h1>。
    ready: async (page) => {
      await page.getByTestId('page-toolbar-title').first().waitFor({ timeout: 60_000 });
      await page.getByRole('region', { name: '筛选' }).waitFor({ timeout: 60_000 });
      await page.getByLabel('查找任务', { exact: true }).waitFor({ timeout: 60_000 });
      await page.getByText('读取团队任务…', { exact: true }).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);
    },
  }),
  base('downloads', '下载与交付', 'ui-14', {
    href: () => '/team/downloads',
    ready: async (page) => { await page.getByTestId('page-toolbar-title').first().waitFor({ timeout: 60_000 }); },
  }),
  base('errors', '出错的任务', 'ui-14', {
    href: () => '/team/errors',
    ready: async (page) => { await page.getByRole('heading', { name: '出错的任务', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('usage-employee', '我的用量', 'ui-14', {
    href: () => '/usage',
    ready: async (page) => { await page.getByRole('heading', { name: '我的用量', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('recycle-bin', '回收站', 'ui-14', {
    href: () => '/team/recycle-bin',
    ready: async (page) => { await page.getByRole('heading', { name: '回收站', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('account', '修改密码', 'ui-14', {
    href: () => '/team/account',
    ready: async (page) => { await page.getByRole('heading', { name: /设置新密码|修改密码/ }).first().waitFor({ timeout: 60_000 }); },
  }),

base('workspace-sidebar', '左侧分组侧栏 + 头像菜单', 'ui-05', {
    href: () => '/',
    ready: async (page) => { await page.getByTestId('workspace-sidebar').waitFor({ timeout: 60_000 }); },
    // 这一屏就是外壳本身：只量外壳子树。
    scope: 'shell',
    actions: [async (page) => {
      // 头像菜单是这一屏的第二个状态：展开后同样要量。
      await page.locator("[class*='wsUser']").first().click();
      await page.locator("[class*='wsMenu']").first().waitFor({ timeout: 30_000 });
    }],
  }),

  // 15 号票：窄窗口（<1280）收法。用户在三种候选里选了「图标窄条 + 悬停浮出名称」
  // （= 规格原文写法），另外两套与 `?narrow=` 试用开关已删除，所以这里只剩一屏。
  // 宽窗口下侧栏不收起，ready 只断言「这一屏真的画出来了」，收法是否生效按窗口宽度分别验证。
  base('narrow-icon-rail', '窄窗口收法 · 图标窄条 + 悬停浮出名称', 'ui-15', {
    href: () => '/',
    ready: async (page) => {
      await page.getByTestId('workspace-sidebar').waitFor({ timeout: 60_000 });
      // Playwright 的指针默认停在 (0,0)，那正是侧栏顶部：悬停会让浮层冒出来，
      // 收起态的截图就拍花了。量之前先把指针挪到内容区中间。
      const size = page.viewportSize();
      if (size) await page.mouse.move(Math.round(size.width * 0.7), Math.round(size.height * 0.6));
      // 收法必须真的落到 DOM 上（窄窗口下才有这个属性）。
      const applied = await page.getByTestId('workspace-sidebar').getAttribute('data-narrow');
      const narrow = await page.evaluate(() => window.matchMedia('(max-width: 1279px)').matches);
      if (narrow && applied !== 'rail') throw new Error(`窄窗口下侧栏应收成图标条，实际 ${applied ?? '（未设置）'}`);
      if (!narrow && applied !== null) throw new Error(`宽窗口下侧栏不该收起，实际 ${applied}`);
    },
    actions: [async (page) => {
      const narrow = await page.evaluate(() => window.matchMedia('(max-width: 1279px)').matches);
      if (!narrow) return;
      // 收起态截图在上一步拍过；这里拍「悬停某行 → 浮出名称」的那一面
      // （验收硬要求：窄条下悬停显示名称）。
      await page.getByTestId('workspace-nav-item').first().hover();
      await page.getByTestId('workspace-nav-flyout').first().waitFor({ timeout: 15_000 });
    }],
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
  }),
  base('project-scene-project-info-dialog', '项目工作台 · 项目信息弹窗', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=scene`,
    skipUnless: 'workbenchAssets',
    ready: async (page) => { await page.getByTestId('workbench-scene').waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('button', { name: '项目信息', exact: true }).first().click();
      await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
    }],
  }),
  base('project-scene-log-drawer', '项目工作台 · 运行日志抽屉', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=scene`,
    skipUnless: 'workbenchAssets',
    ready: async (page) => { await page.getByTestId('workbench-scene').waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('button', { name: '运行日志', exact: true }).first().click();
      await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
    }],
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
  }),
  // 新项目每一步都有空状态（07 号票）：用空项目夹具，断言空状态真的画出来。
  // Lead 合并 04 与 07 时的裁定：07 原本给第 4/5 步写 `checks: []`（理由是不重复量
  // project-video / mixcut 已经在量的同一页）。但「一屏零检查」等于没量，且 04 的
  // 清单自检要求每屏默认跑满四项。改为：这两屏照常量四项，但 **owner 指向该步的归属票**
  // （第 4 步 ui-08、第 5 步 ui-09）——溢出归谁负责由 owner 表达，而不是靠不量来回避。
  ...['scene', 'storyboard', 'script'].map((step) => base(
    `project-empty-${step}`,
    `项目工作台 · 新项目空状态（${step}）`,
    'ui-07',
    {
      href: ({ emptyProject }) => `/projects/${emptyProject.id}?tab=${step}`,
      skipUnless: 'emptyProject',
      ready: emptyStepReady,
    },
  )),
  ...['video', 'final-edit'].map((step) => base(
    `project-empty-${step}`,
    `项目工作台 · 新项目空状态（${step}）`,
    step === 'video' ? 'ui-08' : 'ui-09',
    {
      href: ({ emptyProject }) => `/projects/${emptyProject.id}?tab=${step}`,
      skipUnless: 'emptyProject',
      ready: emptyStepReady,
    },
  )),

  // 第 3 步（08 号票）：三页表单 + 卖点库 + 爆文模板。空项目夹具下也有这一屏，
  // 所以 ready 只等「这一屏真的画出来」的落点：标题、三步切换、提供素材的重心上传区。
  base('project-script', '项目工作台 · 第 3 步 脚本生成', 'ui-08', {
    href: ({ project }) => `/projects/${project.id}?tab=script`,
    ready: async (page) => {
      await page.getByRole('heading', { name: '详情页智能脚本生成', exact: true }).waitFor({ timeout: 60_000 });
      // 第 1 页的素材投放区（data-testid 由面板自己给，是这一屏独有的落点）。
      await page.getByTestId('script-studio-upload-dropzone').waitFor({ timeout: 30_000 });
      // 生产模式与目标时长：字数/时长提示就挂在这套参数旁边。
      await page.getByLabel('生产模式', { exact: true }).waitFor({ timeout: 30_000 });
    },
  }),
  // 第 4 步（08 号票）：点选分镜组之后才是三栏工作台（左编辑 / 中预览 / 右「这条视频用的设置」+ 结果卡）。
  // 只等标题会漏掉整页溢出——那一屏真正的排版在选中分镜组之后才出现，所以 ready 先选组。
  base('project-video', '项目工作台 · 第 4 步 视频生成', 'ui-08', {
    href: ({ project }) => `/projects/${project.id}?tab=video`,
    skipUnless: 'workbenchAssets',
    ready: async (page) => {
      await page.getByRole('heading', { name: '视频生成', exact: true }).waitFor({ timeout: 60_000 });
      const setSelect = page.getByLabel('选择分镜组', { exact: true });
      await setSelect.waitFor({ timeout: 60_000 });
      // 选验收夹具建的那个分镜组（它的名字是「验收分镜组」，选项文案带张数）。
      const options = await setSelect.locator('option').allTextContents();
      const target = options.find((label) => label.includes('验收分镜组'));
      if (!target) throw new Error(`分镜组下拉里没有验收夹具的分镜组，实际选项：${options.join(' | ')}`);
      await setSelect.selectOption({ label: target });
      // 三栏工作台的落点：批量检查按钮（左栏）与结果栏（右栏）。
      await page.getByRole('button', { name: /^批量检查 \d+ 个分镜$/ }).waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: /^分镜 1$/ }).waitFor({ timeout: 30_000 });
    },
    actions: [
      // 批量检查窗口：统一供应商 / 统一秒数在顶部，且秒数只列交集。
      async (page) => {
        await page.getByRole('button', { name: /^批量检查 \d+ 个分镜$/ }).click();
        const dialog = page.getByRole('dialog', { name: '批量检查分镜' });
        await dialog.waitFor({ timeout: 30_000 });
        await dialog.getByTestId('bulk-provider').waitFor({ timeout: 30_000 });
        await dialog.getByTestId('bulk-duration').waitFor({ timeout: 30_000 });
        await dialog.getByTestId('bulk-duration-hint').waitFor({ timeout: 30_000 });
      },
    ],
  }),
  base('mixcut-single', '项目工作台 · 第 5 步 智能混剪（单条精准混剪）', 'ui-09', {
    href: ({ project }) => `/projects/${project.id}?tab=final-edit`,
    ready: async (page) => {
      await page.getByText('当前素材组').first().waitFor({ timeout: 60_000 });
      // 09 号票：混剪页必须占满侧栏右侧的内容区，不被侧栏盖住、不横向滚动。
      // 这是「团队版宽度」的硬事实，只量几何不放宽尺寸阈值（阈值仍在 checks 里）。
      await page.getByTestId('mixcut-shell').first().waitFor({ timeout: 60_000 });
      const shell = await page.evaluate(() => {
        const box = document.querySelector('[data-testid="mixcut-shell"]')?.getBoundingClientRect();
        const sidebar = document.querySelector("aside[data-testid='workspace-sidebar']")?.getBoundingClientRect();
        const frame = document.querySelector('[data-testid="mixcut-shell"]')?.parentElement?.parentElement?.getBoundingClientRect();
        return box ? {
          left: box.left,
          right: box.right,
          width: box.width,
          sidebarRight: sidebar ? sidebar.right : null,
          contentLeft: frame ? frame.left : null,
          contentWidth: frame ? frame.width : null,
        } : null;
      });
      if (!shell) throw new Error('混剪外壳没有画出来');
      if (!(shell.sidebarRight !== null && shell.left >= shell.sidebarRight - 1)) {
        throw new Error(`混剪外壳被侧栏盖住：外壳 left ${Math.round(shell.left)}px，侧栏 right ${Math.round(shell.sidebarRight ?? -1)}px`);
      }
      if (!(shell.contentLeft !== null && Math.abs(shell.left - shell.contentLeft) <= 1.5)) {
        throw new Error(`混剪外壳必须从内容区左边界开始：外壳 left ${Math.round(shell.left)}px，内容区 left ${Math.round(shell.contentLeft ?? -1)}px`);
      }
      if (!(shell.contentWidth !== null && Math.abs(shell.width - shell.contentWidth) <= 1.5)) {
        throw new Error(`混剪外壳必须占满内容区：外壳宽 ${Math.round(shell.width)}px，内容区宽 ${Math.round(shell.contentWidth ?? -1)}px`);
      }
    },
  }),
  base('mixcut-batch', '项目工作台 · 第 5 步 批量生产', 'ui-10', {
    href: ({ project }) => `/projects/${project.id}?tab=final-edit`,
    ready: async (page) => { await page.getByText('当前素材组').first().waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('tab', { name: '批量生产', exact: true }).click();
      await page.getByRole('tab', { name: '批量生产', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(1500);
    }],
  }),
  // 11 号票：批量导出的第 4 步（封面卡 + 大预览 + 一键下载全部）。
  // 夹具保证那四条成片覆盖「已导出 / 修改未导出 / 从没导出 / 渲染失败」。
  base('batch-export', '项目工作台 · 第 5 步 批量导出成片', 'ui-11', {
    href: ({ project }) => `/projects/${project.id}?tab=final-edit`,
    skipUnless: 'batchExportStates',
    ready: async (page) => {
      await page.getByText('当前素材组').first().waitFor({ timeout: 60_000 });
      await page.getByRole('tab', { name: '批量生产', exact: true }).click();
      // 第 4 步「导出成片」：等卡片与封面真的画出来（不是 sleep）。
      await page.getByRole('button', { name: /导出成片/ }).click();
      await page.getByTestId('batch-export-card').first().waitFor({ timeout: 60_000 });
      await page.getByTestId('batch-download-all').waitFor({ timeout: 30_000 });
    },
  }),
  // 11 号票：导出页的大预览（3:4 画面 + 信息栏）。弹窗单独量一次。
  base('batch-export-preview', '项目工作台 · 批量成片大预览', 'ui-11', {
    href: ({ project }) => `/projects/${project.id}?tab=final-edit`,
    skipUnless: 'batchExportStates',
    ready: async (page) => {
      await page.getByText('当前素材组').first().waitFor({ timeout: 60_000 });
      await page.getByRole('tab', { name: '批量生产', exact: true }).click();
      await page.getByRole('button', { name: /导出成片/ }).click();
      await page.getByTestId('batch-export-card').first().waitFor({ timeout: 60_000 });
    },
    actions: [async (page) => {
      await page.locator('[data-testid^="batch-export-card-open-"]').first().click();
      await page.getByTestId('film-preview-dialog').waitFor({ timeout: 30_000 });
    }],
  }),

  // ---------- 管理员侧 ----------
  // 12 号票：运行总览 + 全员任务。ready 等的是「这一屏真的画出来」的落点：
  // 数量卡的固定标题 + 最近任务表/空状态；全员任务等筛选栏与结果说明。
  base('admin-overview', '运行总览（管理员）', 'ui-12', {
    audience: 'admin',
    href: () => '/',
    ready: async (page) => {
      await page.getByRole('region', { name: '任务数量' }).waitFor({ timeout: 60_000 });
      await page.getByTestId('count-running').waitFor({ timeout: 60_000 });
      await page.getByRole('region', { name: '最近任务' }).waitFor({ timeout: 60_000 });
      await page.getByRole('region', { name: '开工前还差几件事' }).waitFor({ timeout: 60_000 });
      // 等「读取运行总览…」消失，否则数量卡还是占位符。
      await page.getByText('读取运行总览…', { exact: true }).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);
    },
  }),
  base('admin-overview-pause-dialog', '运行总览 · 暂停生产确认', 'ui-12', {
    audience: 'admin',
    href: () => '/',
    ready: async (page) => {
      await page.getByRole('region', { name: '任务数量' }).waitFor({ timeout: 60_000 });
      await page.getByText('读取运行总览…', { exact: true }).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);
    },
    actions: [async (page) => {
      const pause = page.getByRole('button', { name: '暂停运行', exact: true });
      // 维护中时按钮禁用、没有确认框可量；这种情况下不硬点，交给下面这条断言说明。
      if (!(await pause.isEnabled().catch(() => false))) return;
      await pause.click();
      await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('dialog').first().waitFor({ state: 'detached', timeout: 30_000 });
    }],
  }),
  base('admin-tasks', '全员任务', 'ui-12', {
    audience: 'admin',
    href: () => '/team/tasks',
    ready: async (page) => {
      await page.getByRole('region', { name: '筛选' }).waitFor({ timeout: 60_000 });
      await page.getByLabel('查找任务', { exact: true }).waitFor({ timeout: 60_000 });
      await page.getByRole('region', { name: '任务列表' }).waitFor({ timeout: 60_000 });
      await page.getByText('读取团队任务…', { exact: true }).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);
    },
  }),
  base('admin-tasks-detail', '全员任务 · 任务详情', 'ui-12', {
    audience: 'admin',
    href: () => '/team/tasks',
    // 详情需要一条真实任务；验收夹具只造了项目和供应商，所以这一屏只在有行时量。
    ready: async (page) => {
      await page.getByRole('region', { name: '筛选' }).waitFor({ timeout: 60_000 });
      await page.getByText('读取团队任务…', { exact: true }).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);
    },
    actions: [async (page) => {
      const row = page.getByTestId('task-row').first();
      if (await row.count() === 0) return;
      await row.click();
      await page.getByTestId('task-detail').waitFor({ timeout: 30_000 });
    }],
  }),
  base('admin-pools', '模型与名额（一个名额池一行）', 'ui-13', {
    audience: 'admin',
    href: () => '/team/admin/pools',
    ready: async (page) => {
      // 这一屏特有的落点：至少一个账号行（「一个名额池一行」），标题取第一条工具栏
      // （外壳那条在页面登记占用后就撤下，过渡瞬间可能并存）。
      await page.getByTestId('pool-row').first().waitFor({ timeout: 60_000 });
      await page.getByTestId('page-toolbar-title').first().getByText('模型与名额', { exact: true }).waitFor({ timeout: 60_000 });
    },
    actions: [async (page) => {
      // 展开一行：模型列表 + 正在使用的成员 + 默认收起的内部编号。
      await page.getByRole('button', { name: /^展开 / }).first().click();
      await page.getByText('包含的模型', { exact: true }).first().waitFor({ timeout: 30_000 });
      const internal = page.getByText('排查用的内部编号', { exact: true }).first();
      await internal.waitFor({ timeout: 30_000 });
      await internal.click();
      await page.getByText(/映射协议：|版本：/).first().waitFor({ timeout: 30_000 });
    }],
  }),
  base('admin-users', '成员与账号', 'ui-14', {
    audience: 'admin',
    href: () => '/team/admin/users',
    // 交接期间页面工具栏与外壳那条都会带 <h1>，且外壳的容器也带 data-testid="page-toolbar"，
    // 所以落到「标题 span」这个唯一节点上，而不是按 heading 角色取。
    ready: async (page) => {
      await page.getByTestId('page-toolbar-title').filter({ hasText: '成员与账号' }).first()
        .waitFor({ timeout: 60_000 });
    },
    // 成员策略对话框（共用 Dialog 外壳）：打开后每档窗口都要量，确认弹窗不会被切掉。
    actions: [async (page) => {
      await page.getByRole('button', { name: '模型与额度', exact: true }).first().click();
      await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
    }],
  }),
  base('admin-resources', '公共资源发布', 'ui-14', {
    audience: 'admin',
    href: () => '/team/admin/resources',
    ready: async (page) => { await page.getByRole('heading', { name: '公共资源', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('admin-operations', '版本与备份', 'ui-14', {
    audience: 'admin',
    href: () => '/team/admin/operations',
    ready: async (page) => { await page.getByRole('heading', { name: '版本与备份', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  // 集成分支曾整体删掉这一屏（隔离数据根扫不到可清理项，弹窗打不开）。
  // 04 号票保留它并把「打不开」降级为 gaps：基础态照样量四项，
  // 弹窗这一档如实记「本次量不到」，既不冒充通过，也不让整轮结果作废。
  base('admin-operations-cleanup-dialog', '版本与备份 · 清理确认弹窗', 'ui-14', {
    audience: 'admin',
    href: () => '/team/admin/operations',
    ready: async (page) => { await page.getByRole('heading', { name: '版本与备份', exact: true }).waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('button', { name: '扫描无用文件', exact: true }).click();
      const confirm = page.getByRole('button', { name: '确认清理预览中的项目', exact: true });
      try {
        await confirm.waitFor({ timeout: 30_000 });
      } catch {
        throw new Error('隔离数据根里没有可清理项，清理确认弹窗不会出现（前置条件不满足，不算尺寸不合格）');
      }
      if (await confirm.isEnabled()) {
        await confirm.click();
        await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
      }
    }],
  }),
  base('admin-settings', '供应商配置', 'ui-14', {
    audience: 'admin',
    href: () => '/settings',
    // 供应商配置页有筛选/图表要点，等「添加供应商」这条本页操作出现再量。
    ready: async (page) => {
      await page.getByRole('heading', { name: '供应商配置', exact: true }).waitFor({ timeout: 60_000 });
      await page.getByRole('button', { name: '添加供应商', exact: true }).first().waitFor({ timeout: 60_000 });
    },
  }),
  base('admin-usage', '团队用量', 'ui-14', {
    audience: 'admin',
    href: () => '/usage',
    ready: async (page) => { await page.getByRole('heading', { name: '团队用量', exact: true }).waitFor({ timeout: 60_000 }); },
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
    if (screen.scope === undefined) screen.scope = 'page';
    if (!['page', 'shell', 'all'].includes(screen.scope)) throw new Error(`屏幕 ${screen.id} 的 scope 只能是 page/shell/all`);
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
