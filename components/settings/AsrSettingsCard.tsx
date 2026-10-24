'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

/**
 * 实拍混剪 · 原声转写（ASR）设置卡片。
 *
 * 刻意与「口播配音」的 TtsProviderSettingsCard 保持同一套骨架：card → 标题行
 * （名称 + 状态徽章 / 启用开关）→ Field 网格 → 底部操作行。样式全部复用
 * globals.css 里的 input-field / label / btn-* 令牌，不引入新的视觉语言。
 */
const KEY_PLACEHOLDER = '••••••••';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

interface AsrProvider {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  resourceId: string;
  model: string;
  enabled: boolean;
  isBuiltin: boolean;
  keyEnv: string;
  hasApiKey: boolean;
  configured: boolean;
  keySource: 'database' | 'env' | null;
}

const RESOURCE_ID_HINT: Array<{ value: string; label: string }> = [
  { value: 'volc.seedasr.auc', label: 'volc.seedasr.auc（SeedASR）' },
  { value: 'volc.bigasr.auc_turbo', label: 'volc.bigasr.auc_turbo（录音文件极速版）' },
  { value: 'volc.bigasr.auc', label: 'volc.bigasr.auc（录音文件标准版）' },
];

export default function AsrSettingsCard() {
  const [provider, setProvider] = useState<AsrProvider | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [model, setModel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/providers/asr');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || '读取语音识别设置失败');
      const next = body.provider as AsrProvider;
      setProvider(next);
      setBaseUrl(next.baseUrl);
      setResourceId(next.resourceId);
      setModel(next.model);
      setEnabled(Boolean(next.enabled));
      setApiKey(next.hasApiKey ? KEY_PLACEHOLDER : '');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const save = async (clear = false) => {
    setSaving(true); setMessage(''); setTestResult(null);
    try {
      const response = await fetch('/api/providers/asr', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey: clear ? '' : apiKey, resourceId, model, enabled }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || '保存失败');
      setMessage('已保存');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  /** 真实调用一次火山接口，确认 Key 与 Resource-Id 都对得上，而不是只看「有没有填」。 */
  const test = async () => {
    setTesting(true); setTestResult(null); setMessage('');
    try {
      const response = await fetch('/api/providers/asr/test', { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || '测试失败');
      setTestResult(body.ok
        ? { ok: true, text: `连通正常，识别到：「${String(body.text ?? '').slice(0, 60)}」` }
        : { ok: false, text: body.message || '测试未通过' });
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="card p-8 text-center text-sm text-ink-tertiary">正在加载语音识别设置…</div>;
  if (!provider) return <div className="card p-5 text-sm text-fail">{message || '语音识别设置不可用'}</div>;

  const keySourceLabel = provider.keySource === 'database' ? '设置页填写'
    : provider.keySource === 'env' ? `环境变量 ${provider.keyEnv}` : '未配置';
  const isSeedAsr = resourceId === 'volc.seedasr.auc';

  return <div className="card p-5">
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{provider.name}</h3>
          <span className={`status-badge ${provider.configured ? 'status-succeeded' : 'status-failed'}`}>
            {provider.configured ? '已配置' : '未配置'}
          </span>
        </div>
        <p className="mt-1 text-xs text-ink-tertiary">
          实拍混剪把原片人声转成逐字时间轴，用来对齐新配音与画面节奏。未配置时原片台词无法自动核对，请在检查成片时人工核对。
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="accent-accent" />
        启用
      </label>
    </div>

    <div className="mt-5 grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field label="Base URL">
          <input
            className="input-field font-mono text-xs"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
            spellCheck={false}
          />
        </Field>
      </div>

      <Field label="API Key">
        <input
          type="password"
          className="input-field font-mono"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="留空则不修改"
          autoComplete="off"
        />
      </Field>

      <Field label="Resource Id">
        <select
          className="input-field font-mono text-xs"
          value={RESOURCE_ID_HINT.some((option) => option.value === resourceId) ? resourceId : '__custom__'}
          onChange={(event) => setResourceId(event.target.value === '__custom__' ? '' : event.target.value)}
        >
          {RESOURCE_ID_HINT.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
          <option value="__custom__">自定义…</option>
        </select>
      </Field>

      {!RESOURCE_ID_HINT.some((option) => option.value === resourceId) && (
        <Field label="自定义 Resource Id">
          <input className="input-field font-mono text-xs" value={resourceId}
            onChange={(event) => setResourceId(event.target.value)} spellCheck={false} />
        </Field>
      )}

      <Field label="模型名">
        <input className="input-field font-mono text-xs" value={model}
          onChange={(event) => setModel(event.target.value)} spellCheck={false} />
      </Field>

      <div>
        <label className="label">Key 来源</label>
        <p className="rounded-xl bg-surface-subtle px-3 py-2.5 text-sm text-ink-secondary">
          {keySourceLabel}
          {provider.keySource === 'env' && <span className="text-ink-tertiary">（在此填写会覆盖）</span>}
        </p>
      </div>
    </div>

    <div className="mt-4 flex items-center justify-between gap-3">
      <p className={`text-sm ${testResult ? (testResult.ok ? 'text-ok' : 'text-fail') : message === '已保存' ? 'text-ok' : 'text-fail'}`}>
        {testResult ? testResult.text : message}
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary btn-sm" disabled={testing || saving} onClick={() => void test()}>
          {testing ? '测试中…' : '测试连通'}
        </button>
        {provider.hasApiKey && (
          <button type="button" className="btn-secondary btn-sm text-fail" disabled={saving} onClick={() => void save(true)}>清除密钥</button>
        )}
        <button type="button" className="btn-primary btn-sm" disabled={saving} onClick={() => void save(false)}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>

    <p className="mt-4 border-t border-hairline pt-3 text-xs text-ink-tertiary">
      {isSeedAsr
        ? '当前使用 SeedASR。火山同一个 Key 只授权部分资源，Resource-Id 必须与已开通的服务一致，否则会返回 45000030。'
        : '换 Resource-Id 前请确认该服务已在火山智能语音控制台开通；未开通会返回 45000030。'}
    </p>
  </div>;
}
