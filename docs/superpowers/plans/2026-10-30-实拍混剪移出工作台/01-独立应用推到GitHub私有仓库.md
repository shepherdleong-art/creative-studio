# 01：独立应用推到 GitHub 私有仓库

**要做什么：** 在 GitHub 上给实拍混剪独立应用建一个私有仓库，把本机全部分支推上去，网页默认显示主干。这一步是工作台删除之前的备份。本机的分支和没提交的改动一点都不动。

**依据：** 确认单「用户已确认」第 2、8 条，「实现决定」第 1 节。

**要先做完：** 无（可以马上开始）

**状态：** `done`

- [x] GitHub 上有私有仓库 `shepherdleong-art/live-mixcut`
- [x] 远端每条分支的提交号都和本机一致（2026-10-30 本机有 16 条分支）
- [x] 仓库网页的默认分支是 `integration/live-mixcut-extraction`
- [x] 本机的当前分支、各分支提交号、`git status --porcelain` 的内容，推送前后完全一样

## 现在的情况（2026-10-30）

- 独立应用目录：`/Users/liangpeijian/for-cc/实拍混剪-AI-movie-cutting`，下面简称 S。
- 没有远端，没有标签。主干是 `integration/live-mixcut-extraction`，本机 `main` 还停在第一次提交（只有规格文档）。
- 另一个 AI 在那边有没提交的复审整改，当前分支是主干。
- `gh` 已登录账号 `shepherdleong-art`，有 `repo` 权限。
- 仓库对象约 64 MB。最大的单个文件是 17 MB 的字体，不超过 GitHub 100 MB 的上限。
- 历史里查过一遍，没有像密钥的字符串。

## 怎么做

1. **记下推送前的状态：** 把下面三条命令的输出存到 `$TMPDIR/cs-removal/01-before.txt`：
   - `git -C S branch --show-current`
   - `git -C S for-each-ref --format='%(refname:short) %(objectname)' refs/heads`
   - `git -C S status --porcelain`
2. **确认那边没有进行到一半的 Git 操作：** `S/.git` 下面不能有 `index.lock`、`MERGE_HEAD`、`CHERRY_PICK_HEAD`、`rebase-merge`、`rebase-apply`。有就停下来报告。
3. **确认还没有远端：** `git -C S remote -v` 应该没有输出。有输出就停下来报告，可能别人已经建过了。
4. **确认仓库名没被占用：** `gh repo view shepherdleong-art/live-mixcut` 应该报找不到。找得到就停下来报告。
5. **推送前再查一遍密钥：** 下面这条命令必须输出 `0`，否则停下来报告。

   ```
   git -C S log --all -p | grep -E "^\+" | grep -c -E "(sk-[A-Za-z0-9]{20,}|AKID[A-Za-z0-9]{16,}|SECRET_KEY=[^ <\"'$]{8,}|API_KEY=[^ <\"'$]{8,})"
   ```
6. **建仓库：** 只建仓库、加远端，这一步不推送。

   ```
   gh repo create shepherdleong-art/live-mixcut --private --source "S" --remote origin --description "实拍混剪独立应用（从 creative-studio 拆出）"
   ```
7. **推送全部分支：** `git -C S push origin --all`。不推标签，现在也没有标签。
8. **改默认分支：** `gh repo edit shepherdleong-art/live-mixcut --default-branch integration/live-mixcut-extraction`。
9. **核对：**
   - `git -C S ls-remote --heads origin` 和第 1 步的分支列表逐条一致；
   - `gh repo view shepherdleong-art/live-mixcut --json visibility,defaultBranchRef` 显示 `PRIVATE` 和主干；
   - 再跑一遍第 1 步的三条命令，结果和 `01-before.txt` 完全一样。

## 不要做

- 不改本机任何分支，包括不把 `main` 快进到主干。
- 不暂存、不提交那边的任何改动。
- 不推标签，不建 Release，不改仓库的其他设置。

## 完成记录

- 2026-10-30 创建私有仓库 `shepherdleong-art/live-mixcut`，推送全部 16 条本地分支，默认分支设为 `integration/live-mixcut-extraction`；本任务没有代码提交。
- 推送前检查：无进行中的 Git 操作，目标仓库名未占用，全部历史的密钥特征扫描结果为 0。
- 核对结果：远端 16 条分支与本机提交号逐条一致；仓库可见性为 `PRIVATE`；推送前后的当前分支、分支提交号和 `git status --porcelain` 完全一致。
- 没跑自动测试（本任务只创建远端备份，不改代码）；与任务单无差异。
