# Luna 执行完之后，给 Sol 做验收 review 的提示词

文档（即验收标准）：`docs/2026-08-09-Electron桌面化-执行文档.md`
仓库：`/Users/liangpeijian/for-cc/creative-studio`

## 已定的节奏

**Phase 0 + 1 做完 → 跑下面的「卡点自查」（几分钟，自己跑，不用动用 Sol）→ 通过就一路推完剩下的 → 全做完发 ⑤ 合并版给 Sol 完整 review。**

为什么卡在这里：Phase 3 和 Phase 4 都建在 Phase 1 的壳上。**边界一旦破防会传染**——等全做完才发现，那两块得跟着重做。而 Phase 2 走错子系统的代价是有界的，只废它自己。

如果打算做到 Phase 4（macOS 签名 + 公证，需要真实 Windows 主机 —— 这是唯一花真金白银的部分），把顺序改成「Phase 0–3 做完先 review，过了再做 Phase 4」，别在有问题的壳上先付签名的钱。

---

## 卡点自查（Phase 0 + 1 做完后跑，几分钟）

> 这是烟雾报警器，不是合格证。第 1 条只查第一层 import，传递依赖仍要靠 ① 或 ⑤ 顺着链走。

**边界（Phase 1 最关键的一条）**

```bash
grep -rnE "better-sqlite3|sharp|ffmpeg-static|ffprobe-static|@/lib|\.\./lib/" desktop/ \
  && echo "❌ 边界破了，停下来查" || echo "✅ 第一层干净"
```

**安全基线六项是否显式写死**（应看到全部六个，缺一即不合格）

```bash
grep -nE "nodeIntegration|contextIsolation|sandbox|webSecurity|webviewTag|preload" desktop/main.ts
```

**是否残留被明令禁止的字符串前缀判断**

```bash
grep -rn "startsWith('http\|startsWith(\"http" desktop/ \
  && echo "❌ 用了字符串判断，必须改用 new URL() 逐项比对" || echo "✅ 无残留"
```

**单实例顺序**（`requestSingleInstanceLock` 的行号必须小于创建窗口和启动服务）

```bash
grep -n "requestSingleInstanceLock\|new BrowserWindow\|spawn\|startService" desktop/main.ts
```

**Phase 0：优雅停机是否真的接上**

```bash
grep -rn "SIGTERM\|SIGINT" lib/ instrumentation.ts app/api/shutdown/   # 应有命中
grep -n "process.exit\|gracefulShutdown" app/api/shutdown/route.ts      # 不应还是裸的硬 exit
```

**Phase 0：两个长任务的 ffmpeg 取消信号是否接了**（文档允许分级收工，但这两个是优先项）

```bash
grep -n "signal" lib/batch-production/batch-renderer.ts lib/batch-production/proxy-executor.ts
```

**测试有没有被改动**（文档明写"停下来查而不是改测试"）

```bash
git diff --stat <基线commit> HEAD -- scripts/ | grep -i test
```

**三件事都得真绿**（自己跑，别信自述）

```bash
npm run build && npm run lint && npm run build:desktop
```

任何一条不过，**停下来查，不要继续推 Phase 2**。

---

## ① 边界合规审查（最重要 —— 整个方案的风险论证都建立在边界上）

你在做**代码验收**，不是方案讨论。

仓库：`/Users/liangpeijian/for-cc/creative-studio`
验收标准：`docs/2026-08-09-Electron桌面化-执行文档.md`（这份文档就是规格说明，一切以它为准）

这个方案的全部风险论证都建立在一条边界上：**Electron 壳只加载纯 JS + Electron 官方 API，业务全部留在私有 Node 子进程。** 文档原话是"违反它，这份文档的风险评估立即作废"。

**请实际读代码验证，不要相信任何提交信息、注释或总结里的自述。** 逐条给「合规 / 违反 / 存疑」+ 证据：

