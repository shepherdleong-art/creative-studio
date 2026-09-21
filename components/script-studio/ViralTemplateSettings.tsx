'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * 设置页「爆文模板库」卡片（迁移方案 §3.1.1）：
 * 导入 .xlsx → 预览总数/去重/异常行 → 确认后保存为不可变版本；
 * 同文件重导幂等；支持激活历史修订；占位/待检查条目如实展示。
 */

interface ViralLibraryView {
  library: { id: string; currentRevisionId: string | null };
  current: {
    id: string;
    revisionNumber: number;
    sourceFilename: string;
    createdAt: string;
    entryCounts: { total: number; usable: number; unusable: number; review: number };
    report: { issues?: Array<{ code: string; message: string }>; mergedCategorySheets?: boolean };
  } | null;
  revisions: Array<{
    id: string;
    revisionNumber: number;
    sourceFilename: string;
    createdAt: string;
    current: boolean;
    entryCount: number;
  }>;
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

export default function ViralTemplateSettings() {
  const [view, setView] = useState<ViralLibraryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null);
  const [preview, setPreview] = useState<{ file: File; report: PreviewReport } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/script-studio/viral-templates');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message || `加载失败：HTTP ${res.status}`);
      }
      setView((await res.json()) as ViralLibraryView);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    // 延迟到宏任务执行，避免 effect 内同步 setState 触发级联渲染。
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const previewFile = async (file: File) => {
    setBusy(true);
    setMessage(null);
    setPreview(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/script-studio/viral-templates/import?mode=preview', { method: 'POST', body: formData });
      const body = (await res.json().catch(() => ({}))) as { message?: string; report?: PreviewReport };
      if (!res.ok || !body.report) throw new Error(body.message || `预览失败：HTTP ${res.status}`);
      setPreview({ file, report: body.report });
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : String(cause), success: false });
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!preview) return;
    setBusy(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', preview.file);
      const res = await fetch('/api/script-studio/viral-templates/import', { method: 'POST', body: formData });
      const body = (await res.json().catch(() => ({}))) as { message?: string; created?: boolean; report?: PreviewReport };
      if (!res.ok) throw new Error(body.message || `导入失败：HTTP ${res.status}`);
      const counts = body.report?.statusCounts;
      const suffix = body.created === false
        ? '内容指纹相同，未产生新版本。'
        : `已保存为新版本（可用 ${counts?.usable ?? 0} · 占位 ${counts?.unusable ?? 0} · 待检查 ${counts?.review ?? 0}）。`;
      setMessage({ text: `导入完成，${suffix}`, success: true });
      setPreview(null);
      await load();
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : String(cause), success: false });
    } finally {
      setBusy(false);
    }
  };

  const activate = async (revisionId: string) => {
    setMessage(null);
    try {
      const res = await fetch('/api/script-studio/viral-templates/current', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionId }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message || `激活失败：HTTP ${res.status}`);
      await load();
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : String(cause), success: false });
    }
  };

  const current = view?.current ?? null;
  const currentIssues = current?.report?.issues ?? [];

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">爆文模板库</h3>
            {current ? (
              <span className="status-badge status-succeeded">
                <Icon name="check" size={12} /> 已启用 v{current.revisionNumber}
              </span>
            ) : (
              <span className="status-badge status-canceled">未导入</span>
            )}
          </div>
          <p className="text-xs text-ink-tertiary">
            强尼精选爆文文案（种草爆文库，按类目）。用于「爆文模板改写」模式：推荐模板 → 勾选 → 按模板改写成自己家脚本。
          </p>
        </div>
        <button
          type="button"
          className="btn-primary btn-sm shrink-0"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="upload" size={14} /> {busy ? '解析中...' : '导入 .xlsx'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void previewFile(file);
          }}
        />
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-[14px] bg-fail/[0.04] p-4 text-sm text-fail">
          <Icon name="alert" size={15} /> {error}
        </div>
      )}
      {message && (
        <div className={`mb-4 flex items-center gap-2 rounded-[14px] p-4 text-sm ${message.success ? 'bg-ok/[0.06] text-ok' : 'bg-fail/[0.04] text-fail'}`}>
          <Icon name={message.success ? 'check' : 'alert'} size={15} /> {message.text}
        </div>
      )}

      {preview && (
        <div className="mb-4 rounded-[14px] border border-accent/30 bg-accent/[0.04] p-4">
          <p className="mb-2 text-sm font-semibold">导入预览（确认后才保存）</p>
          <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-ink-secondary sm:grid-cols-4">
            <div>去重后模板：<strong>{preview.report.totalRows}</strong></div>
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
                <p className="text-xs text-ink-tertiary">还有 {preview.report.issues.length - 8} 条提示未展示...</p>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-primary btn-sm" disabled={busy || !preview.report.canActivate} onClick={() => void confirmImport()}>
              确认保存为模板库版本
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setPreview(null)}>
              取消
            </button>
          </div>
          {!preview.report.canActivate && (
            <p className="mt-2 text-xs text-fail">内容不完整（未解析到有效模板），不能保存。</p>
          )}
        </div>
      )}

      {current ? (
        <div className="mb-4 grid grid-cols-1 gap-x-8 gap-y-1 rounded-[14px] bg-surface-subtle p-4 text-sm text-ink-secondary sm:grid-cols-2">
          <div><span className="text-ink-tertiary">来源文件：</span><code className="break-all text-xs">{current.sourceFilename}</code></div>
          <div><span className="text-ink-tertiary">导入时间：</span>{formatTime(current.createdAt)}</div>
          <div>
            <span className="text-ink-tertiary">当前内容：</span>
            {current.entryCounts.total} 个模板（可用 {current.entryCounts.usable} · 占位 {current.entryCounts.unusable} · 待检查 {current.entryCounts.review}）
          </div>
          <div className="text-xs text-ink-tertiary">占位模板默认不参与推荐；待检查模板可在项目内查看后人工调整。</div>
        </div>
      ) : (
        <p className="mb-4 rounded-[14px] bg-surface-subtle p-4 text-sm text-ink-tertiary">
          尚未导入。上传后先预览去重结果与异常行，确认后才保存为不可变版本；相同文件重复导入不会产生新版本。
        </p>
      )}

      {currentIssues.length > 0 && (
        <div className="mb-4 space-y-1 rounded-[14px] bg-fail/[0.04] p-4">
          <p className="mb-1 text-xs font-semibold text-fail">导入提示（{currentIssues.length}）</p>
          {currentIssues.slice(0, 10).map((issue, index) => (
            <p key={`${issue.code}-${index}`} className="text-xs text-ink-secondary">{issue.message}</p>
          ))}
          {currentIssues.length > 10 && <p className="text-xs text-ink-tertiary">还有 {currentIssues.length - 10} 条未展示...</p>}
        </div>
      )}

      {view && view.revisions.length > 0 && (
        <div>
          <p className="label mb-2">历史版本</p>
          <div className="space-y-1.5">
            {view.revisions.map((revision) => (
              <div key={revision.id} className="flex items-center justify-between gap-3 rounded-[12px] border border-hairline px-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-mono text-xs text-ink-secondary">v{revision.revisionNumber}</span>
                  <span className="mx-2 text-ink-tertiary">·</span>
                  <code className="break-all text-xs text-ink-secondary">{revision.sourceFilename}</code>
                  <span className="ml-2 text-xs text-ink-tertiary">{formatTime(revision.createdAt)}</span>
                  <div className="mt-1 text-xs text-ink-tertiary">{revision.entryCount} 个模板</div>
                </div>
                {revision.current ? (
                  <span className="status-badge status-succeeded shrink-0">当前</span>
                ) : (
                  <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => void activate(revision.id)}>
                    激活
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
