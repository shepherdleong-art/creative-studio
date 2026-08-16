export interface VideoTailFrameCapability {
  supported: boolean;
  protocol?: string;
  reason?: 'unsupported_model' | 'contract_unverified';
}

export type TailFrameUploadState = 'idle' | 'uploading' | 'failed' | 'deleting';

export interface VideoMotionRow {
  key: string;
  prompt: string;
  templateId: string;
  providerId: string;
  durationSec: number;
  tailImageId: string | null;
  tailImageUrl: string | null;
  tailImageName: string | null;
  tailUploadState: TailFrameUploadState;
  tailUploadError: string | null;
}

export function createVideoMotionRow(key: string, durationSec: number): VideoMotionRow {
  return {
    key,
    prompt: '',
    templateId: '',
    providerId: '',
    durationSec,
    tailImageId: null,
    tailImageUrl: null,
    tailImageName: null,
    tailUploadState: 'idle',
    tailUploadError: null,
  };
}

export function updateVideoMotionRowByKey(
  rows: VideoMotionRow[],
  key: string,
  update: (row: VideoMotionRow) => VideoMotionRow,
): { rows: VideoMotionRow[]; updated: boolean } {
  let updated = false;
  const nextRows = rows.map((row) => {
    if (row.key !== key) return row;
    updated = true;
    return update(row);
  });
  return { rows: nextRows, updated };
}

export function removeVideoMotionRowByKey(rows: VideoMotionRow[], key: string): VideoMotionRow[] {
  return rows.filter((row) => row.key !== key);
}

export function getVideoMotionRowIssue(
  row: VideoMotionRow,
  capability: VideoTailFrameCapability | undefined,
): string | null {
  if (row.tailUploadState === 'uploading' || row.tailUploadState === 'deleting') {
    return '请等待尾帧上传或移除完成';
  }
  if (row.tailUploadState === 'failed') {
    return row.tailUploadError || '尾帧上传失败，请重试';
  }
  if (!row.tailImageId) return null;
  if (!capability?.supported) {
    return capability?.reason === 'contract_unverified'
      ? '所选公司供应商的尾帧协议尚未核验，请移除尾帧或改用直连 Seedance 2.0'
      : '所选模型不支持首尾帧，请移除尾帧或更换为 Seedance 2.0';
  }
  if (!row.prompt.trim()) return '已添加尾帧，请同时填写运镜提示词';
  return null;
}
