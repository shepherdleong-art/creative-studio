/**
 * 提交受理证据的纯合同。
 *
 * 这里不访问数据库、不读环境变量，也不解析供应商错误正文。入口适配器只提供
 * 结构化来源、阶段、HTTP 状态和安全错误码；分类器负责统一决定状态、可执行动作
 * 与远端/本地占用。任何无法证明“未创建”的提交异常都必须归为 unknown。
 */

export type SubmissionEntry = 'image' | 'video' | 'canvas';
export type SubmissionStage = 'submit' | 'poll' | 'download';
export type SubmissionSource = 'adapter' | 'transport' | 'provider' | 'persisted' | 'journal' | 'operator';

export type SubmissionEvidenceState =
  | 'confirmed_not_created'
  | 'accepted'
  | 'terminal_failed'
  | 'terminal_succeeded'
  | 'unknown';

export type SubmissionIssue =
  | 'none'
  | 'submit_rejected'
  | 'submit_uncertain'
  | 'remote_query_failed'
  | 'remote_terminal_failed'
  | 'download_failed';

export type SubmissionAction =
  | 'retry_submit'
  | 'poll_remote'
  | 'retry_download'
  | 'reconcile';

export type SubmissionErrorCategory =
  | 'client_rejected'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'parse'
  | 'timeout'
  | 'adapter_rejected'
  | 'unknown';

export interface SafeSubmissionError {
  code: string;
  category: SubmissionErrorCategory;
  httpStatus: number | null;
}

export interface SubmissionEvidenceIdentity {
  entry: SubmissionEntry;
  taskId: string;
  businessAttemptNo: number;
  adapterId: string;
  source: SubmissionSource;
  stage: SubmissionStage;
}

export interface SubmissionOccupancy {
  /** 远端生成名额；未知结果必须保持 hold。 */
  remote: 'hold' | 'release' | 'not_acquired';
  /** 本地 worker 名额；未知提交可结束本轮 worker，但不能据此释放远端名额。 */
  local: 'hold' | 'release';
  releaseWhen: 'confirmed_not_created' | 'remote_terminal' | 'remote_result_confirmed' | null;
}

export interface SubmissionEmployeeCopy {
  label: string;
  detail: string;
  actionLabel: string | null;
}

export interface SubmissionEvidence {
  schemaVersion: 1;
  identity: SubmissionEvidenceIdentity;
  state: SubmissionEvidenceState;
  issue: SubmissionIssue;
  remoteId: string | null;
  hasResultRef: boolean;
  error: SafeSubmissionError | null;
  allowedActions: SubmissionAction[];
  occupancy: SubmissionOccupancy;
  employee: SubmissionEmployeeCopy;
}

export class ProviderRequestError extends Error {
  readonly category: SubmissionErrorCategory;
  readonly httpStatus: number | null;
  readonly code: string;
  readonly ambiguous: boolean;

  constructor(input: {
    message: string;
    category: ProviderRequestError['category'];
    code: string;
    httpStatus?: number | null;
    ambiguous?: boolean;
  }) {
    super(input.message);
    this.name = 'ProviderRequestError';
    this.category = input.category;
    this.httpStatus = input.httpStatus ?? null;
    this.code = input.code;
    this.ambiguous = input.ambiguous ?? false;
  }
}

/** 408/425/429 与所有 5xx 都可能发生在请求已送达之后。 */
export function isAmbiguousSubmissionHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function providerHttpError(status: number, message = `供应商请求失败（HTTP ${status}）`): ProviderRequestError {
  const category: SubmissionErrorCategory = status === 429
    ? 'rate_limited'
    : status >= 500
      ? 'server_error'
      : status === 408 || status === 425
        ? 'timeout'
        : status >= 400 && status < 500
          ? 'client_rejected'
          : 'unknown';
  return new ProviderRequestError({
    message,
    category,
    httpStatus: status,
    code: `provider_http_${Number.isInteger(status) ? status : 'unknown'}`,
    ambiguous: isAmbiguousSubmissionHttpStatus(status),
  });
}

export interface SubmissionSubject {
  entry: SubmissionEntry;
  taskId: string;
  businessAttemptNo: number;
  adapterId: string;
  stage: SubmissionStage;
  source: SubmissionSource;
}

export interface SubmissionFailureInput extends Omit<SubmissionSubject, 'entry'> {
  error: unknown;
  remoteId?: string | null;
  hasResultRef?: boolean;
}

export type SubmissionOutcomeInput = SubmissionSubject & {
  outcome: 'confirmed_not_created' | 'accepted' | 'terminal_failed' | 'terminal_succeeded' | 'download_failed';
  remoteId?: string | null;
  hasResultRef?: boolean;
  errorCode?: string | null;
};

function safeToken(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(normalized) ? normalized : fallback;
}

function errorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { httpStatus?: unknown; status?: unknown; statusCode?: unknown };
  for (const candidate of [value.httpStatus, value.status, value.statusCode]) {
    if (Number.isInteger(candidate) && Number(candidate) >= 100 && Number(candidate) <= 599) {
      return Number(candidate);
    }
  }
  return null;
}

function errorIdentity(error: unknown): SafeSubmissionError {
  if (error instanceof ProviderRequestError) {
    return {
      code: safeToken(error.code, error.httpStatus === null ? 'provider_request_failed' : `provider_http_${error.httpStatus}`),
      category: error.category,
      httpStatus: error.httpStatus,
    };
  }
  const httpStatus = errorStatusCode(error);
  if (httpStatus !== null) {
    return {
      code: httpStatus === 429 ? 'provider_http_429'
        : httpStatus >= 500 ? `provider_http_${httpStatus}`
          : `provider_http_${httpStatus}`,
      category: httpStatus === 429 ? 'rate_limited'
        : httpStatus >= 500 ? 'server_error'
          : httpStatus === 408 || httpStatus === 425 ? 'timeout'
            : 'client_rejected',
      httpStatus,
    };
  }
  const namedCode = error && typeof error === 'object' && 'code' in error
    ? safeToken((error as { code?: unknown }).code, '')
    : '';
  if (error instanceof SyntaxError) {
    return { code: namedCode || 'provider_response_unparsable', category: 'parse', httpStatus: null };
  }
  if (error instanceof TypeError) {
    return { code: namedCode || 'provider_transport_failed', category: 'network', httpStatus: null };
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { code: namedCode || 'provider_request_timeout', category: 'timeout', httpStatus: null };
  }
  return { code: namedCode || 'submission_unknown', category: 'unknown', httpStatus: null };
}

function explicitAdapterRejection(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && 'uncertain' in error
    && (error as { uncertain?: unknown }).uncertain === false);
}

function explicitUncertain(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && 'uncertain' in error
    && (error as { uncertain?: unknown }).uncertain === true);
}

export function submissionEmployeeCopy(
  state: SubmissionEvidenceState,
  issue: SubmissionIssue,
): SubmissionEmployeeCopy {
  if (state === 'confirmed_not_created') {
    return {
      label: '未创建',
      detail: '供应商未创建任务，可重新提交。',
      actionLabel: '重新提交',
    };
  }
  if (state === 'accepted') {
    return {
      label: '已受理',
      detail: '供应商已受理，正在查询结果。',
      actionLabel: null,
    };
  }
  if (state === 'terminal_failed') {
    return {
      label: '生成失败',
      detail: '供应商已明确生成失败，请查看任务记录后再决定是否重试。',
      actionLabel: '查看记录',
    };
  }
  if (state === 'terminal_succeeded' && issue === 'download_failed') {
    return {
      label: '下载失败',
      detail: '生成已完成，但结果下载失败。可以补下载原结果，不会重新调用模型。',
      actionLabel: '重试下载',
    };
  }
  if (state === 'terminal_succeeded') {
    return {
      label: '生成完成',
      detail: '供应商已生成结果。',
      actionLabel: null,
    };
  }
  if (issue === 'remote_query_failed') {
    return {
      label: '结果确认中',
      detail: '暂时无法查询生成结果。原任务身份已保留，后台会继续查询，不会重新生成。',
      actionLabel: '查看核查',
    };
  }
  return {
    label: '结果确认中',
    detail: '本次提交可能已被供应商受理。后台会保留原任务并核对结果，不会自动重复提交。',
    actionLabel: '查看核查',
  };
}

function evidence(
  identity: SubmissionEvidenceIdentity,
  input: {
    state: SubmissionEvidenceState;
    issue: SubmissionIssue;
    remoteId?: string | null;
    hasResultRef?: boolean;
    error?: SafeSubmissionError | null;
    allowedActions: SubmissionAction[];
    occupancy: SubmissionOccupancy;
  },
): SubmissionEvidence {
  return {
    schemaVersion: 1,
    identity,
    state: input.state,
    issue: input.issue,
    remoteId: input.remoteId?.trim() || null,
    hasResultRef: Boolean(input.hasResultRef),
    error: input.error ?? null,
    allowedActions: input.allowedActions,
    occupancy: input.occupancy,
    employee: submissionEmployeeCopy(input.state, input.issue),
  };
}

