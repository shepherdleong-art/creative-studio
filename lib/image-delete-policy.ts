export interface ImageReferenceCounts {
  jobRefs: number;
  sceneRefs: number;
  shotRefs: number;
  videoRefs: number;
}

export const IMAGE_REFERENCE_COUNTS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM jobs WHERE inputImageId = @id OR outputImageId = @id
           OR referenceImageIds LIKE '%"' || @id || '"%') as jobRefs,
    (SELECT COUNT(*) FROM scene_references WHERE imageAssetId = @id) as sceneRefs,
    (SELECT COUNT(*) FROM shots WHERE sourceImageId = @id OR latestGeneratedImageId = @id) as shotRefs,
    (SELECT COUNT(*) FROM video_jobs WHERE sourceImageId = @id) as videoRefs
`;

const REF_LABELS: Array<[keyof ImageReferenceCounts, string]> = [
  ['jobRefs', '生成任务'],
  ['sceneRefs', '场景参考图'],
  ['shotRefs', '分镜'],
  ['videoRefs', '视频任务'],
];

export function getImageDeleteBlockers(refs: ImageReferenceCounts): string[] {
  return REF_LABELS.flatMap(([key, label]) => {
    const count = Number(refs[key]) || 0;
    return count > 0 ? [`${count} 个${label}`] : [];
  });
}

export function getImageDeleteBlockMessage(refs: ImageReferenceCounts): string | null {
  const blockers = getImageDeleteBlockers(refs);
  if (blockers.length === 0) return null;
  return `该素材已被 ${blockers.join('、')}引用，不能直接删除。请先删除关联的分镜组、任务或视频任务。`;
}
