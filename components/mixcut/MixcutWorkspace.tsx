'use client';

import { useState } from 'react';
import BatchPreparationPanel from '@/components/batch-production/BatchPreparationPanel';
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
      <div className="card flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex rounded-xl bg-surface-subtle p-1" role="tablist" aria-label="智能混剪模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'single'}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${mode === 'single' ? 'bg-surface text-accent shadow-sm' : 'text-ink-secondary'}`}
            onClick={() => setMode('single')}
          >单条精准混剪</button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'batch'}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${mode === 'batch' ? 'bg-surface text-accent shadow-sm' : 'text-ink-secondary'}`}
            onClick={() => setMode('batch')}
          >批量生产</button>
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
