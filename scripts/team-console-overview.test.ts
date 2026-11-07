// 12 号票：控制台运行总览 / 全员任务的纯视图口径。
//
// 这一层是「数量卡、最近任务行、今天的成员、名额占用、开工前清单、只读服务器默认值」
// 的唯一计算处：接口用它组装响应，页面只渲染。所以先钉死这些纯函数。
import assert from 'node:assert/strict';
import {
  CONSOLE_STATUS_BUCKETS,
  consoleDefaultsView,
  consoleMemberActivity,
  consoleModelLabel,
  consoleSetupChecklist,
  consoleTaskBucket,
  consoleTaskCounts,
  consoleTaskTone,
  poolOccupancyRows,
  recentConsoleTasks,
  shanghaiDateKey,
  shanghaiTimeLabel,
  taskDetailHref,
  taskIdFromQuery,
  taskRetryTarget,
  type ConsoleTaskLike,
} from '../lib/team-console-overview.ts';
import { TASK_STATUS_LABELS } from '../lib/team-task-labels.ts';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`PASS: ${name}`);
}

function task(overrides: Partial<ConsoleTaskLike> = {}): ConsoleTaskLike {
  return {
    operationId: 'op-1', module: 'image', taskId: 'job-1', taskName: '图片生成', stepName: '生成请求',
    scopeName: '洁面乳详情页', scope: { resourceType: 'project', resourceId: 'project-a' },
    status: 'pending', actorUserId: 'alice', employeeId: '0001', actorDisplayName: '张三',
    model: 'gpt-image-2', providerName: '公司网关', modelStatus: 'recorded',
    createdAt: '2026-11-08T01:00:00.000Z', updatedAt: '2026-11-08T01:00:00.000Z',
    errorId: null,
    ...overrides,
  };
}

check('每个任务状态都落进唯一一张数量卡，没有漏网的状态', () => {
  for (const status of Object.keys(TASK_STATUS_LABELS)) {
    assert.ok(CONSOLE_STATUS_BUCKETS[status], `状态 ${status} 必须有数量卡归属`);
    assert.equal(consoleTaskBucket(status), CONSOLE_STATUS_BUCKETS[status]);
  }
  assert.equal(Object.keys(CONSOLE_STATUS_BUCKETS).length, Object.keys(TASK_STATUS_LABELS).length,
    '数量卡映射不得多于或少于任务状态表');
  // 还没认知的状态按排队处理：宁可少报在跑，也不要误报完成或出错。
  assert.equal(consoleTaskBucket('future_status'), 'queued');
});

check('数量卡四项与任务数据严格一致', () => {
  const now = new Date('2026-11-08T04:00:00.000Z');
  const tasks = [
    task({ operationId: 'a', status: 'admitted' }),
    task({ operationId: 'b', status: 'accepted' }),
    task({ operationId: 'c', status: 'maybe_sent' }),
    task({ operationId: 'd', status: 'reconciling' }),
    task({ operationId: 'e', status: 'pending' }),
    task({ operationId: 'f', status: 'deferred' }),
    task({ operationId: 'g', status: 'succeeded', updatedAt: '2026-11-08T02:00:00.000Z' }),
    task({ operationId: 'h', status: 'succeeded', updatedAt: '2026-11-07T02:00:00.000Z' }),
    task({ operationId: 'i', status: 'failed' }),
    task({ operationId: 'j', status: 'unknown' }),
    task({ operationId: 'k', status: 'canceled' }),
  ];
  const counts = consoleTaskCounts(tasks, now);
  assert.deepEqual(counts, { running: 4, queued: 2, completedToday: 1, failed: 2, total: 11 });
  // 「今天」按北京时间：UTC 2026-11-07T16:30Z 已经是北京时间 11-08 00:30。
  assert.equal(shanghaiDateKey('2026-11-07T16:30:00.000Z'), '2026-11-08');
  assert.equal(consoleTaskCounts([task({ status: 'succeeded', updatedAt: '2026-11-07T16:30:00.000Z' })], now).completedToday, 1,
    '北京时间今天凌晨完成的任务算今天');
  assert.equal(consoleTaskCounts([], now).total, 0, '没有任务时四项都是 0');
});

