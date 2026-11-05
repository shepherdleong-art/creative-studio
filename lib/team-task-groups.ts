/**
 * 团队任务按发起人分组的纯逻辑（浏览器与服务端共用）。
 *
 * 分组身份只认 `actorUserId`：姓名只是显示值，同名成员必须各自成组；
 * 工号跟着显示，便于历史停用成员仍可辨认。
 */

export interface TeamTaskActorGroupItem {
  operationId: string;
  actorUserId: string;
  actorDisplayName: string;
  employeeId: string;
  updatedAt: string;
}

export interface TeamTaskActorGroup<T extends TeamTaskActorGroupItem> {
  actorUserId: string;
  displayName: string;
  employeeId: string;
  /** 当前结果中该组成员的条数（不是全历史任务数）。 */
  count: number;
  latestUpdatedAt: string;
  items: T[];
}

/**
 * 输入已按 `updatedAt DESC` 排序，所以组的下标就是组内最新任务的下标；
 * 组内保持传入顺序。调用方不得再重排，否则「组内沿用原排序」会失守。
 */
export function groupTeamTasksByActor<T extends TeamTaskActorGroupItem>(
  items: readonly T[],
): Array<TeamTaskActorGroup<T>> {
  const groups = new Map<string, TeamTaskActorGroup<T>>();
  for (const item of items) {
    const existing = groups.get(item.actorUserId);
    if (existing) {
      existing.items.push(item);
      existing.count += 1;
      continue;
    }
    groups.set(item.actorUserId, {
      actorUserId: item.actorUserId,
      displayName: item.actorDisplayName,
      employeeId: item.employeeId,
      count: 1,
      latestUpdatedAt: item.updatedAt,
      items: [item],
    });
  }
  return [...groups.values()];
}
