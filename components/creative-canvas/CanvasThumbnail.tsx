'use client';

/**
 * 画布列表卡片封面：按节点真实坐标渲染迷你布局——素材节点显示图片／视频首帧，
 * 其余节点画成小块，连线画成贝塞尔细线，让卡片一眼认出画布内容。
 * 纯 CSS 百分比定位 + 固定宽高比，无需测量容器。
 */

import { useMemo } from 'react';
import { canvasAssetUrl, type CanvasPreviewDto } from './api';

/** 各类节点的缩略估计尺寸；用户调过宽度时按宽度等比缩放高度。 */
const KIND_BOX: Record<string, { w: number; h: number }> = {
  material: { w: 240, h: 300 },
  prompt: { w: 240, h: 140 },
  'image-generation': { w: 280, h: 560 },
  'video-generation': { w: 280, h: 560 },
};

/** 世界包围盒外扩边距（画布坐标单位）。 */
const PAD = 80;
/** 卡片封面区域固定 4:3，世界等比缩放后居中。 */
const CARD_ASPECT = 4 / 3;

interface ThumbBox {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  assetId: string | null;
  mediaKind: string | null;
}

export function CanvasThumbnail({ preview }: { preview: CanvasPreviewDto }) {
  const layout = useMemo(() => {
    if (preview.nodes.length === 0) return null;
    const boxes: ThumbBox[] = preview.nodes.map((node) => {
      const base = KIND_BOX[node.kind] ?? { w: 240, h: 200 };
      const w = node.width ?? base.w;
      return {
        id: node.id,
        kind: node.kind,
        x: node.x,
        y: node.y,
        w,
        h: (base.h * w) / base.w,
        assetId: node.assetId,
        mediaKind: node.mediaKind,
      };
    });
    const minX = Math.min(...boxes.map((box) => box.x)) - PAD;
    const minY = Math.min(...boxes.map((box) => box.y)) - PAD;
    const maxX = Math.max(...boxes.map((box) => box.x + box.w)) + PAD;
    const maxY = Math.max(...boxes.map((box) => box.y + box.h)) + PAD;
    return { boxes, minX, minY, w: maxX - minX, h: maxY - minY };
  }, [preview]);

  if (!layout) return null;
  const { boxes, minX, minY, w: worldW, h: worldH } = layout;
  const pctX = (value: number) => `${((value - minX) / worldW) * 100}%`;
  const pctY = (value: number) => `${((value - minY) / worldH) * 100}%`;
  const pctW = (value: number) => `${(value / worldW) * 100}%`;
  const pctH = (value: number) => `${(value / worldH) * 100}%`;
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const stroke = Math.max(worldW, worldH) * 0.006;

  return (
    <div
      className="flex h-full w-full items-center justify-center p-2"
      data-testid="canvas-thumb"
    >
      <div
        className="relative"
        style={{
          aspectRatio: `${worldW} / ${worldH}`,
          ...(worldW / worldH >= CARD_ASPECT ? { width: '100%' } : { height: '100%' }),
        }}
      >
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${worldW} ${worldH}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          {preview.edges.map((edge) => {
            const source = byId.get(edge.source);
            const target = byId.get(edge.target);
            if (!source || !target) return null;
            const x1 = source.x + source.w - minX;
            const y1 = source.y + source.h / 2 - minY;
            const x2 = target.x - minX;
            const y2 = target.y + target.h / 2 - minY;
            const dx = Math.max(Math.abs(x2 - x1) * 0.5, stroke * 8);
            return (
              <path
                key={`${edge.source}->${edge.target}`}
                d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--color-ink-tertiary)"
                strokeOpacity={0.55}
                strokeWidth={stroke}
              />
            );
          })}
        </svg>
        {boxes.map((box) => (
          <div
            key={box.id}
            className="absolute overflow-hidden rounded-[3px] border border-[var(--color-hairline)] bg-[var(--color-surface)]"
            style={{ left: pctX(box.x), top: pctY(box.y), width: pctW(box.w), height: pctH(box.h) }}
          >
            {box.assetId && box.mediaKind === 'image' ? (
              <img src={canvasAssetUrl(box.assetId)} alt="" loading="lazy" className="h-full w-full object-cover" />
            ) : box.assetId && box.mediaKind === 'video' ? (
              <video
                src={canvasAssetUrl(box.assetId)}
                muted
                playsInline
                preload="metadata"
                className="h-full w-full object-cover"
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