check('最近任务行含六列，按更新时间倒序且每行都带详情链接', () => {
  const rows = recentConsoleTasks([
    task({ operationId: 'old', updatedAt: '2026-11-08T01:00:00.000Z' }),
    task({ operationId: 'new', updatedAt: '2026-11-08T03:00:00.000Z', status: 'failed' }),
  ], new Date('2026-11-08T04:00:00.000Z'));
  assert.deepEqual(rows.map(row => row.operationId), ['new', 'old']);
  const [first] = rows;
  assert.equal(first.taskLabel, '图片生成');
  assert.equal(first.projectName, '洁面乳详情页');
  assert.equal(first.actorName, '张三');
  assert.equal(first.modelLabel, 'gpt-image-2');
  assert.equal(first.statusLabel, '失败');
  assert.equal(first.tone, 'fail');
  assert.match(first.timeLabel, /^11-08 \d{2}:\d{2}$/);
  assert.equal(first.href, '/team/tasks?taskId=new');
  assert.equal(taskDetailHref('op/with space'), '/team/tasks?taskId=op%2Fwith%20space');
  assert.equal(recentConsoleTasks(Array.from({ length: 30 }, (_, index) => task({ operationId: `op-${index}` }))).length, 12,
    '最近任务表最多 12 行');
});

check('模型列如实说明未记录 / 不适用 / 待调用，不猜模型', () => {
  assert.equal(consoleModelLabel({ model: 'gpt-image-2', modelStatus: 'recorded' }), 'gpt-image-2');
  assert.equal(consoleModelLabel({ model: null, modelStatus: 'missing' }), '未记录');
  assert.equal(consoleModelLabel({ model: null, modelStatus: 'not_applicable' }), '本地处理');
  assert.equal(consoleModelLabel({ model: null, modelStatus: 'pending' }), '待调用');
  assert.equal(consoleModelLabel({ model: null, modelStatus: 'undetermined' }), '待确定');
});

check('今天的成员：谁在做什么，一句话写清在产/排队/出错/完成', () => {
  const now = new Date('2026-11-08T04:00:00.000Z');
  const rows = consoleMemberActivity([
    task({ operationId: 'a', actorUserId: 'bob', employeeId: '0002', actorDisplayName: '李四', status: 'pending' }),
    task({ operationId: 'b', actorUserId: 'alice', employeeId: '0001', actorDisplayName: '张三', status: 'admitted' }),
    task({ operationId: 'c', actorUserId: 'alice', status: 'failed' }),
    task({ operationId: 'd', actorUserId: 'alice', status: 'succeeded', updatedAt: '2026-11-08T03:00:00.000Z' }),
    task({ operationId: 'e', actorUserId: 'carol', employeeId: '0003', actorDisplayName: '王五', status: 'canceled' }),
  ], now);
  assert.deepEqual(rows.map(row => row.displayName), ['张三', '李四', '王五'], '在产多的排前面，同分按工号');
  assert.equal(rows[0].summary, '1 条在产，1 处出错，今天完成 1 条');
  assert.equal(rows[1].summary, '1 条排队');
  assert.equal(rows[2].summary, '今天还没有任务');
});

check('名额占用按池一行，用满时给的是人话而不是故障', () => {
  const rows = poolOccupancyRows([
    { poolKey: 'media:z', capacity: 4, held: 4, accepted: 3, maybeSent: 0, notSent: 1, activeMembers: [] },
    { poolKey: 'media:a', capacity: 10, held: 2, accepted: 1, maybeSent: 1, notSent: 0, activeMembers: [] },
    { poolKey: 'media:unset', capacity: 0, held: 0, accepted: 0, maybeSent: 0, notSent: 0, activeMembers: [] },
  ]);
  assert.deepEqual(rows.map(row => row.poolKey), ['media:a', 'media:unset', 'media:z']);
  assert.equal(rows[0].percent, 20);
  assert.equal(rows[0].hint, '还能再跑 8 条');
  assert.equal(rows[1].hint, '还没设名额');
  assert.equal(rows[2].percent, 100);
  assert.equal(rows[2].hint, '名额已用满，新任务排队');
});

