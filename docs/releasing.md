# 发布与维护

## 版本和产物

`package.json` 是版本事实源，`package-lock.json` 的根版本同步更新。
CLI 和安装器读取同一版本。稳定 AppId 不随版本变化。当前先支持 Windows x64。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-inno.ps1
npm run check:publish
npm run release
```

生成 `release/AgentCanvas-<版本>-win-x64-setup.exe`、ZIP 和 `SHA256SUMS.txt`。
Inno Setup 6.7.3 以便携模式下载到忽略的 `.tools/`，执行前检查 Authenticode 发布者。
可用 `ISCC_PATH` 指定已有编译器。发行目录不可覆盖；重做失败的本地候选包时先安全归档。
不附带 Node；运行时 20+，CI/构建使用 Node 24。发布编译所需版本可能高于运行时。

## 安装生命周期

按用户安装到 `%LOCALAPPDATA%/Programs/AgentCanvas`；固定安装目录与 AppId。
新版本覆盖升级，同版本修复，拒绝降级。预检先确认 Node 和版本，再停止本安装目录所属
Node 服务。不得终止开发目录或其他应用的 Node。升级后用户重新打开画板。

安装器维护独立 CLI PATH 项，卸载只移除自己添加的项。可选 skills；使用内容哈希和
安装根路径判断所有权，保留用户更改。Windows 系统卸载入口负责程序文件清理。
画板、注册表数据目录和浏览器缓存不属于安装器文件，不随升级/卸载删除。
旧 0.0.1 PowerShell 试用安装建议先用其原卸载脚本卸载（保留数据），再装新安装器。
本项目开发机沿用 npm link；不要同时让多个安装位置争抢 agent-canvas 命令。

## 验收

1. npm test、类型检查和构建通过；运行真实浏览器验证平滑默认、三角形插入与重载。
2. 新用户路径安装、CLI、HTTP health；无 Node 时应在安装前失败。
3. 同版修复、从较低版本升级、拒绝降级；运行服务时升级仅停止所属服务。
4. 带标记画板数据安装/升级/卸载，确认数据不变；自定义技能不被覆盖。
5. 检查 ZIP 内容、EXE 和 ZIP SHA256、第三方声明；未签名状态明确告知。

## GitHub 范围

仓库提交源码、tests、docs、skills、packaging、锁文件、许可证和 CI。
排除 node_modules、dist、release、.tools、artifacts、.agent-canvas、旧评审材料、日志、凭据。
本机的 `.git/info/exclude` 不会传播，公共排除规则必须在 `.gitignore`。
`npm run check:publish` 检查当前文件范围和常见凭据特征，不替代首次公开前的历史审查。

CI 在 Windows 上测试、构建并生成可下载产物；推送与版本匹配的 vX.Y.Z 标签才生成
**草稿** Release，由维护者验收后公开。创建仓库和第一次公开推送需明确仓库与可见性。
Windows CI 会将 TEMP/TMP 规范为完整路径，避免运行器的 RUNNER~1 短路径与文件系统实际路径不一致。不会放宽产品对目录重定向的校验。
若仅发布流水线出错，修复 main 上的流程后可在 Actions → Validate and package → Run workflow 中填写已有 `release_tag`（如 `v0.2.2`），重新验证该标签源码并生成草稿，无需移动标签。留空只验证所选分支。已有同名 Release 时先核对，流程不会覆盖它。
当前目录含旧本地历史；先检查历史中的评审记录、个人路径和敏感数据，决定保留历史
还是创建干净公开仓库。不要为了公开而覆盖本地原历史。

参考：https://jrsoftware.org/ishelp/ 、https://docs.github.com/en/repositories/releasing-projects-on-github

## 干净公开源码快照

本地提交完成后执行 `npm run export:source`，生成 source.zip 并追加 SHA256。
使用 Git archive 导出已提交文件；按 .gitattributes 排除历史设计和本地验收报告，不带 .git。
该快照可作为首次公开仓库的初始提交，原开发历史继续保留在本机。
