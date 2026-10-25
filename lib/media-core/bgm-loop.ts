/** 最后一个循环点离截断边界至少留这么多，避免循环点恰好落在边界上。 */
const LOOP_POINT_MARGIN_SEC = 0.05;

/**
 * 配乐输入的 `-stream_loop` 次数：只循环到刚好铺满 neededSec，不能用 -1。
 *
 * 自带的 ffmpeg 6.0 每次回到开头，都要等主线程报告上一轮末帧时长；滤镜截够时长后主线程不再
 * 读这一路，若后面还有循环点就永远等不到，成片写完后进程卡在收尾（0% CPU）。配乐短于成片时
 * `-stream_loop -1` 必然触发（lib/film-render/audio.ts 用同样的有限次数规避）。
 * 循环点留了余量，配乐最多比 neededSec 早结束 50ms，落在淡出段内听不出来。
 */
export function bgmStreamLoopCount(bgmDurationSec: number, neededSec: number): number {
  if (!(bgmDurationSec > 0)) throw new Error('无法识别 BGM 时长');
  return Math.max(0, Math.ceil((neededSec - LOOP_POINT_MARGIN_SEC) / bgmDurationSec) - 1);
}
