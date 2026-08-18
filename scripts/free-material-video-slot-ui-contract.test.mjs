import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(
  new URL('../components/VideoGenerationPanel.tsx', import.meta.url),
  'utf8',
);

assert.match(
  panel,
  /<button[\s\S]{0,400}onClick=\{activateFreeHeadFrameSlot\}[\s\S]{0,600}\{headFrameBusy \? '上传中…' : '添加图片'\}/,
  '添加图片必须先激活空槽位，不能直接由按钮内的文件输入触发上传',
);
assert.match(
  panel,
  /\{isFreeSet && freeHeadFrameSlotOpen && \([\s\S]{0,500}等待拖入首帧图片/,
  '空槽位必须显示为可返回的图片 tab',
);
assert.match(
  panel,
  /const selectorLocked = creating \|\| deletingSet \|\| headFrameBusy/,
  '首帧上传期间必须锁定分镜组选择器',
);
assert.match(
  panel,
  /<select[\s\S]{0,500}disabled=\{selectorLocked\}/,
  '分镜组选择器必须实际绑定上传锁定状态',
);
assert.match(
  panel,
  /const targetSetId = effectiveSetId;[\s\S]*selectedSetIdRef\.current === targetSetId[\s\S]*replaceSelectedShot\(newShotId\)/,
  '异步上传回写前必须确认用户仍位于目标分镜组',
);
assert.match(
  panel,
  /const leavingFreeHeadFrameSlot =[\s\S]{0,1200}j\.shotId === shotId[\s\S]{0,160}j\.status === 'succeeded'/,
  '只有离开空槽位时才恢复当前图片对应的成功视频预览',
);
assert.match(
  panel,
  /const shotPreviewJobId =[\s\S]{0,360}previewSuppressedRef\.current = !shotPreviewJobId/,
  '当前图片没有成功视频时必须继续抑制预览，避免轮询带回其他图片的视频',
);
assert.doesNotMatch(
  panel,
  /replaceActiveMotionRows\(cached \? \[\.\.\.cached\] : \[makeEmptyRow\(\)\]\);\s*previewSuppressedRef\.current = false;/,
  '普通图片 tab 切换不能覆盖用户主动关闭预览的状态',
);

console.log('free material video slot UI contract tests passed');
