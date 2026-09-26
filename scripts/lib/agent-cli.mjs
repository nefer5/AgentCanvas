import { execFile as execFileCallback } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { normalizeProjectId } from './project-validator.mjs'
import { isBoardCommand, runBoardCli } from './board-cli.mjs'
import { request as httpRequest } from 'node:http'

const API_BASE = 'http://127.0.0.1:4173'
const HEALTH_TIMEOUT_MS = 750
const START_SCRIPT = fileURLToPath(new URL('../start-excalidraw.ps1', import.meta.url))
const execFileAsync = promisify(execFileCallback)

export const CLI_VERSION = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version

const TOP_LEVEL_HELP = `Agent Canvas CLI ${CLI_VERSION}

连接本地 Excalidraw 画布与 Agent，并处理画板提交。

用法:
  agent-canvas <command> [options]
  agent-canvas --help
  agent-canvas --version

命令:
  open       可见地打开并绑定当前聊天的独立画板（推荐）
  doctor     检查服务和协议，不领取任务
  status     查看绑定画板的真实状态
  receive    默认等待120秒领取绑定画板提交，有提交立即返回
  renew      为正在处理的画板提交续租
  release    释放当前领取
  wait       等待当前项目的下一次画板提交
  inbox      领取当前项目待处理箱中最早的提交
  complete   将一条已处理提交标记为完成
  projects   列出已注册项目

全局选项:
  -h, --help       显示帮助
  -V, --version    显示版本

项目发现:
  未指定 --project 时，从当前目录向父目录查找 .agent-canvas/project.json。

输出:
  业务命令成功时向 stdout 输出一行 JSON；诊断信息写入 stderr。
  帮助和版本查询不要求本地服务正在运行。

示例:
  agent-canvas open --project E:\\work --conversation "opencode:<聊天ID>"
  打开成功后先提醒用户画完点击提交，再执行:
  agent-canvas receive --project E:\\work --board <board-id> --timeout 120
  agent-canvas status --project E:\\work --board <board-id>

旧项目画布示例（不用于新绑定画板）:
  agent-canvas wait --project E:\\work --label "Codex 当前任务"
  agent-canvas inbox --project E:\\work
  agent-canvas complete <submission-id> --project E:\\work
  agent-canvas projects

使用 agent-canvas <command> --help 查看命令详情。`

const COMMAND_HELP = {
  wait: `Agent Canvas CLI ${CLI_VERSION} - wait

等待当前项目的下一次画板提交。

用法:
  agent-canvas wait [--project <dir>] [--label <text>] [--timeout <seconds>]

选项:
  --project <dir>       项目目录；省略时从当前目录向上查找
  --label <text>        Agent 显示名称，默认 Codex
  --timeout <seconds>   等待秒数，范围 10 到 3600，默认 600
  -h, --help            显示本帮助

结果:
  输出 submitted、dismissed 或 timeout 决策的一行 JSON。

示例:
  agent-canvas wait --project E:\\work --label "Codex 当前任务" --timeout 600`,
  inbox: `Agent Canvas CLI ${CLI_VERSION} - inbox

领取当前项目待处理箱中最早的提交。

用法:
  agent-canvas inbox [--project <dir>]

选项:
  --project <dir>   项目目录；省略时从当前目录向上查找
  -h, --help        显示本帮助

结果:
  输出 submitted 或 empty 决策的一行 JSON。

示例:
  agent-canvas inbox --project E:\\work`,
  complete: `Agent Canvas CLI ${CLI_VERSION} - complete

将一条已处理提交标记为完成并移入 processed 目录。

用法:
  agent-canvas complete <submission-id> [--project <dir>]

参数:
  <submission-id>   wait 或 inbox 返回的提交 ID

选项:
  --project <dir>   项目目录；省略时从当前目录向上查找
  -h, --help        显示本帮助

结果:
  输出 completed 决策和提交 ID 的一行 JSON。

示例:
  agent-canvas complete 20260712T120000000Z-client-a1b2c3 --project E:\\work`,
  projects: `Agent Canvas CLI ${CLI_VERSION} - projects

列出本机已注册的 Agent Canvas 项目。

用法:
  agent-canvas projects

选项:
  -h, --help   显示本帮助

结果:
  输出 listed 决策和项目数组的一行 JSON。

示例:
  agent-canvas projects`,
}

export function formatCliHelp(topic) {
  return topic === undefined ? TOP_LEVEL_HELP : COMMAND_HELP[topic]
}

function argumentError(message) {
  return new Error(message)
}

function parseOptions(tokens, allowedOptions) {
  const options = {}
  const positionals = []
  const seen = new Set()

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    if (!allowedOptions.has(token)) throw argumentError(`Unknown option: ${token}`)
    if (seen.has(token)) throw argumentError(`Duplicate option: ${token}`)
    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw argumentError(`Missing value for ${token}`)
    }
    seen.add(token)
    options[token] = value
    index += 1
  }

  return { options, positionals }
}

