# newsnap 0.1 实现设计

> 状态：**草案，待用户审**（2026-10-19）。只写设计，未写代码。
> 依据：[`newsnap-design.md`](newsnap-design.md)（下称「总设计」）§0–§16；§13 的待定项已全部定案。本文与总设计冲突时，以本文为准；总设计 §4 的「停机 + 命令行」改为本文 §4 的方案 B，命令行只留作开发工具和兜底。
> 源码基线不变：DSH `0.2.1-rc.2`、agent-teams `v0.1.25`。

## 0. 范围

**0.1 做：**
- 拍快照（总设计 §2、§3，不变）。
- 恢复：用方案 B 一键自动重启（§4）。还原引擎是一个纯 Node 模块，不依赖 DSH，辅助进程和兜底命令行共用。
- 入口：网页端的会话头按钮 + 斜杠命令。headless 只用于测试。
- 启动对账：恢复中断、成功或失败后，插件下次启动时提示用户（§4.5）。

**0.1 不做：**
- 方案 C（克隆成新会话 id）：留到 0.2 验证。
- 桌面端自动重启：0.1 只检测、不重启（§4.6）。
- fork 适配（已定）。
- token-budget 的内存状态：由 token-budget 0.6.0 的 E5b 负责，newsnap 不管（§13-7）。在 0.6.0 发布前，恢复功能照常可用，但兜底和换窗状态会丢；文档里列为局限。

## 1. 包结构

一个 npm 包，三个入口：服务端插件、客户端插件、命令行。

```
src/
  index.ts            服务端插件：注册路由、斜杠命令、启动对账；inject 只列必需服务
  client/index.tsx    会话头按钮与面板（插槽 conversation.session.header.actions）
  cli.ts              newsnap apply | rollback | list | doctor（开发/兜底）
  core/               ← 纯 Node，不 import 任何 @deepseek-ai/*（辅助进程只加载这一层）
    paths.ts          DSH_HOME、projectKey(cwd)、encodeSegment(id)、会话目录、代文件选择
    manifest.ts       manifest / pending-restore 的 schema、读写（先写临时文件再 rename）、校验
    hash.ts           流式 sha256
    shadow-git.ts     影子 Git 封装（GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE）
    mtime.ts          mtime 清单的生成与还原
    tar.ts            .agent-teams 部分打包 / 解包（保留 mtime）
    teams.ts          只读 team.json 的少数字段（成员与队长会话 id、任务状态、createdAt），对不上就抛 UnsupportedTeamState
    apply.ts          还原引擎（§3）：救援点 → 替换 → 删投影缓存 → 校验，按步骤写日志、可续做、可回滚
    journal.ts        步骤日志（pending-restore.json 内的 steps[]）
  host/               ← 依赖 DSH 运行时
    capture.ts        拍照流程（总设计 §3：前置检查、冻结、复制、复核）
    register.ts       恢复登记与前置检查
    restart.ts        拉起辅助进程 + appExit（§4.2）
    reconcile.ts      启动对账（§4.5）
    routes.ts         HTTP 路由（鉴权照 agent-teams 的 authenticatedWebRoutes）
helper/
  helper.mjs          辅助进程入口：等父进程退出 → core/apply → 重新拉起（§4.3）
```

**inject 原则**（吸取 token-budget 0.5.1 F1 的教训）：只列每个 profile 都有的服务；`webServer`、`appExit`、`agentPresets` 这类不一定有的，一律在调用时用 `ctx.get()` 读，没有就关掉对应功能，不能让整个插件 pending。

## 2. 存储（总设计 §2.2，补细节）

```
<DSH_HOME>/newsnap/<projectKey(cwd)>/
  repo.git/
  snaps/<snapId>/manifest.json, sessions/…, agent-teams.tar, mtimes.json
  rescue/<rescueId>/      结构同 snaps，另含 restore-of: <snapId>
  pending-restore.json    同一时刻最多一份
  lock                    newsnap 自己的互斥锁（flock），拍照、登记、apply 互斥
```

- **manifest 新增字段**：`cwd`、`sessionCwd`（每个会话自己的 cwd，见 §16.6：apply 要用会话 cwd，不能用进程 cwd）、`schema: 1`。
- **pending-restore.json**：`{ schema, snapId, rescueId?, status, steps[], relaunch, createdAt, result? }`
  - `status`：`registered → exiting → applying → applied | failed | rolled-back`
  - `relaunch`：`{ execPath, execArgv, argv, cwd, profile, sessionId?, port? }`，在登记时从 `process.*` 记录。env 不落盘（可能含密钥），由辅助进程直接继承。
  - `result`：`{ ok, message, at, newUrl? }`，供启动对账展示。
- 所有 JSON 都先写 `*.tmp` 再 `rename`，避免写一半。

## 3. 还原引擎 `core/apply.ts`

借鉴 Anionex/dsh-turn-rewind 的 Change Ledger：先做救援点，还原后做哈希校验，失败就回滚，中断后下次能对账续做。步骤固定、每步幂等，完成一步就把 `steps[i].done = true` 写进 pending：

