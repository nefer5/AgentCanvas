# 开发、发布与本机运行布局

源码即开发工作区，不需要再复制一份源码充当“开发版”。本次在现有N05源码的codex/dsh-shared-sidebar分支修改；提交用于回退。需要并行维护稳定版时，再创建Git worktree。

| 类型 | 当前路径/职责 |
|---|---|
| 开发源码 | E:/Proj-2026-N05_AgentCanvas；src、scripts、测试和文档 |
| 本地发布物 | E:/Proj-2026-N05_AgentCanvas-releases/版本目录；预构建tgz、校验及部署回执，不公开发布 |
| 独立验证 | E:/Proj-2026-N05_AgentCanvas-validation/任务目录；合成workspace、专用Home及测试安装 |
| 日常运行包 | 用户LOCALAPPDATA/Programs/AgentCanvas/app；CLI、快捷方式和DSH共用此安装 |
| 用户资料 | 各课题.agent-canvas、LOCALAPPDATA/ExcalidrawAgentBridge及浏览器存储；升级程序不移动这些资料 |

流程：修改源码 → 测试/构建 → pack:local生成预构建包 → 独立安装与DSH/独立双路径验证 → 备份现役程序和DSH连接配置 → 更新同一运行安装 → 回读身份、版本、状态及资料哈希。回退使用部署回执，不把源码node_modules当运行包。

源码、构建包和用户资料分别管理。发布包只含网页构建、CLI/服务、许可证和说明；Node仍由用户准备。临时构建不推送；本轮独立AgentCanvas仓库仅本地提交，不创建公开Release或npm发布。