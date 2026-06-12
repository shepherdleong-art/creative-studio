# 工作台 UI 改版 · Apple 风格 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把整站 UI 改成 Apple（apple.com.cn）风格的精致极简语言，纯视觉重构、不改任何功能。

**Architecture:** 杠杆点是 `app/globals.css` 的设计令牌 + 共享工具类——“类名不变、定义替换”让复用这些类的组件一键换肤；再配合外壳（`layout.tsx` 字体/白底、`Header.tsx` 磨砂导航）与新增的内联 SVG 图标组件，逐屏推进。本计划只详写 **Phase 1（设计系统 + 外壳 + 首页 + Icon）**，Phases 2–4 在 Phase 1 真机验证后各自出详细计划。

**Tech Stack:** Next.js 16 (App Router) · React 19 · Tailwind CSS v4（`@theme` 令牌）· TypeScript · 系统字体栈（离线安全，不使用 `next/font/google`）。

**Spec:** `docs/2026-06-12-workbench-ui-apple-redesign-design.md` · **可视化稿:** `.superpowers/brainstorm/118-1781252957/content/`（`apple-home.html`、`apple-workbench.html`）

---

## 验证方式（重要：本计划不使用单元 TDD）

本改版是纯视觉/样式重构，无行为变化，且仓库当前**无测试框架**（`package.json` 无 `test` 脚本、无 jest/vitest/playwright）。按 YAGNI，本次**不引入测试框架**。每个任务的“验证”= 真实可执行的检查：

- **类型 + 规则：** `npx tsc --noEmit` 与 `npm run lint` 必须通过。
- **构建：** Phase 收尾用 `npm run build` 必须通过。
- **目视：** 开发服务器 `npm run dev:win`（Windows）已开 → 打开 `http://127.0.0.1:3000`，热更新对照可视化稿走查。

> ⚠️ Phase 1 完成后，**设置页 / 新建向导 / 工作台**仍保留旧的内联 Tailwind（`bg-blue-600`、`text-gray-500` 等），它们只会继承新的共享类样式，外观呈“过渡态”（新按钮/卡片/导航 + 旧蓝灰内联）。这是预期的，Phases 2–3 收尾。

---

## 文件结构（Phase 1）

| 文件 | 动作 | 职责 |
|---|---|---|
| `app/globals.css` | 重写 | Apple 设计令牌（`@theme`）+ 重定义共享类（`.card`/`.btn-*`/`.input-field`/`.label`/`.status-*`）+ 新原语（`.pill`/`.segmented`/`.toolbar`/`.data-table`/`.tile`/`.icon-btn`/`.link-accent`） |
| `app/layout.tsx` | 修改 | 使用全局系统字体栈；白底；居中 `main` 节奏；去 emoji 标题 |
| `components/ui/Icon.tsx` | 新建 | 细线 SVG 图标集（替代 emoji），`<Icon name size />` |
| `components/Header.tsx` | 重写 | 磨砂 sticky 导航 + 蓝胶囊“新建项目” + 图标“停止服务” + Apple 弹窗 |
| `app/page.tsx` | 重写 | 首页：hero + 统计块 + 项目图卡 + 首用引导 + 空/加载态 |

---

## Task 1: 设计令牌 + 共享工具类（globals.css）

**Files:**
- Modify (整文件替换): `app/globals.css`

- [ ] **Step 1: 用以下完整内容替换 `app/globals.css`**

