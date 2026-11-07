'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { teamError } from './client';
import PageToolbar from './PageToolbar';
import {
  EmptyState,
  GroupList,
  GroupRow,
  StatusDot,
  Tag,
  ToolbarButton,
} from '@/components/ui/Appearance';
import type { WorkspaceRole } from '@/lib/workspace-navigation';

type ErrorItem = {
  errorId: string;
  actorUserId: string;
  employeeId?: string;
  actorDisplayName?: string;
  module: string;
  taskId: string | null;
  operationId: string | null;
  attemptId: string | null;
  transferId: string | null;
  phase: string | null;
  scope: { resourceType: string; resourceId: string } | null;
  scopeName: string | null;
  stage: string;
  code: string;
  statusCode: number | null;
  safeMessage: string;
  actionHint: string;
  origin: 'server' | 'server_api' | 'worker' | 'client';
  outcome: 'final' | 'recovered';
  model: string | null;
  taskHref: string | null;
  clientVersion: string | null;
  serverReleaseId: string | null;
  configVersion: string | null;
  createdAt: string;
};

const STAGE_LABELS: Record<string, string> = {
  upload: '上传', remote_submit: '生成提交', remote_poll: '远端结果查询', download: '结果下载',
  local_media: '媒体处理', storage: '结果保存', server_api: '业务接口',
  client_update: '客户端更新', client_ui: '客户端界面', server_release: '服务端发布', server_config: '服务端配置',
};
const ORIGIN_LABELS = { server: '服务端自动捕获', server_api: '接口自动捕获', worker: '任务自动捕获', client: '客户端自动上报' };

/**
 * 出错的任务（团队版）。14 号票只换外观：工具栏、分组列表、标签、状态点、
 * 空状态全部改用 02 号票的共用部件，接口、字段和信息结构与改版前一致。
 */
