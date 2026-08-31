'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type {
  ScriptStudioScriptContent,
  ScriptStudioTaskSnapshot,
} from '@/lib/script-studio/types';

interface Props {
  projectId: string;
}

interface Asset {
  id: string;
  filename: string;
  imageUrl?: string;
  role: string;
  usage?: string;
}

interface ScriptProviderView {
  id: string;
  name: string;
  model: string;
  configured: boolean;
  supportsVision: boolean;
  executionScope: 'external' | 'company';
}

function providerStorageKey(projectId: string): string {
  return `script-studio-provider:${projectId}`;
}

function providerOptionLabel(provider: ScriptProviderView): string {
  const nameAlreadyIncludesModel = provider.name.toLocaleLowerCase().includes(provider.model.toLocaleLowerCase());
  const identity = nameAlreadyIncludesModel ? provider.name : `${provider.name} · ${provider.model}`;
  return `${identity} · ${provider.executionScope === 'company' ? '需要公司内网' : '外部直连'}`;
}

interface ScriptView {
  id: string;
  projectId: string;
  shotSetId: string | null;
  currentRevisionId: string | null;
  generationTaskId?: string | null;
  createdAt: string;
  updatedAt: string;
  currentRevision?: {
    id: string;
    revisionNumber: number;
    origin: string;
    contentJson: string;
    targetDurationSec: number;
    estimatedDurationSec: number | null;
    templateId: string;
    templateVersion: number;
    templateRationale: string;
    createdAt: string;
  } | null;
}

interface RevisionView {
  id: string;
  revisionNumber: number;
  origin: string;
  contentJson: string;
  targetDurationSec: number;
  templateId: string;
  createdAt: string;
}

interface LibraryRevisionViewLite {
  id: string;
  revisionNumber: number;
  productName?: string;
  category?: string;
  brand?: string;
  updatedAt?: string;
  createdAt?: string;
  sellingPoints: Array<{
    id: string;
    title: string;
    factText: string;
    usable: number;
    disabledByUser: number;
    evidenceGate: string;
    riskLevel?: string;
    evidenceRefsJson?: string;
  }>;
}

function parseEvidenceRefsDisplay(evidenceRefsJson?: string): string {
  try {
    const refs: unknown = JSON.parse(evidenceRefsJson || '[]');
    if (!Array.isArray(refs) || refs.length === 0) return '';
    return refs
      .map((raw) => {
        const ref = raw && typeof raw === 'object' ? raw as { pageIndex?: unknown; tileRef?: unknown } : {};
        const page = typeof ref.pageIndex === 'number' ? ref.pageIndex + 1 : 1;
        const tile = typeof ref.tileRef === 'string' && ref.tileRef.trim() ? ` ${ref.tileRef.trim()}` : '';
        return `第${page}页${tile}`;
      })
      .join(' · ');
  } catch {
    return '';
  }
}

type StageView = ScriptStudioTaskSnapshot['stages'][number];

const STAGE_LABELS: Record<string, string> = {
  input_check: '整理输入与资源检查',
  read_pages: '读取详情页图片',
  extract: '提取、归并并筛选卖点',
  evidence_gate: '结构门禁与证据核验',
  save_library: '保存产品卖点库',
  load_library: '读取已有卖点库',
  plan: '规划创意方向与模板',
  generate: '生成脚本方案',
  validate: '执行时长、结构、事实和重复度检查',
};

// 原型「阶段 n · xxx」kicker 用的短名。
const STAGE_KICKERS: Record<string, string> = {
  input_check: '准备任务',
  read_pages: '视觉读取',
  extract: '卖点提炼',
  evidence_gate: '证据核验',
  save_library: '资产固化',
  load_library: '资产复用',
  plan: '创意规划',
  generate: '文案生成',
  validate: '完成检查',
};

// 每个阶段的一句固定说明（原型 copy），真实数字放产物小卡。
const STAGE_COPY: Record<string, string> = {
  input_check: '检查图片数量、目标时长和创作要求，随后开始读取详情页。',
  read_pages: '长图会拆成可读区域并自动压缩，不需要你手动处理。',
  extract: '识别商品名称、结构与规格文案；相同意思会合并，没有图片证据的表达不会当作事实。',
  evidence_gate: '数字、材质、认证类卖点要逐条通过二次证据检查，未通过的不会写进脚本。',
  save_library: '把本次识别结果固定为产品资产，之后再生成一版或一组都直接复用、不再重新看图。',
  load_library: '直接读取已保存的卖点与证据，减少等待，也避免同一详情页每次识别结果不一致。',
  plan: '结合时长、人群与创作要求，把每条脚本分配到不同的切入角度。',
  generate: '为每个方案匹配不同表达结构，并把选择结果与理由展示出来。',
  validate: '检查口播时长预算和方案之间的差异，通过后才能进入人工选择。',
};

// 两种模式的完整阶段数，用于进度条；只按真实完成的阶段推进，不做虚假百分比。
const MODE_STAGE_TOTAL: Record<string, number> = {
  first_extraction: 8,
  reuse: 5,
};

const ORIGIN_LABELS: Record<string, string> = {
  ai_generate: 'AI 初稿',
  ai_regenerate: 'AI 再生成',
  manual_edit: '手动编辑',
};

function parseContent(json: string): ScriptStudioScriptContent | null {
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object') return null;
    return value as ScriptStudioScriptContent;
  } catch {
    return null;
  }
}

function durationLabel(seconds: number): string {
  return `${seconds} 秒`;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function timeLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function elapsedSeconds(start: string | null | undefined, end: string | null | undefined, nowMs: number): number {
  if (!start) return 0;
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs)) return 0;
  const endMs = end ? new Date(end).getTime() : nowMs;
  if (!Number.isFinite(endMs)) return 0;
  return Math.max(0, (endMs - startMs) / 1000);
}

