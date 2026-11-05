'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { teamError, teamWrite } from './client';
import { Icon } from '@/components/ui/Icon';

/**
 * 公共资源页「爆文模板库」卡片（票 01 / 规格 §3）。
 *
 * 管理员只靠文件和界面按钮完成闭环：上传 .xlsx → 预览报告 → 发布给团队 →
 * 看到当前团队版本。同时提供既有历史版本的可视化选择发布（按文件名/版本/条目数
 * 识别，内部 ID 由程序传递，不需要手填资源 ID）。取消、解析失败、发布失败
 * 都不改变当前团队版本。
 */

interface TeamRevisionView {
  id: string;
  revisionNumber: number;
  sourceFilename: string;
  createdAt: string;
  current: boolean;
  entryCount: number;
  entryCounts: { total: number; usable: number; unusable: number; review: number };
}

interface TeamCandidateView {
  revisionId: string;
  sourceFilename: string;
  revisionNumber: number;
  entryCount: number;
  createdAt: string;
  libraryOwner: 'personal' | 'team';
}

interface TeamViralTemplateView {
  libraryId: string;
  current: TeamRevisionView | null;
  revisions: TeamRevisionView[];
  candidates: TeamCandidateView[];
}

interface PreviewReport {
  totalRows: number;
  validRows: number;
  canActivate: boolean;
  mergedCategorySheets: boolean;
  statusCounts: { usable: number; unusable: number; review: number };
  issues: Array<{ code: string; message: string }>;
}

