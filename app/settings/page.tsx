'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';

type Category = 'image' | 'script' | 'video';

interface ImageProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  type: string;
  enabled: number;
  defaultCostPerImage?: number;
  hasApiKey: boolean;
}

interface ScriptProvider {
  id: string;
  name: string;
  category: 'script';
  type: string;
  model: string;
  apiStyle: string;
  enabled: number;
  configured: boolean;
  missing?: string[];
  hasApiKey: boolean;
  maxTokens?: number;
}

interface VideoProvider {
  id: string;
  name: string;
  category: 'video';
  type: 'kling' | 'jimeng';
  baseUrl: string;
  defaultModel: string;
  defaultDurationSec: number;
  enabled: number;
  configured: boolean;
  missing?: string[];
  hasApiKey: boolean;
}

type ProviderFormState = {
  name: string;
  type: string;
  apiStyle: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  accessKey: string;
  secretKey: string;
  enabled: boolean;
  defaultCostPerImage: number;
  defaultDurationSec: number;
  maxTokens: number;
};

const KEY_PLACEHOLDER = '••••••••';

const emptyForm: ProviderFormState = {
  name: '',
  type: 'openai-compatible',
  apiStyle: 'openai-compatible',
  baseUrl: '',
  model: '',
  apiKey: '',
  accessKey: '',
  secretKey: '',
  enabled: true,
  defaultCostPerImage: 0,
  defaultDurationSec: 5,
  maxTokens: 8192,
};

const sections: Array<{ id: Category; title: string; description: string; icon: IconName }> = [
  { id: 'image', title: '图片生成', description: '场景图、分镜图和图片重做供应商', icon: 'image' },
  { id: 'script', title: '脚本生成', description: '卖点分析和短视频脚本文案模型', icon: 'file-text' },
  { id: 'video', title: '视频生成', description: '可灵、即梦等图生视频供应商', icon: 'video' },
];

