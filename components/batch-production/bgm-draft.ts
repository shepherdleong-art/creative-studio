/**
 * 批量「检查成片」BGM 本地草稿的纯决策模块。
 *
 * 曲目、音量、淡入、淡出共同组成一份 musicDraft：任一字段与服务端当前值不同，
 * 「应用 BGM 更改」都可点。草稿只在两种情况下对齐服务端真值——
 * 1) 换 plan（丢弃未应用的修改）；
 * 2) 服务端真值本身变化（如应用成功、其他来源写入）。
 * 其他编辑命令触发的静默视图刷新一律保留本地草稿，不覆盖用户未应用的调整。
 */

export interface BatchBgmDraft {
  trackId: string | null;
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export function bgmDraftDiffers(draft: BatchBgmDraft, server: BatchBgmDraft): boolean {
  return draft.trackId !== server.trackId
    || draft.gainDb !== server.gainDb
    || draft.fadeInSec !== server.fadeInSec
    || draft.fadeOutSec !== server.fadeOutSec;
}

export interface BgmDraftViewLoadInput {
  planId: string;
  /** 上一次完成对齐时的 planId；null 表示尚未对齐过。 */
  syncedPlanId: string | null;
  /** 上一次完成对齐时的服务端 BGM 真值；null 表示尚未对齐过。 */
  syncedServerMusic: BatchBgmDraft | null;
  serverMusic: BatchBgmDraft;
  currentDraft: BatchBgmDraft;
}

export interface BgmDraftViewLoadResult {
  /** true 表示草稿必须对齐服务端真值；false 表示保留 currentDraft。 */
  resync: boolean;
  draft: BatchBgmDraft;
  syncedPlanId: string;
  syncedServerMusic: BatchBgmDraft;
}

export function resolveBgmDraftAfterViewLoad(input: BgmDraftViewLoadInput): BgmDraftViewLoadResult {
  const planChanged = input.planId !== input.syncedPlanId;
  const serverChanged = input.syncedServerMusic == null
    || bgmDraftDiffers(input.syncedServerMusic, input.serverMusic);
  const resync = planChanged || serverChanged;
  return {
    resync,
    draft: resync ? input.serverMusic : input.currentDraft,
    syncedPlanId: input.planId,
    syncedServerMusic: input.serverMusic,
  };
}
