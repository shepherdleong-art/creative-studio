# Issue tracker：本地 Markdown

这个仓库的任务单和规格都以 Markdown 文件存在仓库里。不用 GitHub Issues（远端虽在 GitHub、`gh` 也已登录，但本仓库从不建 issue），也不用 `.scratch/`。

> **覆盖 skill 自带默认值**：`to-tickets` 等 skill 的正文里写的是 `.scratch/<feature-slug>/issues/`，
> 本仓库一律改用下面的 `docs/superpowers/` 路径。两者冲突时以本文件为准。

## 位置

- **规格**：`docs/superpowers/specs/<YYYY-MM-DD>-<主题>-<类型>.md`，类型如 `PRD`、`确认单`、`功能方案`、`需求共识`。
- **任务单**：`docs/superpowers/plans/<YYYY-MM-DD>-<主题>/`，一个任务一个文件，文件名 `NN-<中文短标题>.md`，从 `01` 起编号。**永远不要写成一个大文件。**
- 任务目录配一个 `README.md` 当索引，列出全部任务和依赖顺序。
- 任务状态写在文件顶部一行 `**状态：** \`<值>\``，取值见 `triage-labels.md`；没有这一行视为 `needs-triage`。
- 讨论、返工记录追加到文件末尾的 `## Comments` 标题下。

## 当 skill 说「发布到 issue tracker」

在 `docs/superpowers/plans/<YYYY-MM-DD>-<主题>/` 下新建 `NN-<中文短标题>.md`；目录不存在就建，并在 `README.md` 补一行索引。

## 当 skill 说「取出相关任务单」

读被引用的文件路径。用户通常会直接给路径或任务编号。

## 分诊（triage）操作

- **列出待分诊**：扫 `docs/superpowers/plans/*/`，挑出缺少 `Status:` 行或写着 `Status: needs-triage` 的任务文件。
- **改状态**：改文件顶部那一行 `Status:`。
- **要补信息**：把问题追加到 `## Comments`，状态改成 `Status: needs-info`。
- **交给 agent**：状态改成 `Status: ready-for-agent` 之前，先确认文件里已经写清改哪些文件、验收标准是什么。
- **关闭**：状态改成 `Status: wontfix`，并在 `## Comments` 写一句原因。

## Wayfinding（`/wayfinder`）

本仓库平时不用任务图。真要跑，按下面这套映射：

- **地图**：`docs/superpowers/plans/<主题>/README.md`，放 Notes / 已定决策 / 未决问题。
- **子任务**：`NN-<短标题>.md`，顶部加 `Type:`（`research`/`prototype`/`grilling`/`task`）和 `Status:`。
- **依赖**：文件顶部写 `Blocked by: NN, NN`；被列的每个文件都 `resolved` 才算解锁。
- **认领**：动工前先写 `Status: claimed`。
- **完成**：文件末尾加 `## Answer`，状态改 `Status: resolved`，并在 README 的「已定决策」补一行指针。