function formatTime(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function TeamViralTemplateLibrary() {
  const [view, setView] = useState<TeamViralTemplateView | null>(null);
  const [preview, setPreview] = useState<{ file: File; report: PreviewReport } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/team/public-resources/viral-templates', { cache: 'no-store' });
      if (!response.ok) throw new Error(await teamError(response, '读取团队爆文模板库失败'));
      setView(await response.json() as TeamViralTemplateView);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取团队爆文模板库失败');
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function resetMessages() {
    setError('');
    setNotice('');
  }

  async function previewFile(file: File) {
    setBusy(true);
    setProgress('正在解析文件…');
    setPreview(null);
    resetMessages();
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await teamWrite('/api/team/public-resources/viral-templates?mode=preview', { method: 'POST', body: form });
      const body = await response.json().catch(() => ({})) as { message?: string; report?: PreviewReport };
      if (!response.ok || !body.report) throw new Error(body.message || `预览失败：HTTP ${response.status}`);
      setPreview({ file, report: body.report });
      setProgress('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '预览失败');
      setProgress('');
    } finally {
      setBusy(false);
    }
  }

  /** 发布上传文件：显式带当前看到的版本做并发 CAS。 */
  async function publishFile() {
    if (!preview) return;
    setBusy(true);
    setProgress('正在发布给团队…');
    resetMessages();
    try {
      const form = new FormData();
      form.append('file', preview.file);
      const baseRevisionId = view?.current?.id ?? '';
      const response = await teamWrite(
        `/api/team/public-resources/viral-templates?baseRevisionId=${encodeURIComponent(baseRevisionId)}`,
        { method: 'POST', body: form },
      );
      const body = await response.json().catch(() => ({})) as {
        message?: string; created?: boolean; activated?: boolean; revisionNumber?: number;
      };
      if (!response.ok) throw new Error(body.message || `发布失败：HTTP ${response.status}`);
      setNotice(body.created
        ? `已发布团队版本 v${body.revisionNumber}，员工现在统一使用该版本。`
        : body.activated
          ? '该内容已在团队库中，已重新激活为当前版本。'
          : '该内容就是当前团队版本，未产生新版本。');
      setPreview(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发布失败');
    } finally {
      setProgress('');
      setBusy(false);
    }
  }

  /** 从既有修订发布（历史个人修订 / 旧团队版本），不需要手填 ID。 */
  async function publishRevision(revisionId: string) {
    setBusy(true);
    setProgress('正在发布所选版本…');
    resetMessages();
    try {
      const response = await teamWrite('/api/team/public-resources/viral-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionId, baseRevisionId: view?.current?.id ?? null }),
      });
      const body = await response.json().catch(() => ({})) as {
        message?: string; created?: boolean; activated?: boolean; revisionNumber?: number;
      };
      if (!response.ok) throw new Error(body.message || `发布失败：HTTP ${response.status}`);
      setNotice(body.created
        ? `已发布团队版本 v${body.revisionNumber}。`
        : body.activated
          ? '该版本已重新激活为当前团队版本。'
          : '该版本就是当前团队版本。');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发布失败');
    } finally {
      setProgress('');
      setBusy(false);
    }
  }

  const current = view?.current ?? null;
  const candidatePersonal = (view?.candidates ?? []).filter((candidate) => candidate.libraryOwner === 'personal');

  return (
    <section className="card p-6" aria-labelledby="team-viral-template-heading">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h2 id="team-viral-template-heading" className="text-lg font-semibold text-ink">爆文模板库</h2>
            {current ? (
              <span className="status-badge status-succeeded">
                <Icon name="check" size={12} /> 团队当前版本 v{current.revisionNumber}
              </span>
            ) : (
              <span className="status-badge status-canceled">尚未发布</span>
            )}
          </div>
          <p className="text-sm text-ink-secondary">
            上传种草爆文库 .xlsx，预览后发布给团队。员工统一使用当前已发布版本，历史任务保留原快照。
          </p>
        </div>
        <button
          type="button"
          className="btn-primary btn-sm shrink-0"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="upload" size={14} /> {busy ? '处理中…' : '上传 .xlsx'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          aria-label="上传爆文模板 .xlsx"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void previewFile(file);
          }}
        />
      </div>

      {error && <p role="alert" className="mb-4 flex items-center gap-2 rounded-[14px] bg-fail/[0.04] p-4 text-sm text-fail"><Icon name="alert" size={15} /> {error}</p>}
      {notice && <p role="status" className="mb-4 flex items-center gap-2 rounded-[14px] bg-ok/[0.06] p-4 text-sm text-ok"><Icon name="check" size={15} /> {notice}</p>}
      {progress && <p role="status" className="mb-4 text-sm text-ink-secondary">{progress}</p>}

      {preview && (
        <div className="mb-4 rounded-[14px] border border-accent/30 bg-accent/[0.04] p-4">
          <p className="mb-2 text-sm font-semibold">发布预览（确认后才替换团队版本）</p>
          <p className="mb-2 break-all text-xs text-ink-tertiary">{preview.file.name}</p>
          <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-ink-secondary sm:grid-cols-4">
            <div>条目总数：<strong>{preview.report.totalRows}</strong></div>
            <div>可用：<strong className="text-ok">{preview.report.statusCounts.usable}</strong></div>
            <div>占位不可用：<strong className="text-fail">{preview.report.statusCounts.unusable}</strong></div>
            <div>待检查：<strong className="text-warn">{preview.report.statusCounts.review}</strong></div>
          </div>
          {preview.report.mergedCategorySheets && (
            <p className="mb-2 text-xs text-ink-tertiary">未找到「全部模板」主表，已合并分类表并按模板 ID 去重。</p>
          )}
          {preview.report.issues.length > 0 && (
            <div className="mb-3 space-y-1">
              {preview.report.issues.slice(0, 8).map((issue, index) => (
                <p key={`${issue.code}-${index}`} className="text-xs text-ink-secondary">{issue.message}</p>
              ))}
              {preview.report.issues.length > 8 && (
                <p className="text-xs text-ink-tertiary">还有 {preview.report.issues.length - 8} 条提示未展示…</p>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={busy || !preview.report.canActivate || preview.report.statusCounts.usable === 0}
              onClick={() => void publishFile()}
            >
              发布给团队
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setPreview(null)}>
              取消
            </button>
          </div>
          {!preview.report.canActivate && (
            <p className="mt-2 text-xs text-fail">请先修正导入报告中的问题，不能发布。</p>
          )}
          {preview.report.canActivate && preview.report.statusCounts.usable === 0 && (
            <p className="mt-2 text-xs text-fail">没有可推荐的可用模板，不能发布。</p>
          )}
        </div>
      )}

      {current ? (
        <div className="mb-4 grid grid-cols-1 gap-x-8 gap-y-1 rounded-[14px] bg-surface-subtle p-4 text-sm text-ink-secondary sm:grid-cols-2">
          <div><span className="text-ink-tertiary">来源文件：</span><code className="break-all text-xs">{current.sourceFilename}</code></div>
          <div><span className="text-ink-tertiary">发布时间：</span>{formatTime(current.createdAt)}</div>
          <div>
            <span className="text-ink-tertiary">当前内容：</span>
            {current.entryCounts.total} 个模板（可用 {current.entryCounts.usable} · 占位 {current.entryCounts.unusable} · 待检查 {current.entryCounts.review}）
          </div>
          <div className="text-xs text-ink-tertiary">员工统一使用该版本；历史任务保留发布时的条目快照。</div>
        </div>
      ) : (
        <p className="mb-4 rounded-[14px] bg-surface-subtle p-4 text-sm text-ink-tertiary">
          团队还没有发布任何爆文模板库。上传文件后先确认预览，再点击「发布给团队」。
        </p>
      )}

      {(view?.revisions.length ?? 0) > 0 && (
        <div className="mb-4">
          <p className="label mb-2">团队历史版本</p>
          <div className="space-y-1.5">
            {view!.revisions.map((revision) => (
              <div key={revision.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-hairline px-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-mono text-xs text-ink-secondary">v{revision.revisionNumber}</span>
                  <span className="mx-2 text-ink-tertiary">·</span>
                  <code className="break-all text-xs text-ink-secondary">{revision.sourceFilename}</code>
                  <span className="ml-2 text-xs text-ink-tertiary">{formatTime(revision.createdAt)}</span>
                  <div className="mt-1 text-xs text-ink-tertiary">
                    {revision.entryCount} 个模板（可用 {revision.entryCounts.usable}）
                  </div>
                </div>
                {revision.current ? (
                  <span className="status-badge status-succeeded shrink-0">当前</span>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary btn-sm shrink-0"
                    disabled={busy}
                    onClick={() => void publishRevision(revision.id)}
                  >
                    设为当前版本
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {candidatePersonal.length > 0 && (
        <div>
          <p className="label mb-2">可发布的既有导入版本</p>
          <p className="mb-2 text-xs text-ink-tertiary">
            此前通过设置页导入的版本。发布后团队使用所选版本条目；你自己的其他修订仍保持私人。
          </p>
          <div className="space-y-1.5">
            {candidatePersonal.slice(0, 20).map((candidate) => (
              <div key={candidate.revisionId} className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-hairline px-3 py-2 text-sm">
                <div className="min-w-0">
                  <code className="break-all text-xs text-ink-secondary">{candidate.sourceFilename}</code>
                  <span className="ml-2 font-mono text-xs text-ink-tertiary">v{candidate.revisionNumber}</span>
                  <span className="ml-2 text-xs text-ink-tertiary">{candidate.entryCount} 个模板 · {formatTime(candidate.createdAt)}</span>
                </div>
                <button
                  type="button"
                  className="btn-secondary btn-sm shrink-0"
                  disabled={busy}
                  onClick={() => void publishRevision(candidate.revisionId)}
                >
                  发布给团队
                </button>
              </div>
            ))}
            {candidatePersonal.length > 20 && (
              <p className="text-xs text-ink-tertiary">还有 {candidatePersonal.length - 20} 个更早的版本未展示。</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
