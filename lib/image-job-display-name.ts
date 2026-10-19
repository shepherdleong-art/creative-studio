/**
 * 生成图片的用户可见名称。
 *
 * 成功任务的产出文件名已经带有用途前缀（如「场景-」），应优先于输入素材名；
 * 输入素材名可能只是上传时生成的 UUID。任务未完成时再回退到输入名。
 */
export interface ImageJobDisplayNameInput {
  id: string;
  inputFilename?: string | null;
  outputFilename?: string | null;
}

export function getImageJobDisplayName(job: ImageJobDisplayNameInput): string {
  const outputFilename = job.outputFilename?.trim();
  if (outputFilename) return outputFilename;

  const inputFilename = job.inputFilename?.trim();
  if (inputFilename) return inputFilename;

  return `图片任务-${job.id.slice(0, 8)}`;
}
