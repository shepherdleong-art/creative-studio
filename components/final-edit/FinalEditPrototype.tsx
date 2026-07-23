'use client';

/* eslint-disable @next/next/no-img-element -- local generated media is intentionally served by project APIs */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import styles from './FinalEditPrototype.module.css';

type WorkspaceView = 'setup' | 'group' | 'editor';
type InspectorTab = 'subtitle' | 'cover' | 'framing' | 'audio';
type CueDragMode = 'move' | 'start' | 'end';
type CoverPart = 'primary' | 'secondary';

interface SubtitleCue {
  id: string;
  text: string;
  start: number;
  end: number;
}

interface TextStyleState {
  fontFamily: string;
  fontSize: number;
  x: number;
  y: number;
  scale: number;
  color: string;
  align: 'left' | 'center' | 'right';
  safeWidth: number;
  strokeEnabled: boolean;
  strokeColor: string;
  strokeWidth: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowOpacity: number;
  shadowBlur: number;
  shadowDistance: number;
  shadowAngle: number;
}

interface VisualAsset {
  id: string;
  label: string;
  src: string;
}

interface CueDragState {
  cueId: string;
  mode: CueDragMode;
  startX: number;
  start: number;
  end: number;
  previousEnd: number;
  nextStart: number;
}

interface CustomCoverPreset {
  id: string;
  name: string;
  primaryStyle: TextStyleState;
  secondaryStyle: TextStyleState;
}

const TOTAL_DURATION = 18.6;
const INTRO_DURATION = 20 / 24;
const TIMELINE_DURATION = TOTAL_DURATION + INTRO_DURATION;
const MIN_CUE_DURATION = 1 / 24;
const CUSTOM_COVER_PRESET_STORAGE_KEY = 'creative-studio.final-edit.custom-cover-presets.v3';

function imageUrl(filename: string) {
  return `/api/images/outputs/${encodeURIComponent(filename)}`;
}

const VISUAL_ASSETS: VisualAsset[] = [
  {
    id: 'asset-1',
    label: '全景展示',
    src: imageUrl('分镜-PS691-B-模特图-沙发-焦羽胡桃色+黑茶色(3).png'),
  },
  {
    id: 'asset-2',
    label: '舒适坐姿',
    src: imageUrl('分镜-PS691-B-模特图-沙发-焦羽胡桃色+黑茶色(1)-e1c23c.png'),
  },
  {
    id: 'asset-3',
    label: '扶手特写',
    src: imageUrl('分镜-PS691-B-模特图-沙发-焦羽胡桃色+黑茶色(2)-72368a.png'),
  },
  {
    id: 'asset-4',
    label: '材质细节',
    src: imageUrl('分镜-PS691-B-沙发-焦羽胡桃色+黑茶色(4)-r1.png'),
  },
  {
    id: 'asset-5',
    label: '侧面轮廓',
    src: imageUrl('分镜-PS691-B-沙发-焦羽胡桃色+黑茶色(8).png'),
  },
  {
    id: 'asset-6',
    label: '靠背承托',
    src: imageUrl('分镜-PS691-B-模特图-沙发-焦羽胡桃色+黑茶色(9)-r1.png'),
  },
  {
    id: 'asset-7',
    label: '木框结构',
    src: imageUrl('分镜-PS691-B-模特图-沙发-焦羽胡桃色+黑茶色(10).png'),
  },
  {
    id: 'asset-8',
    label: '落座体验',
    src: imageUrl('分镜-PS691-B-模特图-沙发-焦羽胡桃色+黑茶色(12).png'),
  },
  {
    id: 'asset-9',
    label: '空间搭配',
    src: imageUrl('分镜-PS691-B-沙发-焦羽胡桃色+黑茶色(18).png'),
  },
  {
    id: 'asset-10',
    label: '沙发全貌',
    src: imageUrl('分镜-PS691-B-模特图-沙发-焦羽胡桃色+黑茶色(4).png'),
  },
];

const INITIAL_CUES: SubtitleCue[] = [
  { id: 'cue-1', text: '忙碌一天终于可以好好躺下', start: 0, end: 2.85 },
  { id: 'cue-2', text: '六十厘米大座深随心盘腿坐', start: 2.85, end: 5.8 },
  { id: 'cue-3', text: '北美FAS级橡木框架', start: 5.8, end: 8.15 },
  { id: 'cue-4', text: '搭配细腻柔软的半青皮', start: 8.15, end: 10.65 },
  { id: 'cue-5', text: '分段靠背精准承托腰背', start: 10.65, end: 13.6 },
  { id: 'cue-6', text: '坐下就像被温柔拥抱', start: 13.6, end: 16.05 },
  { id: 'cue-7', text: '这才是客厅该有的松弛感', start: 16.05, end: 18.6 },
];

const DEFAULT_SUBTITLE_STYLE: TextStyleState = {
  fontFamily: 'PingFang SC',
  fontSize: 56,
  x: 50,
  y: 78,
  scale: 1,
  color: '#ffffff',
  align: 'center',
  safeWidth: 860,
  strokeEnabled: true,
  strokeColor: '#101010',
  strokeWidth: 4,
  shadowEnabled: true,
  shadowColor: '#000000',
  shadowOpacity: 70,
  shadowBlur: 2,
  shadowDistance: 5,
  shadowAngle: 45,
};

const DEFAULT_COVER_PRIMARY_STYLE: TextStyleState = {
  ...DEFAULT_SUBTITLE_STYLE,
  fontSize: 84,
  y: 19,
  safeWidth: 820,
  strokeWidth: 3,
  shadowBlur: 8,
  shadowDistance: 8,
};

