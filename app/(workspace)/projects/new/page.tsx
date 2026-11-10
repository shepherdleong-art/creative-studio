'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ProviderSettings from '@/components/ProviderSettings';
import PageToolbar from '@/components/team/PageToolbar';
import { GroupList, GroupRow } from '@/components/ui/Appearance';
import { getImageModelCapabilities } from '@/lib/image-model-capabilities';
import { GPT_IMAGE_2_SIZE_MAP, resolveGptImage2Size } from '@/lib/gpt-image-2-size-presets';
import { companyImageCapsForModel } from '@/lib/company-gateway-size';
import { getSupportedImageAspectRatios, getSupportedImageResolutions } from '@/lib/image-generation-settings';
import {
  UNIFIED_IMAGE_MODEL_KEY,
  unifiedImageAspectRatios,
  unifiedImageResolutionsForRatio,
} from '@/lib/media-core/unified-media/catalog';
import { resolveUnifiedImageOutput } from '@/lib/media-core/unified-media/requests';
import {
  STORE_CODES,
  PRODUCTION_TYPES,
  buildProjectBaseName,
  formatShanghaiIdentityDate,
} from '@/lib/project-production-identity';
import { FIRST_STEP_EMPTY_HINT, REMOVED_NEW_PROJECT_CONTROLS, validateNewProjectDraft, type NewProjectDraft } from '@/lib/new-project-form';
import type { WorkspaceRole } from '@/lib/workspace-navigation';

interface Provider {
  id: string; name: string; model: string; type: string; hasApiKey?: boolean;
}

interface SessionUser { displayName: string; role: WorkspaceRole }

type Draft = NewProjectDraft;

const EMPTY_DRAFT: Draft = { storeCode: '', productCode: '', productSubmodel: '', productionType: '', editorName: '' };

/**
 * 新建项目（06 号票）。
 *
 * 只留「员工要决定的事」：店铺 / 型号 / 子型号 / 生产类型 / 剪辑师（默认当前登录人），
 * 以及图片的模型 / 画面比例 / 清晰度 / 质量。超时、并发、图片预处理四个控件已拿掉——
 * 团队版由服务器统一管理（见 `lib/team-service/production-defaults.ts`），
 * 请求里也不再发送这些字段。
 *
 * 项目名按服务器的规则实时预览；输入框保持受控 + 稳定 key，打字不丢焦点。
 */