| # | 步骤 | 说明 |
|---|---|---|
| 1 | lock | 拿 newsnap 自己的 lock；再逐个会话试 `flock session.lock`，**拿不到就中止，什么都不改**（判断 DSH 是否真退了，16.5 证明父进程退出后一定拿得到） |
| 2 | rescue | 把当前会话目录、`.agent-teams` 相关部分、工作区（影子提交 + mtime 清单）做成救援点 |
| 3 | sessions | 换成快照里的代文件，删掉编号更高的代；快照后新增的本队会话整目录移进救援点 |
| 4 | teams | 解 tar，覆盖 `.agent-teams/<teamId>`、`archive/<teamId>`、`.context/`；调整 `retired-members.json` 里本队成员的 id；比对 `mergeSnapshotPicks`，不一致只记警告 |
| 5 | workspace | 在**会话 cwd** 下 `git restore` + 删除快照后新增、且未被忽略的文件 + 还原 mtime |
| 6 | projcache | 删除这些会话在 `storages/session_projcache` 里的记录 |
| 7 | verify | 会话文件 sha256、tar 里的文件、工作区与影子提交逐一比对 |
| 8 | release | 释放锁，status = applied |

- 第 3–7 步任一失败：自动用救援点回滚（同一引擎反向执行，从救援点还原），status = failed，`result.message` 写原因。回滚本身也失败时 status 留在 applying，交给 `newsnap doctor`。
- 引擎接收 `{ home, snapDir, rescueDir, pending }`，不读全局状态，单测直接用临时目录。

## 4. 恢复流程（方案 B）

### 4.1 登记（运行中，`host/register.ts`）
1. 前置检查与总设计 §4.1 相同；另外检查 `ctx.get('appExit')` 是否存在，profile 是否支持（见 §4.6）。不支持就拒绝，并提示改用命令行 `newsnap apply`。
2. 展示影响面（新增会话移进救援点、其他团队写过工作区要勾选确认），等用户确认。
3. 写 pending（status = registered，记录 relaunch）。

### 4.2 退出（`host/restart.ts`）
1. 把 pending.status 改成 exiting。
2. `spawn(process.execPath, [helper.mjs, pendingPath, String(process.pid)], { detached: true, stdio: 'ignore', cwd: <newsnap 目录> }).unref()`。
3. **先回应请求，再退出**：HTTP 路由先返回 202 和「正在重启」，斜杠命令或工具先返回结果，然后在 `setImmediate` 里调用 `appExit(0)`。依据：16.5 和 16.6 证明立即退出会让当前 turn 在工具结果落盘后中止；如果延时 300 ms，turn 会先跑完，多一次模型请求。触发恢复的这一轮发生在快照之后，恢复后会随快照之后的内容一起被回退，不需要特殊处理。

### 4.3 辅助进程（`helper/helper.mjs`）
1. 轮询 `process.kill(ppid, 0)`，直到返回 ESRCH；超时 60 s 就放弃，写 result（失败：DSH 未退出），不重新拉起。
2. status = applying，调用 `core/apply`。
3. 无论成功还是失败（已回滚），都按 relaunch 重新拉起 DSH：
   - web：用原参数原样拉起（会话从磁盘读，端口不变；16.6 验证过）。
   - headless：把原参数里的任务文本换成续接提示，再加 `--session-id`（16.5）。
   - 拉起方式：`spawn(execPath, [...execArgv, ...argv], { detached: true, stdio: 'ignore', cwd })`。web 的日志本来就写在 DSH_HOME，不依赖终端。
4. 辅助进程的输出写到 `newsnap/<key>/helper.log`。

### 4.4 网页端重连与访问令牌（已核对源码）
- `client-connection/src/browser-auth.ts`：URL 里的 `?token=` 是**每次启动新生成**的一次性令牌，换到的 cookie 由一个**持久保存的密钥**签名（凭据库里的 `client-connection/browser-session`），并绑定 host:port。
- 由此推断（未实测）：已经打开过的浏览器带着 cookie，重启后仍然有效，这和 16.6「已打开的页面自动重连」一致；旧的 token 链接在新进程里会失效，但有 cookie 就不需要它。所以 0.1 **不需要固定 token**，前提是端口不变（cookie 绑 authority）。
- **`--port 0` 与自动开浏览器**（10-19 核对 `bundle/web-app`）：不传 `--port` 时用固定默认端口 3080（`cordis.patch.yml:184`）；`--port 0` 由系统随机挑端口，每次启动都不同。另外 web 默认启动后会用**带新 token 的地址自动打开默认浏览器**（`openBrowser` 默认 true，`index.ts:202-235`；`--no-open` 或经 SSH 启动时不开）。因此：
  - 端口固定：已打开的页面靠 cookie 自动重连；重启时如果再自动开浏览器，会多出一个重复标签页。所以辅助进程重启时**追加 `--no-open`**。
  - `--port 0`：端口变了，旧页面重连不上，cookie 也不再匹配。这时**保留自动开浏览器**（不加 `--no-open`），由新进程打开带新 token 的地址。用户会看到新开的标签页，旧标签页需要手动关。登记时提示一句「重启后会在新标签页打开」，仍然允许恢复。
  - 原来就带 `--no-open` 或经 SSH 启动，且用的是 `--port 0`：没人替用户打开新地址。这时只能由辅助进程截取新进程 stdout 里的 URL，写进 `result.newUrl` 和 `helper.log`。登记时提示用户「重启后地址会变，请到终端或 helper.log 里查看」，仍然允许恢复。
