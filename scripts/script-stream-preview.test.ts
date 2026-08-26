import assert from 'node:assert/strict';
import { parseScriptStreamPreview } from '../lib/script-stream-preview.ts';

{
  const parsed = parseScriptStreamPreview(JSON.stringify({
    title: '轻盈岩板餐桌',
    coverTitleParts: { primary: '轻盈岩板餐桌', secondary: '小户型优雅之选' },
    segments: [
      { narration: '第一段口播。', subtitle: '第一段字幕' },
      { narration: '第二段口播。', subtitle: '第二段字幕' },
    ],
  }));
  assert.deepEqual(parsed.title, { text: '轻盈岩板餐桌', done: true });
  assert.deepEqual(parsed.coverTitleParts?.primary, { text: '轻盈岩板餐桌', done: true });
  assert.deepEqual(parsed.coverTitleParts?.secondary, { text: '小户型优雅之选', done: true });
  assert.equal(parsed.segments.length, 2);
  assert.deepEqual(parsed.segments[0]?.narration, { text: '第一段口播。', done: true });
  assert.deepEqual(parsed.segments[0]?.subtitle, { text: '第一段字幕', done: true });
}

{
  const parsed = parseScriptStreamPreview('{"title":"未闭合');
  assert.deepEqual(parsed.title, { text: '未闭合', done: false });
  assert.deepEqual(parsed.coverTitleParts, null);
  assert.deepEqual(parsed.segments, []);
}

{
  const parsed = parseScriptStreamPreview('{"segments":[{"narration":"正在写');
  assert.equal(parsed.segments.length, 1);
  assert.deepEqual(parsed.segments[0]?.narration, { text: '正在写', done: false });
  assert.equal(parsed.segments[0]?.subtitle, null);
}

{
  const parsed = parseScriptStreamPreview('{"title":"\\uD83');
  assert.deepEqual(parsed.title, { text: '', done: false });
}

{
  const parsed = parseScriptStreamPreview('{"title":"emoji\\uD83D\\uDE00"}');
  assert.deepEqual(parsed.title, { text: 'emoji😀', done: true });
}

console.log('script stream preview tests passed');

