'use client';

// §2 右栏「视频包装」卡（PackagingStep 拆解迁移：交互与 pk*/tpl* CSS 类复用）
// - 启用开关 / 模板四列小卡（悬停放大预览卡）/ 三槽 FontPicker（卖点槽保留上传字体）
// - 「跳到封面」「恢复默认版式」「重新提取卖点」「恢复默认文案」按钮行
// - 文案编辑在预览画面内双击直改（§B，PreviewStep 浮框），本卡不再持有文案输入框
// - 所有写操作走 PreviewStep 传入的 onApplyGroup（set_packaging_config 串行队列 + revision 乐观锁），
//   组件内禁止直接 fetch PATCH 组配置（字体上传/物化是资源接口，不在此列）。
// 服务端写法语义（workspace.ts）：enabled/template/varsOverrides 每次必须全量携带（省略即重置/清空）；
// 三槽字体省略保留、null 清除；layouts 按模板键浅合并（{ [template]: {} } 清该模板）；forceReextract 强制重提取。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { TEMPLATES, TemplateThumb } from '@/components/packaging/PackagingTemplates';
import { Icon } from '@/components/ui/Icon';
import type { GroupCommandInput } from '@/components/final-edit/command-types';
import type { PackagingLayouts, PackagingVars } from '@/lib/final-edit/packaging-vars';
import type { PackagingStickerDefaults, PackagingStickerInstance } from '@/lib/media-core/packaging-stickers';
import type { FinalEditGroupView } from '@/lib/final-edit/types';
import { FontPicker, type SystemFontItem } from './FontPicker';
import styles from './mixcut-content.module.css';

type FontSlotKey = 'titleFont' | 'subtitleFont' | 'pointFont';

/** 组级写命令（与 PreviewStep 的 applyGroup 入参同构，避免反向 import）。 */
export type PackagingGroupCommand = GroupCommandInput | ((group: FinalEditGroupView) => GroupCommandInput);
export type PackagingCardTab = 'settings' | 'stickers';

/** 包装预览 JSON（/packaging-preview?format=json）。 */
export interface PackagingPreviewData {
  vars: PackagingVars;
  defaults: PackagingVars;
  frameUrl: string;
  timeline: {
    coverSec: number;
    totalSec: number;
    pointCues: Array<{ id?: string; text: string; startSec: number; endSec: number }>;
    pointCuesMode: 'timed' | 'even' | 'none';
  };
  layouts?: PackagingLayouts;
  stickers: PackagingStickerInstance[];
  stickerDefaults: PackagingStickerDefaults;
  pointCuesStale?: boolean;
  pointCuesEdited?: boolean;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body as T;
}

/** Partial<PackagingVars>（值可缺省）→ 命令要求的 Record<string, string>。 */
function overridesRecord(overrides: Partial<PackagingVars>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') record[key] = value;
  }
  return record;
}

interface ConfigPatch {
  enabled?: boolean;
  template?: string;
  varsOverrides?: Record<string, string>;
  titleFont?: { family: string; file: string } | null;
  subtitleFont?: { family: string; file: string } | null;
  pointFont?: { family: string; file: string } | null;
  layouts?: PackagingLayouts;
  forceReextract?: boolean;
}

function fontSlotPatch(slotKey: FontSlotKey, value: { family: string; file: string } | null): ConfigPatch {
  if (slotKey === 'titleFont') return { titleFont: value };
  if (slotKey === 'subtitleFont') return { subtitleFont: value };
  return { pointFont: value };
}

/** 悬停放大预览卡（fixed 定位：rightCol 是滚动容器，absolute 向左越界会被裁）。 */
function TemplateHoverPreview({ tpl, top, left }: { tpl: { id: string; name: string; desc: string }; top: number; left: number }) {
  return (
    <span className={styles.tplPreview} style={{ top, left }} aria-hidden="true">
      <TemplateThumb template={tpl.id} />
      <span className={styles.tplPreviewName}>{tpl.name}</span>
      <span className={styles.tplPreviewDesc}>{tpl.desc}</span>
    </span>
  );
}

