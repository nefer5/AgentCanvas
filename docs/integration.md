# AgentCanvas 安装接入契约

包名为 `@nefer5/agent-canvas`，命令仍为 `agent-canvas`。当前 `private: true`，不公开发布 npm。

已有 Windows 安装器/便携包继续使用。安装根的 `app` 子目录或源码根包含 package.json、scripts 和 dist。

宿主执行 `node <安装根>/scripts/agent-canvas.mjs integration-info`，取得单行 JSON（installationId 为安装真实路径 SHA256 前24位）；此命令不启动服务、不扫描项目、不领取收件箱。`protocol: 1` 是安装发现协议，`embed.dsh: 4` 是内嵌编辑协议，不能与 HTTP health 的业务 `protocol: 2` 混同。

宿主可执行 `node <serverEntry> --port <回环端口> --data-root <宿主管理的数据目录>`。服务仅监听 127.0.0.1。GET `/api/health` 返回 product、version、embed、原有 protocol/capabilities。宿主必须核验这些字段，不应把任意返回 HTTP 200 的进程当作本产品；也不能关闭不属于自己的已有服务。

本地 npm 包：先 `npm test`、`npm run build`，再 `npm run pack:local -- <输出目录>`。该专用打包入口使用预构建网页和 Node 标准库服务，生成无 runtime dependencies 的 tgz；不包含前端源码、测试、用户数据或 node_modules。直接在源码根执行 npm pack 不属于正式安装包流程。

在独立安装目录执行 `npm install --ignore-scripts --no-audit --no-fund <tgz绝对路径>`，再使用 `node_modules/@nefer5/agent-canvas/scripts/agent-canvas.mjs integration-info`。本地打包不是公开 npm 发布。浏览器已有画板数据仍由原项目与原服务管理，接入不会迁移或领取它们。
