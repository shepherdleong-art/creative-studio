'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * 设置页「脚本知识与模板」区块（方案 §6.4）：
 * - 分别展示「产品策略知识库」与「脚本模板库」的当前版本、来源文件、导入时间与条目数；
 * - 支持分别上传 .xlsx 导入新版本；相同内容指纹幂等；
 * - 支持激活历史修订（只切当前指针，不改条目）；
 * - 展示导入报告中的警告/冲突与无标题列映射提示。
 */

interface CatalogSummary {
  id: string;
  kind: 'strategy' | 'template';
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  current: {
    id: string;
    revisionNumber: number;
    sourceFilename: string;
    importReport: Record<string, unknown>;
    createdAt: string;
    strategyEntryCount?: number;
    frameworkCount?: number;
    copyHookCount?: number;
    visualHookCount?: number;
  } | null;
  revisions: Array<{
    id: string;
    revisionNumber: number;
    sourceFilename: string;
    createdAt: string;
    current: boolean;
    strategyStatus?: { active: number; conflict: number; conflictRows: Array<number | string> };
    templateStatus?: {
      framework: number;
      copyHook: number;
      visualHook: number;
      draftInvalid: number;
      draftRows: number[];
      assetCount: number;
    };
  }>;
}

interface CatalogsResponse {
  catalogs: CatalogSummary[];
}

interface ImportIssueView {
  code: string;
  message: string;
  row?: number;
  column?: string;
}

const KIND_LABEL: Record<'strategy' | 'template', string> = {
  strategy: '产品策略知识库',
  template: '脚本模板库',
};

const KIND_DESC: Record<'strategy' | 'template', string> = {
  strategy: '型号匹配、统一名称与搜索词埋词。只在脚本生成时使用，不参与项目校验与命名。',
  template: '核心框架、文案钩子与画面钩子，含嵌入式参考图。',
};

function importIssues(report: Record<string, unknown> | undefined): ImportIssueView[] {
  if (!report || !Array.isArray(report.issues)) return [];
  return (report.issues as ImportIssueView[]).filter((item) => item && typeof item.message === 'string');
}

function unmappedHeaders(report: Record<string, unknown> | undefined): Array<{ column: string; value: string; row: number }> {
  if (!report || !Array.isArray(report.unmappedHeaders)) return [];
  return report.unmappedHeaders as Array<{ column: string; value: string; row: number }>;
}

