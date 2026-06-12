import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Header from "@/components/Header";
import "./globals.css";

const fontUi = Inter({ subsets: ["latin"], variable: "--font-ui", display: "swap" });
const fontJb = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jb", display: "swap" });

export const metadata: Metadata = {
  title: "产品素材工作台",
  description: "复杂结构产品的图片生产 + 分镜管理 + 视频任务准备",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className={`h-full antialiased ${fontUi.variable} ${fontJb.variable}`}>
      <body className="min-h-full flex flex-col bg-surface text-ink">
        <Header />
        <main className="flex-1 w-full max-w-[980px] mx-auto px-6 py-10">
          {children}
        </main>
      </body>
    </html>
  );
}
