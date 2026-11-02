'use client';
// THROWAWAY shared controls; deliberately outside the proposed product UI.
import { useEffect } from 'react';
import { Icon } from './Icon';

export type PrototypeVariant = 'A' | 'B' | 'C';
export const prototypeVariants = { A: '工作台', B: '任务优先', C: '流程看板' };

export default function TeamPrototypeSwitcher({ variant, role, onVariant, onRole, onState, onReset, scenario, onScenario, className }: {
  variant: PrototypeVariant; role: 'client' | 'server'; onVariant: (v: PrototypeVariant) => void;
  onRole: (v: 'client' | 'server') => void; onState: () => void; onReset: () => void;
  scenario: string; onScenario: (v: string) => void; className: string;
}) {
  const cycle = (delta: number) => onVariant((['A', 'B', 'C'] as const)[(['A', 'B', 'C'].indexOf(variant) + delta + 3) % 3]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.ctrlKey || event.altKey || event.metaKey || target.closest('input,textarea,select,[contenteditable="true"],[role="slider"]')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        onVariant((['A', 'B', 'C'] as const)[(['A', 'B', 'C'].indexOf(variant) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [variant, onVariant]);
  if (process.env.NODE_ENV === 'production') return null;
  return <aside className={className} aria-label="原型切换工具">
    <span data-caption>交互原型 · 模拟数据</span>
    <div data-segment><button aria-pressed={role === 'client'} onClick={() => onRole('client')}>员工客户端</button><button aria-pressed={role === 'server'} onClick={() => onRole('server')}>服务器管理端</button></div>
    <div data-segment><button aria-label="上一个布局" onClick={() => cycle(-1)}><Icon name="chevron-left" size={15}/></button><span>{variant} · {prototypeVariants[variant]}</span><button aria-label="下一个布局" onClick={() => cycle(1)}><Icon name="chevron-right" size={15}/></button></div>
    <select aria-label="演示情境" value={scenario} onChange={e => onScenario(e.target.value)}><option value="normal">情境：正常</option><option value="offline">情境：客户端断网</option><option value="maintenance">情境：服务器维护</option></select>
    <button onClick={onState}>查看状态</button><button onClick={onReset} title="重置本页模拟数据">重置</button>
  </aside>;
}