function formatElapsed(seconds: number): string {
  if (seconds < 0.5) return '';
  if (seconds >= 60) return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
  return `${Math.round(seconds)} 秒`;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// 时间线阶段名下的一句说明：进行中给动作提示，完成后给真实结果。
function stageMessage(stage: StageView): string {
  const payload = stage.payload || {};
  if (stage.status === 'running') {
    const runningHints: Record<string, string> = {
      read_pages: '正在压缩长图并切分为可读区域',
      extract: '正在识别图片中的商品信息与卖点文案',
      evidence_gate: '正在对数字、材质、认证类卖点逐条做二次证据检查',
      generate: '正在按创意方向撰写口播脚本',
      validate: '正在检查时长与方案差异',
    };
    return runningHints[stage.stage] || '正在处理';
  }
  switch (stage.stage) {
    case 'input_check': {
      const mode = asText(payload.mode) === 'reuse' ? '复用已有卖点库' : '首次提取卖点';
      return `目标 ${payload.targetDurationSec ?? '-'} 秒 · 生成 ${payload.requestedCount ?? '-'} 条 · ${mode}`;
    }
    case 'read_pages':
      return `读取 ${payload.imageCount ?? 0} 张详情页，切分为 ${payload.totalTiles ?? 0} 个可读区域${payload.degraded ? '（超长图已自动压缩）' : ''}`;
    case 'extract': {
      const product = [payload.productName, payload.brand, payload.category].map(asText).filter(Boolean).join(' · ');
      return `${product ? `识别商品：${product}；` : ''}归并后得到候选卖点 ${payload.candidateCount ?? 0} 条`;
    }
    case 'evidence_gate':
      return `候选 ${payload.total ?? 0} 条：可用 ${payload.usable ?? 0} 条，排除 ${payload.failed ?? 0} 条，其中 ${payload.highRiskVerified ?? 0} 条高风险卖点通过二次证据检查`;
    case 'save_library':
      return `卖点库已保存为 V${payload.revisionNumber ?? '-'}，后续生成直接复用`;
    case 'load_library':
      return `复用卖点库 V${payload.revisionNumber ?? '-'}，跳过详情页识别`;
    case 'plan': {
      const planCount = Array.isArray(payload.plans) ? payload.plans.length : null;
      return `${asText(payload.audience) ? `受众：${asText(payload.audience)} · ` : ''}${asText(payload.tone) ? `风格：${asText(payload.tone)} · ` : ''}规划 ${planCount ?? '-'} 个创意方向`;
    }
    case 'generate': {
      const errors = Array.isArray(payload.errors) ? payload.errors.filter((item) => asText(item)).length : 0;
      return `已生成 ${payload.generated ?? 0}/${payload.requested ?? '-'} 条${errors > 0 ? `，${errors} 条失败可补跑` : ''}`;
    }
    case 'validate':
      return `通过 ${payload.passed ?? 0} 条${Number(payload.failed) > 0 ? `，未通过 ${payload.failed} 条` : ''}`;
    default:
      return '';
  }
}

interface ArtifactItem {
  label: string;
  title: string;
  copy: string;
}

// 右侧产物区：标题按阶段状态给结果导向文案，items 用真实 payload 数字。
function stageArtifact(stage: StageView | undefined, task: ScriptStudioTaskSnapshot): {
  kicker: string;
  title: string;
  copy: string;
  status: string;
  items: ArtifactItem[];
} {
  if (!stage) {
    return {
      kicker: '准备任务',
      title: '排队等待调度',
      copy: '任务已创建，调度器领取后开始处理。',
      status: '排队中',
      items: [],
    };
  }
  const payload = stage.payload || {};
  const running = stage.status === 'running';
  const kicker = `阶段 ${stage.seq} · ${STAGE_KICKERS[stage.stage] || stage.stage}`;
  const base = { kicker, copy: STAGE_COPY[stage.stage] || '', status: running ? '进行中' : stage.status === 'failed' ? '未通过' : '已完成' };
  switch (stage.stage) {
    case 'input_check':
      return {
        ...base,
        title: running ? '正在整理输入内容' : '输入已整理完成',
        items: [
          { label: '目标时长', title: `${payload.targetDurationSec ?? task.inputSnapshot.targetDurationSec ?? '-'} 秒`, copy: 'AI 按口播速度控制正文长度' },
          { label: '生成数量', title: `${payload.requestedCount ?? task.requestedCount} 条并列方案`, copy: asText(payload.mode) === 'reuse' ? '复用已有卖点库' : '每条使用不同切入角度' },
        ],
      };
    case 'read_pages':
      return {
        ...base,
        title: running ? '正在理解详情页内容' : `已读取 ${payload.imageCount ?? 0} 张详情页`,
        items: [
          { label: '检测到图片', title: `共 ${payload.imageCount ?? '-'} 张详情页`, copy: '逐张识别后合并理解全部内容' },
          { label: '可读区域', title: `${payload.totalTiles ?? '-'} 个切片`, copy: payload.degraded ? '超长图已自动压缩分条' : '按阅读顺序排列' },
        ],
      };
    case 'extract':
      return {
        ...base,
        title: running ? '正在提取并归并卖点' : `已找到 ${payload.candidateCount ?? 0} 条候选卖点`,
        items: [
          { label: '商品初判', title: asText(payload.productName) || '识别中', copy: [payload.brand, payload.category].map(asText).filter(Boolean).join(' · ') || '品牌与品类以图片为准' },
          { label: '候选卖点', title: `${payload.candidateCount ?? '-'} 条`, copy: '相同意思已合并，保留证据来源' },
        ],
      };
    case 'evidence_gate':
      return {
        ...base,
        title: running ? '正在做二次证据检查' : `${payload.usable ?? 0} 条卖点可用`,
        items: [
          { label: '可用卖点', title: `${payload.usable ?? '-'} / ${payload.total ?? '-'} 条`, copy: '促销与未通过核验的不会写入脚本' },
          { label: '高风险核验', title: `${payload.highRiskVerified ?? 0} 条通过二次证据检查`, copy: '数字、材质、认证类逐条核验' },
        ],
      };
    case 'save_library':
      return {
        ...base,
        title: '卖点已保存为产品资产',
        items: [
          { label: '资产状态', title: `产品卖点库 · V${payload.revisionNumber ?? '-'} 已保存`, copy: '每条保留来源与置信度' },
          { label: '复用规则', title: '后续生成跳过识图', copy: '需要更新时再补充或替换详情页' },
        ],
      };
    case 'load_library':
      return {
        ...base,
        title: '已跳过详情页识别',
        items: [
          { label: '本次输入', title: `产品卖点库 · V${payload.revisionNumber ?? '-'}`, copy: '读取已有结构化资产' },
          { label: '节省步骤', title: '不重新拆图 / 不重新识别', copy: '只重新做创意规划和生成' },
        ],
      };
    case 'plan': {
      const plans = Array.isArray(payload.plans) ? payload.plans as Array<Record<string, unknown>> : [];
      return {
        ...base,
        title: running ? '正在拆分创意方向' : `已拆出 ${plans.length || task.requestedCount} 个方向`,
        items: plans.slice(0, 2).map((plan, index) => ({
          label: `方案 ${index + 1}`,
          title: asText(plan.direction) || asText(plan.templateId) || `方向 ${index + 1}`,
          copy: asText(plan.rationale) || '按切入点自动匹配模板',
        })),
      };
    }
    case 'generate':
      return {
        ...base,
        title: running ? '正在撰写脚本方案' : `已生成 ${payload.generated ?? 0} 条脚本`,
        items: [
          { label: '生成进度', title: `${payload.generated ?? task.succeededCount} / ${payload.requested ?? task.requestedCount} 条`, copy: '单条失败不阻断其余方案' },
          { label: '事实来源', title: '全部来自卖点库', copy: '不凭空增加功效' },
        ],
      };
    case 'validate':
      return {
        ...base,
        title: running ? '正在做完成检查' : `${payload.passed ?? 0} 条脚本通过基础校验`,
        items: [
          { label: '时长检查', title: `${payload.passed ?? '-'} 条符合目标预算`, copy: `目标 ${task.inputSnapshot.targetDurationSec ?? '-'} 秒` },
          { label: '差异检查', title: Number(payload.failed) > 0 ? `${payload.failed} 条未通过` : '方案之间保持区分', copy: '切入角度、模板和开场均需不同' },
        ],
      };
    default:
      return { ...base, title: STAGE_LABELS[stage.stage] || stage.stage, items: [] };
  }
}

// 活动日志：从阶段时间戳推导最近几条真实事件，最新在前。
function activityLines(stages: StageView[]): Array<{ time: string; text: string }> {
  const lines: Array<{ time: string; text: string; at: number }> = [];
  for (const stage of stages) {
    const name = STAGE_LABELS[stage.stage] || stage.stage;
    if (stage.startedAt) {
      lines.push({ time: timeLabel(stage.startedAt), text: `开始：${name}`, at: new Date(stage.startedAt).getTime() });
    }
    if (stage.finishedAt) {
      const elapsed = formatElapsed(elapsedSeconds(stage.startedAt, stage.finishedAt, 0));
      const result = stage.status === 'failed' ? '未通过' : '完成';
      lines.push({ time: timeLabel(stage.finishedAt), text: `${result}：${name}${elapsed ? ` · 用时 ${elapsed}` : ''}`, at: new Date(stage.finishedAt).getTime() + 0.5 });
    }
  }
  return lines.sort((a, b) => b.at - a.at).slice(0, 4).map(({ time, text }) => ({ time, text }));
}

export default function ScriptStudioPanel({ projectId }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [libraryReady, setLibraryReady] = useState(false);
  const [libraryRevisionId, setLibraryRevisionId] = useState('');
  const [scripts, setScripts] = useState<ScriptView[]>([]);
  const [task, setTask] = useState<ScriptStudioTaskSnapshot | null>(null);
  const [targetDurationSec, setTargetDurationSec] = useState(15);
  const [requestedCount, setRequestedCount] = useState(3);
  const [creativeBrief, setCreativeBrief] = useState('');
  const [providers, setProviders] = useState<ScriptProviderView[]>([]);
  const [providerId, setProviderId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [collapsedIds, setCollapsedIds] = useState<string[]>([]);
  const [historyFor, setHistoryFor] = useState('');
  const [historyRevisions, setHistoryRevisions] = useState<RevisionView[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryRevision, setLibraryRevision] = useState<LibraryRevisionViewLite | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const taskPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadProviders = useCallback(async () => {
    const response = await fetch('/api/providers/script', { cache: 'no-store' });
    const data = await response.json().catch(() => []);
    if (!response.ok || !Array.isArray(data)) {
      setError('无法读取脚本模型配置，请稍后重试');
      return;
    }
    const next = data as ScriptProviderView[];
    const available = next.filter((provider) => provider.configured && provider.supportsVision);
    setProviders(next);
    setProviderId((current) => {
      if (available.some((provider) => provider.id === current)) return current;
      let remembered = '';
      try {
        remembered = localStorage.getItem(providerStorageKey(projectId)) ?? '';
      } catch {
        // 隐私模式下不持久化选择。
      }
      if (available.some((provider) => provider.id === remembered)) return remembered;
      return available.find((provider) => (
        provider.executionScope === 'company'
        && `${provider.name} ${provider.model}`.toLocaleLowerCase().includes('luna')
      ))?.id
        ?? available.find((provider) => provider.executionScope === 'company')?.id
        ?? available[0]?.id
        ?? '';
    });
  }, [projectId]);

  const loadScripts = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/script-studio/scripts?limit=100`);
    const data = await response.json().catch(() => ({ scripts: [] }));
    setScripts(Array.isArray(data.scripts) ? data.scripts as ScriptView[] : []);
  }, [projectId]);

  const loadLibrary = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/script-studio/library`);
    const data = await response.json().catch(() => ({ current: null }));
    setLibraryReady(Boolean(data.current));
    setLibraryRevisionId(data.current?.id || '');
    setLibraryRevision(data.current || null);
  }, [projectId]);

  const startPolling = useCallback((taskId: string) => {
    if (taskPollRef.current) clearInterval(taskPollRef.current);
    taskPollRef.current = setInterval(async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/script-studio/tasks/${taskId}`, { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        const next = data.task as ScriptStudioTaskSnapshot | undefined;
        if (!next) return;
        setTask(next);
        if (['succeeded', 'partial'].includes(next.status)) {
          setStep(3);
          if (taskPollRef.current) clearInterval(taskPollRef.current);
          await loadScripts();
          await loadLibrary();
        } else if (next.status === 'failed') {
          setError(next.errorMessage || '生成失败');
          if (taskPollRef.current) clearInterval(taskPollRef.current);
        } else if (next.status === 'cancelled') {
          setNotice('任务已停止；返回素材后可重新开始');
          window.setTimeout(() => setNotice(''), 3000);
          if (taskPollRef.current) clearInterval(taskPollRef.current);
        }
      } catch {
        // 网络抖动时继续轮询，不打断任务。
      }
    }, 1200);
  }, [projectId, loadScripts, loadLibrary]);

  const loadTasks = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/script-studio/tasks?limit=10`);
    const data = await response.json().catch(() => ({ tasks: [] }));
    const latest = Array.isArray(data.tasks) ? data.tasks[0] as ScriptStudioTaskSnapshot | undefined : undefined;
    if (latest && ['queued', 'running'].includes(latest.status)) {
      setTask(latest);
      setStep(2);
      startPolling(latest.id);
    } else if (latest && ['succeeded', 'partial'].includes(latest.status)) {
      setTask(latest);
      setStep(3);
    } else if (latest?.status === 'failed') {
      setTask(latest);
      setError(latest.errorMessage || '生成失败，请返回检查素材后重试');
      setStep(2);
    } else if (latest?.status === 'cancelled') {
      setTask(latest);
      setStep(2);
    }
  }, [projectId, startPolling]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadScripts();
      void loadLibrary();
      void loadTasks();
      void loadProviders();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (taskPollRef.current) clearInterval(taskPollRef.current);
    };
  }, [loadScripts, loadLibrary, loadTasks, loadProviders]);

  // 过程页总已用时长的秒级走表；任务终态后停止。
  const taskRunning = Boolean(task && ['queued', 'running'].includes(task.status));
  useEffect(() => {
    if (step !== 2 || !taskRunning) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step, taskRunning]);

  const upload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const form = new FormData();
      Array.from(files).forEach((file) => form.append('files', file));
      form.append('role', 'input');
      form.append('projectId', projectId);
      form.append('usage', 'detail_page');
      form.append('preprocessEnabled', 'false');
      form.append('targetMaxSide', '4096');
      form.append('jpegQuality', '88');
      const response = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await response.json().catch(() => ({ files: [] }));
      if (!response.ok) {
        setError(data.error || '上传失败');
        return;
      }
      const uploaded = Array.isArray(data.files)
        ? (data.files as Array<{ id: string; filename: string; imageUrl?: string; role?: string; usage?: string }>).map((file) => ({
            id: file.id,
            filename: file.filename,
            imageUrl: file.imageUrl,
            role: file.role || 'input',
            usage: file.usage || 'detail_page',
          }))
        : [];
      setAssets((current) => [...current, ...uploaded]);
      setError('');
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '上传失败');
    } finally {
      setUploading(false);
    }
  }, [projectId]);

  const deleteAsset = useCallback(async (assetId: string) => {
    try {
      await fetch(`/api/images/${assetId}`, { method: 'DELETE' });
      setAssets((current) => current.filter((asset) => asset.id !== assetId));
    } catch {
      setError('删除图片失败，请稍后重试');
    }
  }, []);

  const startTask = useCallback(async (sourceSetId: string | null, libraryRevisionId: string | null) => {
    if (!providerId) {
      setError('请先选择一个已配置且支持图片读取的脚本模型');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/script-studio/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceSetId,
          libraryRevisionId,
          targetDurationSec,
          requestedCount,
          creativeBrief,
          providerId,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.message || data.error || `HTTP ${response.status}`);
        return;
      }
      const nextTask = data.task as ScriptStudioTaskSnapshot;
      setTask(nextTask);
      setStep(2);
      setNotice(data.schedulerEnabled ? '' : '任务已创建；真实供应商调用尚未授权，需启用调度器后执行');
      startPolling(nextTask.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }, [projectId, targetDurationSec, requestedCount, creativeBrief, providerId, startPolling]);

  const handleAnalyze = useCallback(async () => {
    if (!providerId) {
      setError('请先选择一个已配置且支持图片读取的脚本模型');
      return;
    }
    if (assets.length === 0 && !libraryReady) {
      setError('请先上传至少一张详情页图片，或先准备好可复用的卖点库');
      return;
    }
    if (assets.length === 0 && libraryReady) {
      await startTask(null, null);
      return;
    }
    const response = await fetch(`/api/projects/${projectId}/script-studio/source-sets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageAssetIds: assets.map((asset) => asset.id) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(data.message || data.error || '创建详情页来源失败');
      return;
    }
    await startTask(data.sourceSetId as string, null);
  }, [assets, libraryReady, projectId, providerId, startTask]);

  const switchRevision = useCallback(async (scriptId: string, revisionId: string) => {
    await fetch(`/api/projects/${projectId}/script-studio/scripts/${scriptId}/current`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revisionId }),
    });
    await loadScripts();
    setHistoryFor('');
    setHistoryRevisions([]);
    setNotice('已切换，该版本现在就是当前版本');
    window.setTimeout(() => setNotice(''), 2000);
  }, [projectId, loadScripts]);

  const copyScript = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setNotice('已复制完整脚本');
      window.setTimeout(() => setNotice(''), 1600);
    } catch {
      setNotice('复制失败，请手动选择文本');
      window.setTimeout(() => setNotice(''), 1600);
    }
  }, []);

  const loadHistory = useCallback(async (scriptId: string) => {
    setHistoryFor(scriptId);
    const response = await fetch(`/api/projects/${projectId}/script-studio/scripts/${scriptId}/revisions?limit=100`);
    const data = await response.json().catch(() => ({ revisions: [] }));
    setHistoryRevisions(Array.isArray(data.revisions) ? data.revisions as RevisionView[] : []);
  }, [projectId]);

  const regenerateOne = useCallback(async (scriptId: string) => {
    setError('');
    if (!providerId) {
      setError('请先选择一个已配置且支持图片读取的脚本模型');
      return;
    }
    try {
      const response = await fetch(`/api/projects/${projectId}/script-studio/scripts/${scriptId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.message || data.error || '再生成失败');
        return;
      }
      const nextTask = data.task as ScriptStudioTaskSnapshot;
      setTask(nextTask);
      setStep(2);
      startPolling(nextTask.id);
    } catch (err) {
      setError(String(err));
    }
  }, [projectId, providerId, startPolling]);

  const retryTask = useCallback(async () => {
    if (!task) return;
    setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/script-studio/tasks/${task.id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.message || data.error || '补跑失败');
        return;
      }
      const nextTask = data.task as ScriptStudioTaskSnapshot;
      setTask(nextTask);
      setStep(2);
      startPolling(nextTask.id);
    } catch (err) {
      setError(String(err));
    }
  }, [projectId, task, startPolling]);

  const regenerateGroup = useCallback(() => {
    if (!libraryRevisionId) {
      setError('当前项目没有可复用的卖点库');
      return;
    }
    void startTask(null, libraryRevisionId);
  }, [libraryRevisionId, startTask]);

  const cancelTask = useCallback(async () => {
    if (!task || !['queued', 'running'].includes(task.status)) return;
    try {
      const response = await fetch(`/api/projects/${projectId}/script-studio/tasks/${task.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.message || data.error || '停止任务失败');
        return;
      }
      if (data.task) setTask(data.task as ScriptStudioTaskSnapshot);
      setNotice('正在停止任务…');
      window.setTimeout(() => setNotice(''), 2000);
    } catch (err) {
      setError(String(err));
    }
  }, [projectId, task]);

  const stepTo = useCallback((next: 1 | 2 | 3) => {
    if (next === 2 && !task && !submitting) return;
    if (next === 3 && !scripts.length) return;
    setStep(next);
  }, [task, submitting, scripts.length]);

  const currentScripts = useMemo(() => scripts.map((script) => {
    const revision = script.currentRevision;
    return { script, content: revision ? parseContent(revision.contentJson) : null };
  }), [scripts]);

  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.configured && provider.supportsVision),
    [providers],
  );
  const selectedProvider = useMemo(
    () => availableProviders.find((provider) => provider.id === providerId) ?? null,
    [availableProviders, providerId],
  );

  const changeProvider = useCallback((nextProviderId: string) => {
    setProviderId(nextProviderId);
    try {
      localStorage.setItem(providerStorageKey(projectId), nextProviderId);
    } catch {
      // 隐私模式下不持久化选择。
    }
  }, [projectId]);

  const toggleCollapsed = useCallback((scriptId: string) => {
    setCollapsedIds((current) => (
      current.includes(scriptId) ? current.filter((id) => id !== scriptId) : [...current, scriptId]
    ));
  }, []);

  // 与服务端 fail closed 一致：证据未通过核验的卖点不计入「有效卖点」。
  const usablePoints = useMemo(() => (
    libraryRevision?.sellingPoints.filter((point) => point.usable === 1 && point.disabledByUser !== 1 && point.evidenceGate !== 'failed') || []
  ), [libraryRevision]);

  const historyScript = useMemo(() => (
    currentScripts.find(({ script }) => script.id === historyFor) || null
  ), [currentScripts, historyFor]);

  // 过程页派生数据
  const doneStageCount = task ? task.stages.filter((stage) => stage.status === 'succeeded').length : 0;
  const stageTotal = task ? (MODE_STAGE_TOTAL[task.mode] || Math.max(task.stages.length, 1)) : 1;
  const currentStageView = task
    ? ((taskRunning
        ? task.stages.find((stage) => stage.status === 'running')
        : task.stages.find((stage) => stage.status === 'failed'))
      || task.stages[task.stages.length - 1])
    : undefined;
  const artifact = task ? stageArtifact(currentStageView, task) : null;
  const taskStart = task?.stages[0]?.startedAt || task?.startedAt || null;
  const lastFinished = task ? [...task.stages].reverse().find((stage) => stage.finishedAt)?.finishedAt : null;
  const taskEnd = taskRunning ? null : (lastFinished || task?.updatedAt || null);
  const totalElapsed = task ? elapsedSeconds(taskStart, taskEnd, nowMs) : 0;

  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
        <div className="flex items-center gap-3">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Icon name="file-text" size={16} />
            详情页智能脚本生成
          </h2>
          <div className="flex items-center gap-1.5 text-xs" aria-label="脚本生成步骤">
            {([1, 2, 3] as Array<1 | 2 | 3>).map((item, index) => (
              <div key={item} className="flex items-center gap-1.5">
                {index > 0 && <span className="text-ink-tertiary">·</span>}
                <button
                  type="button"
                  onClick={() => stepTo(item)}
                  disabled={item === 2 && !task && !submitting || item === 3 && scripts.length === 0}
                  title={item === 1 ? '第 1 页：提供素材' : item === 2 ? '第 2 页：AI 分析与生成' : '第 3 页：选择脚本方案'}
                  className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[0.7rem] font-semibold ${
                    step === item ? 'bg-accent text-white' : item <= step ? 'bg-ok text-white' : 'bg-surface-subtle text-ink-tertiary'
                  }`}
                >
                  {item < step ? '✓' : item}
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-secondary">
          <span>任务状态：{task ? ({
            queued: '排队中',
            running: '运行中',
            succeeded: '已完成',
            partial: '部分完成',
            failed: '失败',
            cancelled: '已停止',
          } as Record<string, string>)[task.status] || task.status : '未开始'}</span>
        </div>
      </div>

      <div className="p-5">
        {error && <div className="mb-4 rounded-[18px] border border-warn/30 bg-warn-tint p-4 text-sm" role="alert">{error}</div>}
        {notice && <div className="mb-4 rounded-[18px] border border-ok/30 bg-ok-tint p-4 text-sm">{notice}</div>}
        {step === 1 && (
          <div className="space-y-5">
            <section
              className={`rounded-[18px] border p-4 transition-colors ${dragOver ? 'border-accent bg-accent-tint' : 'border-hairline bg-surface-subtle'}`}
              onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                if (!uploading) void upload(event.dataTransfer.files);
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                className="hidden"
                onChange={(event) => {
                  const input = event.currentTarget;
                  void upload(input.files).finally(() => { input.value = ''; });
                }}
              />
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold">提供素材</h3>
                  <p className="mt-1 text-sm text-ink-secondary">可以一次性放入一张或多张同一商品详情页。</p>
                </div>
                {assets.length > 0 && (
                  <button type="button" className="btn-primary btn-sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                    {uploading ? '正在上传…' : '继续添加'}
                  </button>
                )}
              </div>
              {assets.length === 0 ? (
                <button
                  data-testid="script-studio-upload-dropzone"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className={`flex min-h-[320px] w-full cursor-pointer flex-col items-center justify-center rounded-[16px] border-2 border-dashed px-6 text-center transition-all focus:outline-none focus:ring-4 focus:ring-accent/20 disabled:cursor-wait lg:min-h-[420px] ${
                    dragOver
                      ? 'border-accent bg-accent-tint text-accent'
                      : 'border-hairline bg-surface text-ink-secondary hover:border-accent/45 hover:bg-surface-hover'
                  }`}
                >
                  <Icon name="folder" size={40} className="mb-5 text-ink-tertiary" />
                  <span className="text-lg font-medium text-ink">
                    {uploading
                      ? '正在上传图片…'
                      : dragOver
                        ? '松开鼠标，开始上传'
                        : '拖拽图片到此处，或点击选择'}
                  </span>
                  <span className="mt-2 max-w-xl text-sm leading-6 text-ink-tertiary">
                    支持 PNG / JPEG / WebP；长详情页会在本地分析时自动压缩和分条处理
                  </span>
                </button>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {assets.map((asset) => (
                    <div key={asset.id} className="group relative rounded-[14px] border border-hairline bg-surface p-2">
                      <div className="aspect-[4/3] overflow-hidden rounded-[10px] bg-surface">
                        {asset.imageUrl ? <img src={asset.imageUrl} alt={asset.filename} className="h-full w-full object-cover" /> : <div className="h-full w-full" />}
                      </div>
                      <div className="mt-2 truncate text-xs text-ink-secondary">{asset.filename}</div>
                      <button
                        type="button"
                        onClick={() => void deleteAsset(asset.id)}
                        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-white opacity-60 transition hover:bg-fail group-hover:opacity-100"
                        title="删除此图片"
                        aria-label={`删除 ${asset.filename}`}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {libraryReady && (
                <p className="mt-3 text-xs text-ok">当前项目已有可复用卖点库，未上传新素材时也可直接生成。</p>
              )}
            </section>

            <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="label">脚本模型</label>
                <select
                  aria-label="脚本模型"
                  value={providerId}
                  onChange={(event) => changeProvider(event.target.value)}
                  className="input-field"
                  disabled={availableProviders.length === 0}
                >
                  {availableProviders.length === 0 && <option value="">暂无可用视觉模型</option>}
                  {availableProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {providerOptionLabel(provider)}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs leading-5 text-ink-tertiary">
                  {selectedProvider
                    ? `本次识图、卖点核验和脚本生成统一使用 ${selectedProvider.model}（${selectedProvider.executionScope === 'company' ? '需要公司内网，并经本机 LiteLLM' : '外部直连'}）`
                    : '请先在设置中配置一个支持图片读取的脚本模型'}
                </p>
              </div>
              <div>
                <label className="label">目标时长</label>
                <select value={targetDurationSec} onChange={(event) => setTargetDurationSec(Number(event.target.value))} className="input-field">
                  {[15, 20, 30, 45, 60].map((duration) => <option key={duration} value={duration}>{durationLabel(duration)}</option>)}
                </select>
              </div>
              <div>
                <label className="label">生成数量</label>
                <select value={requestedCount} onChange={(event) => setRequestedCount(Number(event.target.value))} className="input-field">
                  {[1, 2, 3, 5].map((count) => <option key={count} value={count}>{count} 条并列方案</option>)}
                </select>
              </div>
              <div>
                <label className="label">已添加图片</label>
                <div className="flex h-9 items-center text-sm text-ink-secondary">{assets.length} 张</div>
              </div>
            </section>

            <div>
              <label className="label">创作要求（可选）</label>
              <textarea
                value={creativeBrief}
                onChange={(event) => setCreativeBrief(event.target.value)}
                rows={4}
                placeholder="例如：面向 25-35 岁女性，风格自然可信，避免夸张功效，前三秒强调真实使用场景"
                className="input-field"
              />
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-hairline pt-4">
              <p className="text-xs text-ink-tertiary">✓ 卖点首次提取后固定保存；以后再生成脚本直接复用，不重复识图。</p>
              <button
                type="button"
                onClick={() => void handleAnalyze()}
                disabled={submitting || uploading || !providerId || (assets.length === 0 && !libraryReady)}
                className="btn-primary"
              >
                {submitting ? '正在创建任务…' : '分析并生成脚本'}
              </button>
            </div>
          </div>
        )}

        {step === 2 && task && (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold">
                  {taskRunning
                    ? (task.mode === 'reuse' ? 'AI 正在生成新一组脚本' : 'AI 正在处理这组任务')
                    : task.status === 'failed'
                      ? '任务未通过'
                      : task.status === 'cancelled'
                        ? '任务已停止'
                        : '本组脚本已生成'}
                </h3>
                <p className="mt-1 text-sm text-ink-secondary">
                  {taskRunning
                    ? '你可以离开当前区域，生成过程会继续保留；长详情页首次提取通常需要几分钟。'
                    : task.status === 'cancelled'
                      ? '任务已手动停止，未生成结果；返回素材后可重新开始。'
                      : '中间结果已保留；继续再生成时会复用产品卖点库。'}
                </p>
                {asText(task.inputSnapshot.providerModel) && (
                  <p className="mt-1 text-xs text-ink-tertiary">本次模型：{asText(task.inputSnapshot.providerModel)}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                {taskRunning && <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />}
                <span className="text-xs tabular-nums text-ink-tertiary">{formatClock(totalElapsed)}</span>
                {taskRunning && (
                  <button type="button" onClick={() => void cancelTask()} className="btn-secondary btn-sm text-fail">停止任务</button>
                )}
                {task.status === 'failed' && (
                  <button type="button" onClick={() => void retryTask()} className="btn-primary btn-sm">使用本次模型重试</button>
                )}
                <button type="button" onClick={() => setStep(1)} className="btn-secondary btn-sm">返回素材</button>
              </div>
            </div>

            <div className="h-1.5 overflow-hidden rounded-full bg-surface-subtle">
              <div
                className="h-full rounded-full bg-accent transition-all duration-500"
                style={{ width: `${Math.round((doneStageCount / stageTotal) * 100)}%` }}
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.28fr)]">
              <div className="rounded-[18px] border border-hairline bg-surface-subtle p-4">
                <div className="mb-3 text-[0.7rem] font-bold tracking-wide text-ink-tertiary">真实处理阶段</div>
                <div>
                  {task.stages.map((stage, index) => {
                    const message = stageMessage(stage);
                    return (
                      <div key={`${stage.seq}-${stage.stage}`} className={`relative flex gap-3 pb-4 ${index === task.stages.length - 1 ? '' : 'before:absolute before:bottom-1 before:left-[9px] before:top-6 before:w-px before:bg-hairline before:content-[""]'}`}>
                        <span className={`z-[1] flex h-[19px] w-[19px] flex-none items-center justify-center rounded-full border text-[0.62rem] font-bold ${
                          stage.status === 'running'
                            ? 'border-accent bg-accent text-white'
                            : stage.status === 'succeeded'
                              ? 'border-ok bg-ok text-white'
                              : stage.status === 'failed'
                                ? 'border-fail bg-fail text-white'
                                : 'border-hairline bg-surface text-ink-tertiary'
                        }`}
                        >
                          {stage.status === 'succeeded' ? '✓' : stage.seq}
                        </span>
                        <div className="min-w-0 pt-px">
                          <div className={`text-xs font-semibold ${stage.status === 'running' ? 'text-accent' : stage.status === 'failed' ? 'text-fail' : 'text-ink-secondary'}`}>
                            {STAGE_LABELS[stage.stage] || stage.stage}
                          </div>
                          {message && <div className="mt-1 text-[0.68rem] leading-4 text-ink-tertiary">{message}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {artifact && (
                <div className="flex min-w-0 flex-col rounded-[18px] border border-hairline p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-[0.7rem] font-bold text-accent">{artifact.kicker}</div>
                      <div className="mt-1 text-base font-semibold">{artifact.title}</div>
                      <p className="mt-1.5 text-xs leading-5 text-ink-secondary">{artifact.copy}</p>
                    </div>
                    <span className={`flex-none rounded-full px-2.5 py-1 text-[0.68rem] font-semibold ${
                      artifact.status === '进行中' ? 'bg-accent-tint text-accent' : artifact.status === '未通过' ? 'bg-warn-tint text-warn' : 'bg-ok-tint text-ok'
                    }`}
                    >
                      {artifact.status}
                    </span>
                  </div>
                  {artifact.items.length > 0 && (
                    <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                      {artifact.items.map((item) => (
                        <div key={item.label} className="rounded-[14px] border border-hairline bg-surface-subtle p-3">
                          <div className="text-[0.65rem] text-ink-tertiary">{item.label}</div>
                          <div className="mt-1 truncate text-[0.8rem] font-semibold">{item.title}</div>
                          <div className="mt-1 text-[0.65rem] leading-4 text-ink-secondary">{item.copy}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-auto pt-4">
                    {activityLines(task.stages).map((line, index) => (
                      <div key={`${line.time}-${index}`} className="flex items-start gap-2.5 border-t border-hairline py-2 text-[0.68rem] leading-4 text-ink-secondary">
                        <span className="w-12 flex-none tabular-nums text-ink-tertiary">{line.time}</span>
                        <span>{line.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {task.status === 'failed' && (
              <div className="rounded-[18px] border border-warn/30 bg-warn-tint p-4 text-sm">{task.errorMessage || '生成失败，请返回检查素材后重试'}</div>
            )}
            {task.status === 'cancelled' && (
              <div className="rounded-[18px] border border-hairline bg-surface-subtle p-4 text-sm text-ink-secondary">任务已手动停止，未写入任何结果；返回素材后可重新开始。</div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            {libraryRevision && (
              <section className="rounded-[18px] border border-hairline p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="flex items-center gap-2 text-base font-semibold">
                      <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-ok-tint text-xs text-ok">✓</span>
                      产品卖点库
                    </h3>
                    <p className="mt-1 text-xs text-ink-secondary">从详情页提取并去重后的结构化资产。之后生成新脚本时直接复用，也可以继续补充详情页更新。</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-ok-tint px-2.5 py-1 text-[0.68rem] font-semibold text-ok">✓ 已保存 · 可无限复用</span>
                    <button type="button" onClick={() => setLibraryOpen((current) => !current)} className="btn-secondary btn-sm">{libraryOpen ? '收起编辑' : '回看/编辑'}</button>
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
                  <div className="rounded-[14px] border border-hairline bg-surface-subtle p-3.5">
                    <div className="text-sm font-semibold">{libraryRevision.productName || '未识别商品'}</div>
                    <div className="mt-1 text-[0.68rem] leading-4 text-ink-tertiary">
                      {[libraryRevision.brand, libraryRevision.category].map((item) => item?.trim()).filter(Boolean).join(' · ') || '详情页素材'}
                      <br />
                      {usablePoints.length} 个有效卖点 · V{libraryRevision.revisionNumber}
                    </div>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                    {usablePoints.slice(0, 9).map((point, index) => (
                      <div key={point.id} className="rounded-[14px] border border-hairline bg-surface p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[0.65rem] font-bold text-accent">SP-{String(index + 1).padStart(2, '0')}</span>
                          <span className={`text-[0.6rem] ${point.evidenceGate === 'passed' ? 'text-ok' : 'text-ink-tertiary'}`}>
                            {point.evidenceGate === 'passed' ? '已通过二次证据检查' : '低风险'}
                          </span>
                        </div>
                        <div className="mt-1.5 text-xs font-semibold">{point.title}</div>
                        <div className="mt-1 line-clamp-2 text-[0.65rem] leading-4 text-ink-tertiary">{point.factText}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {libraryOpen && (
                  <div className="mt-4">
                    <LibraryEditor
                      projectId={projectId}
                      revision={libraryRevision}
                      onSaved={() => { setLibraryOpen(false); void loadLibrary(); }}
                    />
                  </div>
                )}
              </section>
            )}

            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">脚本方案</h3>
                <p className="mt-1 text-sm text-ink-secondary">
                  每个方案当前显示的版本会自动供后续流程读取，无需再次确认。
                  {task?.status === 'partial' && ` 本次有 ${task.failedCount} 条未通过，可使用补跑。`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {libraryRevisionId && <span className="text-xs text-ok">✓ 再生成只复用卖点库，不重新识图</span>}
                <button type="button" onClick={regenerateGroup} className="btn-secondary btn-sm">再生成一组</button>
                {(task?.status === 'partial' || task?.status === 'failed') && (
                  <button type="button" onClick={() => void retryTask()} className="btn-secondary btn-sm">补跑缺失条目</button>
                )}
                <button type="button" onClick={() => setStep(1)} className="btn-secondary btn-sm">返回第 1 页</button>
              </div>
            </div>

            <div className="space-y-4">
              {currentScripts.map(({ script, content }, index) => {
                const revision = script.currentRevision;
                // 与原型一致：默认只展开第一个方案，其余收起，点击切换。
                const toggled = collapsedIds.includes(script.id);
                const collapsed = index === 0 ? toggled : !toggled;
                const usedPoints = content?.sellingPointUsage?.filter((point) => point.status === 'used') || [];
                return (
                  <article key={script.id} className="rounded-[18px] border border-hairline bg-surface">
                    <div className="flex items-start justify-between gap-4 p-4">
                      <div className="flex min-w-0 gap-3">
                        <div className="flex h-8 w-8 flex-none items-center justify-center rounded-[10px] bg-surface-subtle text-[0.7rem] font-bold text-ink-secondary">
                          {String(index + 1).padStart(2, '0')}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-sm font-semibold">方案 {index + 1} · {content?.title || '未命名方案'}</h4>
                            <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[0.65rem] font-semibold text-accent">{content?.template || revision?.templateId || '模板'}</span>
                            <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[0.65rem] font-semibold text-ink-secondary">V{revision?.revisionNumber || 1}</span>
                            {task?.parentTaskId && script.generationTaskId === task.id && <span className="rounded-full bg-ok-tint px-2 py-0.5 text-[0.65rem] font-semibold text-ok">补跑</span>}
                          </div>
                          <div className="mt-1 text-xs leading-5 text-ink-secondary">
                            模板选择理由：{content?.templateRationale || revision?.templateRationale || '按切入点自动匹配'}
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-none flex-wrap justify-end gap-1.5">
                        <button type="button" onClick={() => toggleCollapsed(script.id)} className="btn-secondary btn-sm">{collapsed ? '完整脚本' : '收起脚本'}</button>
                        <button type="button" onClick={() => void copyScript(content?.fullScript || '')} className="btn-secondary btn-sm">复制</button>
                        <button type="button" onClick={() => void regenerateOne(script.id)} className="btn-secondary btn-sm">再生成一版</button>
                        <button type="button" onClick={() => void loadHistory(script.id)} className="btn-secondary btn-sm">版本历史</button>
                      </div>
                    </div>
                    {!collapsed && content && (
                      <div className="border-t border-hairline p-4">
                        <div className="grid gap-2.5 sm:grid-cols-2">
                          <div className="rounded-[14px] border border-hairline bg-surface-subtle p-3">
                            <div className="text-[0.65rem] font-semibold text-ink-tertiary">封面主标题</div>
                            <div className="mt-1 text-sm font-semibold">{content.coverTitleParts?.primary || '-'}</div>
                          </div>
                          <div className="rounded-[14px] border border-hairline bg-surface-subtle p-3">
                            <div className="text-[0.65rem] font-semibold text-ink-tertiary">封面副标题</div>
                            <div className="mt-1 text-sm font-semibold">{content.coverTitleParts?.secondary || '-'}</div>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-[13px] border border-hairline px-3 py-2.5 text-[0.68rem] text-ink-secondary">
                          {content.durationStatus === 'qualified'
                            ? <span className="font-semibold text-ok">✓ 时长合格</span>
                            : <span className="font-semibold text-warn">{content.durationStatus === 'too_short' ? '时长偏短' : '时长偏长'}</span>}
                          <span>{content.targetDurationSec} 秒目标</span>
                          {typeof content.estimatedNarrationDurationSec === 'number' && <span>预计 {content.estimatedNarrationDurationSec.toFixed(1)} 秒</span>}
                          <span>{content.contentCharacterCount} 字</span>
                          <span>版本 V{revision?.revisionNumber || 1} · {ORIGIN_LABELS[revision?.origin || ''] || revision?.origin || '-'}</span>
                          <span className="font-semibold text-ok">当前版本自动用于后续流程</span>
                        </div>
                        {usedPoints.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {usedPoints.map((point) => (
                              <span key={point.sellingPointId} className="rounded-full bg-ok-tint px-2 py-1 text-[0.65rem] font-semibold text-ok">✓ {point.title}</span>
                            ))}
                          </div>
                        )}
                        {content.direction && <p className="mt-3 text-xs leading-5 text-ink-secondary">{content.direction}</p>}
                        <div className="mt-3 rounded-[14px] bg-surface-subtle">
                          <div className="flex items-center justify-between border-b border-hairline px-3.5 py-2.5">
                            <span className="text-[0.7rem] font-semibold">完整配音稿</span>
                            <button type="button" onClick={() => toggleCollapsed(script.id)} className="text-[0.65rem] text-ink-tertiary hover:text-ink">收起</button>
                          </div>
                          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap p-3.5 text-sm leading-7">{content.fullScript || '（无脚本内容）'}</pre>
                        </div>
                        <EditBox
                          script={script}
                          content={content}
                          projectId={projectId}
                          onSaved={() => { void loadScripts(); }}
                        />
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {historyScript && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/20" onClick={() => { setHistoryFor(''); setHistoryRevisions([]); }} />
          <aside className="absolute bottom-0 right-0 top-0 flex w-[min(460px,94vw)] flex-col bg-surface shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-hairline p-5">
              <div>
                <div className="text-base font-semibold">版本历史</div>
                <div className="mt-1 text-xs leading-5 text-ink-secondary">
                  {historyScript.content?.title || '未命名方案'} · 当前版本 V{historyScript.script.currentRevision?.revisionNumber || 1}；切换后自动供后续流程读取
                </div>
              </div>
              <button type="button" onClick={() => { setHistoryFor(''); setHistoryRevisions([]); }} className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-surface-subtle text-ink-secondary" aria-label="关闭">
                <Icon name="close" size={13} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="space-y-2.5">
                {[...historyRevisions].reverse().map((revision) => {
                  const isCurrent = revision.id === historyScript.script.currentRevisionId;
                  const preview = parseContent(revision.contentJson)?.fullScript || '';
                  return (
                    <div key={revision.id} className="rounded-[15px] border border-hairline p-3.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-xs font-semibold">
                          <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[0.65rem] font-semibold text-accent">V{revision.revisionNumber}</span>
                          <span>{ORIGIN_LABELS[revision.origin] || revision.origin}</span>
                          {isCurrent && <span className="rounded-full bg-ok-tint px-2 py-0.5 text-[0.65rem] font-semibold text-ok">当前版本</span>}
                        </div>
                        <span className="text-[0.65rem] text-ink-tertiary">{timeLabel(revision.createdAt)}</span>
                      </div>
                      {preview && <p className="mt-2 line-clamp-3 text-xs leading-5 text-ink-secondary">{preview}</p>}
                      <div className="mt-2.5">
                        <button
                          type="button"
                          disabled={isCurrent}
                          onClick={() => void switchRevision(historyScript.script.id, revision.id)}
                          className={isCurrent ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
                        >
                          {isCurrent ? '当前版本' : '切换到此版'}
                        </button>
                      </div>
                    </div>
                  );
                })}
                {historyRevisions.length === 0 && <div className="py-8 text-center text-xs text-ink-tertiary">正在读取版本历史…</div>}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function LibraryEditor({
  projectId,
  revision,
  onSaved,
}: {
  projectId: string;
  revision: LibraryRevisionViewLite;
  onSaved: () => void;
}) {
  const [edits, setEdits] = useState<Array<{ sellingPointId: string; usable?: boolean; disabledByUser?: boolean }>>(
    revision.sellingPoints.map((point) => ({ sellingPointId: point.id, usable: point.usable === 1 && point.disabledByUser !== 1 })),
  );
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/script-studio/library`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits }),
      });
      if (response.ok) onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="rounded-[18px] border border-hairline bg-surface-subtle p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h4 className="text-base font-semibold">卖点库回看 / 编辑</h4>
          <p className="mt-1 text-xs text-ink-secondary">V{revision.revisionNumber} · {revision.productName || '未识别商品'} · {revision.category || ''}</p>
        </div>
        <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary btn-sm">{saving ? '保存中…' : '保存为新修订'}</button>
      </div>
      <div className="space-y-2">
        {revision.sellingPoints.map((point) => (
          <label key={point.id} className="flex items-start gap-3 rounded-[14px] border border-hairline bg-surface p-3 text-sm">
            <input
              type="checkbox"
              checked={point.evidenceGate !== 'failed' && (edits.find((edit) => edit.sellingPointId === point.id)?.usable ?? point.usable === 1)}
              disabled={point.evidenceGate === 'failed'}
              onChange={(event) => {
                setEdits((current) => current.map((edit) => (
                  edit.sellingPointId === point.id ? { ...edit, usable: event.target.checked } : edit
                )));
              }}
            />
            <span className="min-w-0">
              <span className="font-medium">{point.title}</span>
              <span className="ml-2 text-xs text-ink-tertiary">{point.evidenceGate === 'passed' ? '已通过二次证据检查' : point.evidenceGate === 'skipped' ? '低风险' : '未通过核验，不可用'}</span>
              <span className="mt-1 block text-xs text-ink-secondary">{point.factText}</span>
              {parseEvidenceRefsDisplay(point.evidenceRefsJson) && (
                <span className="mt-0.5 block text-[0.65rem] text-ink-tertiary">证据定位：{parseEvidenceRefsDisplay(point.evidenceRefsJson)}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function EditBox({
  script,
  content,
  projectId,
  onSaved,
}: {
  script: ScriptView;
  content: ScriptStudioScriptContent;
  projectId: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content.fullScript);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const nextContent: ScriptStudioScriptContent = {
        ...content,
        fullScript: text,
        segments: content.segments.map((segment, index) => ({
          ...segment,
          narration: text.split('\n')[index] || segment.narration,
          subtitle: segment.subtitle,
        })),
      };
      await fetch(`/api/projects/${projectId}/script-studio/scripts/${script.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentJson: nextContent,
          targetDurationSec: content.targetDurationSec,
          origin: 'manual_edit',
        }),
      });
      onSaved();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  if (!editing) {
    return (
      <div className="mt-3 flex justify-end">
        <button type="button" onClick={() => { setText(content.fullScript); setEditing(true); }} className="btn-secondary btn-sm">编辑</button>
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-2">
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={8} className="input-field" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setEditing(false)} className="btn-secondary btn-sm">取消</button>
        <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary btn-sm">{saving ? '保存中…' : '保存为新版本'}</button>
      </div>
    </div>
  );
}