```css
@import "tailwindcss";

/* ===== Apple-style design tokens ===== */
@theme {
  /* surfaces */
  --color-surface: #ffffff;
  --color-surface-subtle: #f5f5f7;
  --color-surface-hover: #fafafc;
  /* ink (text) */
  --color-ink: #1d1d1f;
  --color-ink-secondary: #6e6e73;
  --color-ink-tertiary: #86868b;
  /* hairlines */
  --color-hairline: #e6e6eb;
  --color-hairline-soft: #f0f0f3;
  /* accent */
  --color-accent: #0071e3;
  --color-accent-hover: #0077ed;
  /* status: text + tint */
  --color-run: #0071e3;   --color-run-tint: #e8f1ff;
  --color-ok: #1b8e4d;    --color-ok-tint: #e7f7ee;
  --color-fail: #d7372b;  --color-fail-tint: #fdebea;
  --color-warn: #b25e00;  --color-warn-tint: #fff4e5;
  --color-idle: #6e6e73;  --color-idle-tint: #efeff2;
  --color-check: #5331d8; --color-check-tint: #ececfb;
  /* status dots */
  --color-dot-ok: #34c759;
  --color-dot-fail: #ff3b30;
  --color-dot-warn: #ff9f0a;
  /* radii */
  --radius-pill: 980px;
  --radius-card: 18px;
  --radius-tile: 16px;
  --radius-control: 10px;
  /* type */
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", "Segoe UI", "Noto Sans SC", "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
}

/* ===== Base ===== */
body {
  background: var(--color-surface);
  color: var(--color-ink);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* ===== Component utilities ===== */
@layer utilities {
  /* surfaces */
  .card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--radius-card); }
  .tile { background: var(--color-surface-subtle); border-radius: var(--radius-tile); }

  /* buttons (pill) */
  .btn-primary, .btn-secondary, .btn-danger {
    display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
    padding: .55rem 1.1rem; border-radius: var(--radius-pill);
    font-size: .9rem; font-weight: 500; line-height: 1; cursor: pointer;
    transition: background .15s ease, color .15s ease, opacity .15s ease, border-color .15s ease;
  }
  .btn-primary { background: var(--color-accent); color: #fff; }
  .btn-primary:hover { background: var(--color-accent-hover); }
  .btn-secondary { background: var(--color-surface-subtle); color: var(--color-ink); }
  .btn-secondary:hover { background: #ececf0; }
  .btn-danger { background: transparent; color: var(--color-fail); border: 1px solid var(--color-hairline); }
  .btn-danger:hover { background: var(--color-fail-tint); border-color: var(--color-fail-tint); }
  .btn-primary:disabled, .btn-secondary:disabled, .btn-danger:disabled { opacity: .45; cursor: not-allowed; }
  .btn-sm { padding: .35rem .8rem; font-size: .8rem; }

  /* inputs */
  .input-field {
    width: 100%; background: var(--color-surface);
    border: 1px solid var(--color-hairline); border-radius: var(--radius-control);
    padding: .5rem .7rem; font-size: .875rem; color: var(--color-ink);
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .input-field::placeholder { color: var(--color-ink-tertiary); }
  .input-field:focus { outline: none; border-color: var(--color-accent); box-shadow: 0 0 0 3px rgba(0,113,227,.35); }
  .label { display: block; font-size: .72rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--color-ink-tertiary); margin-bottom: .4rem; }

  /* link + icon button */
  .link-accent { color: var(--color-accent); transition: opacity .15s ease; }
  .link-accent:hover { text-decoration: underline; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border-radius: 8px; color: var(--color-ink); background: transparent; cursor: pointer; transition: background .15s ease, color .15s ease; }
  .icon-btn:hover { background: var(--color-surface-subtle); }

  /* generic pill */
  .pill { display: inline-flex; align-items: center; gap: .3rem; padding: .15rem .55rem; border-radius: var(--radius-pill); font-size: .72rem; font-weight: 500; white-space: nowrap; }

  /* status badge (legacy class names kept, restyled) */
  .status-badge { display: inline-flex; align-items: center; gap: .3rem; padding: .15rem .55rem; border-radius: var(--radius-pill); font-size: .72rem; font-weight: 500; white-space: nowrap; }
  .status-pending     { background: var(--color-idle-tint);  color: var(--color-idle); }
  .status-running     { background: var(--color-run-tint);   color: var(--color-run); }
  .status-succeeded   { background: var(--color-ok-tint);    color: var(--color-ok); }
  .status-failed      { background: var(--color-fail-tint);  color: var(--color-fail); }
  .status-retrying    { background: var(--color-warn-tint);  color: var(--color-warn); }
  .status-canceled    { background: var(--color-idle-tint);  color: var(--color-ink-tertiary); text-decoration: line-through; }
  .status-needs_check { background: var(--color-check-tint); color: var(--color-check); }

  /* segmented control */
  .segmented { display: inline-flex; gap: 2px; padding: 3px; background: var(--color-surface-subtle); border-radius: 11px; }
  .segmented > button { border: none; background: transparent; cursor: pointer; font-size: .82rem; font-weight: 500; color: var(--color-ink-secondary); padding: .35rem 1rem; border-radius: 8px; transition: background .15s ease, color .15s ease; }
  .segmented > button[aria-selected="true"] { background: var(--color-surface); color: var(--color-ink); box-shadow: 0 1px 3px rgba(0,0,0,.13); }

  /* frosted toolbar */
  .toolbar { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; background: rgba(255,255,255,.72); backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); border-bottom: 1px solid rgba(0,0,0,.08); }

  /* hairline data table */
  .data-table { width: 100%; border-collapse: collapse; }
  .data-table th { text-align: left; font-size: .68rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--color-ink-tertiary); padding: .55rem .7rem; border-bottom: 1px solid var(--color-hairline); }
  .data-table td { padding: .65rem .7rem; font-size: .82rem; color: var(--color-ink); border-bottom: 1px solid var(--color-hairline-soft); }
  .data-table tr:hover td { background: var(--color-surface-hover); }
  .data-table .num { text-align: right; font-family: var(--font-mono); font-size: .76rem; }
}
```

