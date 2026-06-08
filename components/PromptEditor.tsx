'use client';

import { useState } from 'react';

interface Props {
  prompt: string;
  onChange: (prompt: string) => void;
  negativePrompt?: string;
  onNegativeChange?: (negative: string) => void;
}

const TEMPLATES = [
  {
    name: '产品一致性',
    prompt:
      '根据参考图编辑当前图片。保持产品主体、桌子材质、木纹、比例、结构和品牌调性一致。可以调整场景、布置、背景、光线和构图，使图片更适合电商详情页或生活方式广告图。不要改变产品结构，不要添加多余文字，不要让桌子变形，不要生成不真实的连接件。',
  },
  {
    name: '家居生活方式',
    prompt:
      '将当前图片改造成明亮、自然、真实的家居生活方式场景。参考图用于确定桌子外观、木纹、比例和整体风格。保持产品主体一致，增加柔和自然光、干净背景、适量家居装饰。画面要像真实摄影，不要过度渲染，不要出现错误文字。',
  },
  {
    name: '局部细节增强',
    prompt:
      '保持当前图片的产品细节和构图不变，提升质感、光线和背景整洁度。参考图用于保持材质、颜色和品牌风格一致。不要改变产品结构，不要新增无关物体，不要让木纹方向异常。',
  },
];

export default function PromptEditor({
  prompt,
  onChange,
  negativePrompt,
  onNegativeChange,
}: Props) {
  const [variables, setVariables] = useState<string[]>([]);

  const applyTemplate = (template: (typeof TEMPLATES)[number]) => {
    onChange(template.prompt);
  };

  const detectedVars = prompt.match(/\{(\w+)\}/g) || [];
  const uniqueVars = [...new Set(detectedVars.map((v) => v.replace(/[{}]/g, '')))];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="label mb-0">提示词模板</label>
        <div className="flex gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => applyTemplate(t)}
              className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 text-gray-600 transition-colors"
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <textarea
        value={prompt}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        className="input-field font-mono text-sm"
        placeholder="输入统一的图片编辑提示词..."
      />

      {uniqueVars.length > 0 && (
        <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-700">
          <span className="font-medium">检测到变量：</span>
          {uniqueVars.map((v) => (
            <code key={v} className="mx-1 bg-blue-100 px-1 rounded">{`{${v}}`}</code>
          ))}
          <span className="text-blue-500 ml-1">
            — 每张图会替换为对应的值
          </span>
        </div>
      )}

      {onNegativeChange && (
        <div>
          <label className="label">负面约束（可选）</label>
          <textarea
            value={negativePrompt}
            onChange={(e) => onNegativeChange(e.target.value)}
            rows={2}
            className="input-field font-mono text-sm"
            placeholder="不希望出现的内容..."
          />
        </div>
      )}
    </div>
  );
}
