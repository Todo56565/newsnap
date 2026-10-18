# DSH 团队时间回溯：社区现状调研（2026-10-18）

范围：DeepSeek Harness（DSH）+ @nanmicoder/dsh-agent-teams 的「整队快照 / 整体回退」。数据来源：GitHub API（search_repos / repo_get / README）、官方文档页。星数和推送时间均为 2026-10-18 当天读取。

## 0. 结论

- **还没人做 DSH 团队级回溯。** 共查了约 25 组关键词（rewind / checkpoint / snapshot / undo / time machine / rollback / shadow git / fork / agent-teams snapshot / team rewind 等），没有找到能把「队长 + 全部队员子代理会话 + .agent-teams 状态 + 工作区」作为一个原子快照来拍和还原的插件。NanmiCoder/dsh-agent-teams 自己的 issue 里也搜不到 rewind / snapshot / checkpoint / 回退（返回 0 条）。
- **现有 DSH rewind 插件都以单个会话为单位。** 头部插件 SiriLee/dsh-rewind 在文档里写明「子代理的编辑不追踪」。PerryLink/dsh-checkpoint-rewind 也写明作用域是 per session（按 sessionId）。
- **可以直接复用（MIT / Apache / BSD 许可，代码或做法拿来即用）：**
  1. PerryLink/dsh-checkpoint-rewind：工作区快照 provider（`git stash create` / `commit-tree` 生成不挂引用的对象，非 git 目录走 copy manifest），再加 `SessionStore.fork` 回放会话。
  2. Enosensu/dsh-fork-relink：fork 之后把原会话的子代理树复制到新会话（`agents.create`），并补登 `subagent/catalog`。这是「回退后队员会话还能接着用」的关键一步，里面的坑都写在 README 里。
  3. RicardoYan/dsh-session-purger：递归找出一个会话派生的全部子代理会话（任意层级），可以拿来做「这支团队有哪些会话」的枚举逻辑。
- **只能借鉴设计：** Anionex/dsh-turn-rewind（Change Ledger：内容寻址清单、还原前救援点、中断后启动时对账）、DDDMUC/dsh-rewind-pro（trackSubagent、rescue 目录）、BOWLUNA/dsh-zcode-rewind（逐工具调用、配额 / 单文件上限）、GeoSyntax/dsh-plugin-time-machine（会话与工作区协同检查点 + DAG 分叉，但只支持 DSH <0.2.0）、xiaoyuyu6420/dsh-backup（整个 `~/.dsh` 打包，粒度太粗）。
- **行业先例：** 编码代理工具（Claude Code、Gemini CLI、Cline、Roo Code、Kilo Code、Cursor、Aider、Codex）都只回退单个会话或任务。Claude Code 和 Cursor 明确写着子代理的改动不回退。框架层面，AutoGen 的 `team.save_state()`、CrewAI 的 checkpoint 加 Fork、LangGraph 的父子图 time travel 算是「团队整体状态快照」的先例，但都只管内存状态，不管磁盘工作区。
- **有一个坑必须避开：** JJXjustin/dsh-session-rewind 默认把 `.agent-teams` 排除在快照之外。agent-teams 的团队状态正好存在 `<workspace>/.agent-teams/`。我们的快照必须把它作为团队状态单独纳入，不能让通用的工作区排除规则吞掉。

## 1. 目标对象：agent-teams 和 DSH 把状态存在哪

- **@nanmicoder/dsh-agent-teams**（https://github.com/NanmiCoder/dsh-agent-teams ，★2230，MIT，2026-10-18 有推送）
  - 团队状态：`<workspace>/.agent-teams/<teamId>/team.json`（成员、任务、依赖、序号）和 `inbox/captain.jsonl`、`inbox/<member>.jsonl`。删除团队时归档到 `<stateRoot>/archive/<teamId>/`。`stateDir` 可配置。来源：docs/usage.md。
  - 队员是 Harness 的子代理会话（`memberProvider: spawn | fork`）。会话日志里同时写 `agent-teams/*` 事件。状态存在文件里，只在一个 DSH 进程内串行化，不支持多进程协调同一支团队。
  - 推荐组合：DSH 0.2.1-rc.2 + AgentTeams 0.1.25。
