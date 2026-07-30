'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { ProjectInfo } from '@/lib/project-info';

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
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const exportIntent = intent === 'export';

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, saving]);

  const updateField = (field: keyof ProjectInfo, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload: ProjectInfo = {
      name: draft.name.trim(),
      productName: draft.productName.trim(),
      productCode: draft.productCode.trim(),
      productCategory: draft.productCategory.trim(),
    };

    if (!payload.name) {
      setError('项目名称不能为空');
      return;
    }
    if (exportIntent && !payload.productCode) {
      setError('请填写产品型号后再导出');
      return;
    }

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
        className="card w-full max-w-xl overflow-hidden border-black/10 bg-white shadow-[0_24px_70px_rgba(0,0,0,.22)]"
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
                  : '用于项目展示和成片导出，不会重新生成已经完成的混剪内容。'}
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
              <span>项目名称 <span className="text-fail">*</span></span>
              <input
                className="input-field h-11"
                value={draft.name}
                disabled={saving}
                onChange={(event) => updateField('name', event.target.value)}
              />
            </label>

            <label className="grid content-start gap-2 text-[13px] font-medium text-ink">
              <span>产品名称</span>
              <input
                className="input-field h-11"
                value={draft.productName}
                disabled={saving}
                placeholder="例如：舒适软床"
                onChange={(event) => updateField('productName', event.target.value)}
              />
            </label>

            <label className="grid content-start gap-2 text-[13px] font-medium text-ink">
              <span>产品型号 {exportIntent && <span className="text-fail">*</span>}</span>
              <input
                className="input-field h-11"
                value={draft.productCode}
                disabled={saving}
                placeholder="例如：RQ1A-1"
                onChange={(event) => updateField('productCode', event.target.value)}
              />
              <span className="text-[12px] font-normal leading-4 text-ink-tertiary">
                导出必填，用于成片和封面文件名
              </span>
            </label>

            <label className="grid content-start gap-2 text-[13px] font-medium text-ink">
              <span>品类</span>
              <input
                className="input-field h-11"
                value={draft.productCategory}
                disabled={saving}
                placeholder="例如：家居 / 床具"
                onChange={(event) => updateField('productCategory', event.target.value)}
              />
            </label>
          </div>

          <div className="min-h-5 px-6 pb-3" aria-live="polite">
            {error && <p className="text-[13px] text-fail">{error}</p>}
          </div>

          <footer className="flex items-center justify-end gap-3 border-t border-hairline px-6 py-4">
            <button type="button" className="h-10 min-w-20 rounded-full px-4 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45" style={{ border: '1px solid #dedee3', background: '#fff', color: '#1d1d1f' }} disabled={saving} onClick={onClose}>
              取消
            </button>
            <button type="submit" className="h-10 min-w-24 rounded-full px-4 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45" style={{ background: '#1d1d1f', color: '#fff' }} disabled={saving}>
              {saving ? '保存中…' : exportIntent ? '保存并开始导出' : '保存'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
