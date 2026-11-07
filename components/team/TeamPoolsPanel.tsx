'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { teamError, teamWrite } from './client';
import PageToolbar from './PageToolbar';
import { GroupHeading, GroupList, StatusDot, Tag, ToolbarButton } from '@/components/ui/Appearance';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import {
  buildPoolAdminView,
  buildPoolChange,
  POOL_KEY_PATTERN,
  type PoolAdminView,
  type PoolViewRow,
  type PoolViewState,
} from '@/lib/team-service/pool-admin-view';
import type { PoolAdminState } from '@/lib/team-service/pools';
import styles from './TeamPoolsPanel.module.css';

/**
 * 模型与名额（13 号票）——管理员端「一个名额池一行」。
 *
 * 这个页面只回答一个问题：**同一个上游账号同时能跑几条**。
 *   - 一行 = 一个名额池 = 同一个上游账号；账号名、类别、名额、当前占用、状态、共用模型数都在行上。
 *   - 名额只填一次：每行的保存只发**一条**池级变更，池下所有模型一起生效。
 *   - 保存沿用现有版本号防冲突：`expectedVersion` 取读到的池版本，冲突由接口整体拒绝。
 *   - 状态只说白话（可以用 / 还没设名额 / 缺密钥 / 已停用），六个内部状态在
 *     `lib/team-service/pool-admin-view.ts` 里映射，映射问题附一句话和去处。
 *   - 内部池编号默认收起，点开「排查用的内部编号」才看。
 *   - 同一凭据被分到不同名额池时页面顶部提醒；只提醒，不自动合并。
 *
 * 准入计数规则没有变：占用照旧按池统计（已占 / 已受理 / 可能已发 / 未发）。
 */
const STATE_TONE: Record<PoolViewState, 'ok' | 'warn' | 'fail' | 'idle'> = {
  ready: 'ok',
  unconfigured: 'warn',
  credential_missing: 'fail',
  disabled: 'idle',
};

const STATE_DOT: Record<PoolViewState, 'ok' | 'warn' | 'fail' | 'idle'> = {
  ready: 'ok',
  unconfigured: 'warn',
  credential_missing: 'fail',
  disabled: 'idle',
};

type Draft = { capacity: string; enabled: boolean; mergeKey: string };

/** 草稿只放「本页可改的东西」；内部池编号不进草稿，避免默认就把编号显示在输入框里。 */
function draftFor(row: PoolViewRow): Draft {
  return { capacity: String(row.capacity), enabled: row.enabled, mergeKey: '' };
}

function capacityError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '请填一个数字';
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return '名额必须是非负整数';
  return null;
}

