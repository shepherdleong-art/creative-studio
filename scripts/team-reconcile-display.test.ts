// 02 号票：待核对卡片的「通俗说明」映射测试。
//
// 这些断言不碰界面框架，只验证纯展示映射：同一份任务数据被翻译成
// 「当前状态 + 通俗原因 + 费用状态 + 通道说明」，并且在任何情况下都
// 不能替系统承诺「后台会自动查询 / 稍后一定成功」。
//
// 运行：node scripts/team-reconcile-display.test.ts
import assert from 'node:assert/strict';
import { describeReconcileTask } from '../components/team/reconcile-display.ts';

type Channel = {
  channelKey: string;
  state: string;
  operationStatus: string | null;
  waitReason: string | null;
  remoteId: string | null;
  attempts: Array<{
    submissionState: string;
    terminalState: string | null;
    remoteId: string | null;
    receiptRemoteId: string | null;
    errorCode: string | null;
  }>;
};

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelKey: 'qiniu',
    state: 'candidate',
    operationStatus: null,
    waitReason: null,
    remoteId: null,
    attempts: [],
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    mediaTaskId: 'media-task-1',
    status: 'unknown',
    currentChannelKey: 'qiniu',
    cancelRequestedAt: null as string | null,
    businessStatus: null as string | null,
    businessProviderStatus: null as string | null,
    businessError: null as string | null,
    attention: true,
    attentionReasons: ['结果确认中', '提交结果未知'] as string[],
    cost: {
      reservedMinor: 0,
      actualMinor: 0,
      unknownCount: 1,
      costStatus: 'uncertain' as const,
    },
    channels: [channel({
      state: 'unknown',
      attempts: [{
        submissionState: 'maybe_sent',
        terminalState: null,
        remoteId: null,
        receiptRemoteId: null,
        errorCode: null,
      }],
    })],
    ...overrides,
  } as Parameters<typeof describeReconcileTask>[0];
}

// 1) 提交结果未知：状态与原因都说「还没确认」，不承诺后台自动查询或稍后成功。
{
  const display = describeReconcileTask(task());
  assert.equal(display.statusLabel, '结果待确认');
  assert.ok(display.reasons.includes('供应商是否接单还没有确认'), display.reasons.join(' / '));
  assert.equal(display.reasonText.includes('供应商是否接单还没有确认'), true);
  assert.ok(display.reasons.includes('费用尚未核实'));
  assert.equal(display.costNeedsCheck, true);
  const text = [display.statusLabel, display.reasonText, display.costLabel, ...display.reasons].join(' ');
  for (const forbidden of ['自动查询', '自动重试', '稍后成功', '保证成功', '预计成功']) {
    assert.equal(text.includes(forbidden), false, `通俗说明不得承诺「${forbidden}」：${text}`);
  }
}

// 2) 成功且已核账：生成成功与费用核实是两个维度；没有待核对原因。
{
  const display = describeReconcileTask(task({
    status: 'succeeded',
    attention: false,
    attentionReasons: [],
    cost: { reservedMinor: 120, actualMinor: 120, unknownCount: 0, costStatus: 'settled' as const },
    channels: [channel({
      state: 'succeeded',
      remoteId: 'remote-1',
      attempts: [{
        submissionState: 'terminal',
        terminalState: 'succeeded',
        remoteId: 'remote-1',
        receiptRemoteId: 'remote-1',
        errorCode: null,
      }],
    })],
  }));
  assert.equal(display.statusLabel, '生成成功');
  assert.equal(display.costLabel, '已核实 ¥1.20');
  assert.equal(display.costNeedsCheck, false);
  assert.deepEqual(display.reasons, []);
  assert.equal(display.reasonText, '没有待核对的问题，仅供查看。');
}

// 3) 成功但费用未知：仍然提示费用要核实，不把成功等同于已核账。
{
  const display = describeReconcileTask(task({
    status: 'succeeded',
    attentionReasons: [],
    cost: { reservedMinor: 200, actualMinor: 0, unknownCount: 1, costStatus: 'uncertain' as const },
    channels: [channel({
      state: 'succeeded',
      attempts: [{
        submissionState: 'terminal',
        terminalState: 'succeeded',
        remoteId: 'remote-1',
        receiptRemoteId: null,
        errorCode: null,
      }],
    })],
  }));
  assert.equal(display.costNeedsCheck, true);
  assert.ok(display.reasons.includes('生成已成功，费用尚未核实'), display.reasons.join(' / '));
  assert.ok(display.costLabel.includes('尚未核实'), display.costLabel);
}

// 4) 结果已就绪但下载未完成：来自业务状态，不是「生成失败」。
{
  const display = describeReconcileTask(task({
    status: 'succeeded',
    businessStatus: 'download_failed',
    attentionReasons: ['结果待补下载'],
    cost: { reservedMinor: 120, actualMinor: 120, unknownCount: 0, costStatus: 'settled' as const },
  }));
  assert.ok(display.reasons.includes('生成结果已就绪，但下载未完成'), display.reasons.join(' / '));
  assert.equal(display.reasons.some((reason) => reason.includes('失败')), false, '下载未完成不能被说成生成失败');
}

