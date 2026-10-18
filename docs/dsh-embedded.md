# DSH 内嵌编辑模式

2026-10-18 · 0.2.4：独立App和DSH嵌入模式共用AgentPanel与ConnectionDetails。右栏包含真实课题/会话、画面概览、说明、保存、提交记录及连接诊断。DSH通过现有v4消息传输提供数据，新增sidebar能力标识；不访问独立收件箱。历史快照只读，当前画板可继续编辑，建议预览/拒绝及冲突恢复保留。

独立运行、DSH嵌入的提交通道不同；编辑器已连接不代表Agent正在处理。DSH同画面/说明重复提交复用请求身份，编辑后才另起提交。使用同一已安装程序，升级由独立画板维护，DSH按同一安装身份及兼容契约复用新版本。

[开发/发布/运行目录](development-layout.md)

## 历史协议说明


2026-09-26 v4：“拒绝 ▾”展开修改意见文本框。空反馈只拒绝，填写后拒绝并将修改意见发回原聊天；提交前flush用户草稿，后端固定请求身份去重。聊天折叠与绑定元素联动由optDSH插件负责，独立Canvas项目和通用CLI保持原流程。

2026-09-26反向编辑扩展：内嵌画板轮询本会话的Agent建议稿，提供独立只读预览、应用和拒绝。应用先flush用户草稿，再以当前revision请求宿主；被拒绝时不改编辑器，成功后通过CaptureUpdateAction.IMMEDIATELY进入原生撤销历史。宿主仅接受自己的会话/提案，不操作独立Canvas收件箱。新增3项应用顺序/冲突测试，合计116项UI逻辑测试及构建通过；真实浏览器预览与Undo待验。

2026-09-26。新增embed=dsh模式，由optDSH官方聊天页签打开；普通首页仍使用原有App、项目保存和CLI协议。

DSH宿主持有独立board和提交记录，Canvas提供绘图、图形库、局部橡皮擦、保存与显式发送。不会调用独立项目/inbox API或修改原项目场景。父页面固定聊天身份，不接受子页面覆盖目标。

通信同时匹配父窗口、回环origin和随机channel；无父窗口拒绝启动，Cookie不传入iframe。自动保存有revision检查，恢复副本按boardId隔离；历史快照只读。

入口src/EmbeddedCanvas.tsx；主入口按embed参数选择模式。无新增依赖；TypeScript/Vite构建及原有113项UI逻辑测试通过。Edge实际视觉仍待验收。

宿主契约由配套 optDSH 项目的 `docs/architecture/canvas-session-boards.md` 维护。独立画板 Agent 在线仍依赖真实 wait；内嵌“画板已连接”表示编辑器与 DSH 父页握手，不表示模型任务已完成。