- [ ] **Step 2: 验证类型与规则**

Run: `npx tsc --noEmit && npm run lint`
Expected: 均无报错（CSS 改动不影响 TS；lint 通过）。

- [ ] **Step 3: 目视**

`npm run dev:win` 已运行时，打开 `http://127.0.0.1:3000`。预期：首页按钮变胶囊、卡片更大圆角、状态徽标变低饱和胶囊（此时首页其余仍旧，将在 Task 5 重写）。

- [ ] **Step 4: 提交**

```bash
git add app/globals.css
git commit -m "feat(ui): Apple-style design tokens and component utilities"
```

---

## Task 2: 系统字体与外壳（layout.tsx）

**Files:**
- Modify (整文件替换): `app/layout.tsx`

- [ ] **Step 1: 用以下完整内容替换 `app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import Header from "@/components/Header";
import "./globals.css";

export const metadata: Metadata = {
  title: "产品素材工作台",
  description: "复杂结构产品的图片生产 + 分镜管理 + 视频任务准备",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-surface text-ink">
        <Header />
        <main className="flex-1 w-full max-w-[980px] mx-auto px-6 py-10">
          {children}
        </main>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: 验证类型与规则**

Run: `npx tsc --noEmit && npm run lint`
Expected: 通过。（字体走系统栈，不访问 Google Fonts，也不依赖构建期联网。）

- [ ] **Step 3: 目视**

刷新 `http://127.0.0.1:3000`。预期：正文字体走系统 Apple/SF/苹方/微软雅黑栈，背景纯白，内容居中且留白更足。

- [ ] **Step 4: 提交**

```bash
git add app/layout.tsx
git commit -m "feat(ui): system font stack and Apple-style app shell"
```

---

## Task 3: 图标组件（Icon.tsx）

**Files:**
- Create: `components/ui/Icon.tsx`

- [ ] **Step 1: 新建 `components/ui/Icon.tsx`，完整内容如下**