- 待验证：用旧 token 新开页面会怎样（预期是靠 cookie 进入，或者要求重新授权）。

### 4.5 启动对账（`host/reconcile.ts`，插件 apply 时）
| pending.status | 处理 |
|---|---|
| 无 | 无 |
| applied | 在会话头面板显示「已恢复到 <快照>」和「撤销」按钮；然后归档 pending |
| failed / rolled-back | 显示失败原因，说明已经回滚；归档 pending |
| registered / exiting | 辅助进程没起来或 DSH 没退：清掉 pending，提示「恢复未执行」 |
| applying | 辅助进程中途挂了：**拒绝打开本队会话**做不到（会话由宿主按需打开），所以只在面板上醒目提示，并提供「继续恢复」（再走一次 §4.2，引擎按 steps 续做）和「回滚」 |

### 4.6 各 profile 的支持
| profile | 0.1 | 说明 |
|---|---|---|
| web | 支持 | 16.6 已验证 |
| headless | 支持（测试用） | 16.5 已验证 |
| desktop | 不自动重启（用户 10-19 接受） | 宿主由 Electron 拉起（`apps/desktop-host`），Electron 有自己的崩溃恢复和「Restart App and Host」。辅助进程另外拉起一个宿主，会和 Electron 冲突（地址占用，见 `startupAddressInUse`）。0.1 的做法：apply 照做，但不重新拉起，提示用户在 Electron 里点重启。是否能让 Electron 自动重启宿主，留待验证 |
| acp / sdk | 不支持 | 拒绝，提示用命令行 |

profile 的判断：`ctx.get('profileContext')`（`apps/cli/src/profile-boot.ts` 提供），具体字段待实现时核对。

### 4.7 撤销（用户 10-19 定：实现不复杂就做）
- 救援点的结构和快照完全一样（§2），所以撤销 = 以救援点为目标再走一次 §4.1–4.5，复用同一个还原引擎，不需要新代码路径。这次撤销本身也会生成一个新的救援点，所以撤销也能再撤销。
- 唯一要额外处理的是：前置检查里「团队空闲」对救援点同样适用。救援点是在 DSH 已退出时建的，那一刻一定空闲，所以没问题。
- 面板：快照列表下方列出最近的救援点（保留 7 天，总设计 §8），每个都能「恢复到此」；恢复成功后的提示条上放「撤销」，作为最近那个救援点的快捷入口。
- 工作量：只多一个列表区和一个按钮，所以放进 M5 一起做。

## 5. 与 token-budget 的关系
- 恢复后提示是否和原时间线逐字一致，取决于 token-budget 0.6.0 的 E5b。newsnap 不做适配、不 import 它。
- newsnap 整体回退 `.context/`，全文去重撞键不会发生（总设计 §1c(1)）；E5a 是给单会话回退工具用的。
- 两个插件互不依赖；同时装时，加载顺序没有要求。

## 6. 测试
1. **单测（core/，不需要 DSH）**：paths、manifest 读写、mtime 往返、tar 往返、影子 Git 在临时仓库上 snap/restore；apply 引擎在构造的目录上覆盖以下情况：每一步后中断再续做、第 5 步失败后回滚、锁拿不到时零改动。
2. **headless e2e（mock，不花额度）**：复用 `poc/restart-b`，跑「拍照 → 继续一轮 → 恢复 → 自动重启 → 续一轮」，比对 mock 记录的请求前缀。
3. **网页 e2e（mock + Playwright）**：复用 `poc/restart-b/snapweb*.mjs`，加上旧 token 新开页面的用例。
4. **真跑一次（需用户批准）**：队长 + 1 名成员，检查 `prompt_cache_hit_tokens`，并确认 agent-teams 不会重派任务。

## 7. 里程碑（每步小提交，先讨论再写）
- **M1** core：paths、manifest、hash、mtime、tar、teams 只读，加单测。
- **M2** 拍照：host/capture + 影子 Git + 斜杠命令 `/newsnap snap`、`/newsnap list`。
- **M3** 还原引擎 + 命令行 `newsnap apply/rollback/doctor`（停机兜底，也方便开发）。
- **M4** 方案 B：register、restart、helper、reconcile，加 headless e2e。
- **M5** 网页界面：按钮、面板、路由，加 Playwright e2e。
- **M6** 桌面端调研；方案 C 的 PoC（0.2）。

## 8. 已定（用户 10-19）
1. 桌面端 0.1 只做 apply，不自动重启：接受。
2. 撤销：实现不复杂就做。按 §4.7，它复用还原引擎，所以做。
3. `--port 0`：不拒绝，按 §4.4 处理。重启时端口固定就加 `--no-open`；端口随机则交给自动开浏览器，或者记录新地址。

暂无其他待定问题；审过后从 M1 开始写代码。
