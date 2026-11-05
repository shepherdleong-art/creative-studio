import assert from 'node:assert/strict';

// 接缝 1：分组纯函数（浏览器与服务端共用），只按 actorUserId 分组，不查库。
const { groupTeamTasksByActor } = await import('../lib/team-task-groups.ts');

type Item = {
  operationId: string;
  actorUserId: string;
  actorDisplayName: string;
  employeeId: string;
  updatedAt: string;
};

function item(operationId: string, actorUserId: string, displayName: string, employeeId: string, updatedAt: string): Item {
  return { operationId, actorUserId, actorDisplayName: displayName, employeeId, updatedAt };
}

// 组按组内最新任务时间降序；组内沿用传入顺序（接口已按 updatedAt DESC 排序）。
const ordered = [
  item('op-a2', 'u-a', '张三', '0001', '2026-11-05T10:00:00.000Z'),
  item('op-b1', 'u-b', '李四', '0002', '2026-11-05T09:00:00.000Z'),
  item('op-a1', 'u-a', '张三', '0001', '2026-11-05T08:00:00.000Z'),
];
const groups = groupTeamTasksByActor(ordered);
assert.deepEqual(groups.map((group: { actorUserId: string }) => group.actorUserId), ['u-a', 'u-b'],
  '组按下标首次出现（最新任务）排序');
assert.deepEqual(groups[0].items.map((entry: Item) => entry.operationId), ['op-a2', 'op-a1'], '组内沿用原排序');
assert.equal(groups[0].count, 2, '组计数等于当前结果中该组条数');
assert.equal(groups[0].displayName, '张三');
assert.equal(groups[0].employeeId, '0001');
assert.equal(groups[0].latestUpdatedAt, '2026-11-05T10:00:00.000Z');

// 同名成员必须分成两组：身份只认 actorUserId，姓名只是显示值。
const sameName = [
  item('op-c2', 'u-c2', '李四', '0003', '2026-11-05T11:00:00.000Z'),
  item('op-c1', 'u-c1', '李四', '0002', '2026-11-05T10:30:00.000Z'),
  item('op-c2b', 'u-c2', '李四', '0003', '2026-11-05T10:00:00.000Z'),
];
const sameNameGroups = groupTeamTasksByActor(sameName);
assert.equal(sameNameGroups.length, 2, '两位同名成员必须形成不同组');
assert.deepEqual(sameNameGroups.map((group: { actorUserId: string }) => group.actorUserId), ['u-c2', 'u-c1']);
assert.deepEqual(sameNameGroups.map((group: { employeeId: string }) => group.employeeId), ['0003', '0002'],
  '同名成员靠工号与 actorUserId 区分');
assert.equal(sameNameGroups[0].count, 2);
assert.equal(sameNameGroups[1].count, 1);

assert.deepEqual(groupTeamTasksByActor([]), [], '空结果没有分组');

console.log('PASS: team task grouping by actorUserId (pure)');
