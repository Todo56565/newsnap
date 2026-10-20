# M5 网页界面设计草案（讨论稿）

状态：草案，未写代码。依据 DSH dsh-v0.2.1-rc.2 源码（`packages/client/*`、`packages/api/gateway`、`docs/cookbook/adding-a-remote-api.zh.md`）。

## 0. 目标与原则

用户要求：**美观、易用，位置发挥想象力**。

- **快照住在它发生的地方**：时间回溯的心智模型是「对话里的书签」，而不是一个藏在设置里的管理页。
- **一眼能看懂代价**：恢复会丢掉什么（之后的对话轮、成员会话、文件改动）在按下前就看得见。
- **不发明视觉语言**：只用 DSH 自带的 ui-primitives、主题变量和 locale（中/英），深浅色自动跟随；动效克制。
- **斜杠命令照旧可用**：界面只是同一套引擎的另一张脸，命令和界面结果一致。

## 1. 可挂载的位置（源码里已有的 slot）

| slot | 用途设想 |
|---|---|
| `conversation.chat.node`（按 key 注册渲染器） | 对话流里的**快照书签卡** |
| `conversation.session.header.utilities` | 会话头部的**时光机按钮**（ui-schedule、open-in-app 也挂在这里） |
| `sidebar.right.pane.tab` + `.title` | 右侧栏**时间线面板** |
| `shell.overlay` | 全屏**恢复确认面板** + 重启过渡页 |
| `conversation.input.dock` | 输入框上方的**恢复后提示条**（GoalBar 就在这里） |
| `sidebar.session.row.leading` | 左侧会话列表里团队会话的**小标记** |
| `workspace.toast` | 拍照成功或失败的轻提示 |

## 2. 设计方案

### 2.1 对话里的书签（主入口）
每次拍照，对话流在那一刻插入一张细长的书签卡：

```
──────── ◆ 17:19  快照「first」 · 团队 say-one-sentence · 3 个会话 · 12 个文件 ────────
                                                   [回到这里]  [⋯]
```
- 平时只是一条带菱形标记的分隔线，不抢内容；鼠标悬停才展开按钮。
- 「回到这里」打开 2.4 的确认面板。`⋯` 里有：改备注、删除、复制 id。
- 实现：给 `/newsnap snap` 的 `command/done` 注册专用渲染器，替换现在的纯文本结果；顺带解决了 B4 补记「看不出来」的问题。

### 2.2 会话头部的时光机按钮
头部右上角一个时钟加回旋箭头的图标，带快照数小角标。点开是一个弹出层：
- 顶部是**大号「拍一张」按钮**，旁边有可选备注输入框；有进行中任务时按钮置灰，悬停说明原因（复用 preflight 的拦截原因）。
- 下面是**竖向时间线**：最新的在上，每个节点显示相对时间、备注和「之后改了 N 个文件 / 多了 N 轮」，救援点用空心节点并标「撤销点」。
- 快捷键：⌘/Ctrl+Shift+S 拍照（需确认不和 DSH 已有快捷键冲突）。

### 2.3 右侧栏「时光机」面板（深度视图）
从弹出层点「展开」进入，给需要细看的人：
- 左半边是时间线，右半边是选中节点的**对比视图**：文件变化列表（新增 / 删除 / 修改，点开看 diff，复用 DSH 的文件预览）、受影响的会话（会被移除的成员会话标红）、同工作区其他团队（警示）。
- 顶部有一个「从拍照到现在」的迷你时间轴，节点可拖动对比两个快照（远期）。

### 2.4 恢复确认：全屏面板
「回到这里」不用小对话框，用 `shell.overlay` 全屏半透明面板：
- 标题「回到 17:19」，下面三列卡片：**会丢掉**（之后 N 轮对话、N 个成员会话）、**文件会变**（+3 −1 ~8）、**其他团队**（不受影响 / 警示）。
- 底部写明：「会先自动存一个撤销点。」主按钮是「回到 17:19」，次按钮是「取消」。
- 按下后面板变成**过渡页**：时间线倒带动画加步骤（退出 → 恢复文件 → 恢复会话 → 重启），网页端重连成功后**自动刷新页面**（client-modules 有 release-change 和 `connection/reset` 可用），不再需要用户手动刷新。
- 桌面端：过渡页写明「DSH 会关闭，弹出对话框后点重启」，和现在的流程一致。

