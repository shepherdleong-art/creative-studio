'use client';

import { useCallback, useEffect, useState } from 'react';
import { teamError, teamWrite } from './client';
import PageToolbar from './PageToolbar';
import { EmptyState, StatusDot, Tag, ToolbarButton } from '@/components/ui/Appearance';
import type { WorkspaceRole } from '@/lib/workspace-navigation';

type RecycleItem = {
  resourceType: string;
  resourceId: string;
  ownerUserId: string;
  deletedAt: string;
  deletedBy: string | null;
};

type CleanupJob = {
  id: string;
  status: string;
  phase: string;
  blockers: Array<{ kind: string; detail: string }>;
  error: string | null;
};

const RESOURCE_LABELS: Record<string, string> = {
  project: '项目', canvas: '画布', image: '图片', batch: '批量批次', batch_script: '批量脚本',
  project_script: '项目脚本', scene_reference: '场景参考图', shot_set: '分镜组',
  video_reference_asset: '视频参考素材', final_external_asset: '成片外部素材',
  final_variant: '成片草稿', title_preset: '标题预设', video_prompt_template: '视频提示词模板',
};

/**
 * 回收站（团队版）。14 号票只换外观：工具栏、标签、状态点、空状态与表格换成
 * 02 号票的共用部件，接口、列与信息结构与改版前一致。
 */
export default function TeamRecycleBinPanel({ role }: { role: WorkspaceRole }) {
  const [items, setItems] = useState<RecycleItem[]>([]);
  const [jobs, setJobs] = useState<Record<string, CleanupJob>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    const response = await fetch('/api/team/recycle-bin', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, '无法读取回收站'));
    const body = await response.json() as { items: RecycleItem[] };
    setItems(body.items);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh).catch((cause) => setError(cause instanceof Error ? cause.message : '无法读取回收站'));
  }, [refresh]);

  async function run(action: () => Promise<Response>, success: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await action();
      if (!response.ok) throw new Error(await teamError(response, '回收站操作失败'));
      setNotice(success);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回收站操作失败');
    } finally {
      setBusy(false);
    }
  }

  function restore(item: RecycleItem) {
    void run(() => teamWrite('/api/team/recycle-bin/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType: item.resourceType, resourceId: item.resourceId }),
    }), '资源已恢复。');
  }

  function cleanup(item: RecycleItem) {
    if (!window.confirm(`永久清理 ${RESOURCE_LABELS[item.resourceType] ?? item.resourceType} ${item.resourceId}？被任务、历史版本或备份 pin 引用时会拒绝。`)) return;
    const key = `${item.resourceType}:${item.resourceId}`;
    void run(async () => {
      const response = await teamWrite('/api/team/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceType: item.resourceType, resourceId: item.resourceId }),
      });
      if (response.ok) {
        const body = await response.json() as { job: CleanupJob };
        setJobs((current) => ({ ...current, [key]: body.job }));
      }
      return response;
    }, '清理请求已执行；如被引用会显示阻止原因。');
  }

  return (
    <div className="space-y-4">
      <PageToolbar
        role={role}
        subtitle="删除的持久资源会先进入回收站并可恢复；正常列表和新任务不会引用已删除资源。已受理任务仍可读取它冻结的依赖并收取结果。"
        actions={<ToolbarButton icon="retry" onClick={() => void refresh()} disabled={busy}>刷新</ToolbarButton>}
      />

      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
      {notice && (
        <p role="status" className="flex items-center gap-2 text-[13px] text-ok">
          <StatusDot tone="ok" />{notice}
        </p>
      )}

      <section className="card overflow-hidden">
        {items.length === 0 ? (
          <EmptyState icon="trash" title="回收站为空" description="删除的持久资源会出现在这里，可以恢复或由管理员永久清理。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[820px]">
              <thead>
                <tr>
                  <th>资源</th>
                  <th>删除时间</th>
                  <th>阻止原因</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const key = `${item.resourceType}:${item.resourceId}`;
                  const job = jobs[key];
                  return <tr key={key} className="align-top">
                    <td>
                      <div className="font-medium text-ink">{RESOURCE_LABELS[item.resourceType] ?? item.resourceType}</div>
                      <div className="font-mono text-[12px] text-ink-tertiary">{item.resourceId}</div>
                    </td>
                    <td className="tnum text-ink-secondary">{new Date(item.deletedAt).toLocaleString('zh-CN')}</td>
                    <td className="text-[12px] text-ink-secondary">
                      {job?.status === 'deferred' && job.blockers.length > 0
                        ? <ul className="space-y-1">{job.blockers.map((blocker, index) => <li key={index}>· {blocker.detail}</li>)}</ul>
                        : job?.error ? <span className="text-fail">{job.error}</span> : '—'}
                    </td>
                    <td>
                      <div className="flex justify-end gap-2">
                        <ToolbarButton icon="retry" disabled={busy} onClick={() => restore(item)}>恢复</ToolbarButton>
                        {role === 'admin' && <ToolbarButton icon="trash" disabled={busy} onClick={() => cleanup(item)}>永久清理</ToolbarButton>}
                      </div>
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2 text-[12px] leading-5 text-ink-tertiary">
        <Tag tone="idle">管理员专属</Tag>
        <span>
          永久清理只能由管理员执行；清理前会检查跨模块历史版本、共享文件、在途任务和备份 pin。
          未完成上传、取消任务和撤销会话不是回收站资源，按各自入口处理。
        </span>
      </div>
    </div>
  );
}
