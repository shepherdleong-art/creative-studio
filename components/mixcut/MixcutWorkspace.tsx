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
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${mode === 'single' ? 'bg-white text-accent shadow-sm' : 'text-ink-secondary'}`}
            onClick={() => setMode('single')}
          >单条精准混剪</button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'batch'}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${mode === 'batch' ? 'bg-white text-accent shadow-sm' : 'text-ink-secondary'}`}
            onClick={() => setMode('batch')}
          >批量生产</button>
        </div>
        <p className="px-2 text-xs text-ink-tertiary">两种模式数据隔离；切换不会启动任务。</p>
      </div>

      <div className={mode === 'single' ? '' : 'hidden'} aria-hidden={mode !== 'single'}>
        <MixcutPanel {...props} />
      </div>
      {mode === 'batch' && <BatchPreparationPanel projectId={props.projectId} />}
    </div>
  );
}
