import { Icon } from '@/components/ui/Icon';
import type { MixcutContextResponse } from '@/lib/final-edit/types';
import styles from './MixcutPanel.module.css';

type ShotSet = MixcutContextResponse['shotSets'][number];

function formatDuration(durationUs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationUs / 1_000_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

export function MixcutSidebar({
  shotSets,
  activeShotSetId,
  selectedCount,
  availableVideoCount,
  onSelectShotSet,
  disabled,
}: {
  shotSets: ShotSet[];
  activeShotSetId: string | null;
  selectedCount: number;
  availableVideoCount: number;
  onSelectShotSet: (shotSetId: string) => void;
  disabled?: boolean;
}) {
  const active = shotSets.find((shotSet) => shotSet.id === activeShotSetId) ?? null;

  return (
    <aside className={styles.sidebar} aria-label="当前素材组">
      <p className={styles.eyebrow}>当前素材组</p>
      <h2>{active?.name || '暂无分镜组'}</h2>

      <label className={styles.groupPicker}>
        <span className={styles.groupIcon}><Icon name="film" size={17} /></span>
        <span>
          <strong>模块 4 分镜组</strong>
          <select
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
          <small>{active ? `${active.shotCount} 个分镜 · ${active.succeededVideoCount} 条完成视频` : '请先到模块 2 创建分镜组'}</small>
        </span>
      </label>

      <div className={styles.statGrid}>
        <div><strong>{availableVideoCount}</strong><span>可用视频</span></div>
        <div><strong>{selectedCount}</strong><span>已选素材</span></div>
        <div><strong>{formatDuration(active?.totalDurationUs ?? 0)}</strong><span>视频时长</span></div>
        <div><strong>独立</strong><span>素材范围</span></div>
      </div>

      <div className={styles.scopeNotice}>
        <Icon name="lock" size={15} />
        <span>只会使用当前组的视频，其他分镜组不会混入本次匹配。</span>
      </div>
    </aside>
  );
}
