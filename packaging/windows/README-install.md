# AgentCanvas for Windows

Requires Windows 10/11 x64, Windows PowerShell 5.1 and an existing Node.js 20+ on PATH.
Node is NOT bundled. A currently supported Node LTS version is recommended.

Recommended: run AgentCanvas-<version>-win-x64-setup.exe. No administrator privileges
are needed. Re-run the same version to repair; run a newer installer to upgrade.
Downgrades are rejected. The installer stops only servers owned by its installation.
Remove the application through Windows Settings > Apps; canvas data is preserved.

Portable: extract the ZIP into a writable directory and double-click Start AgentCanvas.cmd.
Call agent-canvas.cmd from that folder, or install the setup EXE to add the CLI to PATH.
After installation open a NEW terminal and verify: agent-canvas --version.

Skills are optional in Setup. Existing unmanaged skills are preserved; locally modified
managed skills are preserved on upgrade/uninstall. Node and agent subscriptions are
managed by the user. No automatic download or installation of updates occurs.

Data: %LOCALAPPDATA%\ExcalidrawAgentBridge, each project's .agent-canvas directory,
and browser storage at http://127.0.0.1:4173. These are not part of the install payload.
The app listens only on 127.0.0.1. Agent model/network access depends on the agent tool.
