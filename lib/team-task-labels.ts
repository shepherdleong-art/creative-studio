// Browser-safe names shared by task lists and diagnostics.
export const TASK_MODULE_LABELS: Record<string, string> = {
  image: '图片生成', video: '视频生成', llm: '脚本与文本生成', canvas: '创作画布',
  canvas_export: '画布导出', batch: '批量生产', script_studio: '详情页脚本',
  final_edit: '智能混剪', tts: '配音生成', alignment: '字幕对齐',
};
export const TASK_STEP_LABELS: Record<string, string> = {
  submit: '生成请求', poll: '查询生成结果', download: '下载结果', render: '成片渲染',
  export: '导出', prepare: '准备素材', analyze: '素材分析',
};
export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '排队中', deferred: '等待运行条件', admitted: '准备发送', maybe_sent: '提交中（待确认）',
  accepted: '供应商已受理', reconciling: '核查结果中', succeeded: '成功', failed: '失败',
  unknown: '提交结果待核查', canceled: '已取消',
};
const SCRIPT_STEP_PURPOSE_LABELS: Record<string, string> = {
  generate: '生成', repair: '正文修正', review: '内容检查', fallback: '兜底生成',
  title_repair: '标题修复', distill: '卖点提炼', filter: '模板筛选', style: '风格分析',
  polish: '润色', note: '修改说明',
};

/** Only the documented Script Studio step grammar supplies business plan numbers. */
export function taskStepLabel(step: string, module?: string): string {
  if (module === 'llm') {
    const match = /^script-studio-generate:plan:(\d+):([a-z_]+):(\d+)$/.exec(step);
    if (match && SCRIPT_STEP_PURPOSE_LABELS[match[2]]) {
      const planIndex = Number(match[1]);
      if (Number.isSafeInteger(planIndex) && planIndex > 0) {
        return `第 ${planIndex} 条文案 · ${SCRIPT_STEP_PURPOSE_LABELS[match[2]]}`;
      }
    }
    const generic: Record<string, string> = {
      'script-studio-generate': '文案生成', 'script-studio-reprobe': '视觉信息复核',
      'script-studio-organize': '卖点整理', 'script-studio-vision': '详情页素材分析',
    };
    const [area, subtype] = step.split(':');
    return generic[area] ?? (area === 'script' && subtype === 'vision' ? '详情页素材分析' : undefined)
      ?? TASK_STEP_LABELS[step] ?? '脚本制作步骤';
  }
  if (module === 'tts') {
    if (/^segment:.+:alignment$/.test(step)) return '配音字幕对齐';
    if (/^segment:.+:(?:chunk:\d+(?::request:\d+)?|chunk:\d+)$/.test(step)) return '配音片段';
    return '配音生成';
  }
  if (module === 'alignment') return step.startsWith('transcription:') ? '声音识别' : '字幕对齐';
  if (module === 'canvas_export') return '画布文件打包';
  return TASK_STEP_LABELS[step] ?? '其他制作步骤';
}

export function taskWaitLabel(reason: string | null, concurrency?: number | null): string {
  if (!reason) return '';
  if (reason === 'personal_concurrency') return concurrency === 0
    ? '生效并发上限为 0，无法启动；请管理员检查团队默认或个人固定覆盖'
    : `个人运行名额已满${concurrency == null ? '' : `（上限 ${concurrency}）`}，名额释放后自动继续`;
  const labels: Record<string, string> = {
    maintenance: '系统维护或团队生产已暂停', actor_disabled: '账号已停用，请联系管理员',
    scope_forbidden: '项目访问权限不足，请联系管理员', actor_paused: '该成员已暂停生成',
    pool_missing: '供应商资源池尚未配置，请联系管理员', pool_disabled: '供应商资源池已停用',
    pool_capacity: '供应商名额已满，释放后自动继续', fair_share: '其他成员正在公平使用共享名额，释放后按顺序继续', pricing_required: '模型价格尚未配置',
    currency_mismatch: '计费币种不一致，请联系管理员', monthly_budget: '月度额度不足，请联系管理员',
    cost_unknown: '存在待核实费用，请管理员核查', stage_canceled: '已取消，尚未发送的请求已停止',
    business_failed: '生成失败，请查看项目运行日志',
    model_forbidden: '未获准调用此模型，请联系管理员调整模型权限',
  };
  return labels[reason] ?? `等待条件：${reason}`;
}
