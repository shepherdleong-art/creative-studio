'use client';

import { useState } from 'react';
import BatchPreparationPanel from '@/components/batch-production/BatchPreparationPanel';
import { Segmented } from '@/components/ui/Appearance';
import type { ProjectInfoValue } from '@/components/ProjectInfoDialog';
import MixcutPanel from './MixcutPanel';

interface MixcutWorkspaceProps {
  projectId: string;
  projectName: string;
  projectInfo: ProjectInfoValue;
  onProjectInfoChange: (project: ProjectInfoValue) => void;
}

export default function MixcutWorkspace(props: MixcutWorkspaceProps) {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  return (
    <div className="space-y-4">
      {/* 第 5 步顶部分段按钮（09 号票）：用 02 的共用件 Segmented（原型 .seg）。
          批量那边的内容由 10 号票改，这里只负责入口与外观。
          外框仍保留原来的 `card ... p-3` 块：第 3 步的外壳高度与「滚到页底时预览正文
          贴住全局顶栏」的几何依赖这层留白，去掉或改成 flex 会改变外壳落点。 */}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-3">
        {/* 共用件 Segmented 自身 32px 高；外面这层 py-1.5 把总高补回原来那组
            `py-2` 按钮的 44px，避免顶栏高度变化挪动第 3 步外壳落点（页面滚到底时
            「预览正文贴住全局顶栏」的几何断言有 1px 容差，靠这个保持等价）。 */}
        <div className="py-1.5">
          <Segmented
            value={mode}
            onChange={setMode}
            label="智能混剪模式"
            options={[
              { value: 'single', label: '单条精准混剪' },
              { value: 'batch', label: '批量生产' },
            ]}
          />
        </div>
        <p className="px-2 text-xs text-ink-tertiary">两种模式数据隔离；切换不会启动任务。</p>
      </div>

      {/* 单条面板保持挂载以保留会话状态;隐藏必须内联 display:none ——
          Tailwind 的 hidden 工具类会被未分层全局样式压过,导致批量模式下
          单条内容仍参与排版、把统一审片同屏工作台顶出视口(实测页面溢出 171px)。 */}
      <div style={{ display: mode === 'single' ? undefined : 'none' }} aria-hidden={mode !== 'single'}>
        <MixcutPanel {...props} />
      </div>
      {mode === 'batch' && <BatchPreparationPanel projectId={props.projectId} />}
    </div>
  );
}
