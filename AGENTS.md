# AgentCanvas development

- Keep canvas data local and the HTTP listener loopback-only.
- Node is an external prerequisite; do not bundle it in releases.
- Use package.json as version source. Ship MIT and preserve dependency licenses.
- Keep user canvas files and browser storage out of installers and source uploads.
- Maintain current documentation in docs/; historical design is in docs/archive/.
- Do not treat agent-canvas inbox as a read-only inspection: it claims work.
- Validate release changes with installation/upgrade/data-preservation checks.
- Public GitHub publishing requires a specified destination; CI produces draft releases.
