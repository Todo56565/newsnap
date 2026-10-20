# newsnap

DSH（DeepSeek Harness）+ dsh-agent-teams 的团队时间回溯插件：把队长、全部成员会话、团队状态、dsh-token-budget 记录与工作区作为一个快照拍下，并整体恢复，恢复后窗口号 w / 事件号 e 与拍照时一致。用来替代 fork。

状态：设计草稿，未实现。见 [docs/design/newsnap-design.md](docs/design/newsnap-design.md)；社区调研见 [research/team-rewind-prior-art.md](research/team-rewind-prior-art.md)。

## 依赖

- **需要 git**：工作区快照存在一个独立的影子 git 仓库里（不碰你自己的 `.git`）。DSH 桌面端不自带 git，请先安装（Windows 装 [Git for Windows](https://git-scm.com/download/win)）。newsnap 依次找：环境变量 `NEWSNAP_GIT` 指定的可执行文件、PATH 上的 `git`、Windows 下 Git for Windows 的默认安装位置。找不到时 `/newsnap snap` 直接报「未找到 git」，不会留下任何目录。`newsnap doctor` 会显示用的是哪个 git。

## 已知局限

- 自动重启后网页能自动重连，靠的是浏览器 cookie，它绑定 host:port。如果用 `dsh --profile web --port 0` 启动（系统随机分配端口），重启后端口会变，已打开的页面连不回去：原本会自动开浏览器的，会在新标签页打开新地址；带 `--no-open` 的，需要到终端查看新地址。一般不需要用 `--port 0`。