function formatTime(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function ScriptKnowledgeSettings() {
  const [catalogs, setCatalogs] = useState<CatalogSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const strategyFileRef = useRef<HTMLInputElement>(null);
  const templateFileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState<'strategy' | 'template' | null>(null);
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/script-studio/catalogs');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message || `加载失败：HTTP ${res.status}`);
      }
      const data = (await res.json()) as CatalogsResponse;
      setCatalogs(Array.isArray(data.catalogs) ? data.catalogs : []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  const importFile = async (kind: 'strategy' | 'template', file: File) => {
    setImporting(kind);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/script-studio/catalogs/${kind}/import`, { method: 'POST', body: formData });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        created?: boolean;
        report?: { issues?: ImportIssueView[]; canActivate?: boolean; mergedModelCount?: number; totalRows?: number };
      };
      if (!res.ok) {
        throw new Error(body.message || `导入失败：HTTP ${res.status}`);
      }
      const issues = body.report?.issues?.length ?? 0;
      const canActivate = body.report?.canActivate ?? true;
      const suffix = body.created === false ? '内容指纹相同，未产生新版本。' : canActivate ? '已导入并激活为新版本。' : `已导入（${issues} 条警告）。`;
      setMessage({ kind, text: `导入完成，${suffix}`, success: true });
      await load();
    } catch (cause) {
      setMessage({ kind, text: cause instanceof Error ? cause.message : String(cause), success: false });
    } finally {
      setImporting(null);
    }
  };

  const activate = async (catalogId: string, revisionId: string) => {
    setMessage(null);
    try {
      const res = await fetch(`/api/script-studio/catalogs/${catalogId}/current`, {
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

  const entrySummary = (catalog: CatalogSummary): string => {
    const current = catalog.current;
    if (!current) return '尚未导入';
    if (catalog.kind === 'strategy') {
      return `${current.strategyEntryCount ?? 0} 个合并型号`;
    }
    return [
      current.frameworkCount ? `${current.frameworkCount} 个框架` : '',
      current.copyHookCount ? `${current.copyHookCount} 个文案钩子` : '',
      current.visualHookCount ? `${current.visualHookCount} 个画面钩子` : '',
    ].filter(Boolean).join(' · ') || '已导入';
  };

  const renderCatalog = (catalog: CatalogSummary) => {
    const current = catalog.current;
    const issues = importIssues(current?.importReport);
    const unmapped = unmappedHeaders(current?.importReport);
    const fileRef = catalog.kind === 'strategy' ? strategyFileRef : templateFileRef;

    return (
      <div key={catalog.kind} className="card p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{KIND_LABEL[catalog.kind]}</h3>
              {current ? (
                <span className="status-badge status-succeeded">
                  <Icon name="check" size={12} /> 已启用 v{current.revisionNumber}
                </span>
              ) : (
                <span className="status-badge status-canceled">未导入</span>
              )}
            </div>
            <p className="text-xs text-ink-tertiary">{KIND_DESC[catalog.kind]}</p>
          </div>
          <button
            type="button"
            className="btn-primary btn-sm shrink-0"
            disabled={importing !== null}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="upload" size={14} /> {importing === catalog.kind ? '导入中...' : '导入 .xlsx'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importFile(catalog.kind, file);
            }}
          />
        </div>

        {current ? (
          <div className="mb-4 grid grid-cols-1 gap-x-8 gap-y-1 rounded-[14px] bg-surface-subtle p-4 text-sm text-ink-secondary sm:grid-cols-2">
            <div><span className="text-ink-tertiary">来源文件：</span><code className="break-all text-xs">{current.sourceFilename}</code></div>
            <div><span className="text-ink-tertiary">导入时间：</span>{formatTime(current.createdAt)}</div>
            <div><span className="text-ink-tertiary">当前内容：</span>{entrySummary(catalog)}</div>
            {current.importReport?.mergedModelCount !== undefined && (
              <div><span className="text-ink-tertiary">合并型号：</span>{String(current.importReport.mergedModelCount)}</div>
            )}
          </div>
        ) : (
          <p className="mb-4 rounded-[14px] bg-surface-subtle p-4 text-sm text-ink-tertiary">
            尚未导入。上传后解析结果会作为不可变版本发布，相同文件重复导入不会产生新版本。
          </p>
        )}

        {issues.length > 0 && (
          <div className="mb-4 space-y-1 rounded-[14px] bg-fail/[0.04] p-4">
            <p className="mb-1 text-xs font-semibold text-fail">导入警告（{issues.length}）</p>
            {issues.slice(0, 12).map((issue, index) => (
              <p key={`${issue.code}-${index}`} className="text-xs text-ink-secondary">
                {issue.row ? `第 ${issue.row} 行 · ` : ''}{issue.message}
              </p>
            ))}
            {issues.length > 12 && <p className="text-xs text-ink-tertiary">还有 {issues.length - 12} 条未展示...</p>}
          </div>
        )}

        {unmapped.length > 0 && (
          <div className="mb-4 space-y-1 rounded-[14px] bg-fail/[0.04] p-4">
            <p className="mb-1 text-xs font-semibold text-fail">未识别表头 / 无标题列映射（{unmapped.length}）</p>
            {unmapped.slice(0, 8).map((item, index) => (
              <p key={index} className="text-xs text-ink-secondary">
                {item.column} 列（第 {item.row} 行）：「{item.value}」
              </p>
            ))}
            {unmapped.length > 8 && <p className="text-xs text-ink-tertiary">还有 {unmapped.length - 8} 项未展示...</p>}
          </div>
        )}

        {catalog.revisions.length > 0 && (
          <div>
            <p className="label mb-2">历史版本</p>
            <div className="space-y-1.5">
              {catalog.revisions.map((revision) => (
                <div key={revision.id} className="flex items-center justify-between gap-3 rounded-[12px] border border-hairline px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-mono text-xs text-ink-secondary">v{revision.revisionNumber}</span>
                    <span className="mx-2 text-ink-tertiary">·</span>
                    <code className="break-all text-xs text-ink-secondary">{revision.sourceFilename}</code>
                    <span className="ml-2 text-xs text-ink-tertiary">{formatTime(revision.createdAt)}</span>
                    <div className="mt-1 text-xs text-ink-tertiary">
                      {revision.strategyStatus
                        ? `有效 ${revision.strategyStatus.active} · 冲突 ${revision.strategyStatus.conflict}${revision.strategyStatus.conflictRows.length > 0 ? `（第 ${revision.strategyStatus.conflictRows.join('、')} 行）` : ''}`
                        : revision.templateStatus
                          ? `${revision.templateStatus.framework} 框架 · ${revision.templateStatus.copyHook} 文案钩子 · ${revision.templateStatus.visualHook} 画面钩子${revision.templateStatus.draftInvalid > 0 ? ` · 草稿 ${revision.templateStatus.draftInvalid}（第 ${revision.templateStatus.draftRows.join('、')} 行）` : ''} · ${revision.templateStatus.assetCount} 张参考图`
                          : ''}
                    </div>
                  </div>
                  {revision.current ? (
                    <span className="status-badge status-succeeded shrink-0">当前</span>
                  ) : (
                    <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => void activate(catalog.id, revision.id)}>
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
  };

  if (loading) return <div className="card p-8 text-center text-sm text-ink-tertiary">加载脚本知识与模板…</div>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-[14px] bg-fail/[0.04] p-4 text-sm text-fail">
          <Icon name="alert" size={15} /> {error}
        </div>
      )}
      {message && (
        <div className={`flex items-center gap-2 rounded-[14px] p-4 text-sm ${message.success ? 'bg-ok/[0.06] text-ok' : 'bg-fail/[0.04] text-fail'}`}>
          <Icon name={message.success ? 'check' : 'alert'} size={15} /> {message.text}
        </div>
      )}
      {catalogs.map((catalog) => renderCatalog(catalog))}
      <div className="flex gap-2 rounded-[18px] bg-surface-subtle p-4 text-sm text-ink-secondary">
        <Icon name="lock" size={16} className="mt-0.5 shrink-0 text-ink-tertiary" />
        <p>
          <strong className="text-ink">只读约束：</strong>
          目录只支持不可变版本的新增与切换，不提供物理删除。已排队或已生成的脚本使用创建时的版本快照，切换当前版本不会改变它们。
        </p>
      </div>
    </div>
  );
}
