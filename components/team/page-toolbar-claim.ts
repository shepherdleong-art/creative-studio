'use client';

/**
 * 页面工具栏的归属登记（05 号票）。
 *
 * 外壳会在 `<main>` 顶部自动渲染一条只带标题的工具栏（标题 = 导航名），这样所有团队版
 * 页面一上来就有正确的页面标题。**页面自己想接管工具栏时**（例如 06 要在首页加「新建项目」），
 * 只要挂一个 `<PageToolbar role actions=… />`，它会在挂载时登记占用，外壳那条自动隐藏，
 * 不会出现两条工具栏。
 *
 * 用模块级 Set + useSyncExternalStore 而不是 Context：外壳工具栏和页面工具栏在服务端
 * 渲染树里是兄弟节点，Context 传不过去；而「谁在页面上渲染了工具栏」本来就是浏览器
 * 外部状态。首帧服务端快照为「未被占用」，hydration 后页面工具栏登记，外壳那条按
 * 同一个 React 提交批次撤下，用户不会看到两条。
 */

const claims = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function claimPageToolbar(owner: string): () => void {
  claims.add(owner);
  notify();
  return () => {
    claims.delete(owner);
    notify();
  };
}

export function subscribePageToolbarClaim(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readPageToolbarClaimed(): boolean {
  return claims.size > 0;
}

/** 服务端快照：一律按「未占用」渲染，与首帧输出一致。 */
export function readPageToolbarClaimedOnServer(): boolean {
  return false;
}