- **DSH 会话存储**：`${DSH_HOME:-~/.dsh}/sessions/--<slug-cwd>--/<session-id>/session.vN.jsonl.zstd`，只追加写。DSH 升级会话格式时会在旁边另写新一代文件，所以要读编号最高的那一代。来源：https://vshulcz.github.io/deja-vu/registry/deepseek.html 、https://raw.githubusercontent.com/getagentseal/codeburn/master/docs/providers/dsh.md ，Enosensu/dsh-fork-relink README 也印证了这一点。
- **官方 fork 原语**：`SessionStore.fork(source, boundary?, childSessionId?)`。boundary 必须落在轮次之外，否则直接拒绝，不会悄悄截断；子会话带 `parentSession`、`isSeeded`、`inheritedEventCount`。底层原语是 `ctx.sessions.create(id,{seed,meta})`。来源：https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session
- **DSH 官方没有内置 rewind 或团队快照**：deepseek-ai/deepseek-harness 仓库里搜 rewind / checkpoint 的 issue 返回 0 条（可能是该仓库 issue 搜索不可用），这一点无法完全核实。官方另有实验性的 Agent Teams（dsh-experimental-agent-team-profile，见 shenhuanageshei/dsh-team-link README）。

## 2. DSH 生态相关插件

| 仓库 | ★ | 最近推送 | 许可 | 做了什么 | 团队级？ | 能否复用 |
|---|---|---|---|---|---|---|
| [PerryLink/dsh-checkpoint-rewind](https://github.com/PerryLink/dsh-checkpoint-rewind) | 25 | 2026-10-18 | Apache-2.0 | 三态检查点：工作区（git tree SHA 或 copy manifest）、会话游标（seq + 轮次边界）、配置。在 `fs/write-intent`、`fs/edit-intent`、`tools/pre-execute` 前捕获；`/rewind workspace\|session\|config\|all`；会话回退走 `SessionStore.fork` 生成子会话；快照存 `$DSH_HOME/dsh-checkpoint-rewind`，记录存 storage domain | 否，作用域按 sessionId | **直接复用**：工作区 provider 和 fork 回放。注意它只对白名单原语做无副作用的 git 操作 |
| [tmpdot/dsh-checkpoint-diff](https://github.com/tmpdot/dsh-checkpoint-diff) | 5 | 2026-08-22 | Apache-2.0 | 在上一行插件的检查点上加时间线、逐行 diff 和回滚预览（只覆盖、不删除、可撤销一次） | 「跨会话项目级」只是浏览 | 可复用 UI 和预览思路 |
| [skkaczsh/dsh-checkpoint-rewind](https://github.com/skkaczsh/dsh-checkpoint-rewind) | 0 | 2026-08-21 | Apache-2.0 | PerryLink 版的分叉：快照用临时 GIT_INDEX，回滚时开一个锁定的 detached linked worktree，不改源检出 | 否 | 借鉴「回退到新 worktree」的做法 |
| [SiriLee/dsh-rewind](https://github.com/SiriLee/dsh-rewind) | 141 | 2026-10-17 | MIT | 同一窗口内回退（对话只遮蔽、不删除），写前备份到 `~/.dsh/rewind-snapshots/` | **明确不追踪子代理** | 只能借鉴 |
| [Anionex/dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind) | 133 | 2026-10-18 | BSD-3 | Change Ledger：内容寻址还原点清单、还原前自动救援点、还原后哈希校验、失败回滚、中断日志启动时对账；git 仓库里复用对象库，非 git 目录排除 `.git` 和 `node_modules`；超大文件跳过并报告 | 未提子代理 | **借鉴还原引擎设计** |
| [extracurricular-ai/dsh-filesnap](https://github.com/extracurricular-ai/dsh-filesnap) | 43 | 2026-09-11 | Apache-2.0 | Rust 核心；对话和文件一起回退，支持 /redo；能抓二进制、git 忽略文件和经 `ctx.fs` 的项目外编辑 | 未说明（子代理写入是否经 `ctx.fs` 被捕获**无法核实**） | 借鉴 |
| [DDDMUC/dsh-rewind-pro](https://github.com/DDDMUC/dsh-rewind-pro) | 0 | 2026-10-15 | MIT | 两阶段可撤销回退；写前检查点**包含子代理写入**（`trackSubagent`）；内容有分歧时先移到 rescue 目录；崩溃后续完未完成的还原 | 只覆盖子代理的**文件**，不回退子代理会话 | 借鉴 trackSubagent 和 rescue |
| [BOWLUNA/dsh-zcode-rewind](https://github.com/BOWLUNA/dsh-zcode-rewind) / [dsh-workspace-rewind](https://github.com/BOWLUNA/dsh-workspace-rewind) | 1 / 0 | 2026-09-23 | MIT | 每次变更型工具调用都做检查点，覆盖 bash、MCP 和「subagent tools」；内容寻址 blob；`maxFileBytes` 8 MiB（更大的只记事件），配额 512 MiB 并淘汰最旧 blob；排除 `.git`、`node_modules`、`dist`；先 dry-run，每次还原前写救援记录 | 只到文件层 | 借鉴大文件和配额策略 |
| [GeoSyntax/dsh-plugin-time-machine](https://github.com/GeoSyntax/dsh-plugin-time-machine) | 0 | 2026-09-30 | MIT | 会话和工作区协同检查点、检查点 DAG 分叉、失败反思；完整恢复时清理新增文件，忽略文件保留 | 否；**只支持 DSH >=0.1.5-rc.2 <0.2.0** | 借鉴 DAG 设计 |
| [245678000000/dsh-time-machine](https://github.com/245678000000/dsh-time-machine) | 1 | 2026-08-16 | MIT | 存到 `~/.dsh-time-machine/<workspace-hash>/`；restore 默认在边界处 fork；检查点之后有并发修改就报 `RESTORE_CONFLICT`；副作用账本；工作区锁 | 否 | 借鉴并发冲突检测和锁 |
| [zjukop/dsh-time-machine](https://github.com/zjukop/dsh-time-machine) | 0 | 2026-08-15 | MIT | 两阶段还原（预览拿一次性 token 才能执行）；merge 模式保留新文件，exact 模式删除新文件 | 否 | 借鉴两种还原模式 |
| [JJXjustin/dsh-session-rewind](https://github.com/JJXjustin/dsh-session-rewind) | 1 | 2026-09-05 | 无 | 影子仓库放在 `<workspace>/.dsh-rewind/shadow-repos/<sha1(cwd)16>`；**默认排除 `.agent-teams`**；还原用 `clean -fd` 加 `checkout -f`，新增文件移到 `restore-backups/`；原日志先归档，再原子替换日志文件 | 否 | 反面教材：排除了团队状态。无许可证，不能复用代码 |
| [23swccp/dsh-undo](https://github.com/23swccp/dsh-undo) | 3 | 2026-08-24 | MIT | 私有 GIT_DIR 的影子 git，对话 fork 成新会话 | 否 | 借鉴 |
| [Yu-Zhuang1/dsh-workspace-snapshot-fork](https://github.com/Yu-Zhuang1/dsh-workspace-snapshot-fork) | 1 | 2026-09-02 | MIT | fork 会话时连同历史工作区一起 fork 到新 worktree 或分支；用自己的 exclude 列表（默认 `.git`、`node_modules`、`.env*`），**不**把 `.gitignore` 当安全策略 | 否 | 借鉴密钥排除策略 |
| [Enosensu/dsh-fork-relink](https://github.com/Enosensu/dsh-fork-relink) | 2 | 2026-09-26 | MIT | fork 后为原会话的每个直接子代理调用 `agents.create` 建完整副本（冷会话，避免写租约冲突），再向父会话追加 `subagent/catalog`；读日志时取最高代际；单个副本约 3.5 秒 | **最接近团队级**（复制子代理树） | **直接复用思路和代码** |
| [RicardoYan/dsh-session-purger](https://github.com/RicardoYan/dsh-session-purger) | 0 | 2026-10-18 | MIT | 递归删除一个会话和它派生的全部子代理会话；依赖 DSH 存储布局（>=0.2.1-rc.1 <0.3） | 枚举整棵树 | 复用枚举逻辑 |
| [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup) | 28 | 2026-10-17 | MIT | 整个 `~/.dsh` 打包备份、恢复、迁移，支持 dry-run 和按类型 merge 恢复 | 进程级，不是团队级 | 当兜底，不能作为方案 |
| [helibeiqi/dsh-time-travel](https://github.com/helibeiqi/dsh-time-travel) | 0 | 2026-08-28 | MIT | 工具级补偿：fs.write、fs.delete、bash、http 调用前做快照，回退时执行补偿操作 | 否 | 借鉴不可补偿操作的审计 |
| [robiteame/dsh-session-tree-extension](https://github.com/robiteame/dsh-session-tree-extension) | 20 | 2026-10-13 | MIT | 只追加、多分支的会话树和 `/tree /fork /clone`；排除子代理会话 | 否 | 借鉴血缘展示 |
| [KouzakiUmi/dsh-guard](https://github.com/KouzakiUmi/dsh-guard) | 0 | 2026-10-13 | 无 | dsh-audit-rollback 0.4.0：文件前后像、可选影子 git，存 `~/.dsh/audit-rollback` | 否 | 否 |
| [Punky971210/dsh-punky-swarm](https://github.com/Punky971210/dsh-punky-swarm) | 3 | 2026-10-15 | AGPL-3.0 | 团队「crash-safe checkpoints resume in place」，是续跑不是回退；README 没有细节，**无法核实** | 团队续跑 | AGPL，不宜复用 |
| [louifinn/dsh-tower](https://github.com/louifinn/dsh-tower) | 2 | 2026-10-18 | MIT | 另一套多代理编排：状态存 `.git/dsh-tower/`，每个 mission 一个 worktree | 不同的编排器 | 借鉴「worktree 隔离 + 状态放 .git 内」 |

与本地已知的 7 个仓库的关系（只确认相关性）：
- shenhuanageshei/dsh-team-link（★6）：管的是会话之间的团队，存在 settings 的 teams 键里，和 agent-teams 正交，没有快照能力。
- duanyunlun/dsh-conversation-link（★0）、GengDaPeng/dsh-agent-message（★6）：都是平级会话之间的消息，都排除子代理，与回溯无关。
- heartmove/dsh-session-bridge（★3）：会话死循环时转移或交接，有子代理处理策略（report / ignore / cancel），借鉴价值低。
- Liangebra/dsh-smart-compact、hoyyang/dsh-smart-compact、MimicHunterZ/dsh-agent-compact：都是上下文压缩，不相关。注意它们会改模型可见的历史（shadow message、spill 存储在 `~/.dsh/spill`），回溯时要把这些插件的外部状态一并考虑。

## 3. 其他 agent 工具的同类机制

| 工具 | 机制和存储 | 排除规则 / 大文件 | 快照后新增的文件 | 回退对话？ | 子代理 / 多代理 |
|---|---|---|---|---|---|
| **Claude Code** /rewind（[docs](https://docs.claude.com/en/docs/claude-code/checkpointing)） | 每个开启一轮的 prompt 前，对编辑工具改过的文件做写前快照，存 `~/.claude/file-history/<session>/`；保留最近 100 个检查点，约 30 天清理（[claude-directory](https://code.claude.com/docs/en/claude-directory.md)） | 只追踪编辑工具；bash 改动、外部改动、软链和硬链都不还原 | 只还原它追踪过的文件 | 支持：可选只还原代码、只还原对话或两者都还原 | **子代理编辑一般不还原**，只有前台运行的 fork skill 例外 |
| **Codex CLI** ghost commit / undo（[ghost_commits.rs @61dfe0b](https://github.com/openai/codex/blob/61dfe0b86c75bb4e6c173a70ca9fb2f2daac2f67/codex-rs/git-utils/src/ghost_commits.rs)） | 在**用户自己的仓库**里用临时 GIT_INDEX_FILE 走 `read-tree HEAD`、`add --all`、`write-tree`、`commit-tree`，生成不挂引用的提交 | 默认忽略 node_modules、.venv、dist、build、.cache、__pycache__ 等目录；未跟踪文件超过 10 MiB 不纳入，未跟踪文件数超过 200 的目录视为大目录 | 还原用 `git restore --source <c> --worktree`，不动暂存区；删除快照后新增的未跟踪文件，但快照时已存在的文件、大文件和大目录保留 | 当时的 undo 只针对工作区 | 无。**注意：2026-04-28 已被 PR [#19481](https://github.com/openai/codex/pull/19481) 移除，undo 变成 no-op** |
| **Cline**（[docs](https://docs.cline.bot/core-workflows/checkpoints)、[CheckpointUtils](https://github.com/cline/cline/blob/65e9727c/src/integrations/checkpoints/CheckpointUtils.ts)、[Tracker](https://github.com/cline/cline/blob/65e9727c/src/integrations/checkpoints/CheckpointTracker.ts)） | 每次工具使用后提交到影子 git：`globalStorage/checkpoints/{cwdHash}/.git`，`core.worktree` 指向工作区 | 默认排除列表（构建产物、媒体、缓存、.env、大数据、数据库、日志等）加上 `.gitattributes` 里的 LFS 模式，写入 `info/exclude`；嵌套 `.git` 临时改名禁用；拒绝在 home、Desktop、Documents、Downloads 目录运行 | 用 `reset --hard`；已入影子库的新增文件会被删除 | 三种选项：Restore Files、Task Only、Files & Task | 无 |
| **Roo Code**（[docs](https://docs.roocode.com/features/checkpoints)、[源码](https://github.com/RooCodeInc/Roo-Code/blob/main/src/services/checkpoints/ShadowCheckpointService.ts)） | 每个任务一个影子仓库：`<globalStorage>/tasks/<taskId>/checkpoints`，`core.worktree` 指向工作区 | 内置排除（媒体、二进制、.env、大数据、日志）加 LFS 模式，遵守 `.gitignore`；**发现嵌套 git 就直接禁用** | `git clean -f -d` 后再 `reset --hard`，会删除新增文件 | 支持 Files only 或 Files & Task | 无 |
| **Kilo Code**（[docs](https://kilo.ai/docs/code-with-ai/features/checkpoints)） | 新版叫 snapshot，基于 opencode：隐藏仓库在 `Global.Path.data/snapshot/{projectID}/{worktreeHash}`（[DeepWiki](https://deepwiki.com/Kilo-Org/kilocode/8.3-file-system-snapshots)，二手来源） | 嵌套 git 和子模块会被跳过（有第三方插件补这个缺口） | 按 patch 精确回退，支持 Redo | 支持，快照关闭时只回退对话 | 无 |
| **Cursor**（[agent overview](https://cursor.com/docs/agent/overview)） | 存在本地，与 Git 分离，会自动清理；内部格式没有公开 | 只追踪 Agent 编辑工具的改动 | 只还原 Agent 改过的文件 | **不回退对话**，只还原文件 | 官方论坛答复：终端命令、**子代理**和手改的内容都不还原（[forum](https://forum.cursor.com/t/rollback-doesn-t-restore-previous-chat-state-and-files-remain-in-git-changes/170624/9)） |
| **Aider** /undo（[docs](https://aider.chat/docs/git.html)） | 直接在用户仓库里自动提交，`/undo` 撤销上一次 aider 提交；编辑前先提交脏文件 | 用仓库自身的 .gitignore | 由 git 处理 | 不回退 | 无 |
| **Gemini CLI** /restore（[docs](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md)） | 每次批准修改型工具前提交到影子 git `~/.gemini/history/<project_hash>`；对话和工具调用存 `~/.gemini/tmp/<project_hash>/checkpoints/*.json`；默认关闭 | 文档没写排除细节，**无法核实** | 「回到快照状态」，是否删除新增文件文档没写 | **支持**：还原对话，并重新提出那次工具调用 | 无 |
| **OpenHands** | 会话存 `~/.openhands/conversations/<id>/`，SDK 支持 fork；「从指定检查点恢复」issue [#2059](https://github.com/OpenHands/software-agent-sdk/issues/2059) 已关闭；Docker+Btrfs 容器快照 PR [#6441](https://github.com/All-Hands-AI/OpenHands/pull/6441) 有提出，但是否合入**无法核实** | — | — | — | issue [#6457](https://github.com/All-Hands-AI/OpenHands/issues/6457) 指出：共享工作区时整体还原会覆盖其他会话的改动，提议每个会话独占工作区 |

上面几家共同的工程要点：
1. 影子 git 一律放在工作区外（`~/.gemini/history`、VS Code globalStorage、`~/.claude/file-history`），工作区只当 `core.worktree`。
2. 排除规则 = 内置名单 + LFS 模式 + `.gitignore`，再加大小阈值（Codex 10 MiB，BOWLUNA 8 MiB）。
3. 快照后新增的文件有三种处理：Roo 用 clean 删除；Codex 只删快照时不存在的未跟踪文件，大文件保留；tmpdot 和 zjukop 提供「保留新增」的 merge 模式。
4. 嵌套 git：Roo 直接禁用，Cline 临时改名。

## 4. 多代理「团队整体快照」先例

- **LangGraph**：checkpointer 在每个 super-step 存图状态，`get_state_history` 之后可以 replay 或 fork（[time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel)）。PR [#7038](https://github.com/langchain-ai/langgraph/pull/7038) 修正了 time travel 时子图加载「父图那个历史时刻对应的」检查点，而不是最新检查点。这是「父子代理一致回退」最直接的先例，但不涉及磁盘文件。
- **AutoGen AgentChat**：`team.save_state()` / `load_state()` 一次存下全部参与者和 group chat manager 的状态（`TeamState.agent_states`）（[docs](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html)）。只管内存状态，不管文件。
- **CrewAI**：`checkpoint=True` 默认在每个 task_completed 时把整个 crew 的运行时状态写到 `./.checkpoints`，可以 Resume 或 Fork；Flow 用 `@persist` 加 `restore_from_state_id` 实现分叉（[docs](https://docs.crewai.com/v1.15.20/en/concepts/checkpointing)）。同样不含工作区文件。
- **编码代理领域**：没有找到「多代理团队连同工作区一起快照」的先例。Claude Code 和 Cursor 都明确说子代理改动不回退。

## 5. 对本项目设计的含义（推断，供决策参考）

- 快照单元应该是「团队清单」manifest，包含：
  - 队长 sessionId 和全部队员 sessionId（参照 purger 的递归枚举），每个会话记录事件 seq 和会话格式代际；
  - `.agent-teams/<teamId>/` 的完整拷贝（team.json 和 inbox/*.jsonl）；
  - 一个工作区树对象（参照 PerryLink 或 Codex 的无引用 commit-tree，或 copy provider）。
- 拍快照前最好让团队静止（队长不在轮次中、队员 idle），因为 `SessionStore.fork` 要求 boundary 在轮次之外。
- 回退时对话不截断，而是 fork：队长 fork 到对应 boundary，再参照 fork-relink 重建队员副本，并把新会话 id 写回 team.json。也可以选择只读归档原会话。
- 文件还原借鉴 Change Ledger：先做救援点，再还原，最后哈希校验，并在启动时对账。新增文件提供 exact / merge 两种模式。
- 排除规则不能误伤 `.agent-teams`；用自己的 exclude 名单处理 `.env*` 和大文件。
