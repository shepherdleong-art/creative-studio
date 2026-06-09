'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ProviderSettings from '@/components/ProviderSettings';
import ImageUploader from '@/components/ImageUploader';
import type { UploadedFile } from '@/components/ImageUploader';
import PromptEditor from '@/components/PromptEditor';
import {
  GPT_IMAGE_2_ASPECT_RATIOS,
  GPT_IMAGE_2_RESOLUTIONS,
  GPT_IMAGE_2_SIZE_MAP,
  resolveGptImage2Size,
} from '@/lib/gpt-image-2-size-presets';

// GeekAI GPT-Image-2 estimated prices (CNY per image) — indexed by size
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
  id: string;
  name: string;
  model: string;
  type: string;
  hasApiKey?: boolean;
  defaultCostPerImage?: number;
}

export default function NewProjectPage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [provider, setProvider] = useState<Provider | null>(null);
  const [model, setModel] = useState('gpt-image-2');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  // Aspect ratio + resolution → computed size
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [resolution, setResolution] = useState('1k');
  const [quality, setQuality] = useState('medium');

  const size = useMemo(() => {
    try {
      return resolveGptImage2Size(aspectRatio, resolution);
    } catch {
      // Should not happen with valid UI selections, but don't silently fall back
      return '';
    }
  }, [aspectRatio, resolution]);

  // Get available resolutions for the selected ratio
  const availableResolutions = useMemo(() => {
    return Object.keys(GPT_IMAGE_2_SIZE_MAP[aspectRatio] || {});
  }, [aspectRatio]);
  const [concurrency, setConcurrency] = useState(3);
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [timeoutMs, setTimeoutMs] = useState(300000);

  const [referenceFiles, setReferenceFiles] = useState<UploadedFile[]>([]);
  const [inputFiles, setInputFiles] = useState<UploadedFile[]>([]);

  const [creating, setCreating] = useState(false);

  // Reference guidance: auto-prepend subject preservation when reference images exist
  const [referenceGuidanceMode, setReferenceGuidanceMode] = useState<'preserve_subject' | 'none'>('preserve_subject');

  // Preprocessing settings
  const [preprocessEnabled, setPreprocessEnabled] = useState(true);
  const [targetMaxSide, setTargetMaxSide] = useState(1536);
  const [jpegQuality, setJpegQuality] = useState(85);

  // Cost estimation uses price table when available, falls back to provider default
  const costPerImage = getEstimatedCost(size, quality) || provider?.defaultCostPerImage || 0;
  const estimatedTotalCost = inputFiles.length * costPerImage;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      alert('请输入项目名称');
      return;
    }
    if (!provider) {
      alert('请选择供应商');
      return;
    }
    if (!prompt.trim()) {
      alert('请输入提示词');
      return;
    }
    if (inputFiles.length === 0) {
      alert('请上传待处理图片');
      return;
    }
    if (!provider.hasApiKey) {
      alert('当前供应商未配置 API Key，请先到供应商配置里填写 Key');
      return;
    }
    setCreating(true);

    try {
      // Files were already uploaded and registered to DB by ImageUploader.
      // We only submit asset IDs to the project creation API.
      const referenceIds = referenceFiles.map((f) => f.id);
      const inputIds = inputFiles.map((f) => f.id);

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          providerId: provider.id,
          model,
          prompt,
          negativePrompt,
          aspectRatio,
          resolution,
          size,
          quality,
          concurrency,
          maxAttempts,
          referenceGuidanceMode,
          referenceImageIds: referenceIds,
          inputImageIds: inputIds,
        }),
      });

      const data = await res.json();

      if (data.id) {
        // Start running immediately
        await fetch(`/api/projects/${data.id}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'start',
            concurrency,
            maxAttempts,
            timeoutMs,
          }),
        });

        router.push(`/projects/${data.id}`);
      } else {
        alert('创建失败: ' + (data.error || '未知错误'));
      }
    } catch (err) {
      alert('创建失败: ' + String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">新建批量编辑项目</h1>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Project name */}
        <div>
          <label className="label">项目名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input-field"
            placeholder="例如：春季家居图批量处理"
          />
        </div>

        {/* Provider */}
        <ProviderSettings
          selectedId={provider?.id}
          onSelect={(p) => {
            setProvider(p);
            setModel(p.model);
          }}
        />

        {/* Image upload */}
        <ImageUploader
          role="reference"
          label="参考图"
          hint="上传 1-3 张参考图，用于保持产品风格一致"
          maxFiles={3}
          files={referenceFiles}
          onUploaded={(files) => setReferenceFiles((prev) => [...prev, ...files])}
          onRemove={(i) => setReferenceFiles((prev) => prev.filter((_, idx) => idx !== i))}
          preprocessEnabled={preprocessEnabled}
          targetMaxSide={targetMaxSide}
          jpegQuality={jpegQuality}
        />

        {/* Reference guidance toggle */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={referenceGuidanceMode === 'preserve_subject'}
            onChange={(e) => setReferenceGuidanceMode(e.target.checked ? 'preserve_subject' : 'none')}
            className="w-4 h-4 mt-0.5 rounded border-gray-300"
          />
          <div>
            <span className="text-sm font-medium text-gray-700">保持待处理图主体不变</span>
            <p className="text-xs text-gray-400 mt-0.5">
              有参考图时生效。开启后会自动提示模型保留待处理图的主体、比例和材质；关闭后只使用你写的提示词。
            </p>
          </div>
        </label>

        <ImageUploader
          role="input"
          label="待处理图片"
          hint="上传需要批量编辑的图片，最多 50 张"
          maxFiles={50}
          files={inputFiles}
          onUploaded={(files) => setInputFiles((prev) => [...prev, ...files])}
          onRemove={(i) => setInputFiles((prev) => prev.filter((_, idx) => idx !== i))}
          preprocessEnabled={preprocessEnabled}
          targetMaxSide={targetMaxSide}
          jpegQuality={jpegQuality}
        />

        {/* Prompt */}
        <PromptEditor
          prompt={prompt}
          onChange={setPrompt}
          negativePrompt={negativePrompt}
          onNegativeChange={setNegativePrompt}
        />

        {/* Model params */}
        <div className="card p-4">
          <h3 className="font-medium text-sm mb-3">模型参数</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div>
              <label className="label">模型</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="input-field"
              />
            </div>
            <div>
              <label className="label">画面比例</label>
              <select
                value={aspectRatio}
                onChange={(e) => {
                  const newRatio = e.target.value;
                  setAspectRatio(newRatio);
                  // Sync resolution: if current not available in new ratio, pick first available
                  const avail = Object.keys(GPT_IMAGE_2_SIZE_MAP[newRatio] || {});
                  if (!avail.includes(resolution)) {
                    setResolution(avail[0] || '1k');
                  }
                }}
                className="input-field"
              >
                {GPT_IMAGE_2_ASPECT_RATIOS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            {aspectRatio !== 'auto' && (
            <div>
              <label className="label">清晰度</label>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                className="input-field"
              >
                {GPT_IMAGE_2_RESOLUTIONS.map((r) => (
                  <option key={r} value={r} disabled={!availableResolutions.includes(r)}>
                    {r}{availableResolutions.includes(r) ? ` → ${GPT_IMAGE_2_SIZE_MAP[aspectRatio]?.[r]}` : ' — 不支持'}
                  </option>
                ))}
              </select>
            </div>
            )}
            <div>
              <label className="label">质量</label>
              <select value={quality} onChange={(e) => setQuality(e.target.value)} className="input-field">
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </div>
            <div>
              <label className="label">并发数</label>
              <input
                type="number"
                min={1}
                max={8}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="input-field"
              />
            </div>
            <div>
              <label className="label">重试次数</label>
              <input
                type="number"
                min={0}
                max={5}
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(Number(e.target.value))}
                className="input-field"
              />
            </div>
            <div>
              <label className="label">超时(秒)</label>
              <input
                type="number"
                min={30}
                max={600}
                value={Math.floor(timeoutMs / 1000)}
                onChange={(e) => setTimeoutMs(Number(e.target.value) * 1000)}
                className="input-field"
              />
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">以上为参考价格，实际以中转站后台扣费为准</p>
        </div>

        {/* Image preprocessing */}
        <div className="card p-4">
          <h3 className="font-medium text-sm mb-3">图片预处理</h3>
          <p className="text-xs text-gray-500 mb-3">
            自动压缩大图，减少 API 传输时间和失败率。原图会被保留。
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div>
              <label className="label">启用压缩</label>
              <select
                value={preprocessEnabled ? '1' : '0'}
                onChange={(e) => setPreprocessEnabled(e.target.value === '1')}
                className="input-field"
              >
                <option value="1">开启</option>
                <option value="0">关闭（使用原图）</option>
              </select>
            </div>
            <div>
              <label className="label">最长边</label>
              <select
                value={targetMaxSide}
                onChange={(e) => setTargetMaxSide(Number(e.target.value))}
                className="input-field"
                disabled={!preprocessEnabled}
              >
                <option value={1024}>1024</option>
                <option value={1536}>1536（推荐）</option>
                <option value={2048}>2048</option>
                <option value={4096}>4096（原图）</option>
              </select>
            </div>
            <div>
              <label className="label">JPEG 质量</label>
              <select
                value={jpegQuality}
                onChange={(e) => setJpegQuality(Number(e.target.value))}
                className="input-field"
                disabled={!preprocessEnabled}
              >
                <option value={70}>70</option>
                <option value={85}>85（推荐）</option>
                <option value={95}>95</option>
              </select>
            </div>
          </div>
        </div>

        {/* Cost estimation */}
        <div className="card p-4 bg-blue-50 border-blue-200">
          <h3 className="font-medium text-sm mb-2">成本预估（参考价）</h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-gray-500">任务数</div>
              <div className="font-bold text-lg">{inputFiles.length}</div>
            </div>
            <div>
              <div className="text-gray-500">单张成本</div>
              <div className="font-bold text-lg">¥{costPerImage.toFixed(3)}</div>
            </div>
            <div>
              <div className="text-gray-500">预估总成本</div>
              <div className="font-bold text-lg text-blue-700">
                ¥{estimatedTotalCost.toFixed(2)}
              </div>
            </div>
          </div>
        </div>

        {/* Submit */}
        <div className="flex gap-3 justify-end">
          <Link href="/" className="btn-secondary">
            取消
          </Link>
          <button
            type="submit"
            disabled={creating}
            className="btn-primary"
          >
            {creating ? '创建中...' : '创建并开始运行'}
          </button>
        </div>
      </form>
    </div>
  );
}
