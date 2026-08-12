'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ProviderSettings from '@/components/ProviderSettings';
import {
  getImageModelCapabilities,
} from '@/lib/image-model-capabilities';
import {
  GPT_IMAGE_2_ASPECT_RATIOS,
  GPT_IMAGE_2_RESOLUTIONS,
  GPT_IMAGE_2_SIZE_MAP,
  resolveGptImage2Size,
} from '@/lib/gpt-image-2-size-presets';

interface Provider {
  id: string; name: string; model: string; type: string; hasApiKey?: boolean;
}

export default function NewProjectPage() {
  const router = useRouter();

  // ── Project info ──
  const [name, setName] = useState('');
  const [productName, setProductName] = useState('');
  const [productCode, setProductCode] = useState('');
  const [category, setCategory] = useState('');

  // ── Provider / Model ──
  const [provider, setProvider] = useState<Provider | null>(null);
  const [model, setModel] = useState('gpt-image-2');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [resolution, setResolution] = useState('1k');
  const [quality, setQuality] = useState('medium');
  const [timeoutMs, setTimeoutMs] = useState(600000);
  const [concurrency, setConcurrency] = useState(3);

  const size = useMemo(() => {
    try { return resolveGptImage2Size(aspectRatio, resolution); }
    catch { return ''; }
  }, [aspectRatio, resolution]);
  const modelCapabilities = useMemo(() => getImageModelCapabilities(model), [model]);
  const supportsQuality = modelCapabilities.supportsQuality;

  // ── Preprocessing ──
  const [preprocessEnabled, setPreprocessEnabled] = useState(true);
  const [targetMaxSide, setTargetMaxSide] = useState(1536);
  const [jpegQuality, setJpegQuality] = useState(85);

  const [creating, setCreating] = useState(false);

  const effectiveQuality = supportsQuality ? quality : 'auto';

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
          providerId: provider.id, model, size, quality: effectiveQuality, timeoutMs,
          aspectRatio, resolution,
          concurrency,
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

  const modelControlClass = 'input-field h-11 w-full text-sm leading-none';
  const providerLocksModel = provider?.type === 'packy-images' || provider?.type === 'packy-gemini-image';

  const renderModelParams = (showConcurrency = false) => (
    <div className="card p-4">
      <h3 className="text-sm font-semibold mb-3 text-ink">模型参数</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div>
          <label className="label">模型</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            readOnly={providerLocksModel}
            className={modelControlClass}
          />
        </div>
        <div>
          <label className="label">画面比例</label>
          <select value={aspectRatio} onChange={(e) => { setAspectRatio(e.target.value); const avail = Object.keys(GPT_IMAGE_2_SIZE_MAP[e.target.value] || {}); if (!avail.includes(resolution)) setResolution(avail[0] || '1k'); }} className={modelControlClass}>
            {GPT_IMAGE_2_ASPECT_RATIOS.map((r) => (<option key={r} value={r}>{r}</option>))}
          </select>
        </div>
        {aspectRatio !== 'auto' && (
        <div>
          <label className="label">清晰度</label>
          <select value={resolution} onChange={(e) => setResolution(e.target.value)} className={modelControlClass}>
            {GPT_IMAGE_2_RESOLUTIONS.map((r) => (
              <option key={r} value={r} disabled={!(GPT_IMAGE_2_SIZE_MAP[aspectRatio] || {})[r]}>{r}{GPT_IMAGE_2_SIZE_MAP[aspectRatio]?.[r] ? ` → ${GPT_IMAGE_2_SIZE_MAP[aspectRatio][r]}` : ' — 不支持'}</option>
            ))}
          </select>
        </div>
        )}
        {supportsQuality && (
          <div>
            <label className="label">质量</label>
            <select value={quality} onChange={(e) => setQuality(e.target.value)} className={modelControlClass}>
              <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
            </select>
          </div>
        )}
        <div>
          <label className="label">超时(秒)</label>
          <input type="number" min={30} max={600} value={Math.floor(timeoutMs / 1000)}
            onChange={(e) => setTimeoutMs(Number(e.target.value) * 1000)} className={modelControlClass} />
        </div>
        {showConcurrency && (
          <div>
            <label className="label">并发数</label>
            <input
              type="number"
              min={1}
              max={10}
              value={concurrency}
              onChange={(e) => setConcurrency(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
              className={modelControlClass}
            />
            <p className="mt-1 text-xs text-ink-tertiary">失败或限流时调回 1。</p>
          </div>
        )}
      </div>
      <p className="text-xs text-ink-tertiary mt-2">
        {supportsQuality
          ? '以上为参考价格，实际以中转站后台扣费为准'
          : '当前模型不支持质量参数，实际扣费以供应商后台为准'}
      </p>
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
        新建复杂结构产品项目
      </h1>

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
          <ProviderSettings
            selectedId={provider?.id}
            onSelect={(p) => {
              setProvider(p);
              setModel(p.model);
              setTimeoutMs(getImageModelCapabilities(p.model).recommendedTimeoutMs);
            }}
          />

          {/* Model params */}
          {renderModelParams(true)}

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
    </div>
  );
}
