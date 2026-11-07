'use client';

/**
 * 五步 tab 的**旧入口**（07 号票已换成工具栏里的分段按钮）。
 *
 * 现在真正的实现与权威清单在 `components/workbench/WorkbenchStepNav.tsx`：
 * `WorkbenchStepNav`（`Segmented` 分段按钮）+ `WORKBENCH_STEPS` / `parseWorkbenchTab`。
 *
 * 本文件只为「还在 import 旧名字」的代码留兼容导出，**不要再用它渲染导航**：
 * 规格要求五步是工具栏里的一条分段按钮，不是卡片网格（V09）。
 */
export type { WorkbenchTabId } from './workbench/WorkbenchStepNav';
export { WORKBENCH_STEPS, parseWorkbenchTab, getWorkbenchStepLabel, WorkbenchStepNav } from './workbench/WorkbenchStepNav';
