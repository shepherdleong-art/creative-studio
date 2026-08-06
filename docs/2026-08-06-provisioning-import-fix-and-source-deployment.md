# 统一配置导入修复与源码部署说明

日期：2026-08-06
分支：`linsygroup`

## 背景变化

Windows 安装包（Inno Setup）路线暂停，改为同事从 GitHub `linsygroup` 分支拉取源码部署。原因：

- 构建机的企业安全软件（SEP / 无边界）拦截未签名 exe 的资源写入（`EndUpdateResource`），Inno 压缩无法完成；需要 IT 白名单或代码签名证书才能继续。
- Inno Setup 商业许可证仍需公司评估。

已构建验证过的 payload 保留在构建机 `dist/windows/CreativeStudio`，安装包路线随时可以恢复。

## 源码部署步骤（同事）

0. 前置：确认自己有本仓库的 GitHub 访问权限（私有仓库需要管理员先加 collaborator）。
1. 安装 Node.js 20+（建议 22.x），不需要其他开发环境；ffmpeg 由 npm 依赖自带。
2. `git clone -b linsygroup https://github.com/shepherdleong-art/creative-studio.git`（已有仓库则 `git pull origin linsygroup`）。
3. `npm ci`，然后 `npm run dev`（或双击 `start-windows.cmd`），浏览器打开 `http://127.0.0.1:3000`。
   - 公司网络下 `npm ci` 可能卡在 ffmpeg-static 从 GitHub 下载二进制超时；先设镜像再装：
     `set FFMPEG_BINARIES_URL=https://cdn.npmmirror.com/binaries/ffmpeg-static`（PowerShell 用 `$env:FFMPEG_BINARIES_URL='https://cdn.npmmirror.com/binaries/ffmpeg-static'`）。
4. 打开「设置 → 统一配置导入」，选择管理员分发的 `.provision` 文件并输入导入密码（密码与文件分开渠道分发）。
5. 导入成功后重启工作台，公司网关（LiteLLM sidecar，`127.0.0.1:4000`）随启动拉起；网关异常只禁用公司供应商，不阻塞主应用。
6. 轮换 Key：管理员重新生成 `.provision`，同事再次导入即可覆盖受管供应商；自行添加的供应商不受影响。

### 公司网关 sidecar（源码部署额外一步）

源码部署时 LiteLLM 运行时不随仓库分发，需本机有 Python 3.10+ 后执行一次：

```powershell
python -m venv .venv-litellm
.venv-litellm\Scripts\pip install "litellm[proxy]==1.89.2"
```

`.venv-litellm` 与导入生成的 `config.yaml` 齐备后，`start-windows.cmd` 会自动先拉起 LiteLLM 代理再启动应用；缺失时应用照常可用，仅公司供应商不可用。sidecar 启动已内置 `LITELLM_LOCAL_MODEL_COST_MAP=True`，不依赖访问 GitHub。

## 本次修复：全新部署无法导入统一配置

- 现象：全新安装/全新数据目录下导入 `.provision` 必然报「统一配置导入失败」，与密码无关。
- 根因：早期版本创建的 `video_providers` 表 CHECK 约束只允许 `('kling','jimeng')`，而统一配置需要写入 `openai-video` 类型供应商，事务被约束拒绝后整体回滚。
- 修复：`POST /api/provisioning` 改为先解密认证，再经共享 schema-upgrade gate（已验证备份 + 跨进程锁 + JSONL 审计）把 `video_providers` 安全升级到含 `openai-video` 的约束，然后才落库。升级失败只让导入失败，不影响旧功能。
- 回归测试：`scripts/provisioning.test.ts` 新增旧约束数据库用例（直接导入失败 → gate 升级 → 导入成功且旧供应商保留）。运行方式：`node scripts/provisioning.test.ts`。
- 运维备注：已部署机器如遇此问题，可用同一 gate 对本地 `data/workbench.db` 做一次升级（本分支 2026-08-06 已在用户机器上实测，原内置供应商完好）。

## 其他随本次提交落地的修正

- `scripts/build-litellm-sidecar.ps1` 与 `installer/windows/start-company-sidecar.ps1`：设置 `LITELLM_LOCAL_MODEL_COST_MAP=True`，构建自检与 sidecar 启动不再依赖访问 `raw.githubusercontent.com`（公司网络下会超时，且会被 PowerShell 5.1 提升为终止错误）。
- `eslint.config.mjs`：忽略 `.venv-litellm/**`（第三方虚拟环境，316 个误报 error）。
- `scripts/build-win-installer.ps1`：清理 Turbopack 全项目 trace 带进 payload 的仓库元数据（文档、源码目录、截图等）；禁止打包 `.provision` / 本地 profile 的断言保留。
- 新增 `scripts/diagnose-provision.mts`：隐藏输入密码，本地验证 `.provision` 文件完整性与密码是否匹配，用于导入排障。
