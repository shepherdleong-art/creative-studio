'use client';

import Link from 'next/link';

export type WorkbenchTabId = 'scene' | 'storyboard' | 'script' | 'video';

const TABS: Array<{ id: WorkbenchTabId; label: string; description: string }> = [
  { id: 'scene', label: '新场景图生成', description: '上传场景图 A，生成候选场景' },
  { id: 'storyboard', label: '分镜生成', description: '整理原始分镜并批量生成' },
  { id: 'script', label: '脚本生成', description: '卖点、人群和口播脚本' },
  { id: 'video', label: '视频生成', description: '选择分镜组创建视频任务' },
];

interface Props {
  projectId: string;
  activeTab: WorkbenchTabId;
}

export default function ProjectWorkbenchTabs({ projectId, activeTab }: Props) {
  return (
    <nav className="segmented mb-5 w-full" aria-label="项目工作台分区">
      <div className="grid gap-2 md:grid-cols-4">
        {TABS.map((tab, index) => {
          const active = tab.id === activeTab;
          return (
            <Link
              key={tab.id}
              href={`/projects/${projectId}?tab=${tab.id}`}
              className={`rounded-lg border px-4 py-3 transition ${
                active
                  ? 'border-accent bg-white text-accent shadow-sm'
                  : 'border-transparent text-ink-secondary hover:border-hairline hover:bg-white/70'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${active ? 'bg-accent text-white' : 'bg-surface-subtle text-ink-tertiary'}`}>
                  {index + 1}
                </span>
                <span className="text-sm font-semibold">{tab.label}</span>
              </div>
              <div className="mt-1 truncate pl-8 text-xs opacity-75">{tab.description}</div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
