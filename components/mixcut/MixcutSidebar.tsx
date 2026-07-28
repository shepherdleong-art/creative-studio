import { Icon } from '@/components/ui/Icon';
import type { MixcutContextResponse } from '@/lib/final-edit/types';
import styles from './MixcutPanel.module.css';

type ShotSet = MixcutContextResponse['shotSets'][number];

export interface MixcutSessionItem {
  id: string;
  title: string;
  versionLabel: string;
  shotSetName: string;
  status: string;
  variantCount: number;
  speed: number;
  createdAt: string;
}

const SESSION_STATUS_LABELS: Record<string, string> = {
  editing: '编辑中',
  queued: '排队中',
  running: '生成中',
  ready: '就绪',
  partial: '部分就绪',
  failed: '失败',
};

function formatDuration(durationUs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationUs / 1_000_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function formatSessionTime(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function MixcutSidebar({
  shotSets,
  activeShotSetId,
  selectedCount,
  availableVideoCount,
  stepOverview,
  sessions,
  activeSessionId,
  onSelectSession,
  onSelectShotSet,
  disabled,
}: {
  shotSets: ShotSet[];
  activeShotSetId: string | null;
  selectedCount: number;
  availableVideoCount: number;
  stepOverview: { label: string; detail: string };
  sessions: MixcutSessionItem[];
  activeSessionId: string | null;
  onSelectSession: (groupId: string) => void;
  onSelectShotSet: (shotSetId: string) => void;
  disabled?: boolean;
}) {
  const active = shotSets.find((shotSet) => shotSet.id === activeShotSetId) ?? null;

  return (
    <>
      <section className={styles.panel}>
        <h3><Icon name="film" size={15} />当前素材组</h3>
        <select
          style={{ width: '100%' }}
          value={activeShotSetId ?? ''}
          onChange={(event) => onSelectShotSet(event.target.value)}
          disabled={disabled || shotSets.length === 0}
          aria-label="选择分镜组"
        >
          {shotSets.length === 0 && <option value="">暂无分镜组</option>}
          {shotSets.map((shotSet) => (
            <option key={shotSet.id} value={shotSet.id}>
              {shotSet.name} · {shotSet.succeededVideoCount} 条视频
            </option>
          ))}
        </select>
        <div className={styles.hintLine}>{active ? `${active.shotCount} 个分镜 · ${active.succeededVideoCount} 条完成视频` : '请先到模块 2 创建分镜组'}</div>
      </section>

      <section className={styles.panel}>
        <h3>本组概览</h3>
        <div className={styles.statGrid}>
          <div className={styles.stat}><b>{availableVideoCount}</b><span>可用视频</span></div>
          <div className={`${styles.stat} ${styles.statAccent}`}><b>{selectedCount}</b><span>将参与混剪</span></div>
          <div className={styles.stat}><b>{formatDuration(active?.totalDurationUs ?? 0)}</b><span>视频时长</span></div>
          <div className={styles.stat}><b style={{ fontSize: 15 }}>独立</b><span>素材范围</span></div>
        </div>
        <div className={styles.notice} style={{ marginTop: 10 }}>
          <Icon name="lock" size={13} />
          <span>只会使用当前组的视频，其他分镜组不会混入本次匹配。</span>
        </div>
      </section>

      <section className={styles.panel}>
        <h3>当前步骤</h3>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{stepOverview.label}</div>
        <div className={styles.hintLine} style={{ marginTop: 2 }}>{stepOverview.detail}</div>
      </section>

      {sessions.length > 0 && (
        <section className={`${styles.panel} ${styles.panelGrow}`}>
          <h3>最近会话</h3>
          <div className={styles.panelList}>
            {sessions.map((session) => (
              <button
                type="button"
                className={`${styles.session} ${session.id === activeSessionId ? styles.sessionActive : ''}`}
                key={session.id}
                disabled={disabled}
                onClick={() => onSelectSession(session.id)}
                aria-label={`切换到会话 ${session.title} ${session.versionLabel}`}
                aria-current={session.id === activeSessionId ? 'true' : undefined}
              >
                <div className={styles.sessionT}>{session.title}<span>{session.versionLabel}</span></div>
                <div className={styles.sessionM}>
                  {session.shotSetName} · {session.speed.toFixed(1)}x · {SESSION_STATUS_LABELS[session.status] ?? session.status}
                  {session.variantCount > 0 ? ` · ${session.variantCount} 条草稿` : ''}
                  {session.createdAt ? ` · ${formatSessionTime(session.createdAt)}` : ''}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
