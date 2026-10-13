// §3 包装预览叠加层同步控制器（父页面侧，框架无关）——v2 time() 步进驱动版
//
// v2 重写背景（实测取证）：同源 iframe 与父页面共享主线程，v1 播放态让 iframe 内 GSAP 时间轴
// tl.play() 自由跑（60fps 样式计算），叠加父页视频绘制后在大预览窗口下主线程饱和——视频画面冻结、
// 播放头照走、seek 无响应，关掉包装即恢复。故统一改为「父页面按需步进 tl.time(playhead)」：
// - 播放态：24fps 步进器（与视频帧率同量级），iframe 渲染成本直降 ~60%；时间轴与播放头天然零漂移，
//   v1 的 0.5s 漂移校正器与冗余 play() 初始化一并删除；
// - 暂停态：最小间隔去抖 seek（50ms），目标未变跳过；
// - load 前指令入队，load 后按当前状态恢复（播放→步进器立即校准；暂停→精确停帧）；
// - 文档隐藏恢复（visibilitychange）时强制重校准；attach(null)/destroy 清理全部定时器/队列。
// 全部状态存实例字段（瞬态值），不引入任何 React 渲染订阅。

/** 模板注册的 GSAP 时间轴最小契约（四模板统一 window.__timelines['overlay']）。 */
interface PackagingTimeline {
  time: (value?: number) => number;
  play: (from?: number) => unknown;
  pause: (at?: number) => unknown;
}

/** 播放步进频率（fps）：24 与视频帧率同量级，肉眼无感，iframe 渲染预算约为 60fps 自由跑的 40%。 */
const PLAY_STEP_FPS = 24;
/** 暂停 seek 最小间隔（ms）：连续拖动播放头时合并为至多 20 次/秒的 GSAP 渲染。 */
const SEEK_MIN_INTERVAL_MS = 50;

export class PackagingOverlaySync {
  private iframe: HTMLIFrameElement | null = null;
  private loaded = false;
  private queue: Array<() => void> = [];
  private playheadSec = 0;
  private playing = false;
  private stepRaf = 0; // 播放步进器 rAF 句柄
  private lastStepAt = 0; // 步进器上次写入时刻（跳帧限频）
  private lastStepSec = -1; // 步进器上次写入的播放头（未变跳过，缓冲期不重复渲染）
  private seekTimer = 0; // 暂停去抖 timeout
  private pendingSeekSec: number | null = null;
  private lastSeekAt = 0; // 上次暂停 seek 执行时刻（最小间隔控制）
  private lastPausedSeekSec = -1; // 上次暂停 seek 目标（重复目标跳过）
  private destroyed = false;
  private visibilityBound = false;

  /** 挂载/更换 iframe（重载时先收 null 再收新元素）。load 前指令入队，旧队列随换绑清空。 */
  attach(iframe: HTMLIFrameElement | null) {
    if (this.iframe === iframe) return;
    if (this.destroyed && iframe) return; // 销毁后不再接受新挂载（解绑 null 仍放行）
    if (this.iframe) this.iframe.removeEventListener('load', this.handleLoad);
    this.iframe = iframe;
    this.loaded = false;
    this.queue = [];
    if (!iframe) return;
    this.bindVisibility();
    iframe.addEventListener('load', this.handleLoad);
  }

  /** 播放头位置：存最新值（播放态由步进器消费；暂停态去抖 seek）。 */
  setPlayhead(sec: number) {
    if (this.destroyed || !Number.isFinite(sec)) return;
    this.playheadSec = Math.max(0, sec);
    if (this.playing) return;
    this.scheduleSeek(this.playheadSec);
  }

  /** 播放状态：true → 启 24fps 步进器（立即校准一帧）；false → 停步进器并精确停帧。 */
  setPlaying(playing: boolean) {
    if (this.destroyed || this.playing === playing) return;
    this.playing = playing;
    if (playing) {
      this.cancelPendingSeek(); // 取消未执行的暂停 seek，避免步进后又被旧 seek 拉回
      this.startStepper();
    } else {
      this.stopStepper();
      this.lastPausedSeekSec = -1; // 停帧必须执行
      this.seekNow(this.playheadSec);
    }
  }