check('开工前清单每项状态与就绪检查一致，且都写明去处', () => {
  const pending = consoleSetupChecklist({
    proxyAvailable: false, cosConfigured: false, poolsReady: false,
    poolBlockers: ['公司图片渠道：资源池未配置', '公司视频渠道：缺少密钥'], enabledPools: 2,
  });
  assert.equal(pending.title, '开工前还差 3 件事');
  assert.equal(pending.pendingCount, 3);
  assert.equal(pending.ready, false);
  assert.deepEqual(pending.items.map(item => [item.key, item.state, item.detail]), [
    ['company-proxy', 'action', '未连接'],
    ['cos-relay', 'action', '未配置'],
    ['model-pools', 'action', '2 项待处理'],
  ]);
  assert.deepEqual(pending.items.map(item => item.href), ['/settings', '/settings', '/team/admin/pools']);
  for (const item of pending.items) {
    assert.ok(item.actionLabel.length > 0, `${item.key} 必须写明去哪里处理`);
    assert.ok(item.label.length > 0);
  }
  assert.deepEqual(pending.items[2].reasons, ['公司图片渠道：资源池未配置', '公司视频渠道：缺少密钥']);

  const ready = consoleSetupChecklist({ proxyAvailable: true, cosConfigured: true, poolsReady: true, enabledPools: 3 });
  assert.equal(ready.ready, true);
  assert.equal(ready.pendingCount, 0);
  assert.equal(ready.title, '开工前都准备好了');
  assert.deepEqual(ready.items.map(item => item.detail), ['已就绪', '已配置', '3 个名额池可用']);

  // 读不到状态不能算通过：它显示「没读到状态」，并且仍占一件待处理。
  const unknown = consoleSetupChecklist({ proxyAvailable: null, cosConfigured: null, poolsReady: null });
  assert.equal(unknown.ready, false);
  assert.equal(unknown.pendingCount, 3);
  assert.deepEqual(unknown.items.map(item => item.detail), ['没读到状态', '没读到状态', '没读到状态']);
});

check('服务器默认值只读视图：形状不对就整体收起，不猜数值', () => {
  const missing = consoleDefaultsView(undefined);
  assert.equal(missing.available, false);
  assert.deepEqual(missing.rows, []);
  assert.match(missing.note, /尚未接入/);

  const view = consoleDefaultsView({
    timeoutMs: 600_000, projectConcurrency: 10, videoConcurrency: 3,
    imagePreprocess: { enabled: true, targetMaxSide: 1536, jpegQuality: 85 },
  });
  assert.equal(view.available, true);
  assert.deepEqual(view.rows.map(row => [row.label, row.value]), [
    ['任务超时', '10 分钟'],
    ['项目并发', '10 条'],
    ['视频并发', '3 条'],
    ['图片预处理', '开启 · 最长边 1536px · JPEG 85'],
  ]);
  assert.match(view.note, /只读/);
  const partial = consoleDefaultsView({ timeoutMs: 600_000, imagePreprocess: { enabled: false } });
  assert.equal(partial.available, false, '缺项目并发时不得显示成可用');
});

check('重试只给明确失败的图片/视频任务；待核查不给重试', () => {
  assert.deepEqual(taskRetryTarget(task({ status: 'failed', module: 'image', taskId: 'job-9' })), {
    endpoint: '/api/jobs/job-9/retry', label: '重试这一步', hint: '重试只重新排队这一步，不会重复扣已完成的部分。',
  });
  assert.equal(taskRetryTarget(task({ status: 'failed', module: 'video', taskId: 'video-9' }))?.endpoint, '/api/video-jobs/video-9/retry');
  assert.equal(taskRetryTarget(task({ status: 'unknown', module: 'image' })), null, '提交结果待核查不给重试，先核对结果');
  assert.equal(taskRetryTarget(task({ status: 'failed', module: 'llm', taskId: 'llm-1' })), null, '脚本任务到项目里重试');
  assert.equal(taskRetryTarget(task({ status: 'failed', module: 'image', taskId: '' })), null);
});

check('详情链接里的任务编号做白名单校验', () => {
  assert.equal(taskIdFromQuery(' op-1 '), 'op-1');
  assert.equal(taskIdFromQuery(''), null);
  assert.equal(taskIdFromQuery(null), null);
  assert.equal(taskIdFromQuery('../../etc/passwd'), null);
  assert.equal(taskIdFromQuery('a'.repeat(200)), null);
});

check('时间标签固定按北京时间，不受运行环境时区影响', () => {
  assert.equal(shanghaiTimeLabel('2026-11-08T04:05:00.000Z'), '11-08 12:05');
  assert.equal(shanghaiTimeLabel('not-a-date'), '');
  assert.equal(consoleTaskTone('succeeded'), 'ok');
  assert.equal(consoleTaskTone('pending'), 'idle');
  assert.equal(consoleTaskTone('accepted'), 'run');
});

console.log(`\n${passed} console overview checks passed`);