```tsx
import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "chevron-left" | "chevron-right" | "download" | "play" | "pause"
  | "stop" | "retry" | "trash" | "plus" | "minus" | "check" | "alert"
  | "image" | "settings" | "key" | "logs" | "close" | "power";

const PATHS: Record<IconName, ReactNode> = {
  "chevron-left": <polyline points="15 18 9 12 15 6" />,
  "chevron-right": <polyline points="9 18 15 12 9 6" />,
  download: (<><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>),
  play: <polygon points="5 3 19 12 5 21 5 3" />,
  pause: (<><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>),
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  retry: (<><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></>),
  trash: (<><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></>),
  plus: (<><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>),
  minus: <line x1="5" y1="12" x2="19" y2="12" />,
  check: <polyline points="20 6 9 17 4 12" />,
  alert: (<><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>),
  image: (<><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></>),
  settings: (<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /></>),
  key: <path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3" />,
  logs: (<><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="15" y2="18" /></>),
  close: (<><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>),
  power: (<><path d="M18.36 6.64a9 9 0 11-12.73 0" /><line x1="12" y1="2" x2="12" y2="12" /></>),
};

export function Icon({
  name,
  size = 18,
  ...props
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {PATHS[name]}
    </svg>
  );
}
```

- [ ] **Step 2: 验证类型与规则**

Run: `npx tsc --noEmit && npm run lint`
Expected: 通过（组件暂未被引用，无 lint 错误；下个任务起使用）。

- [ ] **Step 3: 提交**

```bash
git add components/ui/Icon.tsx
git commit -m "feat(ui): add line-icon component (SF Symbols-style) to replace emoji"
```

---

## Task 4: 磨砂导航（Header.tsx）

**Files:**
- Modify (整文件替换): `components/Header.tsx`

- [ ] **Step 1: 用以下完整内容替换 `components/Header.tsx`**

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';

