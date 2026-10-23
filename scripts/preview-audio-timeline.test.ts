import assert from 'node:assert/strict';
import { PreviewAudioTimelinePlayer, type PreviewAudioMedia, type PreviewAudioTimeline } from '../lib/media-core/preview-audio-timeline.ts';

class Media extends EventTarget implements PreviewAudioMedia {
  readyState = 4; duration = 10; currentTime = 0; paused = true; seeking = false;
  gain = 0; removed = false; plays = 0;
  playPromise: Promise<void> | null = null;
  setGain(value: number) { this.gain = value; }
  play() { this.plays++; this.paused = false; return this.playPromise ?? Promise.resolve(); }
  pause() { this.paused = true; }
  dispose() { this.removed = true; this.pause(); }
}
const timeline: PreviewAudioTimeline = { revisionId: 'version-1', bodyDurationUs: 4_000_000, clips: [
  { id: 'original', kind: 'source', url: '/original.mp4', sourceDurationUs: 10_000_000,
    sourceInUs: 5_000_000, sourceOutUs: 7_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000, gainDb: 0 },
  { id: 'voice', kind: 'narration', url: '/voice.wav', sourceDurationUs: 1_000_000,
    sourceInUs: 0, sourceOutUs: 1_000_000, timelineStartUs: 2_000_000, timelineEndUs: 3_000_000, gainDb: -6 },
] };
const media = new Map<string, Media>();
const player = new PreviewAudioTimelinePlayer(timeline, clip => {
  const item = new Media(); item.duration = clip.sourceDurationUs / 1_000_000; media.set(clip.id, item); return item;
});
assert.equal(player.sync(-200_000, true), true, '封面不播放正文声音');
assert.equal(media.get('original')!.paused, true);
assert.equal(player.sync(2_000, true), true);
assert.ok(Math.abs(media.get('original')!.gain - 0.4) < 0.001, '真实声音开头五毫秒逐渐进入，不能直接满音量');
assert.equal(player.sync(500_000, true), true);
assert.equal(media.get('original')!.currentTime, 5.5, '正文0.5秒应取原文件5.5秒');
assert.equal(media.get('original')!.gain, 1);
assert.equal(media.get('voice')!.paused, true);
media.get('original')!.currentTime = 6.985;
player.sync(1_998_000, true);
assert.ok(Math.abs(media.get('original')!.gain - 0.4) < 0.001,
  '媒体时钟略落后时仍须在时间轴切断前完成短淡出，不能等到原生播放器追上');
assert.equal(player.sync(2_250_000, true), true);
assert.equal(media.get('original')!.paused, true);
assert.equal(media.get('voice')!.currentTime, 0.25);
assert.ok(Math.abs(media.get('voice')!.gain - 0.501187) < 0.000001);
player.pause();
assert.equal(media.get('voice')!.paused, true);
assert.equal(media.get('voice')!.gain, 0);
assert.equal(player.sync(3_500_000, true), true, '声音结束后允许合法的无旁白画面');
assert.equal([...media.values()].filter(item => !item.paused).length, 0);
player.dispose();
assert([...media.values()].every(item => item.removed));

const splitMedia: Media[] = [];
const splitPlayer = new PreviewAudioTimelinePlayer({ ...timeline, clips: [
  { ...timeline.clips[0], id: 'left', sourceOutUs: 6_000_000, timelineEndUs: 1_000_000 },
  { ...timeline.clips[0], id: 'right', sourceInUs: 6_000_000, timelineStartUs: 1_000_000 },
] }, () => { const item = new Media(); splitMedia.push(item); return item; });
splitPlayer.sync(999_000, true);
assert.equal(splitMedia[0].gain, 1, '连续来源的左半段不额外淡出');
splitPlayer.sync(1_001_000, true);
assert.equal(splitMedia.find(item => !item.paused)!.gain, 1, '连续来源的右半段不额外淡入');
assert.equal(splitMedia[0].paused, false, '结构分割后继续同一段声音，不暂停并重启另一个媒体');
assert.equal(splitMedia[0].plays, 1, '跨过结构分割点不重新起播');
splitPlayer.dispose();

