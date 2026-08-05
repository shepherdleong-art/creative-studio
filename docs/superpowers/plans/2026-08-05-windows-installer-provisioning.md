# Windows 内部安装包与统一配置导入实施计划

对应规格：`docs/superpowers/specs/2026-08-05-windows-installer-provisioning-spec.md`

## 1. 加密配置协议

- 定义严格的 provisioning v1 payload 与 envelope。
- 用 `scrypt + AES-256-GCM` 实现生成、解密和认证。
- 提供无真实密钥的公司 profile 模板与管理员生成 CLI。
- 覆盖错密码、篡改、超限、placeholder 和非法 company route 测试。

## 2. 原子导入与轮换

- 解密后先完成全部 schema/语义验证。
- 原子更新 `config.yaml`、受管 runtime env 和非秘密状态。
- 在 SQLite transaction 中 upsert 图片、脚本、双视频和豆包 TTS 供应商。
- 重复导入覆盖相同稳定 id，不删除其他供应商。
- 对文件或数据库故障执行恢复，证明不会留下半套配置。

## 3. 首次使用界面

- 增加只接受加密文件和一次性密码的导入 API。
- 设置页增加统一配置卡，显示非秘密状态并支持重新导入。
- 首页首次使用指引优先引导导入统一配置，而不是逐项填写 Key。
- 导入成功后刷新供应商状态，并提示公司 sidecar 的启动/重启状态。

## 4. LiteLLM 私有 runtime

- 固定 CPython x64 与 `litellm[proxy]==1.89.2`。
- 构建机完成下载、签名/完整性验证和依赖 vendoring。
- 最终 runtime 使用相对路径启动，不依赖终端 Python、pip 或复制后失效的 venv launcher。
- 写入无秘密 manifest，并在组装 installer 前执行离线 import/version 自检。

## 5. 安装版 sidecar 生命周期

- `CreativeStudio.exe` 异步确保 loopback LiteLLM，不阻塞核心 app。
- sidecar 脚本负责健康检查、日志与 BOM-less `stack.json`。
- UI shutdown、停止快捷方式和卸载前步骤精确回收受控进程。
- 普通卸载保留本机项目和配置；彻底删除脚本清理受管 provisioning 状态。

## 6. 安装包安全合同

- payload 明确拒绝真实 `config.yaml`、`.env*`、provision 文件及数据目录。
- 安装版使用独立 README，删除源码启动命令的误导。
- 静态测试验证 loopback、固定版本、secret exclusion、停止边界和必需 payload。
- sidecar 构建失败必须让 installer 构建失败。

## 7. 验证顺序

1. provisioning 纯函数和数据库/文件故障测试。
2. Windows installer/sidecar 静态合同测试。
3. ESLint 与 Next production build。
4. 无秘密的 Windows installer 真实构建与干净机安装。
5. 导入占位配置、错密码、重复轮换、卸载保留/彻底清理验证。
6. 用户放入真实 gitignored 配置后，在明确授权费用的前提下完成公司内网真实调用。

## 8. 暂不猜测的边界

- GPT 5.5 素材视觉分析必须等真实协议确认支持 base64、图片 URL 或视频 URL，再接入正式 MediaTransport；安装包工作不把现有 COS 参考图上传冒充成通用素材传输。
- 首版不做每用户 Token、服务端计费、自动更新、公开发行或 Windows 代码签名。
