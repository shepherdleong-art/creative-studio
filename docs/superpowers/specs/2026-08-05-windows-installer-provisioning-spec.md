# Windows 内部安装包与统一配置导入规格

日期：2026-08-05

## 已确认范围

- 仅公司内部使用，目标为 Windows 10/11 x64。
- 每用户安装到本机目录，不要求管理员权限。
- 继续使用默认浏览器承载现有 Next.js 界面，不引入 Electron。
- 安装包携带私有 Node、FFmpeg/FFprobe、Python 与 LiteLLM 等运行依赖；终端用户不安装 Node、Python、npm 或 pip。
- LiteLLM 固定为 `1.89.2`，只监听 `127.0.0.1:4000`。公司 sidecar 故障只禁用公司供应商，不阻塞工作台和外部供应商。
- 安装包永远不包含真实 `config.yaml`、COS 凭据、豆包凭据或供应商 API Key。
- 用户首次启动时导入一份加密配置文件；后续允许再次导入并覆盖同一批受管供应商，以完成 Key 轮换。

## 首版供应商能力

统一配置文件必须显式给出实际模型别名、协议和 endpoint，首版预期能力如下：

| 能力 | 适配器/协议 | 预期模型 |
| --- | --- | --- |
| 场景图与分镜图 | `gateway-task-image` | 公司网关 Image2 Medium |
| 脚本与素材分析 | OpenAI-compatible / Responses，由配置声明 | 公司网关 GPT 5.5，开启视觉能力 |
| 视频生成 | `openai-video` | 公司网关可灵 3.0、即梦 2.0 |
| 口播配音 | 既有豆包 TTS adapter | 豆包 Seed TTS 2.0 |
| 参考媒体交付 | 腾讯云 COS | 受限子账号、预签名 URL |

模型别名必须以最终可运行的 `config.yaml` 为准，不从中文展示名猜测。

## 安全模型

### 交付文件

- 使用版本化 envelope，首版算法为 `scrypt + AES-256-GCM`。
- 每次生成使用随机 salt 和 IV；GCM tag 用于认证，错密码或内容篡改必须在任何持久化前失败。
- 密码不得作为命令行参数，也不得写入日志、状态文件或安装包。
- 导入 API 限制文件、明文和字段大小，只接受严格的 v1 schema。
- UI/API 只显示 profile 名称、导入时间和非秘密指纹，不回显任何 Key 或 `config.yaml` 内容。

该加密保护配置文件的交付和静态存放，不承诺抵御已经获得当前 Windows 账户或管理员权限的人员。首版所有用户共用凭据，因此获授权用户理论上仍可从自己的运行环境提取它；未来若要按用户计费与撤销，应改为每用户网关 Token，真实上游 Key 留在公司服务端。

### 导入后的本机状态

- 图片、脚本、视频和 TTS 凭据继续写入现有本地 SQLite 权威表，复用既有“列表不回显明文”的 API 约束。
- 完整 LiteLLM 配置原子写入 `dataRoot()/config.yaml`，不进入 Git 或 installer payload。
- COS 运行参数写入受管的本机 runtime env 文件，Node 启动时先加载；首次导入时也更新当前进程环境。
- 非秘密导入状态单独保存；日志、`stack.json` 和进程命令行不得包含 Key。
- 重复导入只 upsert 配置文件声明的稳定 provider id，不删除用户自行添加的其他供应商。

## 启动与停止

1. `CreativeStudio.exe` 检查受控 LiteLLM runtime 和 `config.yaml`。
2. 两者齐备时异步确保 LiteLLM 仅监听 loopback；缺配置时正常跳过，启动工作台。
3. LiteLLM 的 stdout/stderr 写入本机日志，状态文件只保存受控 PID、端口、开始时间与停止脚本。
4. Next standalone 始终监听 `127.0.0.1`，随后打开现有浏览器启动页。
5. 停止快捷方式、UI 关闭端点和卸载前步骤只回收当前安装根启动的 Node/LiteLLM 进程。
6. 普通卸载保留项目、成片、本机配置和 Key；“彻底删除用户数据”继续作为独立二次确认动作。

## 构建边界

- 构建机下载并验证固定 CPython x64，构建时把固定 LiteLLM 及依赖 vendoring 到便携 runtime。
- 终端机器不得在线执行 pip；安装包缺少或无法自检 sidecar 时构建必须失败，不能产出伪完整安装包。
- payload 继续拒绝 `data/`、`storage/`、`outputs/`、`.env*`、真实 `config.yaml`、provision 文件和其他本机秘密。
- 记录 Python、LiteLLM 和解析后的依赖版本到不含秘密的构建 manifest。

## 验收标准

- 干净 Windows 10/11 x64 机器在无 Node/Python/npm/pip、无管理员权限下完成安装和启动。
- 未导入配置时工作台可打开，公司供应商显示未配置，外部/本地能力不被阻塞。
- 正确密码首次导入后自动创建/更新预期供应商；错密码、篡改文件和非法 loopback 配置不产生部分状态。
- 再次导入可轮换 Key，旧受管凭据被覆盖，其他供应商不受影响。
- 重启后 COS 与供应商状态仍可用；UI/API/日志/状态文件不出现明文 Key。
- LiteLLM 启动失败、公司内网不可达或 COS 失败时原因可诊断，但工作台仍能打开。
- 在用户明确授权费用后，分别完成一次真实脚本、素材分析、图片、可灵视频、即梦视频和豆包 TTS 调用。

## 最终封装前待提供

- 可运行的真实 `config.yaml`（仅放 gitignored 本机路径，不通过聊天发送）。
- Image2 Medium、GPT 5.5、可灵 3.0、即梦 2.0 的精确 LiteLLM model alias。
- 豆包 API Key、COS SecretId/SecretKey/Domain/SignHost/Prefix/TTL。
- 首版共享配置文件的导入密码，由配置管理员通过安全渠道交付用户。
