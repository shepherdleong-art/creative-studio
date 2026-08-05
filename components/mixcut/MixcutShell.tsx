'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import styles from './mixcut-shell.module.css';

export interface MixcutStepDef {
  label: string;
  hint: string;
  icon: IconName;
  enabled?: boolean;
}

export interface MixcutShellPreviewControls {
  repOff: boolean;
  rgtOff: boolean;
  onRepCollapse: (value: boolean) => void;
  onRgtCollapse: (value: boolean) => void;
  onResizeStart: (side: 'rep' | 'rgt') => (event: React.PointerEvent<HTMLDivElement>) => void;
}

export interface MixcutShellProps {
  steps: MixcutStepDef[];
  activeStep: number;
  onStepSelect: (index: number) => void;
  stepDisabled?: (index: number, step: MixcutStepDef) => boolean;
  /** 顶栏左侧内容(当前上下文);右侧内容可选 */
  topbarLeft: ReactNode;
  topbarRight?: ReactNode;
  /** 左辅栏内容(步骤概览/最近会话等) */
  sidebar: ReactNode;
  /** 主区内容。预览态(第 3 步双栏)时由调用方渲染预览组件并接收折叠/拖拽控制 */
  main: (controls: MixcutShellPreviewControls) => ReactNode;
  /** 预览态:骨架切换为双栏网格并隐藏左辅栏 */
  previewActive: boolean;
  /** shell 根元素附加 data 属性(如分镜组 id) */
  dataAttributes?: Record<string, string>;
  /** 布局记忆的 localStorage key(单条模式沿用 mixcut-layout-v2) */
  layoutStorageKey?: string;
  /** 步骤条的无障碍标签 */
  stepsAriaLabel?: string;
  /** 覆盖层(对话框等),渲染在 shell 根元素内、body 之后 */
  children?: ReactNode;
}

/**
 * 混剪工作台共用骨架:顶栏 + 左步骤条 + 左辅栏 + 主区。
 * 持有折叠/拖拽布局状态与 localStorage 记忆(--navw/--repw/--rgtw 变量),
 * 单条与批量向导共用;内容与步骤组件全部由调用方注入。
 */
export default function MixcutShell({
  steps,
  activeStep,
  onStepSelect,
  stepDisabled,
  topbarLeft,
  topbarRight,
  sidebar,
  main,
  previewActive,
  dataAttributes,
  layoutStorageKey = 'mixcut-layout-v2',
  stepsAriaLabel = '创作步骤',
  children,
}: MixcutShellProps) {
  const [navOff, setNavOff] = useState(false);
  const [colOffA, setColOffA] = useState(false);
  const [repOff, setRepOff] = useState(false);
  const [rgtOff, setRgtOff] = useState(false);
  const [repW, setRepW] = useState(244);
  const [rgtW, setRgtW] = useState(320);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(layoutStorageKey) || 'null') as Record<string, unknown> | null;
        if (saved) {
          setNavOff(Boolean(saved.navOff));
          setColOffA(Boolean(saved.colOffA));
          setRepOff(Boolean(saved.repOff));
          setRgtOff(Boolean(saved.rgtOff));
          if (typeof saved.repW === 'number') setRepW(saved.repW);
          if (typeof saved.rgtW === 'number') setRgtW(saved.rgtW);
        }
      } catch { /* 忽略损坏的布局记忆 */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [layoutStorageKey]);
  useEffect(() => {
    try { localStorage.setItem(layoutStorageKey, JSON.stringify({ navOff, colOffA, repOff, rgtOff, repW, rgtW })); } catch { /* 隐私模式等场景忽略 */ }
  }, [navOff, colOffA, repOff, rgtOff, repW, rgtW, layoutStorageKey]);

  // 预览双栏拖拽调宽:宽度由 JS 写入 --repw/--rgtw(不与 class 折叠机制混用)
  const beginResize = (side: 'rep' | 'rgt') => (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = side === 'rep' ? repW : rgtW;
    const [min, max] = side === 'rep' ? [180, 440] : [240, 500];
    const move = (pointer: PointerEvent) => {
      const dx = pointer.clientX - startX;
      const width = Math.min(max, Math.max(min, side === 'rep' ? startW + dx : startW - dx));
      if (side === 'rep') { setRepW(width); setRepOff(false); } else { setRgtW(width); setRgtOff(false); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const bodyClass = [
    styles.body,
    previewActive ? styles.bodyPreview : '',
    colOffA ? styles.colOffA : '',
    navOff ? styles.navOff : '',
  ].filter(Boolean).join(' ');
  const bodyAttrs: Record<string, string> = {
    'data-layout': previewActive ? 'preview' : 'normal',
    'data-rep-off': repOff ? '1' : '0',
    'data-rgt-off': rgtOff ? '1' : '0',
  };

  return (
    <div className={styles.shell} data-active-step={activeStep} {...dataAttributes}>
      <header className={styles.topbar}>
        {topbarLeft}
        {topbarRight && <div className={styles.topbarRight}>{topbarRight}</div>}
      </header>
      <div
        className={bodyClass}
        style={{ '--repw': `${repOff ? 36 : repW}px`, '--rgtw': `${rgtOff ? 36 : rgtW}px` } as React.CSSProperties}
        {...bodyAttrs}
      >
        <nav className={styles.stepNav} aria-label={stepsAriaLabel}>
          <div className={styles.navRow}>
            <p className={styles.eyebrow}>创作步骤</p>
            <button type="button" className={styles.navToggle} title={navOff ? '展开步骤条' : '收起步骤条'} onClick={() => setNavOff((value) => !value)}>{navOff ? '›' : '‹'}</button>
          </div>
          {steps.map((step, index) => (
            <button
              type="button"
              key={step.label}
              className={`${styles.snav} ${index === activeStep ? styles.snavOn : ''} ${index < activeStep ? styles.snavDone : ''}`}
              disabled={step.enabled === false || Boolean(stepDisabled?.(index, step))}
              onClick={() => onStepSelect(index)}
              aria-label={navOff ? step.label : undefined}
            >
              <span className={styles.snavBar} />
              <span className={styles.snavIco}><Icon name={index < activeStep ? 'check-circle' : step.icon} size={16} /></span>
              <span className={styles.snavTx}><span className={styles.snavLb}>{step.label}</span><span className={styles.snavHint}>{step.hint}</span></span>
            </button>
          ))}
          <p className={styles.stepNavFoot}><Icon name="lock" size={12} /><span>本地保存</span></p>
        </nav>

        <div className={styles.sideCol}>
          <button type="button" className={styles.collapseBtn} title="隐藏辅栏" onClick={() => setColOffA(true)}>‹</button>
          <button type="button" className={styles.expandBtn} title="展开辅栏" onClick={() => setColOffA(false)}>›</button>
          {sidebar}
        </div>

        {main({ repOff, rgtOff, onRepCollapse: setRepOff, onRgtCollapse: setRgtOff, onResizeStart: beginResize })}
      </div>
      {children}
    </div>
  );
}
