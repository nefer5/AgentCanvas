# AgentCanvas Windows 安装与使用

需要 Windows 10/11 x64、Windows PowerShell 5.1、PATH 中已有 Node.js 20+。安装包不包含 Node，建议使用受支持的 LTS 版本。

运行 `AgentCanvas-<版本>-win-x64-setup.exe`，按用户安装，不需要管理员权限。同版本可修复，新版本可覆盖升级，拒绝降级。安装后重开终端，运行 `agent-canvas --version`。

安装时可选 Skill；已有非本安装器管理或被用户修改过的 Skill 会保留。Agent 工具及模型订阅由用户自行准备。没有后台自动更新。

便携包解压到可写目录，双击 `Start AgentCanvas.cmd` 打开页面；命令使用同目录 `agent-canvas.cmd` 的完整路径。便携包不会自动修改 PATH 或安装 Skill。

## 第一次协作

在 Agent 中加载本包 `skills/agent-canvas/SKILL.md`，说“打开这个项目的画板，我要画点东西”。画图、填写说明后点击 **发送当前画板**。

- **Agent 正在等待**：发送成功后，正在等待的 Agent 就能收到内容。默认等待120秒，有提交提前结束等待。
- **未连接**：仍可发送；确认显示已保存到待处理箱后，回到**打开这张画板的原聊天**，说“请领取刚才画板的提交”。必要时提供项目路径和完整画板ID。
- **已发送，Agent 正在处理**：已领取，等待原聊天回复；不是任务已完成。

双击启动器只打开页面，不会自动让 Agent 等待。完整步骤、各模式说明和补领话术见 [中文入门指南](docs/getting-started.md)。旧 Agent 会话可能缓存旧技能，请重新读取或新开会话。

## 升级、卸载与数据

升级只停止所属安装目录的服务，之后重新打开画板。在 Windows 设置 → 应用中卸载；画板数据保留。开发机使用 npm link 时，避免多个安装位置争用同一命令。

数据位于 `%LOCALAPPDATA%/ExcalidrawAgentBridge`、项目的 `.agent-canvas/` 和 `http://127.0.0.1:4173` 的浏览器存储，不属于安装包内容。服务只监听本机；Agent 模型的网络和数据处理由所用 Agent 工具决定。