export default function NewProjectPage() {
  const router = useRouter();

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [session, setSession] = useState<SessionUser | null>(null);

  // 剪辑师默认当前登录人；用户改过之后不再覆盖。
  const [editorTouched, setEditorTouched] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/team/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { authenticated?: boolean; user?: { displayName?: string; role?: WorkspaceRole } } | null) => {
        if (cancelled || !body?.authenticated || !body.user) return;
        setSession({ displayName: body.user.displayName ?? '', role: body.user.role ?? 'employee' });
        setDraft((current) => (current.editorName.trim() ? current : { ...current, editorName: body.user?.displayName ?? '' }));
      })
      .catch(() => { /* 读不到会话时按员工渲染，剪辑师留空由校验提示兜住 */ });
    return () => { cancelled = true; };
  }, []);

  const previewDate = useMemo(() => formatShanghaiIdentityDate(new Date()), []);
  const namePreview = useMemo(() => {
    if (!draft.storeCode || !draft.productCode.trim() || !draft.productionType || !draft.editorName.trim()) return '';
    try {
      return buildProjectBaseName({
        namingDate: previewDate,
        storeCode: draft.storeCode,
        productCode: draft.productCode.trim(),
        productSubmodel: draft.productSubmodel.trim(),
        productionType: draft.productionType,
        editorName: draft.editorName.trim(),
      });
    } catch {
      return '';
    }
  }, [draft, previewDate]);

  // ── Provider / Model ──
  const [provider, setProvider] = useState<Provider | null>(null);
  const [model, setModel] = useState('gpt-image-2');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [resolution, setResolution] = useState('1k');
  const [quality, setQuality] = useState('medium');

  const unifiedSelected = provider?.type === 'unified-image' && provider.model === UNIFIED_IMAGE_MODEL_KEY;
  const modelCapabilities = useMemo(() => getImageModelCapabilities(model), [model]);
  const supportsQuality = !unifiedSelected && modelCapabilities.supportsQuality;
  const companyCaps = useMemo(() => companyImageCapsForModel(model), [model]);
  const nativePixelUi = unifiedSelected || !!companyCaps?.nativeDelivery;
  const aspectRatioOptions = useMemo(
    () => unifiedSelected ? unifiedImageAspectRatios() : getSupportedImageAspectRatios(model),
    [model, unifiedSelected],
  );
  const selectedAspectRatio = aspectRatioOptions.includes(aspectRatio)
    ? aspectRatio
    : (aspectRatioOptions.includes('1:1') ? '1:1' : aspectRatioOptions[0] || '1:1');
  const availableResolutions = useMemo(
    () => unifiedSelected
      ? unifiedImageResolutionsForRatio(selectedAspectRatio)
      : getSupportedImageResolutions(model, selectedAspectRatio),
    [model, selectedAspectRatio, unifiedSelected],
  );
  const selectedResolution = availableResolutions.includes(resolution) ? resolution : availableResolutions[0] || '1k';
  const size = useMemo(() => {
    try {
      return unifiedSelected
        ? resolveUnifiedImageOutput(selectedResolution, selectedAspectRatio).size
        : resolveGptImage2Size(selectedAspectRatio, selectedResolution);
    }
    catch { return ''; }
  }, [selectedAspectRatio, selectedResolution, unifiedSelected]);

  const [creating, setCreating] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const effectiveQuality = supportsQuality ? quality : 'auto';
  const validation = validateNewProjectDraft(draft, provider);
  // 只在「点过创建」或「已经开始填」之后提示，避免一进页面就红一片。
  const started = submitted || Boolean(draft.storeCode || draft.productCode.trim() || draft.productionType);
  const hint = started ? validation.message : '';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setSubmitError('');
    if (validation.missing.length > 0) return;
    setCreating(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeCode: draft.storeCode,
          productCode: draft.productCode.trim(),
          productSubmodel: draft.productSubmodel.trim(),
          productionType: draft.productionType,
          editorName: draft.editorName.trim(),
          workflowType: 'complex_product',
          providerId: provider!.id,
          model,
          size,
          quality: effectiveQuality,
          aspectRatio: selectedAspectRatio,
          resolution: selectedResolution,
        }),
      });
      const data = await res.json() as { id?: string; message?: string; error?: string };
      if (data.id) {
        router.push(`/projects/${data.id}`);
        return;
      }
      setSubmitError(data.message || data.error || '创建失败，请稍后重试。');
    } catch (error) {
      setSubmitError(`创建失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCreating(false);
    }
  };

  const providerLocksModel = provider?.type === 'packy-images' || provider?.type === 'packy-gemini-image';

  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
    <PageToolbar
      role={session?.role ?? 'employee'}
      title="新建项目"
      subtitle="填完生产身份和图片参数就能开工；生产参数由服务器统一管理，这里不用填。"
    />

    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <section>
        <h2 className="mb-2 px-1 text-label font-semibold text-ink-secondary">生产身份</h2>
        <GroupList>
          <GroupRow label="店铺" hint="必填">
            <select
              aria-label="店铺"
              value={draft.storeCode}
              onChange={(event) => setDraft((current) => ({ ...current, storeCode: event.target.value }))}
              className="input-field w-52"
            >
              <option value="">请选择</option>
              {STORE_CODES.map((store) => <option key={store} value={store}>{store}</option>)}
            </select>
          </GroupRow>
          <GroupRow label="型号" hint="必填，例如 XQ9A 或 PC672-A">
            <input
              aria-label="型号"
              type="text"
              value={draft.productCode}
              onChange={(event) => setDraft((current) => ({ ...current, productCode: event.target.value }))}
              className="input-field w-52"
              placeholder="例如 XQ9A"
            />
          </GroupRow>
          <GroupRow label="子型号" hint="可选">
            <input
              aria-label="子型号"
              type="text"
              value={draft.productSubmodel}
              onChange={(event) => setDraft((current) => ({ ...current, productSubmodel: event.target.value }))}
              className="input-field w-52"
              placeholder="可选"
            />
          </GroupRow>
          <GroupRow label="生产类型" hint="必填">
            <select
              aria-label="生产类型"
              value={draft.productionType}
              onChange={(event) => setDraft((current) => ({ ...current, productionType: event.target.value }))}
              className="input-field w-52"
            >
              <option value="">请选择</option>
              {PRODUCTION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </GroupRow>
          <GroupRow label="剪辑师" hint="默认当前登录人">
            <input
              aria-label="剪辑师"
              type="text"
              value={draft.editorName}
              onChange={(event) => {
                setEditorTouched(true);
                setDraft((current) => ({ ...current, editorName: event.target.value }));
              }}
              className="input-field w-52"
              placeholder="例如 紫菜卷"
            />
          </GroupRow>
          <GroupRow label="项目名称" hint="按「日期-店铺-型号-生产类型-剪辑师」由系统生成">
            <span
              className="block max-w-[22rem] truncate text-ink"
              data-testid="project-name-preview"
              title={namePreview}
            >
              {namePreview || <span className="text-ink-tertiary">填完生产身份后自动生成</span>}
            </span>
          </GroupRow>
        </GroupList>
        {!editorTouched && session?.displayName ? <p className="mt-2 px-1 text-label text-ink-tertiary">剪辑师已填成你（{session.displayName}），可以直接改。</p> : null}
      </section>

      <section>
        <h2 className="mb-2 px-1 text-label font-semibold text-ink-secondary">图片参数</h2>
        <GroupList>
          <GroupRow label="模型">
            {unifiedSelected ? (
              <select aria-label="模型" value={UNIFIED_IMAGE_MODEL_KEY} disabled className="input-field w-52">
                <option value={UNIFIED_IMAGE_MODEL_KEY}>Image 2</option>
              </select>
            ) : (
              <input
                aria-label="模型"
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                readOnly={providerLocksModel}
                className="input-field w-52"
              />
            )}
          </GroupRow>
          <GroupRow label="画面比例">
            <select
              aria-label="画面比例"
              value={selectedAspectRatio}
              onChange={(event) => {
                const next = event.target.value;
                setAspectRatio(next);
                const available = unifiedSelected
                  ? unifiedImageResolutionsForRatio(next)
                  : getSupportedImageResolutions(model, next);
                if (!available.includes(resolution)) setResolution(available[0] || '1k');
              }}
              className="input-field w-52"
            >
              {aspectRatioOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </GroupRow>
          {selectedAspectRatio !== 'auto' && <GroupRow label="清晰度" hint={nativePixelUi ? '公司网关按原生像素交付，保证比例与档位' : undefined}>
            <select
              aria-label="清晰度"
              value={selectedResolution}
              onChange={(event) => setResolution(event.target.value)}
              className="input-field w-52"
            >
              {availableResolutions.map((value) => {
                const presetSize = GPT_IMAGE_2_SIZE_MAP[selectedAspectRatio]?.[value];
                const label = !presetSize ? `${value} — 不支持` : (nativePixelUi ? value : `${value} → ${presetSize}`);
                return <option key={value} value={value} disabled={!presetSize}>{label}</option>;
              })}
            </select>
          </GroupRow>}
          {supportsQuality && <GroupRow label="质量">
            <select aria-label="质量" value={quality} onChange={(event) => setQuality(event.target.value)} className="input-field w-52">
              <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
            </select>
          </GroupRow>}
        </GroupList>
        <p className="mt-2 px-1 text-label text-ink-tertiary">
          {supportsQuality ? '以上为参考价格，实际以中转站后台扣费为准。' : '当前模型不支持质量参数，实际扣费以供应商后台为准。'}
        </p>
      </section>

      <ProviderSettings
        selectedId={provider?.id}
        onSelect={(next) => {
          setProvider(next);
          setModel(next.model);
          if (next.type === 'unified-image') setResolution('2k');
        }}
      />

      <div className="flex flex-wrap items-center justify-end gap-3">
        {/* 校验提示写在按钮旁，不用浏览器弹窗。 */}
        <p
          className={`mr-auto text-label ${validation.missing.length > 0 && started ? 'text-warn' : 'text-ink-tertiary'}`}
          role={validation.missing.length > 0 && started ? 'alert' : undefined}
          data-testid="new-project-hint"
        >
          {submitError
            ? <span className="text-fail">{submitError}</span>
            : hint || (namePreview ? `创建后会直接进入第 1 步：${FIRST_STEP_EMPTY_HINT}` : '填完生产身份后，这里会显示项目名。')}
        </p>
        <Link href="/" className="cap">取消</Link>
        <button type="submit" disabled={creating} className="cap cap-primary" data-testid="new-project-submit">
          {creating ? '创建中…' : '创建项目'}
        </button>
      </div>
    </form>
  </div>;
}

/** 供页面级测试断言：新建项目页不得再出现这四个控件。 */
export const NEW_PROJECT_REMOVED_CONTROLS = REMOVED_NEW_PROJECT_CONTROLS;

/** 空状态文案（创建后第 1 步用）：告诉用户先放一张原始场景图。 */
export function firstStepEmptyHint(): string {
  return FIRST_STEP_EMPTY_HINT;
}
