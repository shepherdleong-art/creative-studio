# 公司统一配置制作说明

这里的示例文件不含真实密钥。安装包和 Git 仓库也不得包含真实 `config.yaml`、本地填写档案或生成后的 `.provision` 文件。

## 生成加密交付文件

1. 复制 `company-profile.example.json` 为 `company-profile.local.json`。
2. 在 `.local.json` 中填写应用侧使用的本机代理 Key、图片/脚本/视频模型别名、豆包 Key 和 COS 参数。不要增加 `liteLlmConfigYaml` 字段。
3. 把可运行的 LiteLLM 配置放在仓库根目录 `config.yaml`。该文件与 `.local.json` 都已被 Git 忽略。
4. 在交互式 PowerShell 中运行：

   ```powershell
   npm.cmd run create:provision -- provisioning/company-profile.local.json config.yaml company-profile-2026-08.provision
   ```

   工具会隐藏密码输入并要求确认，随后把 JSON 与原始 `config.yaml` 一起放入经过 scrypt 派生密钥保护的 AES-256-GCM 密文。

5. 分开发送 `.provision` 文件和导入密码。不要把密码写进文件名、聊天记录、脚本参数或安装包。

非交互构建可临时设置当前进程的 `PROVISION_PASSWORD`，但交互式输入更适合人工交付，也更不容易把密码留在自动化日志中。

## 用户导入与轮换

用户安装后打开工作台，在“设置 → 统一配置导入”中选择 `.provision` 并输入密码。导入成功后关闭并重新打开工作台，使 LiteLLM 使用新配置。

轮换 Key 时生成一份新的 `.provision`，再次导入即可覆盖同一批稳定 provider ID；不会删除用户后来添加的其他供应商。普通卸载默认保留本地项目和配置，“彻底删除用户数据”才会删除它们。

## 安全边界

加密保护的是交付文件和静态传输。导入后，现有应用仍会把供应商配置写入本机 SQLite，并把 LiteLLM/COS 运行参数写入仅供当前 Windows 用户使用的本地数据目录。能控制该 Windows 账户或以管理员身份读取其进程和文件的人，仍可能提取共享 Key；按用户计费与单独吊销需要未来改成每用户短期 Token。
