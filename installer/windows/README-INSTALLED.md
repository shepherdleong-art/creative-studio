# 产品素材工作台（Windows 安装版）

本安装包面向 Windows 10/11 x64，使用当前用户目录安装，不需要管理员权限。安装包已经包含 Node.js、FFmpeg/FFprobe 和 LiteLLM 运行时；启动后只打开本机浏览器页面，不要求用户另外安装 Node.js、Python、npm 或 pip。

## 启动与端口

双击“产品素材工作台”即可启动。应用和可选的公司 LiteLLM sidecar 只监听本机回环地址（默认应用 `127.0.0.1:3000`、sidecar `127.0.0.1:4000`），不会把本机服务暴露到公网。若公司配置尚未导入，工作台仍然可以打开，外部供应商等其他功能不受影响。

## 首次配置

请在工作台的配置/导入界面导入管理员提供的加密配置文件并输入一次性密码。解密成功后，应用会在安装目录下创建本机配置：LiteLLM 配置位于 `config.yaml`，受管 COS 运行参数位于 `data\provisioning\runtime.env`，非敏感导入状态位于 `data\provisioning\state.json`。这些文件不在安装包中，也不会写入安装日志、命令行或 `storage\run\stack.json`。
首次导入或轮换配置后，请关闭并重新打开工作台，让 LiteLLM sidecar 使用新配置。

再次导入同一批供应商配置会更新对应的稳定供应商记录，不会删除其他供应商。密码错误或文件损坏时不会留下半套配置。

## 停止、卸载与清理

- “停止产品素材工作台”会停止当前安装目录启动的应用与 LiteLLM sidecar，不会结束其他 Python/Node 进程。
- 普通卸载会停止运行进程并保留项目、成片和本机配置。
- 只有在明确确认后使用“彻底删除用户数据”，才会清理 `data`、`storage`、`config.yaml` 以及 provisioning 状态；它不会触碰加密源文件之外的其他目录。

安装包构建时不会包含真实 `config.yaml`、COS 密钥、API Key、`.env` 文件或本机数据目录。