export function parseCliArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw argumentError('Missing command: expected wait, inbox, complete, or projects')
  }

  if (['--help', '-h', 'help'].includes(args[0]) && args.length === 1) {
    return { command: 'help' }
  }
  if (['--version', '-V'].includes(args[0]) && args.length === 1) {
    return { command: 'version' }
  }

  const [command, ...tokens] = args
  if (['wait', 'inbox', 'complete', 'projects'].includes(command)
    && tokens.length === 1
    && ['--help', '-h'].includes(tokens[0])) {
    return { command: 'help', topic: command }
  }

  if (command === 'projects') {
    if (tokens.length !== 0) throw argumentError('projects does not accept arguments')
    return { command }
  }

  if (command === 'wait') {
    const { options, positionals } = parseOptions(
      tokens,
      new Set(['--project', '--label', '--timeout']),
    )
    if (positionals.length !== 0) throw argumentError(`Unexpected argument: ${positionals[0]}`)
    const timeoutSeconds = options['--timeout'] === undefined
      ? 600
      : Number(options['--timeout'])
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) {
      throw argumentError('--timeout must be an integer from 10 to 3600 seconds')
    }
    return {
      command,
      project: options['--project'],
      label: options['--label'] ?? 'Codex',
      timeoutSeconds,
    }
  }

  if (command === 'inbox') {
    const { options, positionals } = parseOptions(tokens, new Set(['--project']))
    if (positionals.length !== 0) throw argumentError(`Unexpected argument: ${positionals[0]}`)
    return { command, project: options['--project'] }
  }

  if (command === 'complete') {
    const { options, positionals } = parseOptions(tokens, new Set(['--project']))
    if (positionals.length === 0) throw argumentError('complete requires a submission ID')
    if (positionals.length > 1) throw argumentError(`Unexpected argument: ${positionals[1]}`)
    if (positionals[0] === '') throw argumentError('complete requires a submission ID')
    return {
      command,
      project: options['--project'],
      submissionId: positionals[0],
    }
  }

  throw argumentError(`Unknown command: ${command}`)
}

export async function findProject(startPath, { ancestors = false } = {}) {
  const resolvedStart = resolve(startPath)
  let startInfo
  try {
    startInfo = await stat(resolvedStart)
  } catch (error) {
    throw new Error(`Project path is unavailable: ${resolvedStart}`, { cause: error })
  }
  if (!startInfo.isDirectory()) throw new Error(`Project path is not a directory: ${resolvedStart}`)

  let directory = resolvedStart
  while (true) {
    const projectPath = join(directory, '.agent-canvas', 'project.json')
    let contents
    try {
      contents = await readFile(projectPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`Cannot read Agent Canvas project file: ${projectPath}`, { cause: error })
      }
    }

    if (contents !== undefined) {
      let document
      try {
        document = JSON.parse(contents)
      } catch (error) {
        throw new Error(`Agent Canvas project file contains invalid JSON: ${projectPath}`, {
          cause: error,
        })
      }
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new Error(`Agent Canvas project file is invalid: ${projectPath}`)
      }
      let projectId
      try {
        projectId = normalizeProjectId(document.projectId)
      } catch (error) {
        throw new Error(`Agent Canvas project file is invalid: ${projectPath}`, { cause: error })
      }
      return { ...document, projectId, rootPath: directory, projectPath }
    }

    const parent = dirname(directory)
    if (!ancestors) break
    if (parent === directory) break
    directory = parent
  }

  throw new Error(`No Agent Canvas project found from: ${resolvedStart}`)
}

