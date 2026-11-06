'use client';

import TeamBgmLibrary from './TeamBgmLibrary';
import TeamResourceCandidates from './TeamResourceCandidates';

export default function TeamPublicResourcesPanel() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">公共资源发布</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          从已有设置和受管资源中选择发布；员工只会在显式发布后看到团队资源。
        </p>
      </div>
      <TeamResourceCandidates />
      <TeamBgmLibrary />
    </div>
  );
}
