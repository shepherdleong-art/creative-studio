'use client';

import { useState } from 'react';
import TeamBgmLibrary from './TeamBgmLibrary';
import TeamResourceCandidates from './TeamResourceCandidates';
import PageToolbar from './PageToolbar';
import { GroupHeading } from '@/components/ui/Appearance';
import type { WorkspaceRole } from '@/lib/workspace-navigation';

/**
 * 公共资源发布（团队版）。14 号票只换外观：工具栏与分组标题换成 02 号票的
 * 共用部件；发布流程、分页与字段不变。
 */
export default function TeamPublicResourcesPanel({ role }: { role: WorkspaceRole }) {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="space-y-4">
      <PageToolbar
        role={role}
        subtitle="从已有设置和受管资源中选择发布；员工只会在显式发布后看到团队资源。"
      />
      <TeamResourceCandidates refreshKey={refreshKey} />
      <details className="card p-5">
        <summary className="cursor-pointer"><GroupHeading>添加 BGM 音乐</GroupHeading></summary>
        <TeamBgmLibrary onUploaded={() => setRefreshKey(value => value + 1)} />
      </details>
    </div>
  );
}
