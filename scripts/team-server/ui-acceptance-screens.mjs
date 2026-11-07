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
  base('project-scene', '项目工作台 · 第 1 步 新场景图', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=scene`,
    ready: async (page) => { await page.getByRole('heading', { name: '新场景图生成', exact: true }).waitFor({ timeout: 60_000 }); },
  }),
  base('project-scene-project-info-dialog', '项目工作台 · 项目信息弹窗', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=scene`,
    ready: async (page) => { await page.getByRole('heading', { name: '新场景图生成', exact: true }).waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('button', { name: '项目信息', exact: true }).first().click();
      await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
    }],
  }),
  base('project-scene-log-drawer', '项目工作台 · 运行日志抽屉', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=scene`,
    ready: async (page) => { await page.getByRole('heading', { name: '新场景图生成', exact: true }).waitFor({ timeout: 60_000 }); },
    actions: [async (page) => {
      await page.getByRole('button', { name: '运行日志', exact: true }).first().click();
      await page.getByRole('dialog').first().waitFor({ timeout: 30_000 });
    }],
  }),
  base('project-storyboard', '项目工作台 · 第 2 步 分镜生成', 'ui-07', {
    href: ({ project }) => `/projects/${project.id}?tab=storyboard`,
    // 「新分镜图」在这一屏出现两次（区块标题 + 上传区标题），按标题取会撞 strict mode；
    // 用「上传原始分镜图」这个这一屏独有的落点。
    ready: async (page) => { await page.getByText('上传原始分镜图', { exact: true }).first().waitFor({ timeout: 60_000 }); },
  }),
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