const DEFAULT_COVER_SECONDARY_STYLE: TextStyleState = {
  ...DEFAULT_COVER_PRIMARY_STYLE,
  fontSize: 72,
  y: 31,
  color: '#2f7cf6',
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatTime(value: number) {
  const safe = Math.max(0, value);
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`;
}

function percent(value: number) {
  return `${(value / TIMELINE_DURATION) * 100}%`;
}

export default function FinalEditPrototype({ projectName }: { projectName: string }) {
  const [view, setView] = useState<WorkspaceView>('editor');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('subtitle');
  const [variant, setVariant] = useState(1);
  const [script, setScript] = useState('脚本 A · 温柔包裹的居家慢时光');
  const [voice, setVoice] = useState('Cherry · 温柔女声');
  const [speed, setSpeed] = useState(1);
  const [count, setCount] = useState(2);
  const [ratio, setRatio] = useState('3:4');
  const [generating, setGenerating] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const [cues, setCues] = useState(INITIAL_CUES);
  const [selectedCueId, setSelectedCueId] = useState('cue-3');
  const [subtitleStyle, setSubtitleStyle] = useState(DEFAULT_SUBTITLE_STYLE);
  const [coverPart, setCoverPart] = useState<CoverPart>('primary');
  const [coverPrimaryStyle, setCoverPrimaryStyle] = useState(DEFAULT_COVER_PRIMARY_STYLE);
  const [coverSecondaryStyle, setCoverSecondaryStyle] = useState(DEFAULT_COVER_SECONDARY_STYLE);
  const [coverTitlePrimary, setCoverTitlePrimary] = useState('温柔包裹的居家');
  const [coverTitleSecondary, setCoverTitleSecondary] = useState('慢时光');
  const [customCoverPresets, setCustomCoverPresets] = useState<CustomCoverPreset[]>([]);
  const [customPresetName, setCustomPresetName] = useState('');
  const [currentTime, setCurrentTime] = useState(INTRO_DURATION + 6.35);
  const [playing, setPlaying] = useState(false);
  const [previewAssetId, setPreviewAssetId] = useState('asset-1');
  const [bgmGain, setBgmGain] = useState(-16);
  const [bgm, setBgm] = useState('热茶中的温暖.mp3');
  const [saved, setSaved] = useState(true);
  const [historyMessage, setHistoryMessage] = useState('');
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<CueDragState | null>(null);

  const selectedCue = cues.find((cue) => cue.id === selectedCueId) || cues[0];
  const previewAsset = VISUAL_ASSETS.find((asset) => asset.id === previewAssetId) || VISUAL_ASSETS[0];
  const bodyTime = currentTime - INTRO_DURATION;
  const activeCue = cues.find((cue) => bodyTime >= cue.start && bodyTime < cue.end) || selectedCue;

  useEffect(() => {
    const raw = window.localStorage.getItem(CUSTOM_COVER_PRESET_STORAGE_KEY);
    if (!raw) return;
    const timer = window.setTimeout(() => {
      try {
        const stored = JSON.parse(raw) as CustomCoverPreset[];
        if (Array.isArray(stored)) {
          setCustomCoverPresets(stored.filter((item) => item?.id && item?.name && item?.primaryStyle && item?.secondaryStyle));
        }
      } catch {
        window.localStorage.removeItem(CUSTOM_COVER_PRESET_STORAGE_KEY);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setCurrentTime((value) => {
        const next = value + 0.04;
        if (next >= TIMELINE_DURATION) {
          setPlaying(false);
          return TIMELINE_DURATION;
        }
        return next;
      });
    }, 40);
    return () => window.clearInterval(timer);
  }, [playing]);

  const markChanged = () => {
    setSaved(false);
    window.setTimeout(() => setSaved(true), 650);
  };

  const startGeneration = () => {
    setGenerating(true);
    window.setTimeout(() => {
      setGenerating(false);
      setView('group');
    }, 850);
  };

  const updateCueText = (id: string, text: string) => {
    setCues((items) => items.map((cue) => (cue.id === id ? { ...cue, text } : cue)));
    markChanged();
  };

  const beginCueDrag = (event: React.PointerEvent, cueId: string, mode: CueDragMode) => {
    const index = cues.findIndex((cue) => cue.id === cueId);
    const cue = cues[index];
    if (!cue) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = {
      cueId,
      mode,
      startX: event.clientX,
      start: cue.start,
      end: cue.end,
      previousEnd: index > 0 ? cues[index - 1].end : 0,
      nextStart: index < cues.length - 1 ? cues[index + 1].start : TOTAL_DURATION,
    };
    setSelectedCueId(cueId);
  };

  const moveCueDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const timeline = timelineRef.current;
    if (!drag || !timeline) return;
    const secondsDelta = ((event.clientX - drag.startX) / timeline.getBoundingClientRect().width) * TIMELINE_DURATION;
    setCues((items) => items.map((cue) => {
      if (cue.id !== drag.cueId) return cue;
      if (drag.mode === 'start') {
        return { ...cue, start: clamp(drag.start + secondsDelta, drag.previousEnd, drag.end - MIN_CUE_DURATION) };
      }
      if (drag.mode === 'end') {
        return { ...cue, end: clamp(drag.end + secondsDelta, drag.start + MIN_CUE_DURATION, drag.nextStart) };
      }
      const duration = drag.end - drag.start;
      const start = clamp(drag.start + secondsDelta, drag.previousEnd, drag.nextStart - duration);
      return { ...cue, start, end: start + duration };
    }));
    setSaved(false);
  };

  const endCueDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    markChanged();
  };

  const scrubTimeline = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-cue]')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setCurrentTime(clamp(((event.clientX - rect.left) / rect.width) * TIMELINE_DURATION, 0, TIMELINE_DURATION));
  };

  const saveCustomCoverPreset = () => {
    const nextPreset: CustomCoverPreset = {
      id: `custom-${Date.now()}`,
      name: customPresetName.trim() || `我的预设 ${customCoverPresets.length + 1}`,
      primaryStyle: { ...coverPrimaryStyle },
      secondaryStyle: { ...coverSecondaryStyle },
    };
    setCustomCoverPresets((items) => {
      const next = [...items, nextPreset];
      window.localStorage.setItem(CUSTOM_COVER_PRESET_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setCustomPresetName('');
    setHistoryMessage(`已保存自定义预设「${nextPreset.name}」`);
    window.setTimeout(() => setHistoryMessage(''), 1200);
  };

  const applyCustomCoverPreset = (preset: CustomCoverPreset) => {
    setCoverPrimaryStyle({ ...preset.primaryStyle });
    setCoverSecondaryStyle({ ...preset.secondaryStyle });
    setHistoryMessage(`已应用自定义预设「${preset.name}」`);
    window.setTimeout(() => setHistoryMessage(''), 1200);
    markChanged();
  };

  const deleteCustomCoverPreset = (presetId: string) => {
    setCustomCoverPresets((items) => {
      const next = items.filter((item) => item.id !== presetId);
      window.localStorage.setItem(CUSTOM_COVER_PRESET_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const fakeHistory = (message: string) => {
    setHistoryMessage(message);
    window.setTimeout(() => setHistoryMessage(''), 1200);
  };

  return (
    <section className={styles.breakout} aria-label="成片剪辑 UI 交互预览">
      <div className={styles.shell}>
        <header className={styles.workspaceHeader}>
          <div>
            <div className={styles.eyebrow}>第五步 · 成片剪辑 <span>UI 交互预览</span></div>
            <h2>{projectName}</h2>
          </div>
          <nav className={styles.viewSwitch} aria-label="成片工作流页面">
            {([
              ['setup', '1', '生成设置'],
              ['group', '2', '成片组'],
              ['editor', '3', '单条编辑'],
            ] as const).map(([id, index, label]) => (
              <button key={id} type="button" className={view === id ? styles.activeView : ''} onClick={() => setView(id)}>
                <span>{index}</span>{label}
              </button>
            ))}
          </nav>
          <div className={styles.headerActions}>
            <span className={saved ? styles.saved : styles.saving}>{saved ? '已自动保存' : '保存中…'}</span>
            <button type="button" className={styles.secondaryButton}><Icon name="download" size={15} />整组导出</button>
          </div>
        </header>

        {view === 'setup' && (
          <SetupView
            script={script}
            setScript={setScript}
            voice={voice}
            setVoice={setVoice}
            speed={speed}
            setSpeed={setSpeed}
            count={count}
            setCount={setCount}
            ratio={ratio}
            setRatio={setRatio}
            generating={generating}
            previewingVoice={previewingVoice}
            setPreviewingVoice={setPreviewingVoice}
            onGenerate={startGeneration}
          />
        )}

        {view === 'group' && (
          <GroupView variant={variant} setVariant={setVariant} onOpenEditor={() => setView('editor')} />
        )}

        {view === 'editor' && (
          <div className={styles.editor}>
            <div className={styles.editorTopbar}>
              <div className={styles.variantTabs}>
                {[1, 2].map((item) => (
                  <button key={item} type="button" className={variant === item ? styles.activeVariant : ''} onClick={() => setVariant(item)}>
                    成片 {String(item).padStart(2, '0')}
                    <span>{item === 1 ? '18.6s' : '18.9s'}</span>
                  </button>
                ))}
                <button type="button" className={styles.addVariant} title="增加一条成片"><Icon name="plus" size={15} /></button>
              </div>
              <div className={styles.topbarTools}>
                <button type="button" onClick={() => fakeHistory('已撤销上一步操作')} title="撤销"><Icon name="retry" size={16} /></button>
                <button type="button" onClick={() => fakeHistory('已恢复上一步操作')} title="重做"><Icon name="retry" size={16} className={styles.flipIcon} /></button>
                <span className={styles.divider} />
                <button type="button" className={styles.exportButton}><Icon name="download" size={15} />导出当前成片</button>
              </div>
              {historyMessage && <div className={styles.toast}>{historyMessage}</div>}
            </div>

            <div className={styles.editorMain}>
              <aside className={styles.leftSidebar}>
                <div className={styles.panelHeading}><div><strong>视频素材</strong><span>当前分镜组</span></div><span>{VISUAL_ASSETS.length} 条</span></div>
                <AssetPool assets={VISUAL_ASSETS} selectedId={previewAssetId} onSelect={setPreviewAssetId} />
              </aside>

              <main className={styles.previewColumn}>
                <div className={styles.previewToolbar}>
                  <span>画面预览</span>
                  <div>
                    <button type="button" className={ratio === '3:4' ? styles.activeMiniButton : ''} onClick={() => setRatio('3:4')}>3:4</button>
                    <button type="button" className={ratio === '9:16' ? styles.activeMiniButton : ''} onClick={() => setRatio('9:16')}>9:16</button>
                    <button type="button" className={ratio === '16:9' ? styles.activeMiniButton : ''} onClick={() => setRatio('16:9')}>16:9</button>
                    <button type="button" title="全屏预览"><Icon name="maximize" size={15} /></button>
                  </div>
                </div>
                <PreviewCanvas
                  asset={previewAsset}
                  ratio={ratio}
                  cue={activeCue}
                  currentTime={currentTime}
                  coverTitlePrimary={coverTitlePrimary}
                  coverTitleSecondary={coverTitleSecondary}
                  subtitleStyle={subtitleStyle}
                  coverPrimaryStyle={coverPrimaryStyle}
                  coverSecondaryStyle={coverSecondaryStyle}
                />
                <div className={styles.playbackBar}>
                  <button type="button" onClick={() => setCurrentTime(0)} title="回到开头"><Icon name="skip-back" size={17} /></button>
                  <button type="button" className={styles.playButton} aria-label={playing ? '暂停预览' : '播放预览'} onClick={() => setPlaying((value) => !value)}>
                    <Icon name={playing ? 'pause' : 'play'} size={17} />
                  </button>
                  <span>{formatTime(currentTime)} <em>/ {formatTime(TIMELINE_DURATION)}</em></span>
                  <input aria-label="播放进度" type="range" min={0} max={TIMELINE_DURATION} step={0.01} value={currentTime} onChange={(event) => setCurrentTime(Number(event.target.value))} />
                  <button type="button" title="预览声音"><Icon name="monitor" size={16} /></button>
                </div>
              </main>

              <aside className={styles.inspector}>
                <div className={styles.inspectorTabs}>
                  {([
                    ['subtitle', '字幕'],
                    ['cover', '封面'],
                    ['framing', '画面'],
                    ['audio', '音频'],
                  ] as const).map(([id, label]) => (
                    <button type="button" key={id} className={inspectorTab === id ? styles.activeInspectorTab : ''} onClick={() => setInspectorTab(id)}>{label}</button>
                  ))}
                </div>
                <div className={styles.inspectorScroll}>
                  {inspectorTab === 'subtitle' && selectedCue && (
                    <>
                      <InspectorHeading title="字幕属性" description="修改只影响显示文字，不改变配音。" />
                      <label className={styles.fieldLabel}>字幕文字</label>
                      <input aria-label="字幕文字" className={styles.darkInput} value={selectedCue.text} onChange={(event) => updateCueText(selectedCue.id, event.target.value.replace(/\n/g, ''))} />
                      <div className={styles.timelineEditHint}><Icon name="film" size={15} /><div><strong>{formatTime(selectedCue.start)} — {formatTime(selectedCue.end)}</strong><span>直接在下方时间轴拖动字幕块或左右边缘调节时间；字幕不允许重叠。</span></div></div>
                      <TextStyleControls kind="subtitle" value={subtitleStyle} onChange={(next) => { setSubtitleStyle(next); markChanged(); }} />
                    </>
                  )}
                  {inspectorTab === 'cover' && (
                    <>
                      <InspectorHeading title="封面标题" description="默认使用两段式标题，独立封面 JPG 与前 20 帧保持一致。" />
                      <CustomCoverPresetPicker
                        presets={customCoverPresets}
                        presetName={customPresetName}
                        setPresetName={setCustomPresetName}
                        onApply={applyCustomCoverPreset}
                        onDelete={deleteCustomCoverPreset}
                        onSave={saveCustomCoverPreset}
                      />
                      <div className={styles.coverPartSwitch} aria-label="选择要编辑的标题段落">
                        <button type="button" className={coverPart === 'primary' ? styles.activeCoverPart : ''} onClick={() => setCoverPart('primary')}>
                          <span style={{ background: coverPrimaryStyle.color }} />第一段
                        </button>
                        <button type="button" className={coverPart === 'secondary' ? styles.activeCoverPart : ''} onClick={() => setCoverPart('secondary')}>
                          <span style={{ background: coverSecondaryStyle.color }} />第二段
                        </button>
                      </div>
                      <div className={styles.coverPartHint}><Icon name="check" size={14} /><span>两段标题的位置、字体、颜色、描边和阴影完全独立。</span></div>
                      {coverPart === 'primary' ? (
                        <div className={styles.coverPartEditor}>
                          <label className={styles.fieldLabel}>第一段文字</label>
                          <input aria-label="封面标题第一段" className={styles.darkInput} value={coverTitlePrimary} onChange={(event) => { setCoverTitlePrimary(event.target.value.replace(/\n/g, '')); markChanged(); }} />
                          <TextStyleControls kind="cover" value={coverPrimaryStyle} defaultValue={DEFAULT_COVER_PRIMARY_STYLE} onChange={(next) => { setCoverPrimaryStyle(next); markChanged(); }} />
                        </div>
                      ) : (
                        <div className={styles.coverPartEditor}>
                          <label className={styles.fieldLabel}>第二段文字</label>
                          <input aria-label="封面标题第二段" className={styles.darkInput} value={coverTitleSecondary} onChange={(event) => { setCoverTitleSecondary(event.target.value.replace(/\n/g, '')); markChanged(); }} />
                          <TextStyleControls kind="cover" value={coverSecondaryStyle} defaultValue={DEFAULT_COVER_SECONDARY_STYLE} onChange={(next) => { setCoverSecondaryStyle(next); markChanged(); }} />
                        </div>
                      )}
                    </>
                  )}
                  {inspectorTab === 'framing' && (
                    <FramingControls selectedAsset={previewAsset} onSelectAsset={setPreviewAssetId} />
                  )}
                  {inspectorTab === 'audio' && (
                    <AudioControls bgm={bgm} setBgm={setBgm} gain={bgmGain} setGain={(value) => { setBgmGain(value); markChanged(); }} />
                  )}
                </div>
              </aside>
            </div>

            <Timeline
              cues={cues}
              selectedCueId={selectedCueId}
              currentTime={currentTime}
              timelineRef={timelineRef}
              onScrub={scrubTimeline}
              onPointerMove={moveCueDrag}
              onPointerUp={endCueDrag}
              onBeginCueDrag={beginCueDrag}
              onSelectCue={(cue) => {
                setSelectedCueId(cue.id);
                setCurrentTime(INTRO_DURATION + cue.start + 0.02);
                setInspectorTab('subtitle');
              }}
              bgm={bgm}
              gain={bgmGain}
            />

            <footer className={styles.issueBar}>
              <button type="button"><span className={styles.blockingDot} />1 个阻断问题</button>
              <span>第 2 条成片存在 0.7 秒画面缺口，补齐后才能导出。</span>
              <button type="button" onClick={() => setInspectorTab('framing')}>定位并补素材 <Icon name="chevron-right" size={14} /></button>
            </footer>
          </div>
        )}
      </div>
    </section>
  );
}

function SetupView({
  script, setScript, voice, setVoice, speed, setSpeed, count, setCount, ratio, setRatio,
  generating, previewingVoice, setPreviewingVoice, onGenerate,
}: {
  script: string;
  setScript: (value: string) => void;
  voice: string;
  setVoice: (value: string) => void;
  speed: number;
  setSpeed: (value: number) => void;
  count: number;
  setCount: (value: number) => void;
  ratio: string;
  setRatio: (value: string) => void;
  generating: boolean;
  previewingVoice: boolean;
  setPreviewingVoice: (value: boolean) => void;
  onGenerate: () => void;
}) {
  return (
    <div className={styles.setupView}>
      <div className={styles.setupIntro}>
        <span className={styles.sectionNumber}>01</span>
        <div>
          <h3>从脚本开始生成成片</h3>
          <p>选择配音与输出规格后，系统分析当前分镜组的全部成功视频，生成配音并自动剪辑。</p>
        </div>
      </div>
      <div className={styles.setupGrid}>
        <section className={styles.setupCard}>
          <div className={styles.setupCardTitle}><Icon name="file-text" size={18} /><div><strong>脚本</strong><span>字幕和配音均使用这份脚本</span></div></div>
          <label>选择脚本</label>
          <select value={script} onChange={(event) => setScript(event.target.value)}>
            <option>脚本 A · 温柔包裹的居家慢时光</option>
            <option>脚本 B · 客厅里的高级呼吸感</option>
            <option>脚本 C · 久坐也舒服的实木沙发</option>
          </select>
          <div className={styles.scriptPreview}>忙碌了一整天，最治愈的时刻就是窝进沙发里。六十厘米大座深，可以让你随心盘腿坐……</div>
          <div className={styles.metaRow}><span>7 个字幕段落</span><span>目标约 15 秒</span></div>
        </section>

        <section className={styles.setupCard}>
          <div className={styles.setupCardTitle}><Icon name="monitor" size={18} /><div><strong>配音</strong><span>试听和正式生成使用相同语速</span></div></div>
          <label>音色</label>
          <select value={voice} onChange={(event) => setVoice(event.target.value)}>
            <option>Cherry · 温柔女声</option>
            <option>Serena · 知性女声</option>
            <option>Ethan · 沉稳男声</option>
            <option>Chelsie · 明亮女声</option>
          </select>
          <label>语速 <b>{speed.toFixed(2)}x</b></label>
          <div className={styles.rangeWithValue}>
            <input type="range" min={0.75} max={1.5} step={0.05} value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
            <input type="number" min={0.75} max={1.5} step={0.05} value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
          </div>
          <button type="button" className={styles.previewVoiceButton} onClick={() => setPreviewingVoice(!previewingVoice)}>
            <Icon name={previewingVoice ? 'stop' : 'play'} size={14} />
            {previewingVoice ? '停止试听' : '试听示例句'}
          </button>
        </section>

        <section className={styles.setupCard}>
          <div className={styles.setupCardTitle}><Icon name="film" size={18} /><div><strong>输出</strong><span>一次生成多条不同素材组合</span></div></div>
          <label>生成数量</label>
          <div className={styles.choiceRow}>
            {[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} className={count === value ? styles.selectedChoice : ''} onClick={() => setCount(value)}>{value} 条</button>)}
          </div>
          <label>画面比例</label>
          <div className={styles.ratioChoices}>
            {['3:4', '9:16', '16:9'].map((value) => <button type="button" key={value} className={ratio === value ? styles.selectedChoice : ''} onClick={() => setRatio(value)}>{value}</button>)}
          </div>
          <div className={styles.capacityNote}><Icon name="check" size={14} />当前组有 12 条成功视频，预计可以生成 {count} 条草稿。</div>
        </section>
      </div>
      <div className={styles.setupFooter}>
        <div><strong>预计结果</strong><span>{count} 条 {ratio} 成片 · 实际时长以 TTS 为准 · 默认硬切</span></div>
        <button type="button" onClick={onGenerate} disabled={generating}>{generating ? '正在分析素材…' : '分析素材并生成成片'}</button>
      </div>
    </div>
  );
}

function GroupView({ variant, setVariant, onOpenEditor }: { variant: number; setVariant: (value: number) => void; onOpenEditor: () => void }) {
  return (
    <div className={styles.groupView}>
      <div className={styles.groupSummary}>
        <div><span className={styles.sectionNumber}>02</span><div><h3>脚本 A · 温柔包裹的居家慢时光</h3><p>Cherry · 1.00x · 3:4 · 2 条成片</p></div></div>
        <button type="button"><Icon name="plus" size={15} />继续生成</button>
      </div>
      <div className={styles.variantGrid}>
        {[0, 1].map((index) => {
          const item = index + 1;
          const asset = VISUAL_ASSETS[index];
          return (
            <article key={item} className={`${styles.variantCard} ${variant === item ? styles.selectedVariantCard : ''}`} onClick={() => setVariant(item)}>
              <div className={styles.variantCover} style={{ backgroundImage: `url("${asset.src}")` }}>
                <span>成片 {String(item).padStart(2, '0')}</span>
                <strong>{item === 1 ? '温柔包裹的居家慢时光' : '坐下就不想起来的沙发'}</strong>
              </div>
              <div className={styles.variantInfo}>
                <div><strong>{item === 1 ? '18.6 秒' : '18.9 秒'}</strong><span>{item === 1 ? '7 段视频 · 7 条字幕' : '6 段视频 · 7 条字幕'}</span></div>
                <div className={styles.variantMeta}><span>BGM · 热茶中的温暖</span><span>素材重合度 {item === 1 ? '42%' : '58%'}</span></div>
                <div className={styles.variantStatus}><span className={item === 1 ? styles.readyDot : styles.warnDot} />{item === 1 ? '可导出' : '有 1 个画面缺口'}</div>
                <button type="button" onClick={(event) => { event.stopPropagation(); setVariant(item); onOpenEditor(); }}>打开编辑器 <Icon name="chevron-right" size={14} /></button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function AssetPool({ assets, selectedId, onSelect }: { assets: VisualAsset[]; selectedId: string; onSelect: (id: string) => void }) {
  return (
    <div className={styles.assetPanel}>
      <div className={styles.assetFilter}><button type="button" className={styles.activeAssetFilter}>推荐</button><button type="button">全部素材</button><button type="button">使用中</button></div>
      <p>当前分镜组 · {assets.length} 条成功视频</p>
      <div className={styles.assetScroller}>
        <div className={styles.assetGrid}>
          {assets.map((asset, index) => (
            <button type="button" key={asset.id} className={selectedId === asset.id ? styles.selectedAsset : ''} onClick={() => onSelect(asset.id)}>
              <img src={asset.src} alt={asset.label} />
              <span>{asset.label}</span>
              <small>已使用 {index === 3 ? 0 : (index % 3) + 1}/3</small>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.assetTip}>点击素材可替换当前预览画面；拖入时间轴用于插入新片段。</div>
    </div>
  );
}

function PreviewCanvas({
  asset, ratio, cue, currentTime, coverTitlePrimary, coverTitleSecondary,
  subtitleStyle, coverPrimaryStyle, coverSecondaryStyle,
}: {
  asset: VisualAsset;
  ratio: string;
  cue: SubtitleCue;
  currentTime: number;
  coverTitlePrimary: string;
  coverTitleSecondary: string;
  subtitleStyle: TextStyleState;
  coverPrimaryStyle: TextStyleState;
  coverSecondaryStyle: TextStyleState;
}) {
  const isCover = currentTime < INTRO_DURATION;
  const makePreviewTextStyle = (textStyle: TextStyleState): React.CSSProperties => {
    const shadowAngle = (textStyle.shadowAngle * Math.PI) / 180;
    const shadowX = Math.cos(shadowAngle) * textStyle.shadowDistance * 0.35;
    const shadowY = Math.sin(shadowAngle) * textStyle.shadowDistance * 0.35;
    return {
      left: `${textStyle.x}%`,
      top: `${textStyle.y}%`,
      width: `${Math.min(94, (textStyle.safeWidth / 1080) * 100)}%`,
      color: textStyle.color,
      fontFamily: textStyle.fontFamily,
      fontSize: `${clamp(textStyle.fontSize * 0.43, 12, 42)}px`,
      textAlign: textStyle.align,
      transform: `translate(-50%, -50%) scale(${textStyle.scale})`,
      WebkitTextStroke: textStyle.strokeEnabled ? `${Math.max(1, textStyle.strokeWidth * 0.42)}px ${textStyle.strokeColor}` : undefined,
      textShadow: textStyle.shadowEnabled ? `${shadowX}px ${shadowY}px ${textStyle.shadowBlur * 0.35}px color-mix(in srgb, ${textStyle.shadowColor} ${textStyle.shadowOpacity}%, transparent)` : undefined,
    };
  };
  return (
    <div className={`${styles.previewStage} ${styles[`preview${ratio.replace(':', '')}`]}`}>
      <img src={asset.src} alt={asset.label} />
      <div className={styles.previewSafeArea} />
      {isCover ? (
        <>
          <div className={`${styles.previewText} ${styles.coverText}`} style={makePreviewTextStyle(coverPrimaryStyle)}>{coverTitlePrimary}</div>
          <div className={`${styles.previewText} ${styles.coverText}`} style={makePreviewTextStyle(coverSecondaryStyle)}>{coverTitleSecondary}</div>
        </>
      ) : (
        <div className={`${styles.previewText} ${styles.subtitleText}`} style={makePreviewTextStyle(subtitleStyle)}>{cue.text}</div>
      )}
      <span className={styles.previewBadge}>{isCover ? '封面 · 第 1—20 帧' : asset.label}</span>
    </div>
  );
}

function InspectorHeading({ title, description }: { title: string; description: string }) {
  return <div className={styles.inspectorHeading}><h3>{title}</h3><p>{description}</p></div>;
}

function TextStyleControls({ kind, value, defaultValue, onChange }: { kind: 'subtitle' | 'cover'; value: TextStyleState; defaultValue?: TextStyleState; onChange: (value: TextStyleState) => void }) {
  const update = <K extends keyof TextStyleState>(key: K, next: TextStyleState[K]) => onChange({ ...value, [key]: next });
  return (
    <div className={styles.styleControls}>
      <div className={styles.sectionTitle}>文字样式 <button type="button" onClick={() => onChange(defaultValue || DEFAULT_SUBTITLE_STYLE)}>恢复默认</button></div>
      <label className={styles.fieldLabel}>系统字体</label>
      <select className={styles.darkInput} value={value.fontFamily} onChange={(event) => update('fontFamily', event.target.value)}>
        <option>PingFang SC</option><option>Microsoft YaHei</option><option>Songti SC</option><option>STKaiti</option><option>Arial</option>
      </select>
      <SliderField label="字号" value={value.fontSize} min={18} max={140} step={1} suffix="px" onChange={(next) => update('fontSize', next)} />
      <div className={styles.twoColumnControls}>
        <SliderField label="X 位置" value={value.x} min={0} max={100} step={1} suffix="%" onChange={(next) => update('x', next)} />
        <SliderField label="Y 位置" value={value.y} min={0} max={100} step={1} suffix="%" onChange={(next) => update('y', next)} />
      </div>
      <SliderField label="等比缩放" value={value.scale} min={0.5} max={2} step={0.05} suffix="x" onChange={(next) => update('scale', next)} />
      <ColorField label="文字颜色" value={value.color} onChange={(next) => update('color', next)} />
      <div className={styles.alignmentControl}><span>对齐</span><div>{(['left', 'center', 'right'] as const).map((align) => <button type="button" key={align} className={value.align === align ? styles.activeAlign : ''} onClick={() => update('align', align)}>{align === 'left' ? '左' : align === 'center' ? '中' : '右'}</button>)}</div></div>
      <SliderField label={kind === 'subtitle' ? '单行安全宽度' : '文本框宽度'} value={value.safeWidth} min={320} max={1040} step={10} suffix="px" onChange={(next) => update('safeWidth', next)} />

      <div className={styles.effectHeader}><label><input type="checkbox" checked={value.strokeEnabled} onChange={(event) => update('strokeEnabled', event.target.checked)} />描边</label><span>{value.strokeEnabled ? '已启用' : '已关闭'}</span></div>
      {value.strokeEnabled && <div className={styles.effectBody}><ColorField label="颜色" value={value.strokeColor} onChange={(next) => update('strokeColor', next)} /><SliderField label="粗细" value={value.strokeWidth} min={0} max={20} step={1} suffix="px" onChange={(next) => update('strokeWidth', next)} /></div>}

      <div className={styles.effectHeader}><label><input type="checkbox" checked={value.shadowEnabled} onChange={(event) => update('shadowEnabled', event.target.checked)} />阴影</label><span>{value.shadowEnabled ? '已启用' : '已关闭'}</span></div>
      {value.shadowEnabled && <div className={styles.effectBody}>
        <ColorField label="颜色" value={value.shadowColor} onChange={(next) => update('shadowColor', next)} />
        <SliderField label="不透明度" value={value.shadowOpacity} min={0} max={100} step={1} suffix="%" onChange={(next) => update('shadowOpacity', next)} />
        <SliderField label="模糊度" value={value.shadowBlur} min={0} max={40} step={1} suffix="px" onChange={(next) => update('shadowBlur', next)} />
        <SliderField label="距离" value={value.shadowDistance} min={0} max={40} step={1} suffix="px" onChange={(next) => update('shadowDistance', next)} />
        <SliderField label="角度" value={value.shadowAngle} min={-180} max={180} step={1} suffix="°" onChange={(next) => update('shadowAngle', next)} />
      </div>}
    </div>
  );
}

function CustomCoverPresetPicker({
  presets, presetName, setPresetName, onApply, onDelete, onSave,
}: {
  presets: CustomCoverPreset[];
  presetName: string;
  setPresetName: (value: string) => void;
  onApply: (preset: CustomCoverPreset) => void;
  onDelete: (presetId: string) => void;
  onSave: () => void;
}) {
  return (
    <section className={styles.customPresetSection}>
      <div className={styles.customPresetHeader}><strong>我的标题预设</strong><span>保存两段样式与位置，不保存文案</span></div>
      {presets.length > 0 ? (
        <div className={styles.customPresetList}>
          {presets.map((preset) => (
            <div key={preset.id} className={styles.customPresetItem}>
              <button type="button" className={styles.applyCustomPreset} onClick={() => onApply(preset)}>
                <span className={styles.customPresetSwatches}><i style={{ background: preset.primaryStyle.color }} /><i style={{ background: preset.secondaryStyle.color }} /></span>
                <strong>{preset.name}</strong>
              </button>
              <button type="button" className={styles.deleteCustomPreset} aria-label={`删除自定义预设 ${preset.name}`} onClick={() => onDelete(preset.id)}><Icon name="trash" size={12} /></button>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.customPresetEmpty}>还没有自定义预设。调整两段标题后，可在这里保存。</div>
      )}
      <div className={styles.saveCustomPresetRow}>
        <input aria-label="自定义预设名称" value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="例如：门店统一封面" />
        <button type="button" onClick={onSave}><Icon name="plus" size={13} />保存当前样式</button>
      </div>
    </section>
  );
}

function SliderField({ label, value, min, max, step, suffix, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix: string; onChange: (value: number) => void }) {
  return <label className={styles.sliderField}><span>{label}</span><div><input aria-label={`${label}滑块`} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /><label><input aria-label={`${label}数值`} type="number" min={min} max={max} step={step} value={Number(value.toFixed(2))} onChange={(event) => onChange(Number(event.target.value))} /><small>{suffix}</small></label></div></label>;
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className={styles.colorField} title={label}><span>{label}</span><div><input aria-label={label} type="color" value={value} onChange={(event) => onChange(event.target.value)} /><input value={value} onChange={(event) => onChange(event.target.value)} /></div></label>;
}

function FramingControls({ selectedAsset, onSelectAsset }: { selectedAsset: VisualAsset; onSelectAsset: (id: string) => void }) {
  const [scale, setScale] = useState(1.08);
  const [x, setX] = useState(0);
  const [y, setY] = useState(-4);
  return <><InspectorHeading title="画面与片段" description="每个视频片段可独立调整取景。" /><div className={styles.currentAsset}><img src={selectedAsset.src} alt={selectedAsset.label} /><div><strong>{selectedAsset.label}</strong><span>当前时间轴片段</span></div><button type="button" onClick={() => onSelectAsset(VISUAL_ASSETS[(VISUAL_ASSETS.findIndex((asset) => asset.id === selectedAsset.id) + 1) % VISUAL_ASSETS.length].id)}>替换</button></div><SliderField label="画面缩放" value={scale} min={1} max={2} step={0.01} suffix="x" onChange={setScale} /><SliderField label="水平位置" value={x} min={-100} max={100} step={1} suffix="%" onChange={setX} /><SliderField label="垂直位置" value={y} min={-100} max={100} step={1} suffix="%" onChange={setY} /><button type="button" className={styles.unbindButton}><Icon name="lock" size={14} />解除脚本绑定</button><p className={styles.inlineHint}>解除后仍可手动放置该素材，AI 重组不会再把它视为当前文案的固定画面。</p></>;
}

function AudioControls({ bgm, setBgm, gain, setGain }: { bgm: string; setBgm: (value: string) => void; gain: number; setGain: (value: number) => void }) {
  return <><InspectorHeading title="配音与 BGM" description="正文从第 21 帧开始，视频素材原声始终关闭。" /><label className={styles.fieldLabel}>BGM 曲目</label><select className={styles.darkInput} value={bgm} onChange={(event) => setBgm(event.target.value)}><option>热茶中的温暖.mp3</option><option>午后窗边.mp3</option><option>慢慢生活.mp3</option></select><SliderField label="音乐音量" value={gain} min={-40} max={0} step={1} suffix="dB" onChange={setGain} /><div className={styles.audioRules}><div><Icon name="check" size={14} /><span>响度统一后默认 -16 dB</span></div><div><Icon name="check" size={14} /><span>随 TTS 结束自动淡出</span></div><div><Icon name="check" size={14} /><span>曲目过短时平滑循环</span></div><div><Icon name="lock" size={14} /><span>不启用 ducking</span></div></div></>;
}

function Timeline({
  cues, selectedCueId, currentTime, timelineRef, onScrub, onPointerMove, onPointerUp,
  onBeginCueDrag, onSelectCue, bgm, gain,
}: {
  cues: SubtitleCue[];
  selectedCueId: string;
  currentTime: number;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  onScrub: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: () => void;
  onBeginCueDrag: (event: React.PointerEvent, cueId: string, mode: CueDragMode) => void;
  onSelectCue: (cue: SubtitleCue) => void;
  bgm: string;
  gain: number;
}) {
  const clips = [
    { start: 0, end: 3.6, asset: VISUAL_ASSETS[0] },
    { start: 3.6, end: 7.3, asset: VISUAL_ASSETS[1] },
    { start: 7.3, end: 10.8, asset: VISUAL_ASSETS[2] },
    { start: 10.8, end: 14.5, asset: VISUAL_ASSETS[3] },
    { start: 14.5, end: 18.6, asset: VISUAL_ASSETS[0] },
  ];
  return (
    <div className={styles.timelineShell}>
      <div className={styles.timelineToolbar}><div><button type="button"><Icon name="plus" size={14} />添加轨道</button><button type="button"><Icon name="minus" size={14} />缩小</button><button type="button"><Icon name="plus" size={14} />放大</button></div><span>24 fps · 正文 {TOTAL_DURATION.toFixed(1)}s · 总时长 {(TOTAL_DURATION + INTRO_DURATION).toFixed(1)}s</span></div>
      <div className={styles.timelineGrid}>
        <div className={styles.trackLabels}>
          <div className={styles.rulerSpacer} />
          <div><Icon name="file-text" size={14} /><span>字幕</span></div>
          <div><Icon name="film" size={14} /><span>视频</span></div>
          <div><Icon name="lock" size={13} /><span>TTS</span></div>
          <div><Icon name="lock" size={13} /><span>BGM</span></div>
        </div>
        <div className={styles.timelineViewport} ref={timelineRef} onPointerDown={onScrub} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div className={styles.ruler}>{[0, 3, 6, 9, 12, 15, 18].map((time) => <span key={time} style={{ left: percent(time) }}>{time}s</span>)}</div>
          <div className={`${styles.track} ${styles.subtitleTrack}`}>
            {cues.map((cue) => <div key={cue.id} data-cue role="button" tabIndex={0} aria-label={`字幕时间块：${cue.text}`} className={`${styles.timelineCue} ${selectedCueId === cue.id ? styles.selectedTimelineCue : ''}`} style={{ left: percent(INTRO_DURATION + cue.start), width: percent(cue.end - cue.start) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelectCue(cue); }} onPointerDown={(event) => { onSelectCue(cue); onBeginCueDrag(event, cue.id, 'move'); }}><span className={styles.cueHandle} onPointerDown={(event) => onBeginCueDrag(event, cue.id, 'start')} /><b>{cue.text}</b><span className={styles.cueHandle} onPointerDown={(event) => onBeginCueDrag(event, cue.id, 'end')} /></div>)}
          </div>
          <div className={`${styles.track} ${styles.videoTrack}`}><div className={styles.coverBlock} style={{ left: 0, width: percent(INTRO_DURATION) }}>20帧封面</div>{clips.map((clip, index) => <div key={`${clip.asset.id}-${index}`} className={styles.videoClip} style={{ left: percent(INTRO_DURATION + clip.start), width: percent(clip.end - clip.start), backgroundImage: `url("${clip.asset.src}")` }}><span>{clip.asset.label}</span><button type="button" title="删除片段"><Icon name="trash" size={12} /></button></div>)}</div>
          <div className={`${styles.track} ${styles.ttsTrack}`}><div className={styles.audioBlock} style={{ left: percent(INTRO_DURATION), width: percent(TOTAL_DURATION) }}><span>Cherry · 1.00x</span><small>第 21 帧开始 · 锁定</small></div></div>
          <div className={`${styles.track} ${styles.bgmTrack}`}><div className={styles.bgmBlock} style={{ left: percent(INTRO_DURATION), width: percent(TOTAL_DURATION) }}><span>{bgm}</span><small>{gain} dB · 第 21 帧开始 · 自动淡出</small></div></div>
          <div className={styles.introBoundary} style={{ left: percent(INTRO_DURATION) }}><span>正文开始</span></div>
          <div className={styles.playhead} style={{ left: percent(currentTime) }}><span /></div>
        </div>
      </div>
    </div>
  );
}