### 2.5 恢复后的提示条
回来后，输入框上方停一条细提示条（形似 GoalBar）：
`⟲ 已回到 17:19 的快照「first」   [撤销]  [×]`
- 一直显示到用户关掉、发出下一条消息，或下一次恢复为止；状态来自 `lastApplied`（B5 已做持久化）。

### 2.6 左侧会话列表的小标记
带快照的队长会话左边显示一个菱形小点，悬停显示「3 个快照，最近 17:19」。很轻，主要帮助用户找到能回溯的会话。

## 3. 技术路线与风险

**前后端怎么通信是最大的未知。**

- 网页客户端模块：包的 `package.json` 声明 `dsh.client { platform: 'web', inject, external }` 和 `./client` 导出，由 client-modules 扫描并注入页面。第三方插件能否用这套机制，**需要做 PoC 确认**。
- 数据接口首选 Typert Remote：宿主侧 `class NewsnapController extends TypertRemoteService` 加 `@Remote('list' | 'snap' | 'preview' | 'restore' | 'undo' | 'status')`；客户端 `ctx.remote.$mount(contribution)` 挂自己的 `/remote` 产物。风险有三点：
  1. `@Remote` 是装饰器，要求我们引入 tsdown 构建（现在是 strip-types 直跑）；
  2. `typert.remote-client.js` 由 dsh-typert-generator 生成，第三方包能否跑这条生成流水线未知；
  3. 网关是否会发现第三方包里的 Remote 服务（文档写的是「生成时选择的 Remote 方法」）。
- 后备 A：宿主侧 `ctx.webserver.register()` 注册 `/api/newsnap/*` HTTP 路由，只在网页端可用，桌面端不行（桌面走 IPC，可能没有 webserver）。
- 后备 B：界面按钮直接经 commands Remote 执行 `/newsnap …` 命令，结果用 2.1 的渲染器显示。不需要任何新接口，但列表和预览这类读操作会在会话里留下命令记录。

**建议先做 M5-0 PoC（半天到一天）**：一个最小客户端模块，在会话头部挂一个按钮，经 Remote 读 `list` 显示条数；三条路线各验证一遍，网页和桌面都要看。

## 3a. M5-0 PoC 结果（2026-10-21，分支 poc/m5-remote 4206d1d）

网页端实测**走通**（DSH rc.2，`test/e2e/web/m5poc.mjs`）：
- **客户端模块**：第三方插件也会被 client-modules 扫描到。只要 package.json 里有 `dsh.client { platform: 'web' }` 和 `./client` 导出，`newsnap/client.js` 就被打进 `/plugins/??…` 组合脚本加载。包格式是 `window.__ModuleLoader__.load({ id, factory(require) })`，外部依赖（如 react）经 require 从平台模块表取。PoC 手写纯 JS，不需要 DSH 的 tsdown 预设。
- **挂载位置**：`conversation.session.header.utilities` 能挂上按钮（order -6，在计划任务按钮左边），弹出层正常显示。
- **数据接口**：用的是 Typert Gateway 的 **SRC 回退**，它在发布版里也开着：宿主侧没有严格描述符时，按原型上的方法描述符（`@deepseek-ai/dsh-typert-protocol/remote-methods`，version 1）和可见的 `typertRemote` 绑定找服务，从函数源码读参数名，名为 `session` 的参数自动解析成 Session。newsnap 不用装饰器语法、也不在运行时 import 协议包，按格式写好描述符后用 `ctx.provide('newsnapRemote', obj)` 注册即可。
- **客户端调用**：`ctx.remote` 拒绝挂载 SRC 描述符，所以直接用 `ctx.connection.rpc.call('/api', 'newsnap/list', { args: { sessionId } })`，走 `POST /api/newsnap/list`，三次调用都返回 200。代价是没有 schema 校验和生成的类型，需要我们自己校验入参。
- 同一轮还验证了 `delete` 和 `purge` 斜杠命令：预览、确认、救援点删除后 status 显示「不能撤销」，purge 后弹出层显示「还没有快照」，都符合预期。

