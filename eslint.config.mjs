import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "dist-desktop/**",
    "next-env.d.ts",
    // 本地 LiteLLM Python 环境包含其自带的前端构建产物，不属于本仓库源码：
    ".venv-litellm/**",
    // 免安装包内置的便携 Python 运行时（本机构建产物，数百 MB），不参与 lint：
    "python-runtime/**",
    // 本地构建缓存（runtime 归档、安装器中间产物）：
    ".cache/**",
    // 本仓库约定 git worktree 放在 .worktrees/ 下（各自带 .next 构建缓存），不参与 lint：
    ".worktrees/**",
  ]),
]);

export default eslintConfig;
