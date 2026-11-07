'use client';

import { Segmented } from '@/components/ui/Appearance';

export type WorkbenchTabId = 'scene' | 'storyboard' | 'script' | 'video' | 'final-edit';

/**
 * 五步的唯一权威清单（07 号票）：工具栏分段按钮、URL `?tab=` 解析、各步容器都读这里。
 *
 * **标识不变**：`scene | storyboard | script | video | final-edit` 就是现有路由参数，
 * 08/09 号票改步骤内容时不要新增 tab id（要加步骤得先改父规格）。
 */
export const WORKBENCH_STEPS: ReadonlyArray<{ id: WorkbenchTabId; label: string }> = [
  { id: 'scene', label: '场景图' },
  { id: 'storyboard', label: '分镜' },
  { id: 'script', label: '脚本' },
  { id: 'video', label: '视频' },
  { id: 'final-edit', label: '混剪' },
];

const STEP_IDS = WORKBENCH_STEPS.map((step) => step.id);

export function parseWorkbenchTab(value: string | null | undefined): WorkbenchTabId {
  return STEP_IDS.includes(value as WorkbenchTabId) ? (value as WorkbenchTabId) : 'scene';
}

/** 步骤名：标签页标题与空状态文案都用它。 */
export function getWorkbenchStepLabel(id: WorkbenchTabId): string {
  return WORKBENCH_STEPS.find((step) => step.id === id)?.label ?? '';
}

/**
 * 工具栏里的五步分段按钮（02 号票的 `Segmented`，semantics="tabs"）。
 *
 * 08/09 不需要自己画切换器：页面把 `onChange` 接到 URL 即可，
 * 步骤内容组件只关心自己是不是 `active`。
 */
export function WorkbenchStepNav({
  active,
  onChange,
}: {
  active: WorkbenchTabId;
  onChange: (id: WorkbenchTabId) => void;
}) {
  return (
    <Segmented<WorkbenchTabId>
      value={active}
      onChange={onChange}
      label="项目工作台分区"
      options={WORKBENCH_STEPS.map((step) => ({ value: step.id, label: step.label }))}
    />
  );
}
