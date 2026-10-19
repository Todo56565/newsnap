# 桌面端手动测试清单（newsnap 0.1，M4）

沙盒跑不了桌面端（未发 npm、无 Electron），这份清单在你本机执行。macOS、Linux、Windows 都可以；Windows 的会话写锁（命名信号量）只有单测，**Windows 上请特别留意标了「Windows」的检查项**。
预计 15 分钟。第 1–4 步不花模型额度；第 5 步起需要团队有一两轮对话，尽量用短消息。

## 0. 准备
1. 用我给的包 `newsnap-0.1.0-dev.tgz`（或拉最新 main 后 `pnpm install && pnpm build`）。
2. 装进桌面端 profile（按顺序试，**哪种可用请记下来**）：
   - 桌面端自带的 `dsh` 命令：`dsh plugin --profile desktop add file:<路径>/newsnap-0.1.0-dev.tgz`
   - 不行就把 tgz 解压（得到 `package/` 目录），改用 `file:<路径>/package`
   - 或在桌面端「设置 → 插件」里装本地目录。
3. 确认 agent-teams 也装在桌面端，完全退出桌面端再打开。
4. 记下 DSH_HOME（默认 `~/.dsh`，Windows 为 `%USERPROFILE%\.dsh`），后面看 `<DSH_HOME>/newsnap/<工作区>/helper.log`。

## 1. 基本命令（不花额度）
- 在任一会话输入 `/newsnap status` → 应回「没有待处理的恢复」。
  - **如果提示 profile 不支持或没有 appExit**：截图发我，说明桌面端 profile 名或 appExit 与推断不同。

## 2. 建团队并拍照
1. 新开一个工作区（建议空目录 + 一个 `target.txt`，内容 `v1`），建一个小团队（队长 + 1 名成员），让它们各说一句话，等团队空闲。
2. `/newsnap snap 测试` → 应回「已拍快照 <id>…」。`/newsnap list` 能看到它。

## 3. 制造变化
1. 把 `target.txt` 改成 `v2`，再新建 `added.txt`。
2. 让队长再说一句话（快照之后的一轮）。

## 4. 恢复
1. `/newsnap restore <id>` → 应显示影响面，且写明「桌面端会弹出启动失败对话框，点重启即可」。
2. `/newsnap restore <id> confirm`。
3. **观察并记录**：
   - [ ] 是否弹出「启动失败」对话框；对话框文字（截图）
   - [ ] 从输入 confirm 到对话框出现大约几秒
   - [ ] 等 2 秒后点「重启」
4. 重启后：
   - [ ] `target.txt` 是 `v1`，`added.txt` 已删除
   - [ ] 队长会话还在，快照之后的那一轮没了（发起恢复那一轮也没了）
   - [ ] `/newsnap status` 显示「已恢复到快照 …，/newsnap undo 可撤销」
   - [ ] `helper.log` 有 `DSH exited after`、`restored to snapshot`，**没有** `relaunch:` 行；`session guard:` 后面是什么，记下来（预期：macOS/Linux 为 `flock`，Windows 为 `win32-semaphore`；`assume-stopped` 说明没加载到宿主的锁模块）
   - [ ] Windows：点 confirm 后有没有黑色控制台窗口闪过
   - [ ] Windows：`helper.log` 里有没有 `EBUSY`、`EPERM`、`restore error` 之类的文件占用错误

## 5. 撤销
1. `/newsnap undo` → 看提示，再 `/newsnap undo confirm`，同样点「重启」。
2. [ ] `target.txt` 回到 `v2`、`added.txt` 回来、快照之后那一轮回来。

## 6. 故意抢跑（可选）
- 再恢复一次，对话框一出现就**立刻**点「重启」。
- [ ] 重启后 `/newsnap status` 是「已恢复」还是「正在进行」；工作区是否正常。

## 7. 命令行（可选，Windows 尤其有用）
1. 完全退出桌面端。
2. 在 newsnap 包目录执行 `node bin/newsnap.mjs doctor --cwd <工作区>`（Windows 用 `node bin\newsnap.mjs ...`）。
   - [ ] 「会话写锁探测」显示「可用」还是要求 `--dsh-stopped`
3. **桌面端开着、团队会话打开时**再执行一次 `node bin/newsnap.mjs apply <id> --cwd <工作区>`：
   - [ ] 应被拒绝（会话被 DSH 占用），工作区不变。这一步验证锁探测真的生效。

## 回报
把勾选结果、截图、`helper.log` 发我即可。任何一步和预期不同都停下，不用继续往下做。
