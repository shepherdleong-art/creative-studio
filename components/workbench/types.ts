/** 工作台各步骤共用的数据形状（07 号票）。
 *
 * 只描述界面真正读到的字段：页面传进来的对象可以更大（数据库行），
 * 但组件不依赖多余字段，方便单测与验收夹具复用同一份类型。
 */

export interface WorkbenchImage {
  id: string;
  role: string;
  filename: string;
  path?: string;
  imageUrl?: string;
  usage?: string;
}

export interface WorkbenchProvider {
  id: string;
  name: string;
  model: string;
  type?: string;
  enabled: number | boolean;
  hasApiKey: boolean;
}

export interface WorkbenchJob {
  id: string;
  inputFilename?: string;
  outputFilename?: string;
  status: string;
  inputImageId?: string;
  outputImageId?: string;
  errorMessage?: string;
  reviewMark?: string;
  prompt?: string;
  parentJobId?: string;
  revision?: number;
  referenceImageIds?: string;
  providerId?: string;
  model?: string;
  unifiedModel?: string;
  size?: string;
  quality?: string;
}

/** 生成中/排队中的任务状态集合（用于「生成中占位」与轮询）。 */
export const ACTIVE_JOB_STATUSES = ['pending', 'running', 'retrying', 'needs_check'] as const;

export function isActiveJobStatus(status: string | undefined | null): boolean {
  return !!status && (ACTIVE_JOB_STATUSES as readonly string[]).includes(status);
}

/** 结果图地址：优先本地图片 id，其次产出文件路径。 */
export function getJobResultUrl(
  job: Pick<WorkbenchJob, 'outputImageId' | 'outputFilename'> | undefined,
  imageById: Map<string, WorkbenchImage>,
): string | undefined {
  if (!job) return undefined;
  if (job.outputImageId) {
    const image = imageById.get(job.outputImageId);
    if (image?.imageUrl) return image.imageUrl;
  }
  if (job.outputFilename) {
    return `/api/images/outputs/${job.outputFilename.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
  }
  return undefined;
}

export function getJobDisplayName(job: WorkbenchJob, fallback: string): string {
  return job.outputFilename?.trim() || job.inputFilename?.trim() || fallback;
}