export default function TeamPoolsPanel() {
  const [state, setState] = useState<PoolAdminState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** 待确认的变化预览：保存前先让管理员看到「容量从几改到几、版本从几变到几」。 */
  const [pending, setPending] = useState<{
    row: PoolViewRow;
    capacity: number;
    enabled: boolean;
    /** 合并：把这一行改到另一个已存在的池键。 */
    targetPoolKey: string | null;
    summary: string;
  } | null>(null);

  const applyState = useCallback((body: PoolAdminState) => {
    setState(body);
    const view = buildPoolAdminView(body);
    // 每次从服务器拿到新状态就重算草稿：保存/刷新后输入框回到服务器值，
    // 不会留下一个「看起来改过、其实没存」的数字。行的 key 稳定，重算不丢焦点。
    setDrafts(Object.fromEntries(view.rows.map((row) => [row.id, draftFor(row)])));
    return view;
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/team/pools', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, '无法读取名额池状态'));
    const body = await response.json() as PoolAdminState;
    applyState(body);
  }, [applyState]);

  useEffect(() => {
    void Promise.resolve().then(refresh).catch((cause) => setError(cause instanceof Error ? cause.message : '无法读取名额池状态'));
  }, [refresh]);

  const view: PoolAdminView | null = useMemo(() => (state ? buildPoolAdminView(state) : null), [state]);

  function updateDraft(id: string, patch: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? { capacity: '0', enabled: true, mergeKey: '' }), ...patch } }));
  }

  function stepCapacity(row: PoolViewRow, delta: number) {
    const draft = drafts[row.id] ?? draftFor(row);
    const parsed = Number(draft.capacity.trim());
    const base = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : row.capacity;
    updateDraft(row.id, { capacity: String(Math.max(0, base + delta)) });
  }

  /** 只有真的改了名额或启用状态才需要保存，避免无意义地推版本号。 */
  function dirtyOf(row: PoolViewRow): { capacity: number; enabled: boolean; changed: boolean; invalid: string | null } {
    const draft = drafts[row.id] ?? draftFor(row);
    const invalid = capacityError(draft.capacity);
    const capacity = invalid ? row.capacity : Number(draft.capacity.trim());
    return {
      capacity,
      enabled: draft.enabled,
      changed: !invalid && (capacity !== row.capacity || draft.enabled !== row.enabled),
      invalid,
    };
  }

  function requestSave(row: PoolViewRow) {
    const dirty = dirtyOf(row);
    setError('');
    setNotice('');
    if (dirty.invalid) {
      setError(`${row.accountName}：${dirty.invalid}。`);
      return;
    }
    if (!dirty.changed) {
      setNotice(`${row.accountName} 的名额没有变化，不需要保存。`);
      return;
    }
    setPending({
      row,
      capacity: dirty.capacity,
      enabled: dirty.enabled,
      targetPoolKey: null,
      summary: buildSummary(row, dirty.capacity, dirty.enabled),
    });
  }

  /**
   * 合并到另一个名额池：管理员自己填目标池编号，页面只做确认，不自动合并。
   * 目标池存在时沿用它的版本号（版本防冲突照旧）；不存在就是新建一个池。
   */
  function requestMerge(row: PoolViewRow) {
    const draft = drafts[row.id] ?? draftFor(row);
    const targetPoolKey = draft.mergeKey.trim();
    setError('');
    setNotice('');
    if (!POOL_KEY_PATTERN.test(targetPoolKey)) {
      setError('名额池编号只能包含字母、数字、点、下划线、冒号和连字符。');
      return;
    }
    if (targetPoolKey === row.poolKey) {
      setNotice('目标名额池和当前一样，不需要合并。');
      return;
    }
    const invalid = capacityError(draft.capacity);
    if (invalid) {
      setError(`${row.accountName}：${invalid}。`);
      return;
    }
    const capacity = Number(draft.capacity.trim());
    const target = view?.rows.find((item) => item.poolKey === targetPoolKey);
    setPending({
      row,
      capacity,
      enabled: draft.enabled,
      targetPoolKey,
      summary: target
        ? `把「${row.accountName}」并进「${target.accountName}」：两个账号共用一个名额池，名额会改成 ${capacity}`
          + `（原来是 ${target.capacity}），实际并发不会超过这个数。`
        // 新池还没有账号名，只能用管理员刚输入的那串编号说清楚目标。
        : `把「${row.accountName}」改到一个新的名额池（编号 ${targetPoolKey}），名额 ${capacity}。`
          + '如果这是同一个上游账号，请改成已有那个池的编号，才能真正共享名额。',
    });
  }

  async function confirmSave() {
    if (!pending) return;
    const { row, capacity, enabled, targetPoolKey } = pending;
    setPending(null);
    setBusyKey(row.id);
    setError('');
    setNotice('');
    try {
      const targetRow = targetPoolKey ? view?.rows.find((item) => item.poolKey === targetPoolKey) : undefined;
      const built = buildPoolChange(row, {
        capacity,
        enabled,
        ...(targetPoolKey ? { targetPoolKey, targetVersion: targetRow?.version ?? 0 } : {}),
      });
      // 先预览：接口会用版本号拦下过期保存，管理员在提交前就能看到结果。
      const previewResponse = await teamWrite('/api/team/pools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: true, changes: [built.preview] }),
      });
      if (!previewResponse.ok) throw new Error(await teamError(previewResponse, '名额保存预览失败'));
      const previewBody = await previewResponse.json() as {
        preview: Array<{ action: 'create' | 'update' | 'noop'; currentVersion: number; nextVersion: number }>;
      };
      const preview = previewBody.preview[0];

      const response = await teamWrite('/api/team/pools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [built.apply] }),
      });
      if (!response.ok) throw new Error(await teamError(response, '名额保存失败'));
      // 提示里只说账号名，不念内部池编号（编号默认是藏起来的）。
      const targetName = targetPoolKey
        ? (targetRow?.accountName ?? '目标名额池')
        : null;
      const rowsInTarget = targetRow?.modelCount ?? row.modelCount;
      setNotice(
        preview.action === 'noop'
          ? `${row.accountName} 的名额已是 ${capacity}，未产生变更。`
          : `${row.accountName} ${targetName ? `已并入「${targetName}」，` : ''}名额已保存为 ${capacity}`
            + `（版本 ${preview.currentVersion} → ${preview.nextVersion}）；共用这个账号的 ${rowsInTarget} 个模型一起生效。`,
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '名额保存失败');
      // 版本冲突意味着本地版本号已过期：重新拉一次，让页面回到最新状态。
      await refresh().catch(() => undefined);
    } finally {
      setBusyKey(null);
    }
  }

  const summaryLine = view
    ? `${view.summary.ready} 个账号可以用，${view.summary.unconfigured} 个没设名额，`
      + `${view.summary.credentialMissing} 个缺密钥${view.summary.disabled > 0 ? `，${view.summary.disabled} 个已停用` : ''}`
    : '正在读取名额池…';

  return (
    <div className={styles.panel}>
      <PageToolbar
        role="admin"
        subtitle={summaryLine}
        actions={
          <ToolbarButton icon="retry" onClick={() => { void refresh().catch(() => setError('刷新失败')); }}>
            刷新
          </ToolbarButton>
        }
      />

      <p className={styles.lead}>
        <b>名额就是同时能跑几条。</b>
        同一个上游账号下的模型共用名额，所以只按账号设一次；调低名额不会打断正在跑的任务，新任务按新名额排队。
        凭据只以指纹参与映射，不会出现在本页或接口响应里。
      </p>

      {view && view.warnings.length > 0 ? (
        <section className={styles.warning} role="status" aria-label="同一凭据被分到多个名额池">
          <strong>同一个上游账号被分到了不同的名额池</strong>
          <ul>
            {view.warnings.map((warning) => <li key={warning.fingerprint}>{warning.message}</li>)}
          </ul>
          <span>只做提醒，不会自动合并；合并需要你在供应商配置里重新保存这个账号。</span>
        </section>
      ) : null}

      {state && !state.ready ? (
        <section className={styles.blockers} aria-label="还没就绪的名额池">
          <b>
            还有 {view ? view.summary.unconfigured + view.summary.credentialMissing : 0} 个账号没配好
          </b>
          <span>
            {view && view.summary.credentialMissing > 0 ? `${view.summary.credentialMissing} 个缺密钥，` : ''}
            {view && view.summary.unconfigured > 0 ? `${view.summary.unconfigured} 个还没设名额。` : ''}
            没配好的账号会阻止新的付费步骤；已受理任务仍可继续收取结果。
            {' '}
            <a href="/settings">去供应商配置</a>
          </span>
        </section>
      ) : null}

      {error ? <p role="alert" className="text-[13px] text-fail">{error}</p> : null}
      {notice ? <p role="status" className="text-[13px] text-ok">{notice}</p> : null}

      <GroupHeading>{view ? `名额池 · ${view.summary.total} 个账号` : '名额池'}</GroupHeading>

      <GroupList>
        {view?.rows.length
          ? view.rows.map((row) => {
            const draft = drafts[row.id] ?? draftFor(row);
            const dirty = dirtyOf(row);
            const open = expanded[row.id] ?? false;
            const busy = busyKey === row.id;
            const full = row.capacity > 0 && row.occupancy.held >= row.capacity;
            return (
              <section
                key={row.id}
                className={styles.account}
                data-testid="pool-row"
                data-pool-key={row.poolKey || undefined}
                data-pool-state={row.state}
                data-pool-configured={row.configured ? 'true' : 'false'}
              >
                <div className={styles.head}>
                  <div className={styles.identity}>
                    <span className={styles.name} data-testid="pool-account-name">{row.accountName}</span>
                    <span className={styles.meta}>
                      <span>{row.kindLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {row.modelCount === 0
                          ? '还没有模型'
                          : row.modelCount === 1
                            ? '1 个模型'
                            : `${row.modelCount} 个模型共用`}
                      </span>
                    </span>
                    {row.statusDetail ? (
                      <span className={styles.detailLine}>
                        {row.statusDetail}
                        {row.nextStep ? <a href={row.nextStep.href}>{row.nextStep.label}</a> : null}
                      </span>
                    ) : null}
                  </div>

                  <div className={styles.stepper}>
                    <button
                      type="button"
                      className={styles.stepperButton}
                      aria-label={`减少 ${row.accountName} 的名额`}
                      disabled={busy || !row.canSave}
                      onClick={() => stepCapacity(row, -1)}
                    >
                      −
                    </button>
                    <input
                      className={styles.capacityInput}
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      aria-label={`${row.accountName} 名额`}
                      value={draft.capacity}
                      disabled={busy || !row.canSave}
                      aria-invalid={dirty.invalid ? true : undefined}
                      onChange={(event) => updateDraft(row.id, { capacity: event.target.value })}
                    />
                    <button
                      type="button"
                      className={styles.stepperButton}
                      aria-label={`增加 ${row.accountName} 的名额`}
                      disabled={busy || !row.canSave}
                      onClick={() => stepCapacity(row, 1)}
                    >
                      +
                    </button>
                  </div>

                  <div className={styles.usage}>
                    <span className={styles.usageText}>
                      <span>正在用</span>
                      <b>{row.occupancy.held} / {row.capacity}</b>
                    </span>
                    <span className={`${styles.bar}${full ? ` ${styles.barFull}` : ''}`}>
                      <i style={{ width: `${row.capacity > 0 ? Math.min(100, (row.occupancy.held / row.capacity) * 100) : 0}%` }} />
                    </span>
                    {/* 行上就要看得全：已占 / 已受理 / 可能已发 / 未发，不用展开。
                     * 每项各自不换行，窄窗口整项折行，不会把「未发 0」拆成两行。 */}
                    <span className={styles.usageDetail}>
                      <span>已占 {row.occupancy.held}</span>
                      <span>已受理 {row.occupancy.accepted}</span>
                      <span>可能已发 {row.occupancy.maybeSent}</span>
                      <span>未发 {row.occupancy.notSent}</span>
                    </span>
                  </div>

                  <div className={styles.statusCell}>
                    {dirty.changed ? (
                      <button
                        type="button"
                        className={`cap cap-primary ${styles.save}`}
                        disabled={busy || !row.canSave}
                        onClick={() => requestSave(row)}
                      >
                        {busy ? '保存中…' : '保存'}
                      </button>
                    ) : (
                      <Tag tone={STATE_TONE[row.state]}>
                        <StatusDot tone={STATE_DOT[row.state]} />
                        {row.statusLabel}
                      </Tag>
                    )}
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.enabled}
                    aria-label={`${row.accountName} 启用`}
                    className={styles.switch}
                    disabled={busy || !row.canSave}
                    onClick={() => updateDraft(row.id, { enabled: !draft.enabled })}
                  />

                  <button
                    type="button"
                    className={styles.expand}
                    aria-expanded={open}
                    aria-label={open ? `收起 ${row.accountName}` : `展开 ${row.accountName}`}
                    onClick={() => setExpanded((current) => ({ ...current, [row.id]: !open }))}
                  >
                    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={15} />
                  </button>
                </div>

                {open ? (
                  <div className={styles.body}>
                    <div className={styles.bodyInner}>
                      <div>
                        <GroupHeading>包含的模型</GroupHeading>
                        <div className={styles.chips}>
                          {row.models.length > 0
                            ? row.models.map((model) => (
                              <span
                                key={model.key}
                                className={`${styles.chip}${model.status === 'ready' ? '' : ` ${styles.chipBad}`}`}
                                title={model.status === 'ready' ? '可以用' : '这个模型还不可用，见上方账号状态'}
                              >
                                {model.label}
                              </span>
                            ))
                            : <span className={styles.muted}>这个账号下还没有登记模型。</span>}
                        </div>
                      </div>

                      <div>
                        <GroupHeading>正在使用</GroupHeading>
                        {row.activeMembers.length > 0 ? (
                          <div className={styles.members}>
                            {row.activeMembers.map((member) => (
                              <div key={member.actorId} className={styles.member}>
                                <span>{member.actorId}</span>
                                <small>占 {member.held} 个，运行 {member.running}，排队 {member.pending}</small>
                              </div>
                            ))}
                          </div>
                        ) : <span className={styles.muted}>现在没人占用。</span>}
                      </div>

                      <div>
                        <GroupHeading>当前占用</GroupHeading>
                        <div className={styles.occupancy}>
                          <span>已占 <b>{row.occupancy.held}</b></span>
                          <span>已受理 <b>{row.occupancy.accepted}</b></span>
                          <span>可能已发 <b>{row.occupancy.maybeSent}</b></span>
                          <span>未发 <b>{row.occupancy.notSent}</b></span>
                        </div>
                        <p className={styles.muted}>
                          结果没确认前继续占名额；下调名额或停用不会释放已受理的占额，也不会中断结果收取。
                        </p>
                      </div>

                      {row.binding ? (
                        <div>
                          <GroupHeading>合并到另一个名额池</GroupHeading>
                          {row.mergeWarning ? <p className={styles.detailLine}>{row.mergeWarning}</p> : null}
                          <div className={styles.mergeRow}>
                            <input
                              className={styles.poolKeyInput}
                              aria-label={`${row.accountName} 合并到名额池编号`}
                              placeholder="例如 media:company"
                              value={draft.mergeKey}
                              disabled={busy || !row.canSave}
                              onChange={(event) => updateDraft(row.id, { mergeKey: event.target.value })}
                            />
                            {draft.mergeKey.trim().length > 0 ? (
                              <button
                                type="button"
                                className={`cap cap-primary ${styles.save}`}
                                disabled={busy || !row.canSave}
                                onClick={() => requestMerge(row)}
                              >
                                合并
                              </button>
                            ) : (
                              <span className={styles.muted}>
                                只提醒不自动合并；确实要合并时把它填成目标池的编号再点合并。
                              </span>
                            )}
                          </div>
                        </div>
                      ) : null}

                      <details className={styles.internal}>
                        <summary>排查用的内部编号</summary>
                        <code>{row.poolKey || '（这个账号还没有池键）'}</code>
                        {row.poolProtocol ? <code>映射协议：{row.poolProtocol}</code> : null}
                        <code>版本：{row.version}{row.configured ? '' : '（尚未保存到服务器）'}</code>
                      </details>
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })
          : (
            <div className="px-4 py-10 text-center text-[13px] text-ink-secondary" role="status">
              还没有任何名额池。先到「供应商配置」填好密钥与网关地址，回到这里就会看到每个账号一行。
            </div>
          )}
      </GroupList>

      <p className={styles.footerHint}>
        内部编号默认收起，展开某一行后点「排查用的内部编号」才能看到。同一个上游的多个 Key 只有在供应商配置里
        显式保存到同一个名额池时才会共享并发；不同网关地址不能合并计容。
      </p>

      <Dialog
        open={pending !== null}
        title="确认改动名额"
        description={pending?.summary ?? undefined}
        onClose={() => setPending(null)}
        footer={
          <>
            <span className="mr-auto text-[12px] text-ink-secondary">
              保存时用读到的版本号防冲突；别人刚改过就会被拒绝并刷新。
            </span>
            <ToolbarButton onClick={() => setPending(null)}>取消</ToolbarButton>
            <ToolbarButton variant="primary" onClick={() => { void confirmSave(); }}>
              {pending?.targetPoolKey ? '确认合并' : '保存名额'}
            </ToolbarButton>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-ink-secondary">
          名额是整个账号的：保存一次，共用这个账号的模型一起按新名额排队。
          正在跑的任务不会被打断。
        </p>
      </Dialog>
    </div>
  );
}

function buildSummary(row: PoolViewRow, capacity: number, enabled: boolean): string {
  const parts = [`「${row.accountName}」的名额从 ${row.capacity} 改成 ${capacity}`];
  if (enabled !== row.enabled) parts.push(enabled ? '并重新启用这个账号' : '并停用这个账号');
  parts.push(`共用这个账号的 ${row.modelCount} 个模型会一起生效。`);
  if (capacity < row.occupancy.held) {
    parts.push(`现在有 ${row.occupancy.held} 个任务正占着名额，它们不会被中断，新任务按新名额排队。`);
  }
  return parts.join('，');
}