export default function Header() {
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);

  const handleStop = async () => {
    setStopping(true);
    try {
      await fetch('/api/shutdown', { method: 'POST' });
    } catch {
      // Server may close before responding, that's expected
    }
    setTimeout(() => {
      setStopping(false);
      setShowStopConfirm(false);
    }, 2000);
  };

  return (
    <header className="toolbar h-12 gap-5 px-6 text-sm">
      <Link href="/" className="font-semibold tracking-tight text-ink transition-colors hover:text-accent">
        产品素材工作台
      </Link>
      <nav className="ml-auto flex items-center gap-4">
        <Link href="/" className="text-ink-secondary transition-colors hover:text-ink">项目</Link>
        <Link href="/settings" className="text-ink-secondary transition-colors hover:text-ink">供应商</Link>
        <Link href="/projects/new" className="btn-primary btn-sm">
          <Icon name="plus" size={15} /> 新建项目
        </Link>
        <button
          onClick={() => setShowStopConfirm(true)}
          className="icon-btn text-ink-tertiary hover:text-fail"
          title="停止服务"
          aria-label="停止服务"
        >
          <Icon name="power" size={16} />
        </button>
      </nav>

      {showStopConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm">
          <div className="card w-full max-w-sm p-6 shadow-[0_20px_60px_rgba(0,0,0,.18)]">
            <h3 className="mb-2 text-lg font-semibold text-ink">停止服务</h3>
            <p className="mb-2 text-sm text-ink-secondary">
              确定要停止工作台服务吗？停止后需重新运行启动脚本（Windows：
              <code className="rounded bg-surface-subtle px-1 font-mono text-xs">start-windows.cmd</code>；macOS：
              <code className="rounded bg-surface-subtle px-1 font-mono text-xs">start.command</code>）才能再次使用。
            </p>
            <p className="mb-4 text-xs text-ink-tertiary">
              或直接在终端按 <kbd className="rounded bg-surface-subtle px-1 font-mono">Ctrl+C</kbd>
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowStopConfirm(false)} className="btn-secondary btn-sm" disabled={stopping}>
                取消
              </button>
              <button onClick={handleStop} disabled={stopping} className="btn-danger btn-sm">
                {stopping ? '关闭中…' : '确定关闭'}
              </button>
            </div>
            {stopping && <p className="mt-3 text-center text-xs text-ok">服务已关闭，可关闭此窗口</p>}
          </div>
        </div>
      )}
    </header>
  );
}
```

- [ ] **Step 2: 验证类型与规则**

Run: `npx tsc --noEmit && npm run lint`
Expected: 通过。

- [ ] **Step 3: 目视**

刷新任意页面。预期：顶栏变磨砂半透明（滚动时背后内容透出模糊）、去 emoji、右侧蓝胶囊“＋ 新建项目”、电源图标“停止服务”；点击弹窗为 Apple 卡片样式，停止服务功能照常。

- [ ] **Step 4: 提交**

```bash
git add components/Header.tsx
git commit -m "feat(ui): frosted Apple-style header with icon actions"
```

---

## Task 5: 首页（page.tsx）

**Files:**
- Modify (整文件替换): `app/page.tsx`

- [ ] **Step 1: 用以下完整内容替换 `app/page.tsx`**（保留全部数据逻辑，仅重做视觉）

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';

interface Project {
  id: string;
  name: string;
  createdAt: string;
  providerId: string;
  model: string;
  status: string;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  totalCost: number;
  workflowType?: string;
}

interface ProviderStatus {
  total: number;
  configured: number;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  running: '运行中',
  completed: '已完成',
  partial_failed: '部分失败',
  canceled: '已取消',
  needs_check: '待补抓',
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'status-pending',
  running: 'status-running',
  completed: 'status-succeeded',
  partial_failed: 'status-failed',
  canceled: 'status-canceled',
  needs_check: 'status-needs_check',
};

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({ total: 0, configured: 0 });
  const [loading, setLoading] = useState(true);

  const loadProjects = () => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadProjects();
    fetch('/api/providers')
      .then((r) => r.json())
      .then((data: Array<{ hasApiKey: boolean; enabled: number }>) => {
        const enabled = data.filter((p) => p.enabled);
        setProviderStatus({
          total: enabled.length,
          configured: enabled.filter((p) => p.hasApiKey).length,
        });
      })
      .catch(() => {});
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此项目？所有关联的图片和任务将被清除。')) return;
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    loadProjects();
  };

  const hasProjects = projects.length > 0;
  const isFirstUse = !loading && !hasProjects && providerStatus.configured === 0;

  const steps = [
    { n: 1, title: '配置供应商', body: (<>在「<Link href="/settings" className="link-accent">供应商配置</Link>」填入中转站 Base URL 和 API Key</>) },
    { n: 2, title: '上传图片', body: '上传参考图和待编辑图，写一条统一的提示词' },
    { n: 3, title: '开始编辑', body: '点击运行，系统自动并发处理、保存结果、导出报告' },
  ];

  return (
    <div className="space-y-12">
      {/* Hero */}
      <section className="pt-4 text-center">
        <h1 className="text-[2.6rem] font-semibold leading-[1.08] tracking-[-0.022em] text-ink">
          把复杂产品<br />做成一整套素材
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[1.15rem] leading-relaxed text-ink-secondary">
          场景图生产 · 分镜管理 · 视频任务准备。从一张场景图出发，自动并发、保存、导出。
        </p>
        <div className="mt-7 flex items-center justify-center gap-5">
          <Link href="/projects/new" className="btn-primary px-6 py-3 text-base">新建项目</Link>
          {!isFirstUse && <Link href="/settings" className="link-accent text-base">供应商配置 ›</Link>}
        </div>
      </section>

      {/* First-use guide */}
      {isFirstUse && (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {steps.map((s) => (
            <div key={s.n} className="tile p-5">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white">{s.n}</div>
              <div className="mt-3 text-sm font-semibold text-ink">{s.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-ink-secondary">{s.body}</div>
            </div>
          ))}
        </section>
      )}

      {/* Stats */}
      {!isFirstUse && (
        <section className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
          <div className="tile p-5 text-center">
            <div className="text-[2rem] font-semibold tracking-tight text-ink">{projects.length}</div>
            <div className="mt-1 text-[0.8rem] text-ink-secondary">项目总数</div>
          </div>
          <div className="tile p-5 text-center">
            <div className="text-[2rem] font-semibold tracking-tight text-ink">{projects.reduce((s, p) => s + p.completedJobs, 0)}</div>
            <div className="mt-1 text-[0.8rem] text-ink-secondary">已完成任务</div>
          </div>
          <div className="tile p-5 text-center">
            <div className="text-[2rem] font-semibold tracking-tight text-accent">{projects.filter((p) => p.status === 'running').length}</div>
            <div className="mt-1 text-[0.8rem] text-ink-secondary">运行中</div>
          </div>
          <div className="tile p-5 text-center">
            <div className={`text-[2rem] font-semibold tracking-tight ${providerStatus.configured > 0 ? 'text-ink' : 'text-fail'}`}>
              {providerStatus.configured}/{providerStatus.total}
            </div>
            <div className="mt-1 text-[0.8rem] text-ink-secondary">
              <Link href="/settings" className="hover:underline">供应商已配置</Link>
            </div>
          </div>
        </section>
      )}

      {/* Project list */}
      <section>
        {hasProjects && <h2 className="mb-4 text-[1.3rem] font-semibold tracking-tight text-ink">项目</h2>}

        {loading ? (
          <div className="py-10 text-center text-ink-tertiary">
            <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            加载中…
          </div>
        ) : !hasProjects && !isFirstUse ? (
          <div className="py-14 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-subtle text-ink-tertiary">
              <Icon name="image" size={26} />
            </div>
            <h3 className="mb-2 text-lg font-medium text-ink">暂无项目</h3>
            <p className="mb-5 text-sm text-ink-tertiary">创建第一个批量图片编辑项目</p>
            <Link href="/projects/new" className="btn-primary">新建项目</Link>
          </div>
        ) : hasProjects ? (
          <div className="space-y-3">
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="card flex items-center gap-4 p-4 transition-shadow hover:shadow-[0_8px_28px_rgba(0,0,0,.08)]"
              >
                <div className="grid h-[60px] w-[60px] shrink-0 place-items-center rounded-[14px] bg-surface-subtle text-ink-tertiary">
                  <Icon name="image" size={22} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <h3 className="truncate font-semibold text-ink">{p.name}</h3>
                    {p.workflowType === 'complex_product' && <span className="pill bg-check-tint text-check">复杂产品</span>}
                    <span className={`status-badge ${STATUS_CLASS[p.status] ?? 'status-pending'}`}>{STATUS_LABELS[p.status] ?? p.status}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-3.5 text-xs text-ink-secondary">
                    <span>模型 {p.model}</span>
                    <span>{new Date(p.createdAt).toLocaleString('zh-CN')}</span>
                    <span>总任务 {p.totalJobs}</span>
                    <span className="text-ok">成功 {p.completedJobs}</span>
                    {p.failedJobs > 0 && <span className="text-fail">失败 {p.failedJobs}</span>}
                    {p.totalCost > 0 && <span>¥{p.totalCost.toFixed(4)}</span>}
                  </div>
                  {p.totalJobs > 0 && (
                    <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-hairline">
                      <div
                        className={`h-full rounded-full ${
                          p.status === 'completed' ? 'bg-dot-ok' : p.status === 'failed' || p.status === 'partial_failed' ? 'bg-fail' : 'bg-accent'
                        }`}
                        style={{ width: `${Math.round(((p.completedJobs + p.failedJobs) / p.totalJobs) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDelete(p.id); }}
                  className="icon-btn shrink-0 text-ink-tertiary hover:text-fail"
                  title="删除"
                  aria-label="删除"
                >
                  <Icon name="trash" size={17} />
                </button>
                <Icon name="chevron-right" size={20} className="shrink-0 text-ink-tertiary" />
              </Link>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: 验证类型与规则**

