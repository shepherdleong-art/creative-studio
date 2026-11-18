'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Dialog } from '@/components/ui/Dialog';
import {
  MY_PROMPT_NAME_MAX,
  personalCopyName,
  type PromptCategory,
} from '@/lib/prompt-library';
import { teamError, teamWrite } from '@/components/team/client';

export interface LibraryPrompt {
  id: string;
  name: string;
  description: string;
  prompt: string;
  category: PromptCategory;
  isBuiltin: number;
  createdAt: string;
}

/**
 * 「我的常用」提示词（05 / 06 号票）。
 *
 * 场景图、分镜、视频运镜共用同一个控件：选公共预设 → 改写 → 保存到本人账号；
 * 保存和取用都走 `/api/video-prompt-templates?category=…`，服务端按账号隔离。
 * 组件不自己决定全文：任何选择/改写都通过 `onChange` 回传，由所在页面提交任务。
 */
export default function PromptLibraryPicker({
  category,
  value,
  onChange,
  disabled = false,
  label = '我的常用',
}: {
  category: PromptCategory;
  /** 当前输入框里的全文（用于「保存为我的常用」）。 */
  value: string;
  onChange: (prompt: string, templateId: string | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [items, setItems] = useState<LibraryPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [selectedId, setSelectedId] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const response = await fetch(`/api/video-prompt-templates?category=${category}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await teamError(response, '读取常用词失败'));
      const body = await response.json() as LibraryPrompt[];
      setItems(Array.isArray(body) ? body : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取常用词失败');
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    // 延迟到宏任务，避免 effect 内同步 setState 触发级联渲染（与项目里其他
    // 「首屏拉取」组件同一手法）。
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const select = (id: string) => {
    setSelectedId(id);
    if (!id) return;
    const item = items.find((entry) => entry.id === id);
    if (item) onChange(item.prompt, item.id);
  };

  const openSave = () => {
    const source = items.find((entry) => entry.id === selectedId);
    setSaveName(source ? personalCopyName(source.name) : '');
    setSaveError('');
    setSaveOpen(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const response = await teamWrite('/api/video-prompt-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: saveName, prompt: value, category, description: '', inRandomPool: false }),
      });
      if (!response.ok) throw new Error(await teamError(response, '保存常用词失败'));
      const body = await response.json() as { template?: LibraryPrompt };
      setSaveOpen(false);
      await load();
      if (body.template?.id) {
        setSelectedId(body.template.id);
        onChange(body.template.prompt, body.template.id);
      }
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : '保存常用词失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const target = items.find((entry) => entry.id === selectedId);
    if (!target || target.isBuiltin) return;
    setError('');
    try {
      const response = await teamWrite(`/api/video-prompt-templates/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await teamError(response, '删除常用词失败'));
      setSelectedId('');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '删除常用词失败');
    }
  };

  const selected = items.find((entry) => entry.id === selectedId);

  return (
    <div className="space-y-2" data-testid={`prompt-library-${category}`}>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input-field min-w-0 flex-1"
          aria-label={label}
          value={selectedId}
          onChange={(event) => select(event.target.value)}
          disabled={disabled || loading}
        >
          <option value="">{loading ? '正在读取…' : '自定义（手写或选公共预设）'}</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.isBuiltin ? '公共 · ' : '我的 · '}{item.name}
            </option>
          ))}
        </select>
        <button type="button" className="cap" onClick={openSave} disabled={disabled || saving || !value.trim()} data-testid="prompt-library-save">
          <Icon name="plus" size={14} />存为我的常用
        </button>
        {selected && !selected.isBuiltin && (
          <button type="button" className="cap" onClick={() => void remove()} disabled={disabled} data-testid="prompt-library-delete">
            <Icon name="trash" size={14} />删除
          </button>
        )}
      </div>
      <p className="text-xs text-ink-tertiary">
        选公共预设或手写全文后可直接改；存下的常用词只归本人账号，跨项目可用。
      </p>
      {error && <p role="alert" className="text-xs text-fail">{error}</p>}
      <Dialog
        open={saveOpen}
        title="存为我的常用"
        description="保存当前输入框里的完整文字；公共预设不会被改动。"
        onClose={() => setSaveOpen(false)}
        footer={<>
          <button type="button" className="cap" onClick={() => setSaveOpen(false)} disabled={saving}>取消</button>
          <button type="button" className="cap cap-primary" onClick={() => void save()} disabled={saving || !saveName.trim()} data-testid="prompt-library-save-confirm">
            {saving ? '保存中…' : '保存'}
          </button>
        </>}
      >
        <label className="label" htmlFor="prompt-library-name">名称</label>
        <input
          id="prompt-library-name"
          className="input-field"
          maxLength={MY_PROMPT_NAME_MAX}
          value={saveName}
          onChange={(event) => setSaveName(event.target.value)}
        />
        <p className="mt-2 line-clamp-4 whitespace-pre-wrap rounded-lg bg-surface-subtle p-2 text-xs text-ink-secondary">{value}</p>
        {saveError && <p role="alert" className="mt-2 text-xs text-fail">{saveError}</p>}
      </Dialog>
    </div>
  );
}
