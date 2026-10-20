# newsnap

DSH（DeepSeek Harness）+ dsh-agent-teams 的团队时间回溯插件：把队长、全部成员会话、团队状态、dsh-token-budget 记录与工作区作为一个快照拍下，并整体恢复，恢复后窗口号 w / 事件号 e 与拍照时一致。用来替代 fork。

状态：设计草稿，未实现。见 [docs/design/newsnap-design.md](docs/design/newsnap-design.md)；社区调研见 [research/team-rewind-prior-art.md](research/team-rewind-prior-art.md)。

## 依赖

- **需要 git**：工作区快照存在一个独立的影子 git 仓库里（不碰你自己的 `.git`）。DSH 桌面端不自带 git，请先安装（Windows 装 [Git for Windows](https://git-scm.com/download/win)）。newsnap 依次找：环境变量 `NEWSNAP_GIT` 指定的可执行文件、PATH 上的 `git`、Windows 下 Git for Windows 的默认安装位置。找不到时 `/newsnap snap` 直接报「未找到 git」，不会留下任何目录。`newsnap doctor` 会显示用的是哪个 git。

## 删除快照

- `/newsnap delete <快照或救援点 id>` 先显示将删除什么，再输入 `/newsnap delete <id> confirm` 确认。删除后立即清理影子仓库：只被这份快照用到的文件内容一起删掉，和其他快照共用的保留。删的是最近一次恢复的救援点时，那次恢复就不能再撤销。
- `/newsnap purge`（确认：`/newsnap purge confirm`）删除本工作区的全部 newsnap 数据：所有团队的快照、救援点、影子仓库和恢复记录，即 `<DSH_HOME>/newsnap/<工作区键>/` 整个目录。工作区文件和你自己的 `.git` 不受影响。
- 命令行对应 `newsnap delete <id> --yes`、`newsnap purge --yes`；不带 `--yes` 只预览。
- 有恢复进行中（尚未完成或卡住）时两者都拒绝，请先 `resume` 或 `rollback`。

## 已知局限

- 被 `.gitignore` 忽略的文件（如 `dist/`、`node_modules/`）不拍、不回退、也不删除：恢复后源码回到旧版，构建产物可能还是新版，建议恢复后重新构建。单个超过 50 MB 的文件同样处理。

- 自动重启后网页能自动重连，靠的是浏览器 cookie，它绑定 host:port。如果用 `dsh --profile web --port 0` 启动（系统随机分配端口），重启后端口会变，已打开的页面连不回去：原本会自动开浏览器的，会在新标签页打开新地址；带 `--no-open` 的，需要到终端查看新地址。一般不需要用 `--port 0`。