Run: `npx tsc --noEmit && npm run lint`
Expected: 通过。

- [ ] **Step 3: 目视对照可视化稿**

刷新 `http://127.0.0.1:3000`，对照 `.superpowers/brainstorm/118-1781252957/content/apple-home.html`。预期：大标题 hero + 蓝胶囊；4 个浅灰统计块；项目为大圆角图卡（占位图标缩略图 + 状态胶囊 + 元信息 + 细进度条 + 删除图标 + `›`）。逐一确认：新建/删除/跳转、首用引导、空态、加载态、复杂产品徽标、各状态颜色均正确。

> 备注：项目卡缩略图用占位图标（数据无代表图字段）；待 API 暴露代表图后可替换为真实缩略图。

- [ ] **Step 4: 提交**

```bash
git add app/page.tsx
git commit -m "feat(ui): rebuild home page in Apple style"
```

---

## Task 6: Phase 1 收尾验证

**Files:** 无（仅验证）

- [ ] **Step 1: 全量构建**

Run: `npm run build`
Expected: 构建成功，无类型/编译错误。

- [ ] **Step 2: 走查全站导航与回归**

`npm run dev:win`，逐页打开：首页、`/settings`、`/projects/new`、任一 `/projects/[id]`。确认：
- 磨砂导航在每页正常、链接可用、停止服务弹窗正常。
- 首页完全 Apple 化、功能无回归。
- 其余页面为预期“过渡态”（继承新共享类、保留旧内联蓝灰）——记录任何明显错位，留待 Phase 2/3。

