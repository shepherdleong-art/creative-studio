'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ProviderSettings from '@/components/ProviderSettings';
import ImageUploader from '@/components/ImageUploader';
import type { UploadedFile } from '@/components/ImageUploader';
import {
  GPT_IMAGE_2_ASPECT_RATIOS,
  GPT_IMAGE_2_RESOLUTIONS,
  GPT_IMAGE_2_SIZE_MAP,
  resolveGptImage2Size,
} from '@/lib/gpt-image-2-size-presets';

const PRICE_TABLE: Record<string, Record<string, number>> = {
  low: {
    '1024x1024':0.045, '1248x832':0.036, '832x1248':0.036, '1152x864':0.036, '864x1152':0.036,
    '1120x896':0.036, '896x1120':0.036, '1280x720':0.036, '720x1280':0.036,
    '2048x1024':0.09, '1024x2048':0.09, '1456x624':0.036, '624x1456':0.036,
  },
  medium: {
    '1024x1024':0.398, '1248x832':0.311, '832x1248':0.311, '1152x864':0.311, '864x1152':0.311,
    '1120x896':0.311, '896x1120':0.311, '1280x720':0.32, '720x1280':0.32,
    '2048x2048':0.808, '2496x1664':0.808, '1664x2496':0.808, '2304x1728':0.808, '1728x2304':0.808,
    '2240x1792':0.808, '1792x2240':0.808, '2560x1440':0.808, '1440x2560':0.808,
    '2688x1344':0.808, '1344x2688':0.808, '3024x1296':0.808, '1296x3024':0.808,
  },
  high: {
    '1024x1024':1.59, '1248x832':1.24, '832x1248':1.24, '1152x864':1.24, '864x1152':1.24,
    '1120x896':1.24, '896x1120':1.24, '1280x720':1.28, '720x1280':1.28,
    '2048x2048':3.231, '2496x1664':3.231, '1664x2496':3.231, '2304x1728':3.231, '1728x2304':3.231,
    '2240x1792':3.231, '1792x2240':3.231, '2560x1440':3.231, '1440x2560':3.231,
    '2688x1344':3.231, '1344x2688':3.231, '3024x1296':3.231, '1296x3024':3.231,
  },
};

function getEstimatedCost(size: string, quality: string): number {
  return PRICE_TABLE[quality]?.[size] ?? 0;
}

interface Provider {
  id: string; name: string; model: string; type: string; hasApiKey?: boolean; defaultCostPerImage?: number;
}