export function PackagingCard({ group, variantId, preview, previewError, busy, activeTab, stickerPanel, onTabChange, onApplyGroup, onSeek, onPreviewVarsMerge, onPreviewRefresh }: {
  group: FinalEditGroupView;
  variantId: string;
  preview: PackagingPreviewData | null;
  previewError: string;
  busy: boolean;
  activeTab: PackagingCardTab;
  stickerPanel: ReactNode;
  onTabChange: (tab: PackagingCardTab) => void;
  onApplyGroup: (request: PackagingGroupCommand) => Promise<boolean>;
  onSeek: (sec: number) => void;
  onPreviewVarsMerge: (saved: Partial<PackagingVars>) => void;
  onPreviewRefresh: () => void;
}) {
  const config = group.packaging;
  const [fontBusy, setFontBusy] = useState(false);
  const [fontMessage, setFontMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 模板悬停放大预览：250ms 延迟浮出，移走即关；fixed 定位（rightCol 滚动容器内 absolute 向左越界会被裁）
  const [hoverTpl, setHoverTpl] = useState<{ id: string; top: number; left: number } | null>(null);
  const hoverTimerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(hoverTimerRef.current), []);
  const showTplPreview = (templateId: string, el: HTMLElement) => {
    window.clearTimeout(hoverTimerRef.current);
    const rect = el.getBoundingClientRect();
    hoverTimerRef.current = window.setTimeout(() => {
      const width = 210;
      const top = Math.min(Math.max(8, rect.top + rect.height / 2 - 170), window.innerHeight - 340 - 8);
      setHoverTpl({ id: templateId, top, left: rect.left - width - 10 });
    }, 250);
  };
  const hideTplPreview = () => {
    window.clearTimeout(hoverTimerRef.current);
    setHoverTpl(null);
  };

  // 瞬态值入 ref：命令组装读最新配置与回调，不为这些回调新增渲染订阅
  const configRef = useRef(config);
  const onApplyGroupRef = useRef(onApplyGroup);
  const onPreviewVarsMergeRef = useRef(onPreviewVarsMerge);
  const onPreviewRefreshRef = useRef(onPreviewRefresh);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { onApplyGroupRef.current = onApplyGroup; });
  useEffect(() => { onPreviewVarsMergeRef.current = onPreviewVarsMerge; });
  useEffect(() => { onPreviewRefreshRef.current = onPreviewRefresh; });

  // 换组/换草稿/换模板 → 清字体操作提示
  const scopeKey = `${group.id}|${variantId}|${config.template}`;
  const prevScopeRef = useRef(scopeKey);
  useEffect(() => {
    if (prevScopeRef.current === scopeKey) return;
    prevScopeRef.current = scopeKey;
    setFontMessage('');
  }, [scopeKey]);

  const saveConfigPatch = useCallback((patch: ConfigPatch): Promise<boolean> => {
    const current = configRef.current;
    return onApplyGroupRef.current({
      type: 'set_packaging_config',
      config: {
        enabled: patch.enabled ?? current.enabled,
        template: patch.template ?? current.template,
        varsOverrides: patch.varsOverrides ?? overridesRecord(current.varsOverrides),
        ...(patch.titleFont !== undefined ? { titleFont: patch.titleFont } : {}),
        ...(patch.subtitleFont !== undefined ? { subtitleFont: patch.subtitleFont } : {}),
        ...(patch.pointFont !== undefined ? { pointFont: patch.pointFont } : {}),
        ...(patch.layouts !== undefined ? { layouts: patch.layouts } : {}),
        ...(patch.forceReextract !== undefined ? { forceReextract: patch.forceReextract } : {}),
      },
    });
  }, []);

  const handleFontSelect = useCallback(async (slotKey: FontSlotKey, entry: SystemFontItem, materializedFile: string) => {
    setFontMessage('');
    await saveConfigPatch(fontSlotPatch(slotKey, { family: entry.nameZh || entry.family, file: materializedFile }));
  }, [saveConfigPatch]);

  const handleFontClear = useCallback(async (slotKey: FontSlotKey) => {
    setFontMessage('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    await saveConfigPatch(fontSlotPatch(slotKey, null));
  }, [saveConfigPatch]);

  const uploadFont = useCallback(async (file: File) => {
    if (fontBusy) return;
    setFontBusy(true);
    setFontMessage('');
    try {
      const form = new FormData();
      form.append('font', file);
      form.append('slot', 'point');
      const result = await readJson<{ font: string | null }>(await fetch('/api/packaging/user-font', { method: 'POST', body: form }));
      // 自定义上传记入卖点槽（内容寻址文件名必变 → 叠加层经重载键联动刷新）
      if (result.font) await saveConfigPatch({ pointFont: { family: file.name.replace(/\.[^.]+$/, ''), file: result.font } });
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) {
      setFontMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setFontBusy(false);
    }
  }, [fontBusy, saveConfigPatch]);

  const templateMeta = TEMPLATES.find((item) => item.id === config.template) || TEMPLATES[0];
  const disabled = busy || fontBusy;
  const hasOverrides = Object.keys(config.varsOverrides).length > 0;

  const toggleEnabled = () => {
    if (busy) return;
    void saveConfigPatch({ enabled: !config.enabled });
  };

  const selectTemplate = (templateId: string) => {
    if (disabled || templateId === config.template) return;
    void saveConfigPatch({ template: templateId });
  };

  const resetVars = () => {
    if (disabled || !preview) return;
    void (async () => {
      const saved = await saveConfigPatch({ varsOverrides: {} });
      if (saved) onPreviewVarsMergeRef.current(preview.defaults);
    })();
  };

  const jumpToCover = () => {
    if (!preview) return;
    onSeek(preview.timeline.coverSec / 2);
  };

  const resetLayouts = () => {
    if (disabled) return;
    if (!window.confirm(`恢复「${templateMeta.name}」的默认版式？\n该模板下所有手动调整的卖点位置与缩放将被清除（其他模板不受影响）。`)) return;
    void saveConfigPatch({ layouts: { [config.template]: {} } });
  };

  const reextractPoints = () => {
    if (disabled) return;
    if (!window.confirm('按当前口播重新提取卖点？\n将清空手动修改的卖点与正片卖点布局（封面布局保留），并恢复口播变化自动重提取。')) return;
    void (async () => {
      const saved = await saveConfigPatch({ forceReextract: true });
      if (saved) onPreviewRefreshRef.current();
    })();
  };

  return (
    <section className={styles.rcard}>
      <h4><Icon name="film" size={15} />视频包装</h4>
      <div className={styles.ctlRow} style={{ justifyContent: 'space-between' }}>
        <span className={styles.cardSub} style={{ marginTop: 0 }}>
          {config.enabled ? `已启用 · ${templateMeta.name}` : '未启用：导出渲染直接发布无包装原片'}
        </span>
        <button
          type="button"
          className={`${styles.pkSwitch} ${config.enabled ? styles.pkSwitchOn : ''}`}
          role="switch"
          aria-checked={config.enabled}
          aria-label="启用视频包装"
          disabled={busy}
          onClick={toggleEnabled}
        >
          <span className={styles.pkSwitchLabel}>{config.enabled ? '已开启' : '已关闭'}</span>
          <span className={styles.pkSwitchKnob} />
        </button>
      </div>
      <div
        className={`${styles.previewModeTabs} ${styles.packagingTabs}`}
        role="tablist"
        aria-label="视频包装设置"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const next: PackagingCardTab = activeTab === 'settings' ? 'stickers' : 'settings';
          onTabChange(next);
          const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
          buttons[next === 'settings' ? 0 : 1]?.focus();
        }}
      >
        <button
          type="button"
          role="tab"
          id="packaging-settings-tab"
          aria-controls="packaging-settings-panel"
          aria-selected={activeTab === 'settings'}
          tabIndex={activeTab === 'settings' ? 0 : -1}
          className={`${styles.previewModeTab} ${activeTab === 'settings' ? styles.previewModeTabActive : ''}`}
          onClick={() => onTabChange('settings')}
        >包装设置</button>
        <button
          type="button"
          role="tab"
          id="packaging-stickers-tab"
          aria-controls="packaging-stickers-panel"
          aria-selected={activeTab === 'stickers'}
          tabIndex={activeTab === 'stickers' ? 0 : -1}
          className={`${styles.previewModeTab} ${activeTab === 'stickers' ? styles.previewModeTabActive : ''}`}
          onClick={() => onTabChange('stickers')}
        >贴纸</button>
      </div>
      <div id="packaging-settings-panel" role="tabpanel" aria-labelledby="packaging-settings-tab" hidden={activeTab !== 'settings'}>
      {!config.enabled && (
        <p className={styles.hintLine}>开启后可选择模板、字体与文案，包装层直接叠加在预览窗口并同步播放。</p>
      )}
      {config.enabled && (
        <>
          <div className={`${styles.tplGrid} ${styles.tplGridCompact}`} role="radiogroup" aria-label="包装模板">
            {TEMPLATES.map((item) => (
              <button
                type="button"
                key={item.id}
                role="radio"
                aria-checked={config.template === item.id}
                className={`${styles.tplCard} ${config.template === item.id ? styles.tplCardActive : ''}`}
                disabled={disabled}
                onClick={() => selectTemplate(item.id)}
                onMouseEnter={(event) => showTplPreview(item.id, event.currentTarget)}
                onMouseLeave={hideTplPreview}
                onFocus={(event) => showTplPreview(item.id, event.currentTarget)}
                onBlur={hideTplPreview}
                title={item.desc}
              >
                <TemplateThumb template={item.id} />
                <span className={styles.tplName}>{item.name}</span>
              </button>
            ))}
            {hoverTpl && (
              <TemplateHoverPreview
                tpl={TEMPLATES.find((item) => item.id === hoverTpl.id) || TEMPLATES[0]}
                top={hoverTpl.top}
                left={hoverTpl.left}
              />
            )}
          </div>

          <div className={styles.pkFontRows}>
            {([['titleFont', '主标题字体', config.titleFont ?? null, 'title'], ['subtitleFont', '副标题字体', config.subtitleFont ?? null, 'subtitle'], ['pointFont', '卖点字体', config.pointFont ?? null, 'point']] as const).map(([key, label, current, slot]) => (
              <div className={styles.pkFontRow} key={key}>
                <span className={styles.pkFontLabel}>{label}</span>
                <FontPicker
                  current={current}
                  slot={slot}
                  onSelect={(entry, file) => void handleFontSelect(key, entry, file)}
                  onSelectNone={() => void handleFontClear(key)}
                  disabled={disabled}
                />
                {key === 'pointFont' && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".ttf,.otf,.woff2"
                      style={{ display: 'none' }}
                      aria-hidden="true"
                      tabIndex={-1}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadFont(file);
                        else event.target.value = '';
                      }}
                    />
                    <button type="button" className={styles.btn} disabled={disabled} onClick={() => fileInputRef.current?.click()} title="上传自定义字体文件">
                      {fontBusy ? '处理中…' : '上传字体'}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
          {fontMessage && <p className={styles.exportBlocker}><Icon name="alert" size={14} />{fontMessage}</p>}

          {previewError ? (
            <p className={styles.exportBlocker}><Icon name="alert" size={14} />{previewError}</p>
          ) : (
            <p className={styles.hintLine} style={{ marginTop: 12 }}>双击预览画面中的标题/卖点文字可直接修改；留空则该元素不显示。</p>
          )}

          {preview?.pointCuesStale && preview?.pointCuesEdited ? (
            <p className={styles.hintLine} style={{ color: '#B25E00' }}>口播已变化，可重新提取卖点</p>
          ) : null}

          <div className={styles.ctlRow} style={{ marginTop: 12 }}>
            <button type="button" className={`${styles.btn} ${styles.small}`} disabled={disabled || !preview} onClick={jumpToCover} title="跳到封面段中点并暂停，便于查看封面包装">跳到封面</button>
            <button type="button" className={`${styles.btn} ${styles.small}`} disabled={disabled} onClick={resetLayouts} title="清除当前模板下所有手动调整的卖点位置与缩放">恢复默认版式</button>
            <button type="button" className={`${styles.btn} ${styles.small}`} disabled={disabled} onClick={reextractPoints} title="按当前口播重新提取正片卖点">重新提取卖点</button>
            <button type="button" className={`${styles.btn} ${styles.small}`} disabled={disabled || !hasOverrides} onClick={resetVars} title="清除所有手动修改的文案，恢复自动推导文案">恢复默认文案</button>
          </div>
          <p className={styles.hintLine}>预览为近似效果，最终以导出渲染为准。</p>
        </>
      )}
      </div>
      <div id="packaging-stickers-panel" role="tabpanel" aria-labelledby="packaging-stickers-tab" hidden={activeTab !== 'stickers'}>
        {stickerPanel}
      </div>
    </section>
  );
}
