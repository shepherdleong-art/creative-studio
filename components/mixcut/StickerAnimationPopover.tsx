'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { PackagingTemplateId } from '@/lib/final-edit/packaging-vars';
import {
  STICKER_ANIMATION_PRESETS,
  resolveStickerAnimation,
  type StickerAnimation,
  type StickerAnimationPresetId,
} from '@/lib/media-core/packaging-stickers';
import styles from './mixcut-content.module.css';

const DEMO_PRESETS: StickerAnimationPresetId[] = ['soft', 'bounce', 'rise', 'slide', 'zoom', 'none'];
const DEMO_IMAGE = '/api/packaging/stickers/show/highlight.png';
const DEMO_CLASS: Record<StickerAnimationPresetId, string> = {
  soft: styles.stickerDemoSoft,
  bounce: styles.stickerDemoBounce,
  rise: styles.stickerDemoRise,
  slide: styles.stickerDemoSlide,
  zoom: styles.stickerDemoZoom,
  none: styles.stickerDemoNone,
};

export function StickerAnimationPopover({ value, template, disabled, allowFollowTemplate = false, onChange }: {
  value: StickerAnimation;
  template: PackagingTemplateId;
  disabled: boolean;
  allowFollowTemplate?: boolean;
  onChange: (animation: StickerAnimation) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();
  const resolved = resolveStickerAnimation(value, template);
  const valueLabel = value === 'follow-template' ? `跟随模板（${STICKER_ANIMATION_PRESETS[resolved].name}）` : STICKER_ANIMATION_PRESETS[resolved].name;

  useEffect(() => {
    if (!open) return;
    const pointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('pointerdown', pointerDown);
    window.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('keydown', keyDown);
    };
  }, [open]);

  const choose = (animation: StickerAnimation) => {
    onChange(animation);
    setOpen(false);
  };

  return (
    <span ref={rootRef} className={styles.stickerAnimationAnchor}>
      <button
        type="button"
        className={styles.stickerAnimationTrigger}
        disabled={disabled}
        aria-label={`预览动效 ${valueLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((current) => !current)}
      ><Icon name="play" size={10} />{valueLabel}</button>
      {open ? (
        <span id={popoverId} role="dialog" aria-label="选择贴纸动效" className={styles.stickerAnimationPopover}>
          <span className={styles.stickerAnimationHead}>
            <span>选择动效</span>
            <button type="button" aria-label="关闭动效选择" onClick={() => setOpen(false)}><Icon name="close" size={12} /></button>
          </span>
          {allowFollowTemplate ? (
            <button type="button" className={styles.stickerAnimationFollow} aria-pressed={value === 'follow-template'} onClick={() => choose('follow-template')}>
              跟随模板推荐（{STICKER_ANIMATION_PRESETS[resolveStickerAnimation('follow-template', template)].name}）
            </button>
          ) : null}
          <span className={styles.stickerAnimationGrid}>
            {DEMO_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset}
                className={`${styles.stickerAnimationCard} ${value === preset ? styles.stickerAnimationCardActive : ''}`}
                data-animation-card={preset}
                aria-label={`选择动效 ${STICKER_ANIMATION_PRESETS[preset].name}`}
                aria-pressed={value === preset}
                onClick={() => choose(preset)}
              >
                <span className={styles.stickerAnimationStage}>
                  {/* 六卡始终复用同一原图；关闭浮窗即卸载并停止全部 CSS 动画。 */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className={`${styles.stickerAnimationDemo} ${DEMO_CLASS[preset]}`} data-animation-demo={preset} src={DEMO_IMAGE} alt="" draggable={false} />
                </span>
                <span>{STICKER_ANIMATION_PRESETS[preset].name}</span>
              </button>
            ))}
          </span>
        </span>
      ) : null}
    </span>
  );
}
