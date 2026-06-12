'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  type: string;
  enabled: number;
  defaultCostPerImage?: number;
  hasApiKey: boolean;
}

export default function SettingsPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state for editing
  const [editForm, setEditForm] = useState({
    name: '',
    baseUrl: '',
    model: '',
    type: 'geekai-json',
    apiKey: '',
    defaultCostPerImage: 0,
    enabled: true,
  });

  const [showNewForm, setShowNewForm] = useState(false);

  const loadProviders = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/providers');
      const data = await res.json();
      if (Array.isArray(data)) setProviders(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProviders();
  }, []);

  const startEdit = (p: Provider) => {
    setEditingId(p.id);
    setEditForm({
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      type: p.type || 'geekai-json',
      apiKey: '',
      defaultCostPerImage: p.defaultCostPerImage || 0,
      enabled: !!p.enabled,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setShowNewForm(false);
  };

  const handleSave = async (id: string) => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: editForm.name,
        baseUrl: editForm.baseUrl,
        model: editForm.model,
        type: editForm.type,
        defaultCostPerImage: editForm.defaultCostPerImage,
        enabled: editForm.enabled,
      };

      // Only send apiKey if user entered one
      if (editForm.apiKey.trim()) {
        body.apiKey = editForm.apiKey.trim();
      }

      await fetch(`/api/providers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      setEditingId(null);
      await loadProviders();
    } catch (err) {
      alert('保存失败: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!editForm.name.trim()) {
      alert('请输入供应商名称');
      return;
    }
    setSaving(true);
    try {
      await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editForm.name,
          baseUrl: editForm.baseUrl,
          model: editForm.model,
          type: editForm.type,
          apiKey: editForm.apiKey.trim(),
          defaultCostPerImage: editForm.defaultCostPerImage,
        }),
      });
      setShowNewForm(false);
      await loadProviders();
    } catch (err) {
      alert('创建失败: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此供应商？')) return;
    try {
      const res = await fetch(`/api/providers/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      await loadProviders();
    } catch (err) {
      alert('删除失败: ' + String(err));
    }
  };

  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/providers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      await loadProviders();
    } catch (err) {
      alert('更新失败: ' + String(err));
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.02em]">供应商配置</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            管理 API 供应商的 Base URL、API Key 和默认参数
          </p>
          <p className="mt-1 text-xs text-ink-tertiary">
            可以保存多个供应商，只有启用且已配置 Key 的供应商会出现在新建项目中。允许多个供应商同时启用。
          </p>
        </div>
        <button
          onClick={() => {
            setShowNewForm(true);
            setEditingId(null);
            setEditForm({
              name: '',
              baseUrl: '',
              model: 'gpt-image-2',
              type: 'geekai-json',
              apiKey: '',
              defaultCostPerImage: 0,
              enabled: true,
            });
          }}
          className="btn-primary"
        >
          <Icon name="plus" size={15} /> 添加供应商
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-ink-tertiary">加载中...</div>
      ) : (
        <div className="space-y-4">
          {/* New provider form */}
          {showNewForm && (
            <div className="card border-accent/30 bg-accent/[0.06] p-5 shadow-[0_0_0_1px_var(--color-accent)_inset]">
              <h3 className="font-semibold mb-4">新建供应商</h3>
              <ProviderForm
                form={editForm}
                onChange={setEditForm}
              />
              <div className="flex gap-2 justify-end mt-4">
                <button onClick={cancelEdit} className="btn-secondary btn-sm">取消</button>
                <button
                  onClick={handleCreate}
                  disabled={saving}
                  className="btn-primary btn-sm"
                >
                  {saving ? '保存中...' : '创建'}
                </button>
              </div>
            </div>
          )}

          {/* Existing providers */}
          {providers.map((p) => (
            <div key={p.id} className={`card p-5 ${editingId === p.id ? 'border-accent/40' : ''}`}>
              {editingId === p.id ? (
                <>
                  <h3 className="font-semibold mb-4">编辑: {p.name}</h3>
                  <ProviderForm
                    form={editForm}
                    onChange={setEditForm}
                  />
                  <div className="flex gap-2 justify-end mt-4">
                    <button onClick={cancelEdit} className="btn-secondary btn-sm">取消</button>
                    <button
                      onClick={() => handleSave(p.id)}
                      disabled={saving}
                      className="btn-primary btn-sm"
                    >
                      {saving ? '保存中...' : '保存'}
                    </button>
                  </div>
                </>
              ) : (
                <div>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="font-semibold">{p.name}</h3>
                        <span className={`status-badge ${p.hasApiKey ? 'status-succeeded' : 'status-failed'}`}>
                          <Icon name={p.hasApiKey ? 'key' : 'alert'} size={12} />
                          {p.hasApiKey ? '已配置 Key' : '未配置 Key'}
                        </span>
                        {!p.enabled && (
                          <span className="status-badge status-canceled">已禁用</span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm text-ink-secondary">
                        <div>
                          <span className="text-ink-tertiary">Base URL:</span>{' '}
                          <code className="rounded bg-surface-subtle px-1 text-xs">{p.baseUrl}</code>
                        </div>
                        <div>
                          <span className="text-ink-tertiary">模型:</span> {p.model}
                        </div>
                        <div>
                          <span className="text-ink-tertiary">类型:</span> {p.type}
                        </div>
                        <div>
                          <span className="text-ink-tertiary">预估成本:</span>{' '}
                          {p.defaultCostPerImage != null ? `¥${p.defaultCostPerImage}/张` : '未设置'}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 ml-4 justify-end">
                      <button
                        onClick={() => handleToggleEnabled(p.id, !p.enabled)}
                        disabled={saving}
                        className={p.enabled ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
                      >
                        {p.enabled ? '禁用' : '启用'}
                      </button>
                      <button
                        onClick={() => startEdit(p)}
                        disabled={saving}
                        className="btn-secondary btn-sm"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => handleDelete(p.id)}
                        disabled={saving}
                        className="icon-btn text-fail"
                        title="删除"
                        aria-label={`删除 ${p.name}`}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}

          {providers.length === 0 && !showNewForm && (
            <div className="flex flex-col items-center py-12 text-center text-ink-tertiary">
              <Icon name="settings" size={34} className="mb-2" />
              <p>暂无供应商配置</p>
              <p className="text-xs mt-1">点击「添加供应商」开始</p>
            </div>
          )}
        </div>
      )}

      {/* Security note */}
      <div className="mt-8 flex gap-2 rounded-[18px] bg-surface-subtle p-4 text-sm text-ink-secondary">
        <Icon name="key" size={16} className="mt-0.5 shrink-0 text-ink-tertiary" />
        <p><strong className="text-ink">安全提示：</strong>API Key 仅存储在本地 SQLite 数据库中，不会出现在前端页面和日志里。
        编辑时 Key 字段始终显示为空，只有输入新值才会更新。
        </p>
      </div>
    </div>
  );
}

/** Reusable provider form fields */
function ProviderForm({
  form,
  onChange,
}: {
  form: {
    name: string;
    baseUrl: string;
    model: string;
    type: string;
    apiKey: string;
    defaultCostPerImage: number;
    enabled: boolean;
  };
  onChange: (f: typeof form) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label className="label">名称</label>
        <input
          type="text"
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          className="input-field"
          placeholder="例如: Packy API"
        />
      </div>
      <div>
        <label className="label">Base URL</label>
        <input
          type="text"
          value={form.baseUrl}
          onChange={(e) => onChange({ ...form, baseUrl: e.target.value })}
          className="input-field font-mono text-xs"
          placeholder="https://api.example.com"
        />
      </div>
      <div>
        <label className="label">模型名</label>
        <input
          type="text"
          value={form.model}
          onChange={(e) => onChange({ ...form, model: e.target.value })}
          className="input-field"
          placeholder="gpt-image-2"
        />
      </div>
      <div>
        <label className="label">接口类型</label>
        <select
          value={form.type}
          onChange={(e) => onChange({ ...form, type: e.target.value })}
          className="input-field"
        >
          <option value="geekai-json">GeekAI (JSON + async polling)</option>
          <option value="packy-images">Packy Images API (multipart, no polling)</option>
          <option value="openai-compatible">OpenAI-compatible (multipart)</option>
        </select>
      </div>
      <div>
        <label className="label">API Key</label>
        <input
          type="password"
          value={form.apiKey}
          onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
          className="input-field font-mono"
          placeholder="留空则不修改；输入新 Key 以更新"
          autoComplete="off"
        />
        <p className="mt-1 text-xs text-ink-tertiary">
          密钥已保存时此处为空，不会回显
        </p>
      </div>
      <div>
        <label className="label">预估单张成本 (¥)</label>
        <input
          type="number"
          step="0.01"
          min="0"
          value={form.defaultCostPerImage}
          onChange={(e) => onChange({ ...form, defaultCostPerImage: parseFloat(e.target.value) || 0 })}
          className="input-field"
        />
      </div>
      <div className="flex items-end pb-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => onChange({ ...form, enabled: e.target.checked })}
            className="w-4 h-4 rounded border-hairline accent-accent"
          />
          <span className="text-sm text-ink-secondary">启用</span>
        </label>
      </div>
    </div>
  );
}
