/**
 * 视频单播放注册表：同一时刻只允许一个预览在播（避免视口外视频持续解码）。
 * 按 nodeId 注册，替代原来的 document.querySelectorAll('video') 全局扫描；
 * 后续播放列表／候选列表的多播放器互斥复用同一注册表。
 */

const registry = new Map<string, Set<HTMLMediaElement>>();

export function registerMedia(nodeId: string, element: HTMLMediaElement): void {
  const set = registry.get(nodeId) ?? new Set<HTMLMediaElement>();
  set.add(element);
  registry.set(nodeId, set);
}

export function unregisterMedia(nodeId: string, element: HTMLMediaElement): void {
  const set = registry.get(nodeId);
  if (!set) return;
  set.delete(element);
  if (set.size === 0) registry.delete(nodeId);
}

/** 暂停除 nodeId 外的所有已注册媒体（含同节点的其他播放器）。 */
export function pauseAllMediaExcept(nodeId: string, current: HTMLMediaElement): void {
  for (const [owner, elements] of registry) {
    for (const element of elements) {
      if (owner === nodeId && element === current) continue;
      if (!element.paused) element.pause();
    }
  }
}
