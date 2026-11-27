import type Database from 'better-sqlite3';

export interface ImageReferenceCounts {
  jobRefs: number;
  sceneRefs: number;
  shotRefs: number;
  videoRefs: number;
  coverRefs?: number;
}

export const IMAGE_REFERENCE_COUNTS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM jobs WHERE inputImageId = @id OR outputImageId = @id
           OR referenceImageIds LIKE '%"' || @id || '"%') as jobRefs,
    (SELECT COUNT(*) FROM scene_references WHERE imageAssetId = @id) as sceneRefs,
    (SELECT COUNT(*) FROM shots WHERE sourceImageId = @id OR latestGeneratedImageId = @id) as shotRefs,
    (SELECT COUNT(*) FROM video_jobs WHERE sourceImageId = @id OR tailImageId = @id) as videoRefs
`;

const REF_LABELS: Array<[keyof ImageReferenceCounts, string]> = [
  ['jobRefs', '生成任务'],
  ['sceneRefs', '场景参考图'],
  ['shotRefs', '分镜'],
  ['videoRefs', '视频任务'],
  ['coverRefs', '一键成片封面'],
];

export function countImageCoverReferences(db: Database.Database, id: string): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_click_film_packaging'").get()) return 0;
  return db.prepare(`SELECT COUNT(*) FROM one_click_film_packaging
    WHERE json_valid(optionsJson) AND json_extract(optionsJson,'$.coverMedia.kind')='project_image'
      AND json_extract(optionsJson,'$.coverMedia.assetId')=?`).pluck().get(id) as number;
}

export function readImageReferenceCounts(db: Database.Database, id: string): ImageReferenceCounts {
  const counts = db.prepare(IMAGE_REFERENCE_COUNTS_SQL).get({ id }) as ImageReferenceCounts;
  return { ...counts, coverRefs: countImageCoverReferences(db, id) };
}

export function getImageDeleteBlockers(refs: ImageReferenceCounts): string[] {
  return REF_LABELS.flatMap(([key, label]) => {
    const count = Number(refs[key]) || 0;
    return count > 0 ? [`${count} 个${label}`] : [];
  });
}

export function getImageDeleteBlockMessage(refs: ImageReferenceCounts): string | null {
  const blockers = getImageDeleteBlockers(refs);
  if (blockers.length === 0) return null;
  if (refs.coverRefs) return `该素材已被 ${blockers.join('、')}引用，请先更换关联的封面并解除其他引用。`;
  return `该素材已被 ${blockers.join('、')}引用，不能直接删除。请先删除关联的分镜组、任务或视频任务。`;
}