- [ ] **Step 3: 标记 Phase 1 完成**

```bash
git commit --allow-empty -m "chore(ui): Phase 1 (design system + shell + home) complete"
```

---

## Phases 2–4 路线图（待 Phase 1 真机验证后各自展开为详细计划）

> 共享原语已就绪，后续主要是逐文件把内联 `bg-blue-600 / text-gray-* / rounded-xl / emoji` 替换为令牌工具类（`bg-accent / text-ink-secondary / rounded-card / <Icon>`）+ 套用新原语（`.segmented / .data-table / .tile / .toolbar`）。

### Phase 2 — 设置页 + 新建向导（低风险表单）
- `app/settings/page.tsx` + `components/ProviderSettings.tsx`：供应商卡片、表单（`.input-field`/`.label`）、状态胶囊、安全提示条；编辑态高亮改用浅蓝/发丝线；emoji（🔑⚠️⚙️🔒）→ `<Icon>`。
- `app/projects/new/page.tsx`：工作流切换 → `.segmented`；分区为 `.card`；供应商选择器为可选图块；成本预览为 `.tile`。

### Phase 3 — 工作台核心（`app/projects/[id]/page.tsx` + 约 14 组件）
- 3a 工具栏/标签/队列：页面头改 `.toolbar`；`ProjectWorkbenchTabs.tsx` → `.segmented`；`JobQueueTable.tsx` → `.data-table`（等宽右对齐数字、蓝色文字操作）。
- 3b 工作区：`AssetUploadGrid.tsx`/`ImageUploader.tsx`/`PromptEditor.tsx`/`SceneReferencePanel.tsx`/`ShotSetPanel.tsx`/`ScriptPanel.tsx`/`VideoGenerationPanel.tsx` 套用新卡片/输入/按钮。
- 3c 结果网格：`ImagePickerGrid.tsx`/`ResultGallery.tsx`/`HoverZoomImage.tsx` → Apple Photos 观感（蓝色描边选中 + ✓、状态圆点、失败格特样）。
- 模态 → Apple sheet；`LogDrawer.tsx`/`LogViewer.tsx` 容器 Apple 化、日志正文保留深色终端。

### Phase 4 — 结果浏览/图库深色
- 为 `ResultGallery` 全屏查看器与图片网格引入作用域深色令牌（`.theme-dark`），其余维持浅色。

---

## Self-Review（对照 spec）

- **覆盖：** spec §3 令牌→Task 1；§4 原语→Task 1；§5 外壳→Task 2/4；§3.7 图标→Task 3；§6.1 首页→Task 5；§6.2–6.5→Phases 2–4 路线图。无遗漏。
- **占位符：** 无 TBD/TODO；每个改码步骤含完整代码。
- **类型一致：** 全程统一 `Icon`/`IconName`、系统字体栈、令牌 `--color-*`/`--radius-*`、状态类名 `status-pending|running|succeeded|failed|retrying|canceled|needs_check`（与 `globals.css` 一致）。
- **离线约束：** 字体不经 `next/font/google`，不访问运行时 CDN，也不依赖构建期联网。
```
