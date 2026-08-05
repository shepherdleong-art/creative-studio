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
    // Downloaded/private installer runtimes are third-party generated payloads.
    ".cache/**",
    "next-env.d.ts",
    // 本仓库约定 git worktree 放在 .worktrees/ 下（各自带 .next 构建缓存），不参与 lint：
    ".worktrees/**",
  ]),
]);

export default eslintConfig;
