'use client';

import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { ProjectInfo } from '@/lib/project-info';
import { STORE_CODES, PRODUCTION_TYPES, buildProjectBaseName, ENABLE_NEW_EXPORT_IDENTITY_KEY } from '@/lib/project-production-identity';

export type ProjectInfoValue = ProjectInfo & { id: string };
export type ProjectInfoDialogIntent = 'edit' | 'export';

interface ProjectInfoDialogProps {
  open: boolean;
  project: ProjectInfoValue;
  intent: ProjectInfoDialogIntent;
  onClose: () => void;
  onSaved: (project: ProjectInfoValue) => void | Promise<void>;
}

interface ProjectInfoResponse {
  project?: ProjectInfoValue;
  error?: string;
  message?: string;
  requiresConfirmation?: boolean;
}

export function ProjectInfoDialog(props: ProjectInfoDialogProps) {
  if (!props.open) return null;
  return <ProjectInfoDialogContent key={`${props.project.id}:${props.intent}`} {...props} />;
}

function ProjectInfoDialogContent({
  project,
  intent,
  onClose,
  onSaved,
}: ProjectInfoDialogProps) {
  const [draft, setDraft] = useState<ProjectInfo>(() => ({
    name: project.name,
    productName: project.productName,
    productCode: project.productCode,
    productCategory: project.productCategory,
    storeCode: project.storeCode,
    productSubmodel: project.productSubmodel,
    productionType: project.productionType,
    editorName: project.editorName,
    namingDate: project.namingDate,
    hasExportIdentity: project.hasExportIdentity,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [enableNewIdentity, setEnableNewIdentity] = useState(false);
  const exportIntent = intent === 'export';

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, saving]);

  const namePreview = useMemo(() => {
    if (!draft.storeCode || !draft.productCode.trim() || !draft.productionType || !draft.editorName.trim() || !draft.namingDate) return '';
    try {
      return buildProjectBaseName({
        namingDate: draft.namingDate, storeCode: draft.storeCode, productCode: draft.productCode.trim(),
        productSubmodel: draft.productSubmodel.trim(), productionType: draft.productionType, editorName: draft.editorName.trim(),
      });
    } catch {
      return '';
    }
  }, [draft.storeCode, draft.productCode, draft.productSubmodel, draft.productionType, draft.editorName, draft.namingDate]);

  const identityChanged = useMemo(
    () => draft.storeCode !== project.storeCode
      || draft.productCode !== project.productCode
      || draft.productSubmodel !== project.productSubmodel
      || draft.productionType !== project.productionType
      || draft.editorName !== project.editorName,
    [draft, project],
  );

  const updateField = (field: keyof ProjectInfo, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.storeCode) { setError('请选择店铺'); return; }
    if (!draft.productCode.trim()) { setError('请填写产品型号'); return; }
    if (!draft.productionType) { setError('请选择生产类型'); return; }
    if (!draft.editorName.trim()) { setError('请填写剪辑师'); return; }

    const payload: Record<string, unknown> = {
      storeCode: draft.storeCode,
      productCode: draft.productCode.trim(),
      productSubmodel: draft.productSubmodel.trim(),
      productionType: draft.productionType,
      editorName: draft.editorName.trim(),
    };

    // 已有正式导出产物且身份发生变化：必须先显式确认「启用新的导出名称」。
    const frozenWithChange = project.hasExportIdentity && identityChanged;
    if (frozenWithChange && !enableNewIdentity) {
      setError('项目已有正式导出产物，修改身份将启用新的导出名称；请勾选确认后再保存。');
      return;
    }
    if (frozenWithChange) payload[ENABLE_NEW_EXPORT_IDENTITY_KEY] = true;

    setSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({})) as ProjectInfoResponse;
      if (!response.ok || !body.project) {
        throw new Error(body.message || body.error || `保存失败（HTTP ${response.status}）`);
      }
      await onSaved(body.project);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-black/35 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-info-dialog-title"
        className="card w-full max-w-xl overflow-hidden border-black/10 bg-surface shadow-[0_24px_70px_rgba(0,0,0,.22)]"
      >
        <form onSubmit={(event) => void submit(event)}>
          <header className="flex items-start justify-between gap-5 px-6 pb-5 pt-6">
            <div>
              <h2 id="project-info-dialog-title" className="text-[20px] font-semibold tracking-[-0.02em] text-ink">
                编辑项目信息
              </h2>
              <p className="mt-1 text-[13px] leading-5 text-ink-secondary">
                {exportIntent
                  ? '补齐资料后会保存到项目，并继续本次成片导出。'
                  : '用于项目展示和成片导出；项目名称由系统自动生成。'}
              </p>
            </div>
            <button
              type="button"
              aria-label="关闭项目信息弹窗"
              className="icon-btn -mr-1 -mt-1 shrink-0"
              disabled={saving}
              onClick={onClose}
            >
              <Icon name="close" size={17} />
            </button>
          </header>

          <div className="grid items-start gap-x-4 gap-y-5 px-6 pb-6 sm:grid-cols-2">
            <label className="grid content-start gap-2 text-[13px] font-medium text-ink">
              <span>店铺 <span className="text-fail">*</span></span>
              <select
                className="input-field h-11"
                value={draft.storeCode}
                disabled={saving}
                onChange={(event) => updateField('storeCode', event.target.value)}
              >
                <option value="">请选择</option>
                {STORE_CODES.map((store) => (<option key={store} value={store}>{store}</option>))}
              </select>
            </label>

            <label className="grid content-start gap-2 text-[13px] font-medium text-ink">
              <span>生产类型 <span className="text-fail">*</span></span>
              <select
                className="input-field h-11"
                value={draft.productionType}
                disabled={saving}
                onChange={(event) => updateField('productionType', event.target.value)}
              >
                <option value="">请选择</option>
                {PRODUCTION_TYPES.map((type) => (<option key={type} value={type}>{type}</option>))}
              </select>
            </label>

            <label className="grid content-start gap-2 text-[13px] font-medium text-ink">
              <span>型号 <span className="text-fail">*</span></span>
              <input
                className="input-field h-11"
                value={draft.productCode}
                disabled={saving}
                placeholder="例如：XQ9A 或 PC672-A"
                onChange={(event) => updateField('productCode', event.target.value)}
              />
              <span className="text-[12px] font-normal leading-4 text-ink-tertiary">
                整个输入值就是型号，不会自动拆分
              </span>
            </label>

            <label className="grid content-start gap-2 text-[13px] font-medium text-ink">
              <span>子型号</span>
              <input
                className="input-field h-11"
                value={draft.productSubmodel}
                disabled={saving}
                placeholder="可选"
                onChange={(event) => updateField('productSubmodel', event.target.value)}
              />
            </label>

            <label className="grid content-start gap-2 text-[13px] font-medium text-ink">
              <span>剪辑师 <span className="text-fail">*</span></span>
              <input
                className="input-field h-11"
                value={draft.editorName}
                disabled={saving}
                placeholder="例如：紫菜卷"
                onChange={(event) => updateField('editorName', event.target.value)}
              />
            </label>

            <label className="grid content-start gap-2 text-[13px] font-medium text-ink">
              <span>项目名称（自动生成）</span>
              <input
                className="input-field h-11 bg-transparent text-ink-secondary"
                value={namePreview}
                readOnly
                placeholder="填写完身份后自动生成"
              />
            </label>
          </div>

          {project.hasExportIdentity && identityChanged && (
            <label className="mx-6 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={enableNewIdentity}
                onChange={(event) => setEnableNewIdentity(event.target.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span>已有正式导出产物，确认后将以新的身份启用新的导出名称；旧文件与历史导出保持不变。</span>
            </label>
          )}

          <div className="min-h-5 px-6 pb-3" aria-live="polite">
            {error && <p className="text-[13px] text-fail">{error}</p>}
          </div>

          <footer className="flex items-center justify-end gap-3 border-t border-hairline px-6 py-4">
            <button type="button" className="btn-secondary h-10 min-w-20 px-4 text-[14px]" disabled={saving} onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn-primary h-10 min-w-24 px-4 text-[14px]" disabled={saving}>
              {saving ? '保存中…' : exportIntent ? '保存并开始导出' : '保存'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