  /** 卸载清理：interval/timeout/队列/事件监听全收。 */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.attach(null);
    this.stopStepper();
    this.cancelPendingSeek();
    if (this.visibilityBound) {
      this.visibilityBound = false;
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private readonly handleLoad = () => {
    if (this.destroyed) return;
    this.loaded = true;
    const queued = this.queue;
    this.queue = [];
    for (const run of queued) run();
    // 恢复当前播放头状态：播放→步进器强制重新校准一帧；暂停→精确停帧
    if (this.playing) {
      this.lastStepSec = -1;
      this.startStepper();
      this.withTimeline((tl) => { tl.pause(); tl.time(this.playheadSec); });
    } else {
      this.lastPausedSeekSec = -1;
      this.seekNow(this.playheadSec);
    }
  };

  private readonly handleVisibilityChange = () => {
    if (this.destroyed || document.visibilityState !== 'visible') return;
    // 隐藏期间 iframe rAF 被节流，恢复时以当前播放头强制重校准
    this.lastStepSec = -1;
    this.lastPausedSeekSec = -1;
    this.withTimeline((tl) => { tl.time(this.playheadSec); });
  };

  private bindVisibility() {
    if (this.visibilityBound || this.destroyed) return;
    this.visibilityBound = true;
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  // ---- 播放步进器：rAF 驱动 + 24fps 跳帧上限 ----
  // 必须 rAF 而非 setInterval：FinalEditPreview 的视频绘制/播放时钟都是 rAF（忙时自动降帧、公平让路），
  // interval 不感知主线程负载会强制触发——弱机上 GSAP 单次渲染稍慢就会独吞主线程，rAF 系的视频绘制
  // 被饿到一帧不画（2026-10-08 用户实机：从头到尾卡第一帧、只有包装在动）。rAF 版忙时自然少跑，
  // 与视频绘制公平竞争；健康机上用跳帧把 GSAP 渲染压到 24fps 上限。

  private startStepper() {
    if (this.stepRaf || this.destroyed) return;
    // 起步即暂停并校准一帧（pause 防时间轴残留自播与步进双重驱动；load 前入队，load 后由 handleLoad 再校准）
    this.command((tl) => { tl.pause(); tl.time(this.playheadSec); });
    this.lastStepAt = 0;
    const tick = () => {
      this.stepRaf = 0;
      if (this.destroyed || !this.playing) return;
      const now = performance.now();
      const target = this.playheadSec;
      // 距上次写入 ≥ 步长才渲染（跳帧限频）；播放头未前进（缓冲/卡帧）也不重复渲染
      if (now - this.lastStepAt >= 1000 / PLAY_STEP_FPS && Math.abs(target - this.lastStepSec) >= 1e-4) {
        this.lastStepAt = now;
        this.lastStepSec = target;
        this.withTimeline((tl) => { tl.time(target); });
      }
      this.stepRaf = requestAnimationFrame(tick);
    };
    this.stepRaf = requestAnimationFrame(tick);
  }

  private stopStepper() {
    if (this.stepRaf) {
      cancelAnimationFrame(this.stepRaf);
      this.stepRaf = 0;
    }
    this.lastStepSec = -1;
    this.lastStepAt = 0;
  }

  // ---- 暂停 seek：最小间隔去抖 + 重复目标跳过 ----

  private scheduleSeek(sec: number) {
    this.pendingSeekSec = sec;
    if (this.seekTimer) return; // 已有尾随定时器，合并为最后一次
    const wait = Math.max(0, SEEK_MIN_INTERVAL_MS - (performance.now() - this.lastSeekAt));
    this.seekTimer = window.setTimeout(() => {
      this.seekTimer = 0;
      if (this.destroyed || this.playing || this.pendingSeekSec == null) return;
      const target = this.pendingSeekSec;
      this.pendingSeekSec = null;
      if (Math.abs(target - this.lastPausedSeekSec) < 1e-4) return; // 目标未变不重复渲染
      this.lastPausedSeekSec = target;
      this.lastSeekAt = performance.now();
      this.seekNow(target);
    }, wait);
  }

  private cancelPendingSeek() {
    this.pendingSeekSec = null;
    if (this.seekTimer) {
      window.clearTimeout(this.seekTimer);
      this.seekTimer = 0;
    }
  }

  // ---- iframe 时间轴访问 ----

  private timeline(): PackagingTimeline | null {
    try {
      const win = this.iframe?.contentWindow as (Window & { __timelines?: Record<string, PackagingTimeline> }) | null;
      return win?.__timelines?.overlay ?? null;
    } catch {
      return null; // 跨域/文档已销毁等异常静默降级
    }
  }

  private withTimeline(run: (tl: PackagingTimeline) => void) {
    const tl = this.timeline();
    if (tl) run(tl);
  }

  /** load 前指令入队，load 后直执。 */
  private command(run: (tl: PackagingTimeline) => void) {
    if (!this.loaded) {
      this.queue.push(() => this.withTimeline(run));
      return;
    }
    this.withTimeline(run);
  }

  private seekNow(sec: number) {
    this.command((tl) => { tl.pause(); tl.time(sec); });
  }
}
