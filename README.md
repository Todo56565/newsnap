# newsnap

DSH（DeepSeek Harness）+ dsh-agent-teams 的团队时间回溯插件：把队长、全部成员会话、团队状态、dsh-token-budget 记录与工作区作为一个快照拍下，并整体恢复，恢复后窗口号 w / 事件号 e 与拍照时一致。用来替代 fork。

状态：设计草稿，未实现。见 [docs/design/newsnap-design.md](docs/design/newsnap-design.md)；社区调研见 [research/team-rewind-prior-art.md](research/team-rewind-prior-art.md)。

## 已知局限

- 自动重启后网页能自动重连，靠的是浏览器 cookie，它绑定 host:port。如果用 `dsh --profile web --port 0` 启动（系统随机分配端口），重启后端口会变，已打开的页面连不回去：原本会自动开浏览器的，会在新标签页打开新地址；带 `--no-open` 的，需要到终端查看新地址。一般不需要用 `--port 0`。
