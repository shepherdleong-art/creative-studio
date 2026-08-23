import type { Metadata } from "next";
import { Suspense } from "react";
import Header from "@/components/Header";
import "./globals.css";

export const metadata: Metadata = {
  title: "产品素材工作台",
  description: "复杂结构产品的图片生产 + 分镜管理 + 视频任务准备",
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

// 外观偏好初始化：水合前同步执行，按 localStorage / 系统外观给 <html> 挂
// data-theme，避免夜间模式首帧白闪。与 components/ThemeToggle.tsx 用同一份 key。
const themeInitScript = `(function(){try{var p=localStorage.getItem('creative-studio-theme');var d=p==='light'||p==='dark'?p:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=d;}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-surface text-ink">
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <Header />
        <main className="flex-1 w-full max-w-[980px] mx-auto px-6 py-10">
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