const cutMedia: Media[] = [];
const cutPlayer = new PreviewAudioTimelinePlayer({ ...timeline, clips: [
  { ...timeline.clips[0], id: 'before-cut', sourceOutUs: 6_000_000, timelineEndUs: 1_000_000 },
  { ...timeline.clips[0], id: 'after-cut', sourceInUs: 7_000_000, sourceOutUs: 8_000_000,
    timelineStartUs: 1_500_000, timelineEndUs: 2_500_000 },
] }, () => { const item = new Media(); cutMedia.push(item); return item; });
cutPlayer.sync(900_000, true);
cutPlayer.sync(1_250_000, true);
assert(cutMedia.every(item => item.paused), '同一文件两段之间的空位保持安静');
cutPlayer.sync(1_600_000, true);
assert.equal(cutMedia.find(item => !item.paused)!.currentTime, 7.1, '有真实裁切的后段不能被合并成连续原声');
cutPlayer.dispose();

const delayed = new Media(); delayed.readyState = 0;
const states: string[] = [];
const waiting = new PreviewAudioTimelinePlayer({ ...timeline, clips: [timeline.clips[0]] }, () => delayed, state => states.push(state.status));
assert.equal(waiting.sync(0, true), false, '声音尚未载入时不能推进画面时钟');
assert.equal(delayed.plays, 0);
delayed.readyState = 4; delayed.seeking = true;
waiting.sync(500_000, true);
waiting.sync(1_000_000, true);
delayed.seeking = false; delayed.dispatchEvent(new Event('seeked'));
assert.equal(delayed.currentTime, 6, '载入或跳转完成时只使用最新播放头');
assert.equal(delayed.paused, false);
delayed.dispatchEvent(new Event('error'));
assert.equal(waiting.sync(1_000_000, true), false);
assert.equal(states.at(-1), 'error');
assert.equal(delayed.paused, true);
const priorPlays = delayed.plays;
waiting.dispose(); delayed.dispatchEvent(new Event('loadedmetadata'));
assert.equal(delayed.plays, priorPlays, '卸载后的旧媒体事件不得再播放');

const late = new Media();
let finishPlay!: () => void;
late.playPromise = new Promise(resolve => { finishPlay = () => { late.paused = false; resolve(); }; });
const pending = new PreviewAudioTimelinePlayer({ ...timeline, clips: [timeline.clips[0]] }, () => late);
pending.sync(0, true); pending.pause(); finishPlay();
await Promise.resolve();
assert.equal(late.paused, true, '迟到的play完成回调不能撤销用户暂停');
assert.equal(late.gain, 0);
pending.dispose();
const retryMedia: Media[] = [];
const retry = new PreviewAudioTimelinePlayer({ ...timeline, clips: [timeline.clips[0]] }, () => {
  const item = new Media(); retryMedia.push(item); return item;
});
retry.sync(700_000, true);
retryMedia[0].dispatchEvent(new Event('error'));
assert.equal(retry.sync(700_000, true), false);
retry.pause(); retry.retryFailed();
assert.equal(retryMedia[0].removed, true, '明确重试时释放出错的媒体元素');
assert.equal(retry.sync(700_000, true), true);
assert.equal(retryMedia.at(-1)!.currentTime, 5.7, '重试保持原播放位置和源时间映射');
retry.dispose();
// 两组独立的 24fps 帧边界转整数微秒，区间相减可能相差 1 微秒。
assert.doesNotThrow(() => {
  const rounded = new PreviewAudioTimelinePlayer({ ...timeline, clips: [{ ...timeline.clips[0], timelineEndUs: 2_000_001 }] }, () => new Media());
  rounded.dispose();
});
assert.throws(() => new PreviewAudioTimelinePlayer({ ...timeline, clips: [timeline.clips[0], { ...timeline.clips[1], timelineStartUs: 1_000_000, timelineEndUs: 2_000_000 }] }, () => new Media()), /重叠/);
console.log('preview audio timeline: 原声取源、配音衔接、片头/空白/暂停及释放通过');
