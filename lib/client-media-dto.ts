import { resolveStorageRelativePath, toStorageImageUrl, toStorageVideoUrl } from './storage-url.ts';

type Row = Record<string, unknown>;

function pick(source: Row, keys: readonly string[]): Row {
  const output: Row = {};
  for (const key of keys) {
    if (source[key] !== undefined) output[key] = source[key];
  }
  return output;
}

const PROJECT_IMAGE_FIELDS = [
  'id',
  'projectId',
  'role',
  'filename',
  'mimeType',
  'width',
  'height',
  'originalWidth',
  'originalHeight',
  'processedWidth',
  'processedHeight',
  'originalSizeBytes',
  'processedSizeBytes',
  'preprocessingEnabled',
  'usage',
  'createdAt',
] as const;

const IMAGE_JOB_FIELDS = [
  'id',
  'projectId',
  'inputImageId',
  'referenceImageIds',
  'providerId',
  'model',
  'prompt',
  'size',
  'quality',
  'status',
  'attempt',
  'maxAttempts',
  'startedAt',
  'finishedAt',
  'latencyMs',
  'estimatedCost',
  'errorMessage',
  'reviewMark',
  'outputImageId',
  'providerTaskId',
  'providerStatus',
  'submittedAt',
  'lastPolledAt',
  'pollCount',
  'parentJobId',
  'revision',
  'referenceGuidanceMode',
  'createdAt',
  'creationIndex',
  'unifiedModel',
  'unifiedRuleVersion',
  'cancelRequestedAt',
] as const;

const VIDEO_JOB_FIELDS = [
  'id',
  'projectId',
  'shotSetId',
  'shotId',
  'sourceImageId',
  'tailImageId',
  'providerId',
  'model',
  'templateId',
  'prompt',
  'durationSec',
  'generationMode',
  'aspectRatio',
  'resolution',
  'status',
  'providerStatus',
  'lastPolledAt',
  'pollCount',
  'filename',
  'displayName',
  'attempt',
  'maxAttempts',
  'errorMessage',
  'startedAt',
  'finishedAt',
  'createdAt',
  'rejectedAt',
  'rejectReason',
  'multiShot',
  'unifiedModel',
  'unifiedRuleVersion',
  'cancelRequestedAt',
  'providerTaskId',
  'providerName',
  'templateName',
] as const;

/** Safe project image projection: no physical paths on disk. */
export function projectImageForClient(row: Row): Row {
  const output = pick(row, PROJECT_IMAGE_FIELDS);
  const filePath = typeof row.path === 'string' ? row.path : '';
  output.relativePath = resolveStorageRelativePath(filePath)?.split(/[/\\]/).join('/') ?? '';
  output.imageUrl = toStorageImageUrl(filePath);
  return output;
}

/** Safe image-job projection: no raw upstream response or signed media URL. */
export function imageJobForClient(row: Row): Row {
  return pick(row, [
    ...IMAGE_JOB_FIELDS,
    'inputFilename',
    'outputFilename',
    'creationSequence',
  ]);
}

/** Safe video-job projection: physical paths become booleans and API media URLs. */
export function videoJobForClient(row: Row): Row {
  const output = pick(row, VIDEO_JOB_FIELDS);
  const localVideoPath = typeof row.localVideoPath === 'string' ? row.localVideoPath : null;
  const posterImagePath = typeof row.posterImagePath === 'string' ? row.posterImagePath : null;
  output.hasLocalVideo = Boolean(localVideoPath);
  output.videoUrl = toStorageVideoUrl(localVideoPath);
  if (posterImagePath) output.posterImageUrl = toStorageImageUrl(posterImagePath);
  return output;
}