export default function NewProjectPage() {
  const router = useRouter();

  // ── Project info ──
  const [name, setName] = useState('');
  const [productName, setProductName] = useState('');
  const [productCode, setProductCode] = useState('');
  const [category, setCategory] = useState('');
  const [workflowType, setWorkflowType] = useState<'complex_product' | 'legacy_batch_edit'>('complex_product');

  // ── Provider / Model ──
  const [provider, setProvider] = useState<Provider | null>(null);
  const [model, setModel] = useState('gpt-image-2');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [resolution, setResolution] = useState('1k');
  const [quality, setQuality] = useState('medium');
  const [timeoutMs, setTimeoutMs] = useState(600000);
  const [generationCount, setGenerationCount] = useState(1);

  const size = useMemo(() => {
    try { return resolveGptImage2Size(aspectRatio, resolution); }
    catch { return ''; }
  }, [aspectRatio, resolution]);

  // ── Preprocessing ──
  const [preprocessEnabled, setPreprocessEnabled] = useState(true);
  const [targetMaxSide, setTargetMaxSide] = useState(1536);
  const [jpegQuality, setJpegQuality] = useState(85);

  // ── Legacy fields ──
  const [legacyPrompt, setLegacyPrompt] = useState('');
  const [legacyNegativePrompt, setLegacyNegativePrompt] = useState('');
  const [legacyRefFiles, setLegacyRefFiles] = useState<UploadedFile[]>([]);
  const [legacyInputFiles, setLegacyInputFiles] = useState<UploadedFile[]>([]);
  const [legacyConcurrency, setLegacyConcurrency] = useState(3);
  const [legacyMaxAttempts, setLegacyMaxAttempts] = useState(2);

  const [creating, setCreating] = useState(false);

  const costPerImage = getEstimatedCost(size, quality) || provider?.defaultCostPerImage || 0;

  const handleSubmitComplex = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { alert('请输入项目名称'); return; }
    if (!provider) { alert('请选择供应商'); return; }
    if (!provider.hasApiKey) { alert('当前供应商未配置 API Key'); return; }

    setCreating(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, productName, productCode, category,
          workflowType: 'complex_product',
          providerId: provider.id, model, size, quality, timeoutMs,
          aspectRatio, resolution,
          preprocessEnabled, targetMaxSide, jpegQuality,
        }),
      });
      const data = await res.json();
      if (data.id) {
        router.push(`/projects/${data.id}`);
      } else {
        alert('创建失败: ' + (data.error || '未知错误'));
      }
    } catch (err) { alert('创建失败: ' + String(err)); }
    finally { setCreating(false); }
  };

  const handleSubmitLegacy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { alert('请输入项目名称'); return; }
    if (!provider) { alert('请选择供应商'); return; }
    if (!legacyPrompt.trim()) { alert('请输入提示词'); return; }
    if (legacyInputFiles.length === 0) { alert('请上传待处理图片'); return; }
    if (!provider.hasApiKey) { alert('当前供应商未配置 API Key'); return; }
    setCreating(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, workflowType: 'legacy_batch_edit',
          providerId: provider.id, model,
          prompt: legacyPrompt, negativePrompt: legacyNegativePrompt,
          aspectRatio, resolution, size, quality,
          concurrency: legacyConcurrency, maxAttempts: legacyMaxAttempts, timeoutMs,
          referenceImageIds: legacyRefFiles.map((f) => f.id),
          inputImageIds: legacyInputFiles.map((f) => f.id),
        }),
      });
      const data = await res.json();
      if (data.id) {
        await fetch(`/api/projects/${data.id}/run`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', concurrency: legacyConcurrency, maxAttempts: legacyMaxAttempts, timeoutMs }),
        });
        router.push(`/projects/${data.id}`);
      } else { alert('创建失败: ' + (data.error || '未知错误')); }
    } catch (err) { alert('创建失败: ' + String(err)); }
    finally { setCreating(false); }
  };

  const renderModelParams = () => (
    <div className="card p-4">
      <h3 className="text-sm font-semibold mb-3 text-ink">模型参数</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div>
          <label className="label">模型</label>
          <input type="text" value={model} onChange={(e) => setModel(e.target.value)} className="input-field" />
        </div>
        <div>
          <label className="label">画面比例</label>
          <select value={aspectRatio} onChange={(e) => { setAspectRatio(e.target.value); const avail = Object.keys(GPT_IMAGE_2_SIZE_MAP[e.target.value] || {}); if (!avail.includes(resolution)) setResolution(avail[0] || '1k'); }} className="input-field">
            {GPT_IMAGE_2_ASPECT_RATIOS.map((r) => (<option key={r} value={r}>{r}</option>))}
          </select>
        </div>
        {aspectRatio !== 'auto' && (
        <div>
          <label className="label">清晰度</label>
          <select value={resolution} onChange={(e) => setResolution(e.target.value)} className="input-field">
            {GPT_IMAGE_2_RESOLUTIONS.map((r) => (
              <option key={r} value={r} disabled={!(GPT_IMAGE_2_SIZE_MAP[aspectRatio] || {})[r]}>{r}{GPT_IMAGE_2_SIZE_MAP[aspectRatio]?.[r] ? ` → ${GPT_IMAGE_2_SIZE_MAP[aspectRatio][r]}` : ' — 不支持'}</option>
            ))}
          </select>
        </div>
        )}
        <div>
          <label className="label">质量</label>
          <select value={quality} onChange={(e) => setQuality(e.target.value)} className="input-field">
            <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
          </select>
        </div>
        <div>
          <label className="label">超时(秒)</label>
          <input type="number" min={30} max={600} value={Math.floor(timeoutMs / 1000)}
            onChange={(e) => setTimeoutMs(Number(e.target.value) * 1000)} className="input-field" />
        </div>
      </div>
      <p className="text-xs text-ink-tertiary mt-2">以上为参考价格，实际以中转站后台扣费为准</p>
    </div>
  );

  const renderPreprocessing = () => (
    <div className="card p-4">
      <h3 className="text-sm font-semibold mb-3 text-ink">图片预处理</h3>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="label">启用压缩</label>
          <select value={preprocessEnabled ? '1' : '0'} onChange={(e) => setPreprocessEnabled(e.target.value === '1')} className="input-field">
            <option value="1">开启</option><option value="0">关闭（使用原图）</option>
          </select>
        </div>
        <div>
          <label className="label">最长边</label>
          <select value={targetMaxSide} onChange={(e) => setTargetMaxSide(Number(e.target.value))} className="input-field" disabled={!preprocessEnabled}>
            <option value={1024}>1024</option><option value={1536}>1536（推荐）</option><option value={2048}>2048</option><option value={4096}>4096（原图）</option>
          </select>
        </div>
        <div>
          <label className="label">JPEG 质量</label>
          <select value={jpegQuality} onChange={(e) => setJpegQuality(Number(e.target.value))} className="input-field" disabled={!preprocessEnabled}>
            <option value={70}>70</option><option value={85}>85（推荐）</option><option value={95}>95</option>
          </select>
        </div>
      </div>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-3xl font-semibold tracking-[-0.02em] mb-8">
        {workflowType === 'complex_product' ? '新建复杂结构产品项目' : '新建批量编辑项目'}
      </h1>

      {/* Mode toggle */}
      <div className="mb-8 flex items-center gap-3">
        <span className="text-sm text-ink-secondary">工作流</span>
        <div className="segmented">
          <button type="button" aria-selected={workflowType === 'complex_product'} onClick={() => setWorkflowType('complex_product')}>复杂结构产品</button>
          <button type="button" aria-selected={workflowType === 'legacy_batch_edit'} onClick={() => setWorkflowType('legacy_batch_edit')}>旧版批量编辑</button>
        </div>
      </div>

      {workflowType === 'legacy_batch_edit' ? (
        /* ── Legacy batch edit form ── */
        <form onSubmit={handleSubmitLegacy} className="space-y-10">
          <div>
            <label className="label">项目名称</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="例如：春季家居图批量处理" />
          </div>
          <ProviderSettings selectedId={provider?.id} onSelect={(p) => { setProvider(p); setModel(p.model); }} />
          <ImageUploader role="reference" label="参考图" hint="上传 1-3 张参考图" maxFiles={3}
            files={legacyRefFiles} onUploaded={(files) => setLegacyRefFiles((p) => [...p, ...files])}
            onRemove={(i) => setLegacyRefFiles((p) => p.filter((_, idx) => idx !== i))}
            preprocessEnabled={preprocessEnabled} targetMaxSide={targetMaxSide} jpegQuality={jpegQuality} />
          <ImageUploader role="input" label="待处理图片" hint="上传需要批量编辑的图片，最多 50 张" maxFiles={50}
            files={legacyInputFiles} onUploaded={(files) => setLegacyInputFiles((p) => [...p, ...files])}
            onRemove={(i) => setLegacyInputFiles((p) => p.filter((_, idx) => idx !== i))}
            preprocessEnabled={preprocessEnabled} targetMaxSide={targetMaxSide} jpegQuality={jpegQuality} />
          <div>
            <label className="label">提示词</label>
            <textarea value={legacyPrompt} onChange={(e) => setLegacyPrompt(e.target.value)} rows={3} className="input-field" placeholder="描述你想要的生成效果..." />
          </div>
          <div>
            <label className="label">每张生成数量</label>
            <input type="number" min={1} max={10} value={generationCount} onChange={(e) => setGenerationCount(Math.max(1, Number(e.target.value)))} className="input-field w-24" />
          </div>
          {renderModelParams()}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">并发数</label>
              <input type="number" min={1} max={8} value={legacyConcurrency} onChange={(e) => setLegacyConcurrency(Number(e.target.value))} className="input-field" />
            </div>
            <div>
              <label className="label">重试次数</label>
              <input type="number" min={0} max={5} value={legacyMaxAttempts} onChange={(e) => setLegacyMaxAttempts(Number(e.target.value))} className="input-field" />
            </div>
          </div>
          {renderPreprocessing()}
          <div className="tile p-5">
            <h3 className="font-medium text-sm mb-2">成本预估（参考价）</h3>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div><div className="text-ink-secondary">任务数</div><div className="font-bold text-lg">{legacyInputFiles.length * generationCount}</div></div>
              <div><div className="text-ink-secondary">单张成本</div><div className="font-bold text-lg">¥{costPerImage.toFixed(3)}</div></div>
              <div><div className="text-ink-secondary">预估总成本</div><div className="text-lg font-bold text-accent">¥{(legacyInputFiles.length * generationCount * costPerImage).toFixed(2)}</div></div>
            </div>
          </div>
          <div className="flex gap-3 justify-end">
            <Link href="/" className="btn-secondary">取消</Link>
            <button type="submit" disabled={creating} className="btn-primary">{creating ? '创建中...' : '创建并开始运行'}</button>
          </div>
        </form>
      ) : (
        /* ── Complex product workflow ── */
        <form onSubmit={handleSubmitComplex} className="space-y-10">
          {/* Project info */}
          <div className="card p-4">
            <h3 className="text-sm font-semibold mb-3 text-ink">项目信息</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">项目名称 *</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="例如：奶油风软包床" />
              </div>
              <div>
                <label className="label">产品名称</label>
                <input type="text" value={productName} onChange={(e) => setProductName(e.target.value)} className="input-field" placeholder="可选" />
              </div>
              <div>
                <label className="label">产品编号</label>
                <input type="text" value={productCode} onChange={(e) => setProductCode(e.target.value)} className="input-field" placeholder="可选" />
              </div>
              <div>
                <label className="label">品类</label>
                <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} className="input-field" placeholder="可选" />
              </div>
            </div>
            <p className="text-xs text-ink-tertiary mt-3">
              创建项目后，可在项目工作台中按需上传素材、生成场景图、分镜图、脚本和视频。
            </p>
          </div>

          {/* Provider */}
          <ProviderSettings selectedId={provider?.id} onSelect={(p) => { setProvider(p); setModel(p.model); }} />

          {/* Model params */}
          {renderModelParams()}

          {/* Preprocessing (collapsible) */}
          <details className="card p-4">
            <summary className="text-sm font-semibold text-ink cursor-pointer">图片预处理（高级设置）</summary>
            <div className="mt-3">
              {renderPreprocessing()}
            </div>
          </details>

          {/* Submit */}
          <div className="flex gap-3 justify-end">
            <Link href="/" className="btn-secondary">取消</Link>
            <button type="submit" disabled={creating} className="btn-primary">
              {creating ? '创建中...' : '创建项目'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