export default function TeamErrorsPanel({ role }: { role: WorkspaceRole }) {
  const searchParams = useSearchParams();
  const [items, setItems] = useState<ErrorItem[]>([]);
  const [errorId, setErrorId] = useState(() => searchParams.get('errorId') ?? '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const params = errorId.trim() ? `?errorId=${encodeURIComponent(errorId.trim())}` : '';
      const response = await fetch(`/api/team/errors${params}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(await teamError(response, '错误中心读取失败'));
      const body = await response.json() as { items: ErrorItem[] };
      setItems(body.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '错误中心读取失败');
    } finally {
      setLoading(false);
    }
  }, [errorId]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  async function copyDetails(item: ErrorItem) {
    try {
      await navigator.clipboard.writeText(JSON.stringify({
        errorId: item.errorId, message: item.safeMessage, action: item.actionHint,
        actorUserId: item.actorUserId, module: item.module, taskId: item.taskId,
        operationId: item.operationId, attemptId: item.attemptId, scope: item.scope,
        transferId: item.transferId, phase: item.phase,
        stage: item.stage, code: item.code, model: item.model,
        clientVersion: item.clientVersion, serverReleaseId: item.serverReleaseId,
        configVersion: item.configVersion, createdAt: item.createdAt,
      }, null, 2));
      setCopied(item.errorId);
      setNotice('已复制脱敏排查信息。');
    } catch {
      setError('复制失败，请展开技术详情手动复制。');
    }
  }

  return (
    <div className="space-y-4">
      <PageToolbar
        role={role}
        subtitle="系统自动捕获失败并关联制作任务，无需填写技术错误码。员工只看本人，管理员可排查团队记录。"
        actions={<ToolbarButton icon="retry" onClick={() => void refresh()}>刷新</ToolbarButton>}
      />

      <GroupList>
        <GroupRow label="按错误编号查找" stacked>
          <form
            onSubmit={(event) => { event.preventDefault(); void refresh(); }}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              className="input-field min-w-0 flex-1"
              value={errorId}
              onChange={(event) => setErrorId(event.target.value)}
              placeholder="输入完整错误编号"
              aria-label="错误编号"
            />
            <ToolbarButton type="submit">查找</ToolbarButton>
            <ToolbarButton onClick={() => setErrorId('')} disabled={!errorId}>清除筛选</ToolbarButton>
          </form>
        </GroupRow>
      </GroupList>

      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
      {notice && (
        <p role="status" className="flex items-center gap-2 text-[13px] text-ok">
          <StatusDot tone="ok" />{notice}
        </p>
      )}

      <section className="space-y-3">
        {items.map((item) => (
          <article key={item.errorId} className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{STAGE_LABELS[item.stage] ?? '服务故障'}</span>
                  <Tag tone="idle">{ORIGIN_LABELS[item.origin]}</Tag>
                  <Tag tone={item.outcome === 'recovered' ? 'ok' : 'fail'}>
                    {item.outcome === 'recovered' ? '已自动恢复' : '最终失败'}
                  </Tag>
                </div>
                <p className="mt-2.5 text-[13px] text-ink">{item.safeMessage}</p>
                <p className="mt-1.5 text-[13px] leading-6 text-ink-secondary">下一步：{item.actionHint}</p>
                <p className="tnum mt-2.5 text-[12px] text-ink-tertiary">
                  {new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {item.taskHref && <Link className="cap" href={item.taskHref}>查看关联任务</Link>}
                <button className="cap" type="button" onClick={() => void copyDetails(item)}>
                  {copied === item.errorId ? '已复制排查信息' : '复制排查信息'}
                </button>
                <a className="cap" href={`/api/team/errors/${item.errorId}/diagnostics`}>下载诊断包</a>
              </div>
            </div>

            <dl className="mt-3 grid gap-x-5 gap-y-1.5 text-[12px] text-ink-secondary sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="inline text-ink-tertiary">成员：</dt><dd className="inline">{item.actorDisplayName ?? item.actorUserId}{item.employeeId ? `（${item.employeeId}）` : ''}</dd></div>
              <div><dt className="inline text-ink-tertiary">项目 / 画布：</dt><dd className="inline">{item.scopeName ?? '未关联'}</dd></div>
              <div><dt className="inline text-ink-tertiary">实际模型：</dt><dd className="inline">{item.model ?? '未记录'}</dd></div>
              <div><dt className="inline text-ink-tertiary">关联任务：</dt><dd className="inline">{item.taskId ? '已关联' : '未关联'}</dd></div>
              <div><dt className="inline text-ink-tertiary">客户端：</dt><dd className="inline">{item.clientVersion ?? '未记录'}</dd></div>
              <div><dt className="inline text-ink-tertiary">服务端：</dt><dd className="inline">{item.serverReleaseId ?? '未记录'}</dd></div>
            </dl>

            <details className="mt-3 text-[12px] text-ink-secondary">
              <summary className="cursor-pointer">技术详情与版本</summary>
              <div className="mt-2 grid gap-1.5 break-all">
                <div>错误编号：<code>{item.errorId}</code></div>
                <div>技术错误码：<code>{item.code}</code></div>
                <div>模块：{item.module} / {item.stage}</div>
                <div>任务：{item.taskId ?? '未关联'}</div>
                <div>执行记录：{item.operationId ?? '未记录'}</div>
                <div>执行尝试：{item.attemptId ?? '未记录'}</div>
                <div>传输：{item.transferId ?? '未关联'}</div>
                <div>客户端阶段：{item.phase ?? '未记录'}</div>
                <div>资源：{item.scope ? `${item.scope.resourceType}/${item.scope.resourceId}` : '未关联'}</div>
                <div>配置版本：{item.configVersion ?? '未记录'}</div>
                <div>HTTP 状态：{item.statusCode ?? '未记录'}</div>
              </div>
            </details>
          </article>
        ))}
        {!loading && items.length === 0 && (
          <EmptyState
            icon="check"
            title="当前没有符合条件的错误记录"
            description="系统故障会自动出现在这里，无需手工上报。"
          />
        )}
        {loading && <p className="py-8 text-center text-[13px] text-ink-tertiary">读取自动错误记录…</p>}
      </section>
    </div>
  );
}
