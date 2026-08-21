'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  TEMPLATE_DESCRIPTION_MAX,
  TEMPLATE_NAME_MAX,
  TEMPLATE_PROMPT_MAX,
} from '@/lib/video-prompt-template';

interface MotionTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  isBuiltin: number;
  inRandomPool: number;
}

interface FormState {
  name: string;
  description: string;
  prompt: string;
  inRandomPool: boolean;
}

const emptyForm: FormState = { name: '', description: '', prompt: '', inRandomPool: true };

async function fetchTemplates(): Promise<MotionTemplate[]> {
  const res = await fetch('/api/video-prompt-templates');
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

export default function MotionTemplateSettings() {
  const [templates, setTemplates] = useState<MotionTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  // 首屏加载带 active 守卫：卸载之后不再写状态（和 VideoGenerationPanel 同一套）。
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await fetchTemplates();
        if (active) setTemplates(list);
      } catch {
        if (active) setError('加载模板失败，请刷新重试。');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const reload = useCallback(async () => {
    try {
      setTemplates(await fetchTemplates());
    } catch {
      setError('加载模板失败，请刷新重试。');
    }
  }, []);

  const closeForm = () => {
    setCreating(false);
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
    setWarnings([]);
  };

  const beginCreate = () => {
    setEditingId(null);
    setCreating(true);
    setForm(emptyForm);
    setError(null);
    setWarnings([]);
  };

  // 内置模板每次启动都会被 seed 写回官方措辞，所以只能复制成自定义再改。
  const beginCopy = (template: MotionTemplate) => {
    setEditingId(null);
    setCreating(true);
    setForm({
      name: `${template.name} 副本`.slice(0, TEMPLATE_NAME_MAX),
      description: template.description,
      prompt: template.prompt,
      inRandomPool: true,
    });
    setError(null);
    setWarnings([]);
  };

  const beginEdit = (template: MotionTemplate) => {
    setCreating(false);
    setEditingId(template.id);
    setForm({
      name: template.name,
      description: template.description,
      prompt: template.prompt,
      inRandomPool: template.inRandomPool !== 0,
    });
    setError(null);
    setWarnings([]);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await fetch(
        editingId ? `/api/video-prompt-templates/${editingId}` : '/api/video-prompt-templates',
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        },
      );
      const data = await res.json().catch(() => ({})) as { error?: string; warnings?: string[] };
      if (!res.ok) { setError(data.error || `HTTP ${res.status}`); return; }
      await reload();
      const nextWarnings = data.warnings ?? [];
      closeForm();
      // 提示词写法上的建议不拦提交，但要留在屏幕上，别一闪而过。
      setWarnings(nextWarnings);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const togglePool = async (template: MotionTemplate) => {
    setError(null);
    try {
      const res = await fetch(`/api/video-prompt-templates/${template.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inRandomPool: template.inRandomPool === 0 }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setError(data.error || `HTTP ${res.status}`); return; }
      await reload();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (template: MotionTemplate) => {
    if (!window.confirm(`删除模板「${template.name}」？`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/video-prompt-templates/${template.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setError(data.error || `HTTP ${res.status}`); return; }
      await reload();
    } catch (err) {
      setError(String(err));
    }
  };

  if (loading) return <p className="py-8 text-center text-sm text-ink-tertiary">加载运镜模板...</p>;

  const pooled = templates.filter((t) => t.inRandomPool !== 0).length;
  const builtins = templates.filter((t) => t.isBuiltin === 1);
  const customs = templates.filter((t) => t.isBuiltin !== 1);

  const formCard = (
    <div className="card border-accent/30 bg-accent/[0.04] p-5">
      <h3 className="mb-4 font-semibold">{editingId ? '编辑模板' : '新建模板'}</h3>
      <div className="space-y-3">
        <div>
          <label className="label">名称</label>
          <input
            className="input-field"
            value={form.name}
            maxLength={TEMPLATE_NAME_MAX}
            placeholder="例如：慢速左推"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className="label">描述（可选）</label>
          <input
            className="input-field"
            value={form.description}
            maxLength={TEMPLATE_DESCRIPTION_MAX}
            placeholder="一句话说明这个运镜用在什么场合"
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div>
          <label className="label">提示词</label>
          <textarea
            className="input-field"
            rows={5}
            value={form.prompt}
            maxLength={TEMPLATE_PROMPT_MAX}
            placeholder="建议以「以当前图片为首帧」开头，并写上「不要添加文字」"
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          />
          <p className="mt-1 text-xs text-ink-tertiary">
            {form.prompt.length} / {TEMPLATE_PROMPT_MAX}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <input
            type="checkbox"
            checked={form.inRandomPool}
            onChange={(e) => setForm({ ...form, inRandomPool: e.target.checked })}
          />
          参与「一键随机填充」
        </label>
      </div>
      {error && (
        <p className="mt-3 rounded-[10px] bg-fail-tint px-3 py-2 text-xs text-fail">{error}</p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={closeForm} className="btn-secondary btn-sm">取消</button>
        <button onClick={() => void save()} disabled={saving} className="btn-primary btn-sm">
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );

  const renderCard = (template: MotionTemplate) => {
    const builtin = template.isBuiltin === 1;
    const inPool = template.inRandomPool !== 0;
    return (
      <div key={template.id} className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-ink">{template.name}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                builtin ? 'bg-ink/[0.06] text-ink-tertiary' : 'bg-accent-tint/20 text-accent'
              }`}>
                {builtin ? '内置' : '自定义'}
              </span>
              {!inPool && (
                <span className="rounded-full bg-warn-tint px-2 py-0.5 text-[10px] font-medium text-warn">
                  不参与随机
                </span>
              )}
            </div>
            {template.description && (
              <p className="mt-1 text-xs text-ink-tertiary">{template.description}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void togglePool(template)}
              className="btn-secondary btn-sm"
              title={inPool ? '不再被一键随机填充抽到' : '让一键随机填充可以抽到它'}
            >
              {inPool ? '移出随机' : '加入随机'}
            </button>
            {builtin ? (
              <button onClick={() => beginCopy(template)} className="btn-secondary btn-sm">
                <Icon name="copy" size={12} /> 复制一份
              </button>
            ) : (
              <>
                <button onClick={() => beginEdit(template)} className="btn-secondary btn-sm">编辑</button>
                <button
                  onClick={() => void remove(template)}
                  className="btn-secondary btn-sm text-fail"
                  aria-label={`删除 ${template.name}`}
                >
                  <Icon name="trash" size={12} />
                </button>
              </>
            )}
          </div>
        </div>
        <p className="mt-3 whitespace-pre-wrap rounded-[10px] bg-surface-subtle px-3 py-2 text-xs leading-relaxed text-ink-secondary">
          {template.prompt}
        </p>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-secondary">
          共 {templates.length} 条，其中 <strong className="text-ink">{pooled}</strong> 条参与「一键随机填充」。
          内置模板不可修改，需要改先复制一份。
        </p>
        <button onClick={beginCreate} className="btn-primary btn-sm shrink-0">
          <Icon name="plus" size={14} /> 新建模板
        </button>
      </div>

      {warnings.length > 0 && (
        <div className="rounded-[12px] border border-warn/25 bg-warn-tint px-4 py-3">
          {warnings.map((warning) => (
            <p key={warning} className="text-xs leading-relaxed text-warn">{warning}</p>
          ))}
        </div>
      )}
      {error && !creating && !editingId && (
        <p className="rounded-[12px] bg-fail-tint px-4 py-3 text-xs text-fail">{error}</p>
      )}

      {(creating || editingId) && formCard}

      {customs.length > 0 && (
        <>
          <h3 className="pt-2 text-sm font-semibold text-ink">自定义模板</h3>
          {customs.map(renderCard)}
        </>
      )}

      <h3 className="pt-2 text-sm font-semibold text-ink">内置模板</h3>
      {builtins.map(renderCard)}
    </div>
  );
}
