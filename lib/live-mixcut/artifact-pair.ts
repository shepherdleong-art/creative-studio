/**
 * 正式视频与封面的配对键。封面命名比视频多一个「-封面」后缀；旧命名
 * 则只有扩展名不同。这里只处理受控的正式导出相对路径，不接收浏览器路径。
 */
export function batchArtifactPairKey(relativePath: string): string {
  return relativePath.replace(/\.[^./\\]+$/u, '').replace(/-封面$/u, '');
}

export function batchArtifactPathsArePaired(videoRelativePath: string, coverRelativePath: string): boolean {
  return batchArtifactPairKey(videoRelativePath) === batchArtifactPairKey(coverRelativePath);
}
