import assert from 'node:assert/strict';
import { findUnusedCoverCandidate, hasRepairableBlockingIssue } from '../components/final-edit/editor-repair.ts';
import type { FinalEditGroupView } from '../lib/final-edit/types.ts';

const group = {
  coverCandidates: [
    { kind: 'storyboard_image', coverKey: 'image:a', sourceUrl: '/a' },
    { kind: 'storyboard_image', coverKey: 'image:b', sourceUrl: '/b' },
    { kind: 'storyboard_image', coverKey: 'image:c', sourceUrl: '/c' },
  ],
  variants: [
    { id: 'v1', cover: { coverKey: 'image:a' }, issues: [{ code: 'duplicate_cover', severity: 'blocking', message: '重复' }] },
    { id: 'v2', cover: { coverKey: 'image:a' }, issues: [{ code: 'duplicate_cover', severity: 'blocking', message: '重复' }] },
    { id: 'v3', cover: { coverKey: 'image:b' }, issues: [] },
  ],
} as unknown as FinalEditGroupView;

assert.equal(findUnusedCoverCandidate(group, 'v1'), 'image:c', '一键修复应选取同组成片尚未使用的封面');
assert.equal(hasRepairableBlockingIssue(group, 'v1'), true);
group.variants[0].issues = [{ code: 'alignment_failed', severity: 'blocking', message: '对齐失败' }];
assert.equal(hasRepairableBlockingIssue(group, 'v1'), false, '不能把需要重新生成的对齐错误伪装成可自动修复');

console.log('final-edit editor repair tests passed');
