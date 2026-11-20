'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import PageToolbar from '@/components/team/PageToolbar';
import { GroupList, GroupRow } from '@/components/ui/Appearance';
import {
  STORE_CODES,
  PRODUCTION_TYPES,
  buildProjectBaseName,
  formatShanghaiIdentityDate,
} from '@/lib/project-production-identity';
import type { WorkspaceRole } from '@/lib/workspace-navigation';

interface Provider {
  id: string;
  name: string;
  model: string;
  type: string;
  hasApiKey?: boolean;
  enabled?: number | boolean;
}

interface SessionUser { displayName: string; role: WorkspaceRole }

/**
 * 一键成片 · 第一步：创建项目。
 *
 * 只收四项项目信息（店铺、型号、类型、剪辑师），项目名按工作台既有规则实时预览。
 * 数量在脚本页决定，视频参数在生成页决定，这里不出现。
 */
export default function OneClickFilmNewPage() {
  const router = useRouter();
  const [storeCode, setStoreCode] = useState('');
  const [productCode, setProductCode] = useState('');
  const [productionType, setProductionType] = useState('');
  const [editorName, setEditorName] = useState('');
  const [session, setSession] = useState<SessionUser | null>(null);
  const [editorTouched, setEditorTouched] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/team/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { authenticated?: boolean; user?: { displayName?: string; role?: WorkspaceRole } } | null) => {
        if (cancelled || !body?.authenticated || !body.user) return;
        setSession({ displayName: body.user.displayName ?? '', role: body.user.role ?? 'employee' });
        setEditorName((current) => (current.trim() ? current : body.user?.displayName ?? ''));
      })
      .catch(() => {});
    void fetch('/api/providers', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : []))
      .then((list: Provider[]) => setProviders(Array.isArray(list) ? list : []))
      .catch(() => setProviders([]));
    return () => { cancelled = true; };
  }, []);

  const previewDate = useMemo(() => formatShanghaiIdentityDate(new Date()), []);
  const namePreview = useMemo(() => {
    if (!storeCode || !productCode.trim() || !productionType || !editorName.trim()) return '';
    try {
      return buildProjectBaseName({
        namingDate: previewDate,
        storeCode,
        productCode: productCode.trim(),
        productSubmodel: '',
        productionType,
        editorName: editorName.trim(),
      });
    } catch {
      return '';
    }
  }, [storeCode, productCode, productionType, editorName, previewDate]);

  const missing = [
    !storeCode ? '店铺' : '',
    !productCode.trim() ? '型号' : '',
    !productionType ? '生产类型' : '',
    !editorName.trim() ? '剪辑师' : '',
  ].filter(Boolean);
  const started = submitted || Boolean(storeCode || productCode.trim() || productionType);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setError('');
    if (missing.length > 0) return;
    const provider = providers.find((item) => item.enabled !== false && item.enabled !== 0 && item.hasApiKey);
    if (!provider) {
      setError('还没有可用的图片供应商，请先在供应商配置里填好 API Key。');
      return;
    }
    setCreating(true);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeCode,
          productCode: productCode.trim(),
          productSubmodel: '',
          productionType,
          editorName: editorName.trim(),
          workflowType: 'one_click_film',
          providerId: provider.id,
          model: provider.model,
          aspectRatio: '1:1',
          resolution: '1k',
        }),
      });
      const body = await response.json() as { id?: string; message?: string; error?: string };
      if (body.id) {
        router.push(`/one-click-film/${body.id}`);
        return;
      }
      setError(body.message || body.error || '创建失败，请稍后重试。');
    } catch (cause) {
      setError(`创建失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setCreating(false);
    }
  };

  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
    <PageToolbar
      role={session?.role ?? 'employee'}
      title="一键成片"
      subtitle="填完四项项目信息就能开工；数量在脚本页决定，视频参数在生成页决定。"
    />

    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <section>
        <h2 className="mb-2 px-1 text-label font-semibold text-ink-secondary">项目信息</h2>
        <GroupList>
          <GroupRow label="店铺" hint="必填">
            <select aria-label="店铺" value={storeCode} onChange={(event) => setStoreCode(event.target.value)} className="input-field w-52">
              <option value="">请选择</option>
              {STORE_CODES.map((store) => <option key={store} value={store}>{store}</option>)}
            </select>
          </GroupRow>
          <GroupRow label="型号" hint="必填，例如 XQ9A">
            <input aria-label="型号" type="text" value={productCode} onChange={(event) => setProductCode(event.target.value)} className="input-field w-52" placeholder="例如 XQ9A" />
          </GroupRow>
          <GroupRow label="类型" hint="必填">
            <select aria-label="类型" value={productionType} onChange={(event) => setProductionType(event.target.value)} className="input-field w-52">
              <option value="">请选择</option>
              {PRODUCTION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </GroupRow>
          <GroupRow label="剪辑师" hint="默认当前登录人">
            <input
              aria-label="剪辑师"
              type="text"
              value={editorName}
              onChange={(event) => { setEditorTouched(true); setEditorName(event.target.value); }}
              className="input-field w-52"
              placeholder="例如 紫菜卷"
            />
          </GroupRow>
          <GroupRow label="项目名称" hint="按「日期-店铺-型号-类型-剪辑师」自动生成">
            <span className="block max-w-[22rem] truncate text-ink" data-testid="one-click-film-name-preview" title={namePreview}>
              {namePreview || <span className="text-ink-tertiary">填完项目信息后自动生成</span>}
            </span>
          </GroupRow>
        </GroupList>
        {!editorTouched && session?.displayName ? <p className="mt-2 px-1 text-label text-ink-tertiary">剪辑师已填成你（{session.displayName}），可以直接改。</p> : null}
      </section>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className={`mr-auto text-label ${missing.length > 0 && started ? 'text-warn' : 'text-ink-tertiary'}`} role={missing.length > 0 && started ? 'alert' : undefined}>
          {error
            ? <span className="text-fail">{error}</span>
            : missing.length > 0 && started
              ? `还差${missing.join('、')}，填完就能创建。`
              : namePreview ? '创建后会直接进入上传素材。' : '填完项目信息后，这里会显示项目名。'}
        </p>
        <Link href="/" className="cap">取消</Link>
        <button type="submit" disabled={creating} className="cap cap-primary" data-testid="one-click-film-create">
          {creating ? '创建中…' : '创建并准备素材'}
        </button>
      </div>
    </form>
  </div>;
}