// 5) 取消意图仍在等结果：说清「已提交的部分还要等」，不触发推定失败。
{
  const display = describeReconcileTask(task({
    cancelRequestedAt: '2026-11-11T08:00:00.000Z',
    attentionReasons: ['已请求取消'],
  }));
  assert.ok(display.reasons.some((reason) => reason.includes('取消')), display.reasons.join(' / '));
}

// 6) 远端身份缺失：提交过却没记到远端 ID，就说这一点，不猜成功或失败。
{
  const display = describeReconcileTask(task({
    attentionReasons: ['结果确认中'],
    channels: [channel({
      state: 'accepted',
      attempts: [{
        submissionState: 'accepted',
        terminalState: null,
        remoteId: null,
        receiptRemoteId: null,
        errorCode: null,
      }],
    })],
  }));
  assert.ok(display.reasons.some((reason) => reason.includes('远端') && reason.includes('ID')), display.reasons.join(' / '));
  // 已经受理的任务不能说成「是否接单还没确认」；结果未知用另一句。
  assert.ok(display.reasons.includes('生成结果还没有确认'), display.reasons.join(' / '));
  assert.equal(display.reasons.includes('供应商是否接单还没有确认'), false, '已受理的任务不能再说接单未确认');
}

// 6b) 同一件「结果还没确认」来自状态、通道和供应商三层时只留一句，不重复刷屏。
{
  const display = describeReconcileTask(task({
    attentionReasons: ['结果确认中', '通道结果未知', '供应商结果未知'],
    businessProviderStatus: 'unknown',
    channels: [channel({ state: 'unknown' })],
  }));
  assert.equal(
    display.reasons.filter((reason) => reason === '生成结果还没有确认').length,
    1,
    display.reasons.join(' / '),
  );
}

// 7) 七牛成功、腾讯候选 0 尝试：腾讯是备用通道，未提交，不显示成额外付费调用。
{
  const display = describeReconcileTask(task({
    status: 'succeeded',
    attention: false,
    attentionReasons: [],
    currentChannelKey: 'qiniu',
    cost: { reservedMinor: 120, actualMinor: 120, unknownCount: 0, costStatus: 'settled' as const },
    channels: [
      channel({
        channelKey: 'qiniu',
        state: 'succeeded',
        attempts: [{
          submissionState: 'terminal',
          terminalState: 'succeeded',
          remoteId: 'qiniu-r1',
          receiptRemoteId: 'qiniu-r1',
          errorCode: null,
        }],
      }),
      channel({ channelKey: 'tencent', state: 'candidate', attempts: [] }),
    ],
  }));
  const tencent = display.channels.find((item) => item.channelKey === 'tencent');
  assert.ok(tencent);
  assert.equal(tencent.standbyUnsubmitted, true);
  assert.equal(tencent.stateLabel, '备用通道，未提交');
  assert.match(tencent.note ?? '', /不会产生额外费用/);
  assert.equal(display.channels.find((item) => item.channelKey === 'qiniu')?.standbyUnsubmitted, false);
}

// 8) 费用状态的各种来源都翻成中文，且金额用两位小数。
{
  assert.equal(
    describeReconcileTask(task({ cost: { reservedMinor: 50, actualMinor: 0, unknownCount: 0, costStatus: 'estimated' as const } })).costLabel,
    '预估 ¥0.50，尚未核实',
  );
  assert.equal(
    describeReconcileTask(task({ cost: { reservedMinor: 0, actualMinor: 0, unknownCount: 0, costStatus: 'released' as const } })).costLabel,
    '已释放，不计费',
  );
  assert.equal(
    describeReconcileTask(task({ cost: { reservedMinor: 0, actualMinor: 0, unknownCount: 0, costStatus: 'unpriced' as const } })).costLabel,
    '未定价，待核实',
  );
}

// 9) 未知的 attentionReasons 不丢：保留原文，不擅自归类成「失败」或「系统处理中」。
{
  const display = describeReconcileTask(task({ attentionReasons: ['某个未来原因'] }));
  assert.ok(display.reasons.includes('某个未来原因'));
}

// 10) 历史成功记录统一用「待补下载」以外的业务错误不阻挠阅读：业务错误只放到技术详情，
//     这里只验证通俗原因不直接照搬英文/错误码。
{
  const display = describeReconcileTask(task({
    businessError: 'PROVIDER_HTTP_502_BAD_GATEWAY',
    attentionReasons: [],
  }));
  assert.equal(display.reasons.some((reason) => reason.includes('502')), false, '通俗原因不直接照搬技术错误码');
}

console.log('team reconcile display mapping passed');
