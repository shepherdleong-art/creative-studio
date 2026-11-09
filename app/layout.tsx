import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { cookies } from "next/headers";
import Header, { type HeaderPrincipal } from "@/components/Header";
import TeamFetchBridge from "@/components/TeamFetchBridge";
import ClientDiagnostics from "@/components/team/ClientDiagnostics";
import WorkspacePageChrome from "@/components/team/WorkspacePageChrome";
import { canvasFeatureEnabled } from "@/lib/creative-canvas/config";
import { applicationTitle, BRAND_SUBTITLE } from "@/lib/brand";
import { readRuntimeConfig } from "@/lib/team-service/config";
import { TEAM_SESSION_COOKIE } from "@/lib/team-service/auth/request";
import { getTeamAuthService } from "@/lib/team-service/auth/runtime";
import "./globals.css";

// 标题按端区分：员工端「林视创作台」、管理员端「林视控制台」、个人本地版与
// 登录页用正式写法。只有知道当前是谁才能定端点，所以标题跟着身份走；
// 身份结构不可用时退回正式写法，绝不猜端点。
export async function generateMetadata(): Promise<Metadata> {
  const config = readRuntimeConfig();
  let title = applicationTitle(null, config.mode);
  if (config.mode === 'server') {
    try {
      const token = (await cookies()).get(TEAM_SESSION_COOKIE)?.value;
      const resolved = token ? getTeamAuthService().resolveSession(token) : null;
      title = applicationTitle(resolved ? { role: resolved.role } : null, config.mode);
    } catch {
      // 身份结构不可用时使用正式写法。
    }
  }
  return {
    title,
    applicationName: title,
    description: BRAND_SUBTITLE,
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/icons/app-icon.svg", type: "image/svg+xml" },
        { url: "/icons/app-icon-32.png", sizes: "32x32", type: "image/png" },
      ],
      apple: [
        { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
      ],
    },
  };
}

// 外观偏好初始化：水合前同步执行，按 localStorage / 系统外观给 <html> 挂
// data-theme，避免夜间模式首帧白闪。与 components/ThemeToggle.tsx 用同一份 key。
const themeInitScript = `(function(){try{var p=localStorage.getItem('creative-studio-theme');var d=p==='light'||p==='dark'?p:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=d;}catch(e){}})();`;

async function RuntimeHeader() {
  // Read the server's runtime flag so standalone builds can enable the entry at launch.
  await connection();
  const config = readRuntimeConfig();
  if (config.mode === 'local') return <Header canvasEnabled={canvasFeatureEnabled()} />;
  let principal: HeaderPrincipal | null = null;
  try {
    const token = (await cookies()).get(TEAM_SESSION_COOKIE)?.value;
    const resolved = token ? getTeamAuthService().resolveSession(token) : null;
    if (resolved) {
      principal = {
        employeeId: resolved.employeeId,
        displayName: resolved.displayName,
        role: resolved.role,
        mustChangePassword: resolved.mustChangePassword,
      };
    }
  } catch {
    // 身份结构不可用时使用无权限 Header，业务入口由运行时 readiness 继续关闭。
  }
  return <Header canvasEnabled={canvasFeatureEnabled()} deploymentMode="server" principal={principal} />;
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const deploymentMode = readRuntimeConfig().mode;
  // 团队版不再套 980px 居中栏：宽度由各页自己决定（侧栏让位规则在
  // components/team/workspace.module.css 里按同一份 deployment 标记生效）。
  // 本地版保持原样，避免影响个人工作台。
  const team = deploymentMode === 'server';
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning data-deployment-mode={deploymentMode}>
      <body className="min-h-full flex flex-col bg-surface text-ink">
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <TeamFetchBridge />
        <ClientDiagnostics />
        <Suspense fallback={<Header deploymentMode={process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE === 'server' ? 'server' : 'local'} />}>
          <RuntimeHeader />
        </Suspense>
        <main
          data-workspace-shell={team ? 'team' : undefined}
          className={team
            ? 'flex-1 flex min-h-0 w-full min-w-0 flex-col'
            : 'flex-1 w-full max-w-[980px] mx-auto px-6 py-10'}
        >
          {/* 团队版：每页标题一次接全（含 app/team/** 这条路由树）。本地版不渲染。 */}
          {team && (
            <Suspense fallback={null}>
              <WorkspacePageChrome />
            </Suspense>
          )}
          <Suspense fallback={
            <div className="flex items-center justify-center py-20">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            </div>
          }>
            {children}
          </Suspense>
        </main>
      </body>
    </html>
  );
}