**风险与未验证**
- SRC 回退依赖协议的内部格式（描述符属性名、version 1、按参数名匹配 lookup），DSH 升级时可能变化。对策：把 Remote 适配集中在 `host/remote.ts` 一处，启动时自检，失败只关掉界面、不影响命令。
- 桌面端没测。理论上 Connection 与 carrier 无关，桌面端也经 /api RPC 分发，需要用户本机验证。
- 写操作（snap、restore）还没接。restore 会让宿主退出，届时客户端需要配合重连后自动刷新。
- 权限：非 owner 的 Peer（远程访问）会经 remoteAccess 判定，SRC 方法默认的处理方式未查。

**结论**：首选路线可行，不需要后备方案 A 或 B。

## 4. 分期

- **M5-0** PoC：确认通信路线（见上）。
- **M5-1** 书签卡（2.1）、头部按钮与弹出时间线（2.2）、全屏确认与过渡页（2.4，含网页端自动刷新）、恢复后提示条（2.5）。
- **M5-2** 右侧栏对比视图（2.3）、会话列表标记（2.6）、快捷键。
- 远期：两个快照互相对比、拖动时间轴。

## 4a. 用户选择（2026-10-21）

看了线框 `m5-mockups.html` 后选：**1 书签卡、3 右侧栏对比视图、确认用 B 轻量对话框、5 恢复后提示条**。2（头部按钮）和 6（列表标记）不做，全屏面板 A 不做。

新增想法 7（线框 §7）：在 DSH 右侧的轮次导航条（ui-chat `TurnNavigator`）上，用一条线标出最近一次快照，位置在拍照前后两轮之间；最底下永远有一条「现在」线，鼠标悬停出现拍照按钮。
- 可行性：导航条是 ChatView 的内部组件，没有 slot；只能在页面上叠一层、按它的 DOM 位置画线（脆弱），或者给上游提 issue 要一个装饰挂载点。快照要记下拍照时队长会话的轮号。
- **10-21 用户定：不做 7**（没有挂载点）。M5 范围定为 1、3、B、5。

## 5. 待定（请用户定，§4a 之前的版本）

1. 主入口用书签卡（2.1）加头部按钮（2.2）两个都要，还是只要其一？
2. 恢复确认用全屏面板（2.4），还是更轻的居中对话框？
3. 对比视图（2.3）放 M5-2 可以吗？它要算 diff，成本最高。
4. ~~第三方 Remote 走不通时的后备~~：PoC 已走通，不再需要。

## 5. M5-1 实现（10-21）
- 宿主：`host/remote.ts` 的 Remote 方法 list / snap / preview / restore / undo（失败统一返回 `{ ok:false, message }`，文案与斜杠命令同源 `host/errors.ts`；restore/undo 回应发出 400ms 后才让宿主退出）。list 带每张快照的 commandId 和最近一次恢复。
- 客户端 `client/index.js`：
  - 1 书签卡：注册 `conversation.chat.commandview` 键 `newsnap`，`/newsnap snap` 成功的那一行画成虚线书签（时间、备注、会话数），悬停出「回到这里」；按 commandId 认领快照，快照被删时显示「快照已删除」。其他子命令画成简化的命令行（可展开多行输出）。
  - B 确认框：用 ui-primitives 的 Modal/Button；一句话代价 + 忽略文件提示 + 其他团队警告，「查看详情」折叠快照 id、新开会话数、重启方式。
  - 过渡层：确认后全屏半透明「正在回到 HH:MM…」；网页端轮询页面地址，看到服务断开又恢复（或 connection/reset）后自动 `location.reload()`。桌面端只提示点「重启」。
  - 5 提示条：`conversation.input.dock`，显示最近一次恢复/撤销，带「撤销」（救援点还在时）和 ×；关闭记在 localStorage（按团队+恢复时间）。**发下一条消息后自动消失未做**。
- 网页 e2e（test/e2e/web/m5.mjs）通过：书签卡出现 → 确认框 → 过渡层 → 12 秒后自动刷新、文件回到 v1 → 提示条 → 撤销 → 14 秒后自动刷新、文件回到 v2 → 提示条变「已撤销上一次恢复」→ × 关闭。控制台只有重启期间的连接拒绝。
- 已知：文案只有中文；网页上无斜杠命令时拍的快照（Remote snap）没有书签卡（M5-2 时间线里会有）。