1. `desktop/` 下**任何文件**都不得 import 或 require `better-sqlite3`、`sharp`、`ffmpeg-static`、`ffprobe-static`，也不得 import `lib/` 下任何业务模块。检查直接依赖**和传递依赖**（顺着 import 链走，别只看第一层）。
2. `webPreferences` 六项是否**显式写死**：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`、`webviewTag:false`、`preload` 已设。有没有在别处创建了第二个 `BrowserWindow` 或 `webContents` 而没套用同一套配置？
3. preload 是否只通过 `contextBridge` 暴露了文档列出的那几个具名方法？有没有暴露 `ipcRenderer`、`fs`、`path`、`child_process`，或任何能转发任意 channel 的通用函数？
4. IPC sender 校验：每个 `ipcMain.handle` 是否都校验了 `event.senderFrame`？文档**明令禁止** `startsWith('http://127.0.0.1')` 这类字符串判断，要求用 `new URL()` 逐项比对 protocol/hostname/port。grep 确认没有字符串前缀判断残留。
5. 导航封锁：`will-navigate` 是否 `preventDefault()`；`setWindowOpenHandler` 是否默认 `deny`。
6. 单实例锁：`requestSingleInstanceLock()` 是否在**创建窗口和启动服务之前**调用（顺序错了等于没做，会撞上跨进程 SQLite 写锁）。

输出：一张合规表。任何「违反」都要指出具体文件行和为什么它破坏了边界。如果你只是没找到证据、而非确认合规，请标「存疑」而不是「合规」。

---

## ② 走没走错子系统 + 原生导入安全审查

你在做代码验收。

仓库：`/Users/liangpeijian/for-cc/creative-studio`
验收标准：`docs/2026-08-09-Electron桌面化-执行文档.md`

这个项目有**两套互不相通的素材系统**，文档专门写了一节警告不要搞混。执行者最可能犯的错就是接错那一套。

**A. 子系统是否走对**

1. 原生导入是否落在**批量侧**（`components/batch-production/BatchStepMaterials.tsx` + `lib/batch-production/media-catalog.ts` 的 `registerLinkedSource` + `batch_assets` 表）？
2. `components/mixcut/MaterialStep.tsx` 和 `lib/final-edit/material-import*.ts` **是否被改动**？文档明令这一侧 V1 不动。`git diff` 确认。
3. 有没有出现"在 final-edit 侧新造 linked 支持"的代码？那是文档明确排除的另一个量级的工程。
4. 是否复用了**已有的** `registerLinkedSource`，而不是另写了一份登记逻辑？grep 确认没有重复实现（比如自己算指纹、自己写 `batch_asset_sources`）。
5. 素材列表/缩略图/分析/勾选是否**没被改动**？文档说 `prepare.ts` 的 `listProjectAssets` 不筛 sourceKind，linked 素材应自动出现，不需要改这些。如果这些被改了，说明理解偏了。

**B. 路径安全模型是否真的成立**

6. renderer 是否**全程拿不到绝对路径**？grep 前端代码，确认 bridge 返回值里没有路径字段，也没有把路径塞进 URL、日志或 React state。
7. `app/api/desktop/import-linked` 是否同时具备两道守卫：`CREATIVE_STUDIO_DESKTOP === '1'` **和**每次启动的 secret？缺一道就是可绕过。
8. secret 有没有泄漏进 URL query、日志、错误响应体、崩溃报告，或任何 renderer 可读的地方？grep 全仓。
9. 端点是否验证了"只接受 Electron main 提交"？如果 renderer 能直接 `fetch` 成功，这是**严重安全缺陷**——等于页面可以让后端读任意本地文件。请实际推演一次攻击路径。
10. 是否复用了现有的 `CREATIVE_STUDIO_DESKTOP` 开关（`lib/final-edit/desktop-reveal.ts` 的既有模式），还是新造了一个 flag？文档要求复用。

输出：分「安全缺陷 / 走错子系统 / 重复造轮子 / 合规」四类。安全缺陷要给出可执行的攻击路径。

---

## ③ 「存量不动」是否兑现 + 有没有假完成

你在做代码验收，重点是**核对声称与实际是否一致**。

仓库：`/Users/liangpeijian/for-cc/creative-studio`
验收标准：`docs/2026-08-09-Electron桌面化-执行文档.md`

这份文档的核心承诺是"**存量不动**"——约 6 万行业务代码一行不改，新增的是一个独立的 `desktop/` 目录。请验证这个承诺是否兑现。

**A. 改动范围**

1. 找到执行开始前的基线 commit（问用户，或用当前分支与 `main` 的 merge-base），跑 `git diff --stat <基线> HEAD`。
2. 改动是否集中在：`desktop/`（新增）、`app/api/desktop/`（新增）、`lib/shutdown.ts`（新增）、`instrumentation.ts`、`app/api/shutdown/route.ts`、`components/batch-production/BatchStepMaterials.tsx`、构建配置（`package.json`/`tsconfig`/`eslint`/`next.config.ts`）、以及 Phase 0 里 ffmpeg signal 接线涉及的执行器？
3. **任何超出上述范围的业务代码改动都要单独列出并解释。** 尤其注意：有没有为了让壳跑起来而顺手改了业务逻辑、放宽了校验、或删掉了某个约束？

**B. 测试是否真绿（防止改测试而不是改代码）**

4. 实际运行所有 `scripts/*.test.ts` 和 `scripts/*.test.mjs`（Node 22+，`node scripts/<name>.test.ts` 逐个跑）。**不要相信任何"测试已通过"的自述，自己跑。**
5. `git diff` 检查**测试文件本身有没有被改动**。文档明写："任何一条挂了，说明越过了边界，停下来查而不是改测试。" 如果测试被改了，逐条判断是合理适配还是掩盖失败。
6. `npm run build` 和 `npm run lint` 是否真的通过？自己跑一遍。

**C. Phase 0 是否真的做完**

7. `lib/ffmpeg.ts` 的 `AbortSignal` 接线：文档列了约 10 个 ffmpeg 调用点，并允许分级收工（优先 `batch-renderer.ts` 和 `proxy-executor.ts`）。实际接了几个？**未接的有没有在文档/代码里如实记为已知缺口**，还是被悄悄跳过了？
8. `SIGTERM`/`SIGINT` 处理是否真的注册了？`app/api/shutdown/route.ts` 是否还是硬 `process.exit(0)`？

输出：
- 「超范围改动」清单
- 「测试被改动」清单（含判断）
- 「声称完成但实际未完成」清单
- 实际跑出来的测试/构建结果（贴原始输出，不要只写"通过"）

---

## ④ 验证矩阵实测复核

你在做代码验收的最后一关。

仓库：`/Users/liangpeijian/for-cc/creative-studio`
验收标准：`docs/2026-08-09-Electron桌面化-执行文档.md`

文档末尾有一张 12 条的验证矩阵。请**逐条判断它是否真的被验证过**，并把能自动验的自己跑一遍。

对每一条给出三选一：
- **已实测通过**（你自己跑的，贴证据）
- **只能人工验**（说明具体怎么操作，交给用户）
- **未验证 / 证据不足**

特别关注这几条容易被含糊带过的：

- **第 5 条（大素材导入）**：这是整个项目的成败判据。有没有真的用大文件测过？`storage` 目录体积在导入前后是否不变？原文件位置是否未动？如果只是"逻辑上应该不复制"，那是未验证。
- **第 7 条（正常退出回收）**：退出后有没有实际检查残留？`pgrep -f ffmpeg`、`lsof -i` 确认无孤儿进程和遗留监听端口。
- **第 8 条（强杀恢复）**：直接 kill 进程后重启，任务是否真的靠租约恢复？有没有 ghost-running？
- **第 11 条（安装包洁净）**：如果做了 Phase 4，检查 payload 里有没有 `data/`、`storage/`、日志、API Key，以及**文档新点出的泄漏面：`desktop/` 的 TS 源码和 sourcemap**。
- **第 12 条（回归）**：见上一轮，测试必须与基线一致。

另外，文档里有两处明确标注"必须实测、不能假设"的地方，请确认它们的实测结论有没有被写回文档：
1. standalone `server.js` 能否拿到 server 实例读回真实端口（还是走了 POST 回调的退路）
2. Windows 上孙进程树（Node 服务 → ffmpeg）的回收方式

输出：12 行的矩阵表 + 「文档标注需实测但没有结论」的清单。

---

## ⑤ 只发一条的合并版

你在对一次已完成的实现做**验收 review**，不是方案讨论。

仓库：`/Users/liangpeijian/for-cc/creative-studio`
验收标准：`docs/2026-08-09-Electron桌面化-执行文档.md`（这份文档就是规格，一切以它为准）

背景：这是个约 6 万行的 Next.js + SQLite 本地应用，本次给它加了一层 Electron 薄壳。方案的全部风险论证建立在两条承诺上：**① 壳只加载纯 JS，业务零迁移；② 存量代码一行不改。** 你的任务是验证这两条是否兑现，以及有没有偷工减料。

**请自己运行命令和读代码，不要相信提交信息、注释或任何"已完成"的自述。**

1. **边界有没有破防**：`desktop/` 下任何文件（含传递依赖）是否 import 了 `better-sqlite3`/`sharp`/`ffmpeg-static` 或 `lib/` 业务模块？`webPreferences` 六项是否显式写死、有没有漏配的第二个窗口？preload 有没有暴露 `ipcRenderer` 或通用转发函数？IPC 有没有残留 `startsWith('http://127.0.0.1')` 这类被文档明令禁止的字符串判断？

2. **有没有走错子系统**：原生导入必须落在**批量侧**（`BatchStepMaterials.tsx` + `registerLinkedSource` + `batch_assets`）。`components/mixcut/MaterialStep.tsx` 和 `lib/final-edit/material-import*.ts` 按文档 V1 不该被动——`git diff` 确认。有没有重复实现一份登记逻辑而不是复用现成的？

3. **路径安全模型是否成立**：renderer 是否全程拿不到绝对路径？`/api/desktop/import-linked` 是否同时有桌面 env 和启动 secret 两道守卫？**请实际推演一次攻击：如果 renderer 直接 fetch 这个端点提交任意路径会怎样？** 能成功就是严重缺陷。secret 有没有泄漏进 URL、日志或错误响应？

4. **存量是否真的没动**：跑 `git diff --stat <基线commit> HEAD`（基线问用户或用与 main 的 merge-base）。列出所有超出「desktop/ + app/api/desktop/ + lib/shutdown.ts + instrumentation.ts + app/api/shutdown + BatchStepMaterials.tsx + 构建配置 + ffmpeg signal 接线」范围的改动。

5. **测试是不是真绿**：自己跑所有 `scripts/*.test.ts`（`node scripts/<name>.test.ts`）、`npm run build`、`npm run lint`，**贴原始输出**。同时 `git diff` 检查测试文件有没有被改——文档明写"停下来查而不是改测试"，测试被改动需要逐条判断是合理适配还是掩盖失败。

6. **有没有声称完成但实际没做**：Phase 0 的 ffmpeg `AbortSignal` 接线（文档列了约 10 个调用点，允许分级收工但要求如实记录未完成的）；`SIGTERM`/`SIGINT` 是否真注册；12 条验证矩阵里哪些是真跑过的、哪些只是"逻辑上应该没问题"。

输出按严重程度排序：**破坏边界的 / 安全缺陷 / 假完成 / 超范围改动 / 小瑕疵**。每条给具体文件行和证据。如果某项你只是没找到问题而非确认无误，标「存疑」而不是「通过」——不要给我一份看起来很干净但其实没查的报告。
