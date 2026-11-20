'use client';

import { useState } from 'react';
import { EmptyState, GroupHeading, Tag } from '@/components/ui/Appearance';
import { Icon } from '@/components/ui/Icon';
import { analysisSourceIds, type FilmPoint, type FilmState } from './types';
import { SourceSummary } from './UploadStage';
import styles from './one-click-film.module.css';

/**
 * 第二步 · 分析内容：核对产品名称、外观线索、候选卖点及来源。
 * 产品名有效且至少勾选一项有内容、有来源的卖点，才能「确认内容，去生成脚本」。
 */
export function AnalysisStage({
  state,
  busy,
  onBack,
  onReanalyze,
  onConfirmed,
}: {
  state: FilmState;
  busy: boolean;
  onBack: () => void;
  onReanalyze: () => void;
  onConfirmed: () => void;
}) {
  const analysis = state.analysis;
  // 以分析版本为键保存本地编辑：切换版本时自动回到该版本的原始内容，
  // 不用在 effect 里同步（React 19 禁止渲染期 setState 级联）。
  const [edits, setEdits] = useState<{ key: string; productName: string; points: FilmPoint[] } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const analysisKey = analysis ? `${analysis.id}:${analysis.confirmedAt ?? ''}` : '';
  const productName = edits?.key === analysisKey
    ? edits.productName
    : analysis?.confirmedProductName || analysis?.productName || '';
  const points: FilmPoint[] = edits?.key === analysisKey ? edits.points : analysis?.points ?? [];
  const setProductName = (value: string) => setEdits({ key: analysisKey, productName: value, points });
  const setPoints = (updater: (current: FilmPoint[]) => FilmPoint[]) => setEdits({
    key: analysisKey,
    productName,
    points: updater(points),
  });

  if (!analysis) {
    return <div className={styles.stage}>
      <div className={styles.stageBody}>
        <EmptyState
          icon="sparkle"
          title="还没有分析结果"
          description={analysisSourceIds(state).length === 0
            ? '先上传素材，再发起分析。'
            : '回到上传页点「分析素材」，系统会识别产品名称、外观与卖点。'}
        />
      </div>
      <div className={styles.stageFoot}>
        <p className={styles.hint}>分析会读取本项目的场景图与详情页。</p>
        <div className={styles.footActions}>
          <button type="button" className="cap" onClick={onBack}>回到上传素材</button>
        </div>
      </div>
    </div>;
  }

  if (analysis.status === 'failed') {
    return <div className={styles.stage}>
      <div className={styles.stageBody}>
        <EmptyState
          icon="alert"
          title="分析没有完成"
          description={analysis.errorMessage || '识别失败，可以换一张更清晰的图片后重试。'}
        />
      </div>
      <div className={styles.stageFoot}>
        <p className={styles.hintFail}>{analysis.errorMessage || '识别失败'}</p>
        <div className={styles.footActions}>
          <button type="button" className="cap" onClick={onBack}>回到上传素材</button>
          <button type="button" className="cap cap-primary" disabled={busy} onClick={onReanalyze}>重新分析</button>
        </div>
      </div>
    </div>;
  }

  if (analysis.status !== 'succeeded') {
    return <div className={styles.stage}>
      <div className={styles.stageBody}>
        <EmptyState icon="sparkle" title="正在识别素材…" description="读取产品名称、外观线索与卖点来源，稍等一下。" />
      </div>
    </div>;
  }

  const selected = points.filter((point) => point.selected && point.text.trim());
  const selectedSourced = selected.filter((point) => point.sourceImageId || point.evidenceRefs.length > 0);
  const canConfirm = Boolean(productName.trim()) && selectedSourced.length > 0;

  const toggle = (index: number) => {
    setPoints((current) => current.map((point, i) => (i === index ? { ...point, selected: !point.selected } : point)));
  };
  const edit = (index: number, text: string) => {
    setPoints((current) => current.map((point, i) => (i === index ? { ...point, text, edited: true } : point)));
  };

  const confirm = async () => {
    setError('');
    if (!productName.trim()) { setError('产品名称不能为空。'); return; }
    if (selectedSourced.length === 0) { setError('至少勾选一项有内容的卖点。'); return; }
    if (selectedSourced.length !== selected.length) {
      setError('有卖点缺少来源图片，不能确认。请取消勾选或重新分析。');
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/one-click-film/${state.project.id}/analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'confirm',
          analysisId: analysis.id,
          productName,
          points: points.map((point) => ({ text: point.text, selected: point.selected })),
        }),
      });
      const body = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.message || body.error || '确认失败');
      onConfirmed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return <div className={styles.stage}>
    <div className={styles.stageBody}>
      <div className={styles.analysisTop}>
        <div className={styles.analysisField}>
          <label htmlFor="ocf-product-name">产品名称</label>
          <input
            id="ocf-product-name"
            className="input-field"
            value={productName}
            onChange={(event) => setProductName(event.target.value)}
            placeholder="例如 云朵床"
          />
        </div>
        <div className={styles.analysisMeta}>
          <Tag tone="idle">分析 v{analysis.versionNumber}</Tag>
          {analysis.confirmedAt ? <Tag tone="ok">已确认</Tag> : <Tag tone="warn">待确认</Tag>}
          {analysis.appearance ? <small title={analysis.appearance}>{analysis.appearance}</small> : null}
        </div>
      </div>

      <GroupHeading action={<small className={styles.hint}>改写或排除不支持的卖点，勾选的才会进入脚本。</small>}>
        候选卖点 · 已选 {selectedSourced.length}/{points.length}
      </GroupHeading>
      <div className={styles.pointList}>
        {points.map((point, index) => {
          const sourced = Boolean(point.sourceImageId) || point.evidenceRefs.length > 0;
          return <div key={`${analysis.id}-${index}`} className={styles.pointRow} data-selected={point.selected}>
            <input
              type="checkbox"
              checked={point.selected}
              onChange={() => toggle(index)}
              aria-label={`选用卖点 ${index + 1}`}
            />
            <div className={styles.pointBody}>
              <input
                className="input-field"
                value={point.text}
                onChange={(event) => edit(index, event.target.value)}
                aria-label={`卖点 ${index + 1} 文字`}
              />
              <div className={styles.pointMeta}>
                <Tag tone={sourced ? 'ok' : 'fail'}>{sourced ? point.sourceLabel || '有来源' : '缺少来源'}</Tag>
                <Tag tone="idle">{point.kind === 'appearance' ? '外观' : point.kind === 'usage' ? '使用动作' : '功能主张'}</Tag>
                {point.edited ? <small>已改写</small> : null}
              </div>
            </div>
          </div>;
        })}
      </div>

      <GroupHeading>本次来源</GroupHeading>
      <SourceSummary images={state.images.filter((image) => analysisSourceIds(state).includes(image.id))} />
    </div>

    <div className={styles.stageFoot}>
      <p className={error ? styles.hintFail : canConfirm ? styles.hint : styles.hintWarn} role={error ? 'alert' : undefined}>
        {error || (canConfirm ? '确认后，选用的卖点会带入脚本页。' : '产品名有效且至少勾选一项有来源的卖点，才能去生成脚本。')}
      </p>
      <div className={styles.footActions}>
        <button type="button" className="cap" onClick={onBack}>回到上传素材</button>
        <button type="button" className="cap" disabled={busy} onClick={onReanalyze}>
          <Icon name="sparkle" size={14} />重新分析
        </button>
        <button type="button" className="cap cap-primary" disabled={!canConfirm || saving} onClick={() => void confirm()} data-testid="one-click-film-confirm">
          {saving ? '保存中…' : '确认内容，去生成脚本'}
        </button>
      </div>
    </div>
  </div>;
}
