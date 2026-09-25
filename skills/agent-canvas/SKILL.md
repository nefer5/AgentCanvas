---
name: agent-canvas
description: Use when the user asks an Agent to open, connect to, draw on, receive from, or process an Excalidraw Local canvas, or mentions Agent 画板、未连接、待处理箱、发送当前画板、agent-canvas CLI.
---

# Agent Canvas

## 概述

为 Excalidraw Local 建立可验证的 Agent 协作闭环。核心原则：**页面打开、项目选中、Agent 连接是三个不同状态；只有活动的 `agent-canvas wait` 会话才代表已连接。**

## 何时使用

- 用户要求 Agent 打开本地画布、一起画图或在画布上交互。
- 用户询问 Agent 面板的“未连接”“正在等待”或“待处理箱”。
- 用户已经点击“发送当前画板”，要求 Agent 领取、处理或完成。
- 需要使用 `agent-canvas wait`、`inbox`、`complete` 或项目 `.agent-canvas/` 数据。

只讨论普通 Excalidraw 使用方法、且不涉及本地 Agent 面板时，不需要本 skill。

## 连接真值表

| 页面/项目状态 | 活动 wait | 含义 | 可以宣称已连接 |
|---|:---:|---|:---:|
| 页面已打开，项目已选中 | 否 | 画布可用，但 Agent 离线 | 否 |
| URL 带 `projectRoot` | 否 | 仅用于注册和选择项目 | 否 |
| 用户从快捷方式自行打开 | 否 | 正常离线，可发送到待处理箱 | 否 |
| 页面已打开，项目匹配 | 是 | Agent 正在等待该项目提交 | 是 |
| 提交已进入待处理箱 | 否 | 提交已持久保存，等待领取 | 否 |
| wait 已返回一次提交 | 否 | 本次连接已完成交付并退出 | 否；继续协作需新 wait |

连接状态来自服务端活动会话，不来自页面来源、项目名或 URL。

## Agent 发起实时协作

### 1. 确定项目与服务

1. 使用当前任务的实际工作目录作为 `cwd`；用户明确指定其他目录时使用指定目录。
2. 确认 `agent-canvas` 命令存在。命令缺失时报告缺失，不伪造连接。
3. 确认 `http://127.0.0.1:4173/api/health` 健康；不健康时使用项目提供的正式启动器启动服务，不另起 5173 开发服务。

### 2. 打开并注册项目

使用当前工具支持的浏览器 skill 或浏览器控制能力打开：

```text
http://127.0.0.1:4173/?projectRoot=<encodeURIComponent(cwd)>
```

确认两项事实：

- Agent 面板选中的项目路径等于 `cwd`；
- 页面完成启动后，URL 已清除 `projectRoot`。

若目录首次使用，必须等页面完成注册并生成 `.agent-canvas/project.json` 后再启动 wait。

### 3. 建立真实连接

在可持续读取输出的终端或 PTY 会话中启动：

```powershell
agent-canvas wait --project "<cwd>" --label "<当前 Agent 或任务名称>"
```

该命令会阻塞等待提交。保持会话运行，不要把它放进一个无法回收输出的隐藏进程。

页面按项目轮询连接状态。确认面板显示“Agent 正在等待”后，才告诉用户画布已连接。将可见标签页保留给用户操作。

### 4. 接收、处理与完成

用户点击发送后，wait 返回 JSON 决策。只有 `decision` 为 `submitted` 且包含真实 `submissionId` 时才进入处理：

1. 读取返回的说明、场景与预览路径。
2. 按用户说明处理，保留提交 ID 和项目目录。
3. 运行适合该任务的验证。
4. 工作实际完成后执行：

```powershell
agent-canvas complete "<submission-id>" --project "<cwd>"
```

5. 向用户报告处理结果和完成状态。

`received` 只代表 Agent 已领取，不代表任务完成。`complete` 不能提前执行。

wait 每次只交付一个提交并退出。仍需实时协作时，处理完成后重新启动新的 wait。

## 用户自行打开画布

用户从桌面快捷方式或直接访问页面时：

- 应用恢复上次项目或使用临时画板；
- 不自动创建 Agent 会话；
- “未连接，发送后进入待处理箱”是正常状态；
- 点击发送会把完整提交持久保存到项目待处理箱。

如果用户只是询问为什么未连接，解释上述区别，不擅自启动 wait，也不要让用户关闭一个本来正常的离线画布。

如果用户随后要求 Agent 参与：

- 尚未发送且希望实时交付：针对正确项目启动 wait，再确认页面在线；
- 已经发送到待处理箱：直接领取，不要求用户重发。

```powershell
agent-canvas inbox --project "<cwd>"
```

`inbox` 返回 `submitted` 时按“接收、处理与完成”流程推进；返回 `empty` 时说明当前没有待处理提交。

## 完整示例

用户说：“打开画布跟我一起画，当前项目就是这个任务目录。”

Agent 的正确顺序：

1. 读取当前 `cwd`，检查 4173 健康状态与 `agent-canvas` 命令。
2. 用浏览器打开带编码 `projectRoot` 的 URL。
3. 确认面板项目路径匹配 `cwd`，URL 参数已清理。
4. 在可继续读取的终端会话运行 `agent-canvas wait --project "<cwd>" --label "Codex 当前任务"`。
5. 再次观察页面；只有看到“Agent 正在等待”才回复：“画布已打开并连接，我会在这里等你发送。”
6. 用户发送后从 wait 输出取得 submission ID，完成请求与验证。
7. 执行 `agent-canvas complete`，再报告完成。

## 恢复检查表

### 页面没有选中正确项目

- 核对传入的是目录绝对路径并正确 URL 编码。
- 查看页面是否显示明确启动错误。
- 不要静默切换到临时画板继续画。

### 页面仍显示未连接

- 确认 wait 命令仍在运行，而不是已经报错或超时。
- 核对 wait 使用的项目目录与面板当前项目路径一致。
- 检查 `.agent-canvas/project.json` 已存在。
- 等待页面完成一次轮询后重新观察；仍离线则报告真实阻塞点。

### wait 退出或超时

- 当前连接已经离线，不再宣称已连接。
- 仍需实时交互时重新启动 wait。
- 用户已经发送时先检查 inbox，避免要求重复发送。

### 提交领取后处理失败

- 不执行 complete。
- 保留 submission ID，向用户报告具体失败和可恢复步骤。

## 常见错误

- **把页面可交互当作连接成功**：画布 UI 与 Agent 接收通道相互独立。
- **只传 `projectRoot` 就显示在线**：它只负责注册与选项目。
- **先 wait、后首次注册**：CLI 找不到 `.agent-canvas/project.json`。
- **启动 5173 Vite 开发端口**：正式本地桥接协议位于 `127.0.0.1:4173`。
- **把 wait 丢进不可读取输出的后台进程**：用户发送后 Agent 无法取得 submission ID。
- **用户自行打开却要求关闭重开**：离线待处理箱本来就是受支持流程。
- **收到即 complete**：必须先完成用户要求并验证。

## 快速参考

| 目的 | 命令/动作 |
|---|---|
| Agent 打开正确项目 | 浏览器打开 `/?projectRoot=<编码 cwd>` |
| 建立实时连接 | `agent-canvas wait --project <cwd> --label <label>` |
| 领取离线提交 | `agent-canvas inbox --project <cwd>` |
| 完成真实工作 | `agent-canvas complete <id> --project <cwd>` |
| 判断是否在线 | 页面存在该项目的活动 wait 会话 |
