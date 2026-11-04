'use client';

import { useState, type FormEvent } from 'react';
import { teamError, teamWrite } from './client';

const PUBLISHABLE: Array<{ value: string; label: string }> = [
  { value: 'bgm', label: 'BGM 曲目' },
  { value: 'video_prompt_template', label: '视频提示词模板' },
  { value: 'title_preset', label: '标题预设' },
  { value: 'lut', label: 'LUT' },
  { value: 'script_catalog', label: '脚本目录' },
  { value: 'script_catalog_revision', label: '脚本目录修订' },
  { value: 'script_template_asset', label: '模板素材' },
  { value: 'viral_template_library', label: '爆文模板库' },
  { value: 'viral_template_revision', label: '爆文模板修订' },
  { value: 'viral_template_entry', label: '爆文模板条目' },
];

export default function TeamPublicResourcesPanel() {
  const [resourceType, setResourceType] = useState(PUBLISHABLE[0].value);
  const [resourceId, setResourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function publish(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await teamWrite('/api/team/public-resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceType, resourceId: resourceId.trim() }),
      });
      if (!response.ok) throw new Error(await teamError(response, '公共资源发布失败'));
      setNotice(`已发布 ${resourceId.trim()}；员工可见范围由资源权限决定，版本仍以各自修订记录为准。`);
      setResourceId('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公共资源发布失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">公共资源发布</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          把已有资源登记为团队公共可见。发布走真实 API 与资源归属校验；不复制文件、不改变已有版本。
          不存在的资源类型会明确拒绝，不会显示模拟成功。
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      {notice && <p role="status" className="text-sm text-ok">{notice}</p>}

      <section className="card p-6">
        <h2 className="mb-5 text-lg font-semibold text-ink">发布已有资源</h2>
        <form onSubmit={publish} className="grid gap-4 md:grid-cols-[220px_1fr_auto] md:items-end">
          <label>
            <span id="public-resource-type-label" className="label">资源类型</span>
            <select aria-labelledby="public-resource-type-label" className="input-field" value={resourceType} onChange={(event) => setResourceType(event.target.value)}>
              {PUBLISHABLE.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span className="label">资源 ID</span>
            <input className="input-field font-mono" value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder="从对应资源列表复制 ID" required />
          </label>
          <button className="btn-primary" disabled={busy || !resourceId.trim()} type="submit">发布为公共资源</button>
        </form>
        <p className="mt-4 text-xs leading-5 text-ink-tertiary">
          公共资源只在 server 模式可用；本机字体、打包模板等入口在 server 模式下保持禁用。
        </p>
      </section>
    </div>
  );
}
