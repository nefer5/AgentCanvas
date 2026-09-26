# AgentCanvas

基于 Excalidraw 的本地画板，让人和 Agent 通过画布表达、提交和处理需求。
默认使用平滑线条，内置 6 种常用三角形和一个平面直角坐标系。绘图在本机完成，可离线使用。

文字、几何形状、箭头和自由书写拥有独立默认样式；顶部工具栏提供只影响手写笔迹的局部橡皮擦，支持三档尺寸和单次拖擦撤销。详见[绘图默认值与局部擦除](docs/drawing-tools.md)。

## 当前状态

当前版本为 **0.2.2**。支持稳定画板/聊天绑定、可见启动、120秒等待接收、可靠性面板和可恢复画板历史。
下载和版本说明见 [GitHub Releases](https://github.com/nefer5/AgentCanvas/releases)。安装包不含 Node，预览阶段未做代码签名。
CI 的版本标签先生成草稿 Release，由维护者验证后公开。

## 安装与升级

Windows 10/11 x64，已有 Node.js 20+（建议使用受支持的 LTS），Windows PowerShell 5.1。
**发布包不包含 Node**，安装器会检查用户已有环境。

从 GitHub Releases 下载 `AgentCanvas-<版本>-win-x64-setup.exe` 并运行。
按用户安装，不要求管理员权限，支持覆盖升级和同版本修复，拒绝降级。
安装后通过开始菜单打开 AgentCanvas；新开终端运行 `agent-canvas --version`。
安装器可选安装 Agent 技能，保留已有非本安装器管理或已被用户修改的技能。

便携使用：下载 ZIP，解压后双击 `Start AgentCanvas.cmd`。
便携包不修改 PATH，可直接调用同目录的 `agent-canvas.cmd`。

卸载：Windows 设置 → 应用 → AgentCanvas。卸载程序文件，保留画板数据。
升级由用户主动下载新版安装器完成；当前没有后台自动更新。
未签名的预览安装包可能出现 Windows 发布者提示。

## 第一次使用

在 Agent 聊天中说“打开这个项目的画板，我要画点东西”，画完点击右侧 **“发送当前画板”**。

- 显示 **“Agent 正在等待”**：发送成功后，等待中的 Agent 就能收到内容并继续处理。默认等待最多120秒。
- 显示 **“未连接”**：仍可发送，确认内容已保存到待处理箱后，回到**打开这张画板的原聊天**说“请领取刚才画板的提交”。必要时补充项目路径和完整画板ID。网页不会自动唤醒已结束的聊天。
- 显示 **“已发送，Agent 正在处理”**：已被领取，等待聊天回复；不等于工作已完成。

完整步骤、状态对照和可复制话术见 [中文入门指南](docs/getting-started.md)。安装包与便携包也附带这份指南。

## Agent 协作

Agent 使用正式可见入口，无需自行选择浏览器自动化或拼接后台命令：

```text
agent-canvas open --project "<项目目录>" --conversation "<工具:聊天ID>" --name "讨论草图"
先向用户发出画板已打开、等待画完提交的提醒，再执行：
agent-canvas receive --project "<项目目录>" --board <返回的画板ID> --timeout 120
```

默认打开后，Agent先明确提醒“画板已打开，请画完点击提交，我会等待最多120秒”，再执行 `receive --timeout 120`。用户明确只打开或只查状态时才不等待；立即领取已有提交可用 `--timeout 0`。完成工作并验证后才调用 `complete`。中文 Skill 说明了首次打开、原聊天复用与失败处理，详见[Agent快速流程](docs/reliability-guide.md#agent快速流程)。

相同项目和聊天恢复同一画板；页面刷新保持绑定，不会跟随其他标签页的项目。`open` 等待页面加载与可见性握手；接收通道是否在线另行显示。CLI内部短请求组成一次最长120秒等待，不会自动唤醒已经结束的 Agent 回合，提交会持久保留，供当前聊天继续领取。处理超过两分钟需用 `renew` 续租，实际完成并验证后才调用 `complete`。

右侧“连接与可靠性”可折叠查看后台、保存、接收和窗口状态；“画板历史”提供图形预览、分页筛选、收藏、归档、回收预览及恢复。活跃/失联窗口、未完成任务及冲突副本会阻止清理。回收站不会自动永久删除，不把移动到回收站计作释放磁盘空间。

既有项目画布与 DSH 内嵌画布保留；旧版 `wait/inbox/complete` 仍可用于继续旧项目队列，`inbox` 会领取工作，不能用于状态检查。日常只读检查用 `doctor` 和 `status --board`。详见[使用与恢复说明](docs/reliability-guide.md)。

自动历史采用固定槽位：每张画板最多20份、合计64 MiB、至少60秒间隔；当前内容持续保存，不再逐次生成完整历史文件。冲突恢复另限3份/64 MiB，显式提交数据独立保留。

## 数据与网络

服务只监听 `127.0.0.1:4173`。数据保存在每个项目的 `.agent-canvas/`、
`%LOCALAPPDATA%/ExcalidrawAgentBridge/` 和浏览器站点存储中，不上传到 GitHub。
Agent 模型的网络及数据处理取决于用户使用的 Agent 工具。
图形库保存在浏览器中，可使用 Excalidraw 自带导入/导出功能备份。

## 开发

```powershell
npm ci
npm test
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-excalidraw.ps1 -NoBrowser
npm run test:visual
```

全局 CLI 开发链接：`npm link`。停止服务：`scripts/stop-excalidraw.ps1`。
发布、安装验证及上传范围见 [发布手册](docs/releasing.md)。
作为受信任回环宿主中的内嵌编辑器使用时，边界与消息协议见 [DSH 内嵌编辑模式](docs/dsh-embedded.md)。

## 许可

AgentCanvas 使用 [MIT](LICENSE) 许可，不增加个人使用或分享限制。
Excalidraw、React 等依赖保留其各自许可；发布包附带第三方声明和许可证。
