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
    <nav className="mb-5 rounded-xl border border-gray-200 bg-white p-2 shadow-sm" aria-label="项目工作台分区">
      <div className="grid gap-2 md:grid-cols-4">
        {TABS.map((tab, index) => {
          const active = tab.id === activeTab;
          return (
            <Link
              key={tab.id}
              href={`/projects/${projectId}?tab=${tab.id}`}
              className={`rounded-lg border px-4 py-3 transition ${
                active
                  ? 'border-blue-600 bg-blue-50 text-blue-700 shadow-sm'
                  : 'border-transparent text-gray-600 hover:border-gray-200 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}`}>
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