async function responseJson(response, operation) {
  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error })
  }
  if (!response.ok) {
    const message = body?.error?.message ?? `${operation} failed with HTTP ${response.status}`
    throw new Error(message)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${operation} returned an invalid response`)
  }
  return body
}

async function fetchJson(fetch, url, operation, options = {}) {
  const response = await fetch(url, options)
  return responseJson(response, operation)
}

function jsonPost(body) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function validDecision(body, allowed, operation) {
  if (!allowed.has(body.decision)) throw new Error(`${operation} returned an invalid decision`)
  if (body.decision === 'submitted'
    && (typeof body.submissionId !== 'string' || body.submissionId.trim() === '')) {
    throw new Error(`${operation} returned a submitted decision without a submission ID`)
  }
  return body
}

async function runWait(command, project, fetch) {
  const session = await fetchJson(
    fetch,
    `${API_BASE}/api/agent-sessions`,
    'Agent session registration',
    jsonPost({
      projectId: project.projectId,
      label: command.label,
      timeoutMs: command.timeoutSeconds * 1000,
    }),
  )
  if (typeof session.id !== 'string' || typeof session.token !== 'string') {
    throw new Error('Agent session registration returned an invalid response')
  }
  const decision = await fetchJson(
    fetch,
    `${API_BASE}/api/agent-sessions/${encodeURIComponent(session.id)}/wait`,
    'Agent session wait',
    { headers: { Authorization: `Bearer ${session.token}` } },
  )
  return validDecision(
    decision,
    new Set(['submitted', 'dismissed', 'timeout']),
    'Agent session wait',
  )
}

async function relocateProject(project, fetch) {
  const result = await fetchJson(
    fetch,
    `${API_BASE}/api/projects/relocate`,
    'Project relocation handshake',
    jsonPost({
      projectId: project.projectId,
      rootPath: project.rootPath,
    }),
  )
  if (!result.project
    || typeof result.project !== 'object'
    || result.project.id !== project.projectId
    || typeof result.project.rootPath !== 'string') {
    throw new Error('Project relocation handshake returned an invalid response')
  }
  return { ...project, rootPath: result.project.rootPath }
}

async function runInbox(project, fetch) {
  const decision = await fetchJson(
    fetch,
    `${API_BASE}/api/projects/${encodeURIComponent(project.projectId)}/inbox/claim`,
    'Inbox claim',
    jsonPost({ receiverId: 'agent-canvas-cli' }),
  )
  return validDecision(decision, new Set(['submitted', 'empty']), 'Inbox claim')
}

async function runComplete(command, project, fetch) {
  await fetchJson(
    fetch,
    `${API_BASE}/api/submissions/${encodeURIComponent(command.submissionId)}/complete`,
    'Submission completion',
    jsonPost({ projectId: project.projectId }),
  )
  return { decision: 'completed', submissionId: command.submissionId }
}

async function runProjects(fetch) {
  const result = await fetchJson(fetch, `${API_BASE}/api/projects`, 'Project listing')
  if (!Array.isArray(result.projects)) throw new Error('Project listing returned an invalid response')
  return { decision: 'listed', projects: result.projects }
}

function diagnosticMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return `agent-canvas: ${message}`
}

export async function runAgentCli(args, dependencies) {
  if (isBoardCommand(args)) return runBoardCli(args, dependencies)
  const { cwd, ensureServer, fetch, stderr, stdout } = dependencies
  let command
  try {
    command = parseCliArgs(args)
  } catch (error) {
    stderr(diagnosticMessage(error))
    return 1
  }

  if (command.command === 'help') {
    stdout(formatCliHelp(command.topic))
    return 0
  }
  if (command.command === 'version') {
    stdout(CLI_VERSION)
    return 0
  }

  try {
    await ensureServer()
    let decision
    if (command.command === 'projects') {
      decision = await runProjects(fetch)
    } else {
      const discoveredProject = await findProject(command.project ?? cwd, { ancestors: command.project === undefined })
      const project = await relocateProject(discoveredProject, fetch)
      if (command.command === 'wait') decision = await runWait(command, project, fetch)
      if (command.command === 'inbox') decision = await runInbox(project, fetch)
      if (command.command === 'complete') decision = await runComplete(command, project, fetch)
    }
    stdout(JSON.stringify(decision))
    return 0
  } catch (error) {
    stderr(diagnosticMessage(error))
    return 1
  }
}

async function healthAvailable(fetch) {
  try {
    const response = await fetch(`${API_BASE}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const body = await response.json()
    return body?.ok === true
  } catch {
    return false
  }
}

export function legacyWaitFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
      const request = httpRequest(url, { method: 'GET', headers: init.headers }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })))
      })
      request.setTimeout(3_610_000, () => request.destroy(new Error('Legacy wait transport timed out')))
      request.on('error', reject); request.end()
    })
}

export function createDefaultDependencies(options = {}) {
  // Legacy wait has a 10-minute business deadline. Native fetch's 5-minute
  // response-header timeout is unsuitable for that single long response.
  const fetch = options.fetch ?? ((url, init = {}) => {
    if (!/^http:\/\/127\.0\.0\.1:4173\/api\/agent-sessions\/[^/]+\/wait$/.test(String(url))) return globalThis.fetch(url, init)
    return legacyWaitFetch(url, init)
  })
  const execFile = options.execFile ?? execFileAsync
  return {
    fetch,
    cwd: options.cwd ?? process.cwd(),
    stdout: options.stdout ?? console.log,
    stderr: options.stderr ?? console.error,
    ensureServer: async () => {
      if (await healthAvailable(fetch)) return
      await execFile(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          START_SCRIPT,
          '-NoBrowser',
        ],
        { windowsHide: true },
      )
      if (!await healthAvailable(fetch)) {
        throw new Error('Excalidraw Local launcher completed without a healthy Agent Canvas API')
      }
    },
  }
}
