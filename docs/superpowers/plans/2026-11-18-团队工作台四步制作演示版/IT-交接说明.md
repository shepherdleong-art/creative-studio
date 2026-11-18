# 团队工作台四步制作演示版 · IT 交接说明

**状态：** `ready-for-human`

本文件写给接手本 Demo 的 IT：分支、提交、启动条件、演示开关与 PM 复验步骤。产品范围与验收标准见[功能方案](../../specs/2026-11-18-团队工作台四步制作演示版-功能方案.md)，实施票见 [README](README.md)。

## 分支与提交

- 分支：`codex/team-demo-four-step-20261118`（从 `origin/main` 的 `2d457ea6` 开出，仓库内独立 Demo 分支）。
- 基线提交：`2d457ea6`（PR #16 合并点）。
- 实现提交：本文件所在提交及其之前的 `feat(team-demo)` / `feat(mixcut)` 系列，用 `git log --oneline 2d457ea6..HEAD` 可复现完整清单。
- 工作树位置（实现时）：`I:\m7-studio\.worktrees\team-demo-20261118`。`node_modules` 是真实拷贝——Turbopack 不接受指向工作树外的符号链接。

## 本机启动条件

Node.js 22+。两种方式任选：

- `npm ci --include=dev` 后 `npm run dev:win`：普通开发服务器（127.0.0.1:3000）。
- `node scripts/local-preview.mjs --no-open`：演示入口（团队模式 + 演示数据根，推荐给 IT/PM）。

演示入口会：

- 以 `CREATIVE_STUDIO_DEPLOYMENT_MODE=server` 启动，监听 `127.0.0.1:3410`（回环地址）；
- 数据根固定为 `outputs/local-preview/`（与个人版 `storage/` 隔离）；
- 首次启动自动初始化管理员工号 `0001`，一次性凭据打印在启动日志里；
- 打印一行「演示开关」，见下节。

浏览器打开 `http://127.0.0.1:3410/team/login`。停止：`node scripts/local-preview.mjs stop`（或双击「停止本地预览.cmd」）。

## 演示开关

开关的唯一裁决点是 `lib/demo-runtime.ts`，启动脚本只把结果写进环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CREATIVE_STUDIO_CANVAS_ENABLE` | `0` | 强制关闭创作画布：导航、`/canvas` 页面、画布接口与执行器一起关 |
| `CREATIVE_STUDIO_MODULE_BATCH` | `1` | 批量生产保留 |
| `CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO` | `1` | 详情页脚本工作室保留 |
| `CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER` | `0` | 真实脚本调度；PM 要实际跑爆文改写时显式设 `1` |
| `CREATIVE_STUDIO_DEMO_ALLOW_CANVAS` | 未设置 | 仅排障：设为 `1` 才允许打开画布（`.env.local` 的 `CANVAS_ENABLE=1` 不生效） |
| `CREATIVE_STUDIO_SCRIPT_ALLOW_LEGACY_MODES` | 未设置 | 仅排障：设为 `1` 才恢复「多方向生成 / 痛点解决型」旧模式 |

模型凭据（脚本/图片/视频/TTS、COS）由 IT 在演示环境的 `.env.local` 与供应商配置里填写，不进仓库。

## 已实现范围

- **02** 演示启动与入口裁剪：画布强制关闭（含直接访问地址与接口）、首页移除「实拍混剪」、两种混剪都保留普通视频导入。
- **03** 只保留爆文模板改写：首次生成、换模板、结果页再生成、旧任务补跑都只接受 `template_rewrite`；卖点提取/复用、模板选择、人工编辑与保存不变。
- **04** 管理员一键查看用户视角：只切展示 Cookie（`/api/team/auth/view-as`），会话与权限不变；员工没有入口，直接请求 403。
- **05 / 06** 「我的常用」提示词：运镜、场景、分镜三类共用 `video_prompt_templates` 的私有归属；员工保存/更新/删除只影响本人条目，跨项目可取用；公共预设只读原文，员工另存为私有副本。
- **07 / 08** 两种混剪的自带输入：空项目可直接建空分镜组并导入自带视频（导入后默认参与混剪），文案可直接输入/粘贴；批量生产保留自定义导入素材与脚本、生成份数。

## PM 复验步骤

1. 管理员登录 → 确认左侧没有「创作画布」、首页没有「实拍混剪」；直接访问 `/canvas` 得到 404 页。
2. 管理员头像菜单 →「查看用户视角」：导航变为员工端并显示横幅；点「返回管理界面」恢复管理导航。全程同一账号。
3. 公共资源页发布一条公共提示词；员工账号在场景/分镜/运镜页选到它，改写后「存为我的常用」；换一个项目仍能取用，另一名员工看不到。
4. 脚本页：生产模式固定为「爆文模板改写」；提取或复用卖点 → 挑模板 → 生成 → 改一句并保存。
5. 混剪页：选「单条精准混剪」，空项目点「建空分镜组，导入自带视频」，导入自己的视频与文案；切「批量生产」导入素材与脚本、设份数建批次。
6. 正式出片与包装/贴纸效果需真实模型与 ffmpeg：按功能方案 Testing Decisions 打开导出的 MP4 核对。

## 自动检查覆盖

| 检查 | 覆盖 |
| --- | --- |
| `npm run check:main-path` | 上传 → 建项目 → 场景/分镜 → 脚本 → 视频 → 混剪 → 正式渲染 → ZIP；模拟供应商 |
| `scripts/team-demo-runtime.test.ts` | 演示开关、画布闸门、旧模式拒绝 |
| `scripts/team-view-as-user.test.ts` | 视角切换只改展示、员工越权被拒 |
| `scripts/prompt-library.test.ts` | 三类常用词的归属、跨项目取用、私有隔离、公共预设只读 |
| `scripts/workspace-navigation.test.ts` | 首页新建入口与导航（无画布/实拍混剪） |
| `scripts/team-api-auth-matrix.test.ts` | 员工/管理员/资源归属矩阵 |
| `scripts/team-demo-acceptance.playwright.test.mjs` | 真实浏览器：02/03/04 + 05/06 入口 |
| `scripts/team-demo-mixcut-entry.playwright.test.mjs` | 真实浏览器：空项目两种混剪的自带视频/文案入口 |

真实 MP4 的包装与贴纸效果仍需按验收表人工播放核对（自动检查只证明数据与媒体能衔接）。