export default function SettingsPage() {
  const [active, setActive] = useState<Category>('image');
  const [imageProviders, setImageProviders] = useState<ImageProvider[]>([]);
  const [scriptProviders, setScriptProviders] = useState<ScriptProvider[]>([]);
  const [videoProviders, setVideoProviders] = useState<VideoProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ category: Category; id: string } | null>(null);
  const [creating, setCreating] = useState<Category | null>(null);
  const [form, setForm] = useState<ProviderFormState>(emptyForm);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [imageRes, scriptRes, videoRes] = await Promise.all([
        fetch('/api/providers'),
        fetch('/api/providers/script'),
        fetch('/api/providers/video?all=1'),
      ]);
      const [imageData, scriptData, videoData] = await Promise.all([
        imageRes.json().catch(() => []),
        scriptRes.json().catch(() => []),
        videoRes.json().catch(() => []),
      ]);
      if (Array.isArray(imageData)) setImageProviders(imageData);
      if (Array.isArray(scriptData)) setScriptProviders(scriptData);
      if (Array.isArray(videoData)) setVideoProviders(videoData);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, []);

  const beginCreate = (category: Category) => {
    setActive(category);
    setCreating(category);
    setEditing(null);
    setForm({
      ...emptyForm,
      type: category === 'image' ? 'openai-compatible' : category === 'video' ? 'jimeng' : 'openai-compatible',
      apiStyle: 'openai-compatible',
      model: category === 'image' ? 'gpt-image-2' : category === 'video' ? 'doubao-seedance-1-5-pro-251215' : 'gpt-4o',
    });
  };

  const beginEdit = (category: Category, provider: ImageProvider | ScriptProvider | VideoProvider) => {
    setActive(category);
    setCreating(null);
    setEditing({ category, id: provider.id });
    const hasKey = provider.hasApiKey;
    setForm({
      ...emptyForm,
      name: provider.name,
      type: provider.type,
      enabled: Boolean(provider.enabled),
      baseUrl: 'baseUrl' in provider ? provider.baseUrl : '',
      model: 'model' in provider ? provider.model : ('defaultModel' in provider ? provider.defaultModel : ''),
      apiStyle: 'apiStyle' in provider ? provider.apiStyle : 'openai-compatible',
      defaultCostPerImage: 'defaultCostPerImage' in provider ? provider.defaultCostPerImage || 0 : 0,
      defaultDurationSec: 'defaultDurationSec' in provider ? provider.defaultDurationSec || 5 : 5,
      maxTokens: 'maxTokens' in provider ? (provider as ScriptProvider).maxTokens || 8192 : 8192,
      apiKey: hasKey && provider.type !== 'kling' ? KEY_PLACEHOLDER : '',
      accessKey: hasKey && provider.type === 'kling' ? KEY_PLACEHOLDER : '',
      secretKey: hasKey && provider.type === 'kling' ? KEY_PLACEHOLDER : '',
    });
  };

  const cancelForm = () => {
    setCreating(null);
    setEditing(null);
    setForm(emptyForm);
  };

  const saveProvider = async (clearSecret = false) => {
    const category = creating || editing?.category;
    if (!category) return;
    setSaving(true);
    try {
      const body = buildPayload(category, clearSecret);
      const url = editing
        ? `/api/providers/${category === 'image' ? '' : `${category}/`}${editing.id}`
        : `/api/providers${category === 'image' ? '' : `/${category}`}`;
      const res = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        alert(data?.error || `保存失败：HTTP ${res.status}`);
        return;
      }
      cancelForm();
      await loadAll();
    } finally {
      setSaving(false);
    }
  };

  const buildPayload = (category: Category, clearSecret: boolean) => {
    const base = {
      name: form.name,
      type: form.type,
      enabled: form.enabled,
    };
    const realKey = (v: string) => {
      const t = v.trim();
      return t && t !== KEY_PLACEHOLDER ? t : '';
    };
    if (category === 'image') {
      return {
        ...base,
        baseUrl: form.baseUrl,
        model: form.model,
        defaultCostPerImage: form.defaultCostPerImage,
        ...(realKey(form.apiKey) || clearSecret ? { apiKey: clearSecret ? '' : realKey(form.apiKey) } : {}),
      };
    }
    if (category === 'script') {
      return {
        ...base,
        apiStyle: form.apiStyle,
        baseUrl: form.baseUrl,
        model: form.model,
        maxTokens: form.maxTokens,
        ...(realKey(form.apiKey) || clearSecret ? { apiKey: clearSecret ? '' : realKey(form.apiKey) } : {}),
      };
    }
    return {
      ...base,
      baseUrl: form.baseUrl,
      defaultModel: form.model,
      defaultDurationSec: form.defaultDurationSec,
      ...(form.type === 'kling'
        ? {
            ...(realKey(form.accessKey) || clearSecret ? { accessKey: clearSecret ? '' : realKey(form.accessKey) } : {}),
            ...(realKey(form.secretKey) || clearSecret ? { secretKey: clearSecret ? '' : realKey(form.secretKey) } : {}),
            ...(clearSecret ? { apiKey: '' } : {}),
          }
        : {
            ...(realKey(form.apiKey) || clearSecret ? { apiKey: clearSecret ? '' : realKey(form.apiKey) } : {}),
            ...(clearSecret ? { accessKey: '', secretKey: '' } : {}),
          }),
    };
  };

  const deleteProvider = async (category: Category, id: string) => {
    if (!confirm('确定删除这个供应商吗？')) return;
    const res = await fetch(`/api/providers/${category === 'image' ? '' : `${category}/`}${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      alert(data?.error || '删除失败');
      return;
    }
    await loadAll();
  };

  const toggleEnabled = async (category: Category, id: string, enabled: boolean) => {
    const res = await fetch(`/api/providers/${category === 'image' ? '' : `${category}/`}${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      alert(data?.error || '更新失败');
      return;
    }
    await loadAll();
  };

  const currentProviders =
    active === 'image' ? imageProviders : active === 'script' ? scriptProviders : videoProviders;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.02em]">供应商配置</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            管理图片、脚本和视频生成模型。所有密钥统一从这里配置，避免和环境变量产生冲突。
          </p>
        </div>
        <button onClick={() => beginCreate(active)} className="btn-primary shrink-0">
          <Icon name="plus" size={15} /> 添加供应商
        </button>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-2 md:grid-cols-3">
        {sections.map((section) => (
          <button
            key={section.id}
            onClick={() => setActive(section.id)}
            className={`rounded-[14px] border p-4 text-left transition-colors ${
              active === section.id
                ? 'border-accent/35 bg-accent-tint/10'
                : 'border-hairline bg-surface hover:border-accent/20'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-ink">
              <Icon name={section.icon} size={16} />
              {section.title}
            </div>
            <p className="mt-1 text-xs text-ink-tertiary">{section.description}</p>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-ink-tertiary">加载中...</div>
      ) : (
        <div className="space-y-4">
          {(creating === active || editing?.category === active) && (
            <div className="card border-accent/30 bg-accent/[0.04] p-5">
              <h3 className="mb-4 font-semibold">{creating ? '新建供应商' : '编辑供应商'}</h3>
              <ProviderForm category={active} form={form} onChange={setForm} />
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                {editing && (
                  <button onClick={() => void saveProvider(true)} disabled={saving} className="btn-secondary btn-sm text-fail">
                    清除密钥
                  </button>
                )}
                <button onClick={cancelForm} className="btn-secondary btn-sm">取消</button>
                <button onClick={() => void saveProvider(false)} disabled={saving} className="btn-primary btn-sm">
                  {saving ? '保存中...' : '保存'}
                </button>
              </div>
            </div>
          )}

          {currentProviders.map((provider) => (
            <ProviderCard
              key={provider.id}
              category={active}
              provider={provider}
              editing={editing?.id === provider.id && editing.category === active}
              onEdit={() => beginEdit(active, provider)}
              onToggle={() => void toggleEnabled(active, provider.id, !provider.enabled)}
              onDelete={() => void deleteProvider(active, provider.id)}
            />
          ))}

          {currentProviders.length === 0 && (
            <div className="flex flex-col items-center py-12 text-center text-ink-tertiary">
              <Icon name="settings" size={34} className="mb-2" />
              <p>暂无供应商配置</p>
              <p className="mt-1 text-xs">点击“添加供应商”开始。</p>
            </div>
          )}
        </div>
      )}

      <div className="mt-8 flex gap-2 rounded-[18px] bg-surface-subtle p-4 text-sm text-ink-secondary">
        <Icon name="lock" size={16} className="mt-0.5 shrink-0 text-ink-tertiary" />
        <p>
          <strong className="text-ink">安全提示：</strong>
          密钥只保存在本地 SQLite 中，前端只显示是否已配置。编辑时密钥框留空表示不修改，使用“清除密钥”才会删除本地保存的值。
        </p>
      </div>
    </div>
  );
}

function ProviderCard({
  category,
  provider,
  editing,
  onEdit,
  onToggle,
  onDelete,
}: {
  category: Category;
  provider: ImageProvider | ScriptProvider | VideoProvider;
  editing: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const configured = category === 'image'
    ? provider.hasApiKey
    : 'configured' in provider ? provider.configured : false;
  const missing = 'missing' in provider ? provider.missing || [] : [];
  const model = 'model' in provider ? provider.model : provider.defaultModel;
  const baseUrl = 'baseUrl' in provider ? provider.baseUrl : '';

  return (
    <div className={`card p-5 ${editing ? 'border-accent/40' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{provider.name}</h3>
            <span className={`status-badge ${configured ? 'status-succeeded' : 'status-failed'}`}>
              <Icon name={configured ? 'key' : 'alert'} size={12} />
              {configured ? '已配置' : '未配置'}
            </span>
            {!provider.enabled && <span className="status-badge status-canceled">已禁用</span>}
          </div>
          <div className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm text-ink-secondary sm:grid-cols-2">
            {baseUrl && (
              <div className="min-w-0">
                <span className="text-ink-tertiary">Base URL:</span>{' '}
                <code className="break-all rounded bg-surface-subtle px-1 text-xs">{baseUrl}</code>
              </div>
            )}
            <div><span className="text-ink-tertiary">模型:</span> {model || '-'}</div>
            <div><span className="text-ink-tertiary">类型:</span> {provider.type}</div>
            {category === 'image' && 'defaultCostPerImage' in provider && (
              <div><span className="text-ink-tertiary">成本:</span> ¥{provider.defaultCostPerImage || 0}/张</div>
            )}
            {category === 'video' && 'defaultDurationSec' in provider && (
              <div><span className="text-ink-tertiary">默认时长:</span> {provider.defaultDurationSec}s</div>
            )}
          </div>
          {missing.length > 0 && (
            <p className="mt-2 text-xs text-fail">缺少配置：{missing.join(', ')}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <button onClick={onToggle} className={provider.enabled ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}>
            {provider.enabled ? '禁用' : '启用'}
          </button>
          <button onClick={onEdit} className="btn-secondary btn-sm">编辑</button>
          <button onClick={onDelete} className="icon-btn text-fail" title="删除" aria-label={`删除 ${provider.name}`}>
            <Icon name="trash" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderForm({
  category,
  form,
  onChange,
}: {
  category: Category;
  form: ProviderFormState;
  onChange: (form: ProviderFormState) => void;
}) {
  const isVideoKling = category === 'video' && form.type === 'kling';

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="名称">
        <input value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} className="input-field" placeholder="例如：Packy API" />
      </Field>

      <Field label="接口类型">
        <select value={form.type} onChange={(e) => onChange({ ...form, type: e.target.value })} className="input-field">
          {category === 'image' && (
            <>
              <option value="geekai-json">GeekAI (JSON + async polling)</option>
              <option value="packy-images">Packy Images API</option>
              <option value="packy-gemini-image">Gemini Image API</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </>
          )}
          {category === 'script' && (
            <>
              <option value="gemini">Gemini</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </>
          )}
          {category === 'video' && (
            <>
              <option value="jimeng">即梦 / Seedance</option>
              <option value="kling">可灵</option>
            </>
          )}
        </select>
      </Field>

      {category === 'script' && (
        <Field label="API 风格">
          <select value={form.apiStyle} onChange={(e) => onChange({ ...form, apiStyle: e.target.value })} className="input-field">
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="native-gemini">Native Gemini</option>
          </select>
        </Field>
      )}

      <Field label="Base URL">
        <input value={form.baseUrl} onChange={(e) => onChange({ ...form, baseUrl: e.target.value })} className="input-field font-mono text-xs" placeholder="https://api.example.net" />
      </Field>

      <Field label={category === 'video' ? '默认模型' : '模型名'}>
        <input value={form.model} onChange={(e) => onChange({ ...form, model: e.target.value })} className="input-field" placeholder="gpt-4o / kling-v3" />
      </Field>

      {isVideoKling ? (
        <>
          <Field label="Access Key">
            <input type="password" value={form.accessKey} onChange={(e) => onChange({ ...form, accessKey: e.target.value })} className="input-field font-mono" autoComplete="off" placeholder="留空则不修改" />
          </Field>
          <Field label="Secret Key">
            <input type="password" value={form.secretKey} onChange={(e) => onChange({ ...form, secretKey: e.target.value })} className="input-field font-mono" autoComplete="off" placeholder="留空则不修改" />
          </Field>
        </>
      ) : (
        <Field label="API Key">
          <input type="password" value={form.apiKey} onChange={(e) => onChange({ ...form, apiKey: e.target.value })} className="input-field font-mono" autoComplete="off" placeholder="留空则不修改" />
        </Field>
      )}

      {category === 'image' && (
        <Field label="预估单张成本 (¥)">
          <input type="number" min="0" step="0.01" value={form.defaultCostPerImage} onChange={(e) => onChange({ ...form, defaultCostPerImage: Number(e.target.value) || 0 })} className="input-field" />
        </Field>
      )}

      {category === 'script' && (
        <Field label="最大输出 Token">
          <input type="number" min="512" step="512" value={form.maxTokens} onChange={(e) => onChange({ ...form, maxTokens: Number(e.target.value) || 8192 })} className="input-field" />
        </Field>
      )}

      {category === 'video' && (
        <Field label="默认时长 (秒)">
          <input type="number" min="2" max="15" value={form.defaultDurationSec} onChange={(e) => onChange({ ...form, defaultDurationSec: Number(e.target.value) || 5 })} className="input-field" />
        </Field>
      )}

      <div className="flex items-end pb-2">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={form.enabled} onChange={(e) => onChange({ ...form, enabled: e.target.checked })} className="h-4 w-4 rounded border-hairline accent-accent" />
          <span className="text-sm text-ink-secondary">启用</span>
        </label>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}