function classifyFailure(identity: SubmissionEvidenceIdentity, input: SubmissionFailureInput): SubmissionEvidence {
  const remoteId = input.remoteId?.trim() || null;
  if (identity.stage === 'poll') {
    return evidence(identity, {
      state: 'unknown',
      issue: 'remote_query_failed',
      remoteId,
      hasResultRef: input.hasResultRef,
      error: errorIdentity(input.error),
      allowedActions: remoteId ? ['poll_remote', 'reconcile'] : ['reconcile'],
      occupancy: { remote: remoteId ? 'hold' : 'not_acquired', local: 'release', releaseWhen: 'remote_result_confirmed' },
    });
  }
  if (identity.stage === 'download') {
    return evidence(identity, {
      state: 'terminal_succeeded',
      issue: 'download_failed',
      remoteId,
      hasResultRef: true,
      error: errorIdentity(input.error),
      allowedActions: ['retry_download'],
      occupancy: { remote: 'release', local: 'release', releaseWhen: 'remote_terminal' },
    });
  }

  const error = errorIdentity(input.error);
  const status = error.httpStatus;
  const ambiguous = error.category === 'rate_limited'
    || error.category === 'server_error'
    || error.category === 'network'
    || error.category === 'parse'
    || error.category === 'timeout'
    || (status !== null && isAmbiguousSubmissionHttpStatus(status))
    || explicitUncertain(input.error);

  if (!ambiguous && (
    error.category === 'client_rejected'
    || error.category === 'adapter_rejected'
    || explicitAdapterRejection(input.error)
  )) {
    return evidence(identity, {
      state: 'confirmed_not_created',
      issue: 'submit_rejected',
      remoteId,
      error,
      allowedActions: ['retry_submit'],
      occupancy: { remote: 'release', local: 'release', releaseWhen: 'confirmed_not_created' },
    });
  }

  return evidence(identity, {
    state: 'unknown',
    issue: 'submit_uncertain',
    remoteId,
    hasResultRef: input.hasResultRef,
    error,
    allowedActions: remoteId ? ['poll_remote', 'reconcile'] : ['reconcile'],
    occupancy: { remote: 'hold', local: 'release', releaseWhen: 'remote_result_confirmed' },
  });
}

export function classifyImageSubmissionFailure(input: SubmissionFailureInput): SubmissionEvidence {
  return classifyFailure({
    entry: 'image', taskId: input.taskId, businessAttemptNo: input.businessAttemptNo,
    adapterId: input.adapterId, stage: input.stage, source: input.source,
  }, input);
}

export function classifyVideoSubmissionFailure(input: SubmissionFailureInput): SubmissionEvidence {
  return classifyFailure({
    entry: 'video', taskId: input.taskId, businessAttemptNo: input.businessAttemptNo,
    adapterId: input.adapterId, stage: input.stage, source: input.source,
  }, input);
}

export function classifyCanvasSubmissionFailure(input: SubmissionFailureInput): SubmissionEvidence {
  return classifyFailure({
    entry: 'canvas', taskId: input.taskId, businessAttemptNo: input.businessAttemptNo,
    adapterId: input.adapterId, stage: input.stage, source: input.source,
  }, input);
}

export function classifySubmissionOutcome(input: SubmissionOutcomeInput): SubmissionEvidence {
  const identity: SubmissionEvidenceIdentity = {
    entry: input.entry,
    taskId: input.taskId,
    businessAttemptNo: input.businessAttemptNo,
    adapterId: input.adapterId,
    stage: input.stage,
    source: input.source,
  };
  const remoteId = input.remoteId?.trim() || null;
  const error: SafeSubmissionError | null = input.errorCode
    ? { code: safeToken(input.errorCode, 'provider_error'), category: 'unknown', httpStatus: null }
    : null;
  if (input.outcome === 'confirmed_not_created') {
    return evidence(identity, {
      state: 'confirmed_not_created', issue: 'submit_rejected', remoteId, error,
      allowedActions: ['retry_submit'],
      occupancy: { remote: 'release', local: 'release', releaseWhen: 'confirmed_not_created' },
    });
  }
  if (input.outcome === 'accepted') {
    return evidence(identity, {
      state: 'accepted', issue: 'none', remoteId, hasResultRef: input.hasResultRef,
      allowedActions: remoteId ? ['poll_remote'] : [],
      occupancy: { remote: 'hold', local: 'hold', releaseWhen: 'remote_terminal' },
    });
  }
  if (input.outcome === 'download_failed') {
    return evidence(identity, {
      state: 'terminal_succeeded', issue: 'download_failed', remoteId, hasResultRef: true, error,
      allowedActions: ['retry_download'],
      occupancy: { remote: 'release', local: 'release', releaseWhen: 'remote_terminal' },
    });
  }
  const failed = input.outcome === 'terminal_failed';
  return evidence(identity, {
    state: failed ? 'terminal_failed' : 'terminal_succeeded',
    issue: failed ? 'remote_terminal_failed' : 'none',
    remoteId,
    hasResultRef: input.hasResultRef,
    error,
    allowedActions: failed ? ['retry_submit'] : [],
    occupancy: { remote: 'release', local: 'release', releaseWhen: 'remote_terminal' },
  });
}
