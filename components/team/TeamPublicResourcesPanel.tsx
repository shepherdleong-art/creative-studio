'use client';

import { useState } from 'react';
import TeamBgmLibrary from './TeamBgmLibrary';
import TeamResourceCandidates from './TeamResourceCandidates';

export default function TeamPublicResourcesPanel() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">公共资源发布</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          从已有设置和受管资源中选择发布；员工只会在显式发布后看到团队资源。
        </p>
      </div>
      <TeamResourceCandidates refreshKey={refreshKey} />
      <details className="card p-6">
        <summary className="cursor-pointer text-lg font-semibold text-ink">添加 BGM 音乐</summary>
        <TeamBgmLibrary onUploaded={() => setRefreshKey(value => value + 1)} />
      </details>
    </div>
  );
}
