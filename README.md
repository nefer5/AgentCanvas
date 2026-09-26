# AgentCanvas

基于 Excalidraw 的本地画板，让人和 Agent 通过画布表达、提交和处理需求。
默认使用平滑线条，内置 6 种常用三角形和一个平面直角坐标系。绘图在本机完成，可离线使用。

文字、几何形状、箭头和自由书写拥有独立默认样式；顶部工具栏提供只影响手写笔迹的局部橡皮擦，支持三档尺寸和单次拖擦撤销。详见[绘图默认值与局部擦除](docs/drawing-tools.md)。

## 当前状态

当前版本为 0.1.0 预览候选。源码和发布流水线已提供；首次公开时尚无正式 Release。
真实 Windows EXE 安装、升级、卸载及用户数据保留仍待完整验收。
CI 的版本标签只生成草稿 Release，验收后再公开安装包。

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

## Agent 协作

在右侧面板添加项目，Agent 使用：

```text
agent-canvas wait --project "<项目目录>" --label "当前任务"
agent-canvas inbox --project "<项目目录>"
agent-canvas complete <submission-id> --project "<项目目录>"
```

只有活动的 wait 才表示 Agent 已连接；用户自行打开时可离线提交到待处理箱。
`inbox` 会领取提交，不是无副作用的查询；实际处理完成后才调用 `complete`。

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
