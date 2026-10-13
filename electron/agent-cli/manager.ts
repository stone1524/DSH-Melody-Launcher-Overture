// Agent CLI 工具管理器：安装 / 卸载 / 厂商配置 / 连通性测试的编排层。
//
// 与 DSH 整合包体系刻意平行：这些 CLI 不进 DSH 家目录，而是装进启动器私有的
// npm 前缀目录（userData/agent-cli/prefix），不污染用户系统全局 npm。
// 运行时依赖全部注入（node 解析器、命令执行器、fetch），测试用替身。

import { mkdirSync } from 'node:fs'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type {
  AgentCliConfigureRequest,
  AgentCliEntry,
  AgentCliId,
  AgentCliInstallRecord,
  AgentCliListResult,
  AgentCliProviderTestInput,
  AgentCliProviderTestResult,
} from '../../src/types'
import { AGENT_CLI_DEFINITIONS, AGENT_CLI_PROVIDERS, HERMES_PROVIDER_ENV, getAgentCliDefinition, getAgentCliProvider } from './catalog'
import { findAgentCliRecord, readAgentCliRegistry, removeAgentCliRecord, upsertAgentCliRecord } from './registry'

/** 安装日志保留的尾部行数（随结果返回，完整日志走 output 事件流）。 */
const LOG_TAIL_LINES = 40
/** npm 安装硬顶：镜像正常时 1–2 分钟，留足慢网余量。 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
/** 版本验证/卸载超时。 */
const VERIFY_TIMEOUT_MS = 30_000
/** Hermes 社区安装脚本硬顶：下载 + Python 环境装配，比 npm 慢得多。 */
const HERMES_INSTALL_TIMEOUT_MS = 20 * 60 * 1000

export interface CommandRunnerInput {
  executable: string
  args: string[]
  env: Record<string, string | undefined>
  timeoutMs?: number
}

export interface CommandRunnerResult {
  exitCode: number
  /** 合并后的输出尾部（与 command.ts 的 CommandResult 同形）。 */
  output: string
}

export type CommandRunner = (input: CommandRunnerInput) => Promise<CommandRunnerResult>

export interface AgentCliManagerOptions {
  /** userData/agents.json。 */
  registryPath: string
  /** 启动器私有 npm 前缀根（userData/agent-cli）。 */
  prefixRoot: string
  /** 解析便携 Node 运行时（复用主进程的下载/镜像/校验链）；失败抛错。 */
  resolveNode: () => Promise<{ node: string; npm: string }>
  /** 用户 npm 镜像偏好读取器；空则用 npmmirror（候选链回退交给 npm 自身重试）。 */
  readNpmRegistry?: () => Promise<string | null>
  /** 命令执行器；缺省用 command.ts 的 runCommand。 */
  runCommand?: CommandRunner
  /** 进度与日志外送（进启动器日志）。 */
  onOutput?: (level: 'info' | 'error' | 'success', text: string) => void
  /** 连通性测试的 fetch 实现；缺省全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 覆盖用户主目录（测试注入）。 */
  homeDir?: string
  /**
   * 内置离线包目录候选（按优先级）：便携 exe 同级的 offline-packs/ → 资源目录 → 开发态项目根。
   * Codex 离线包以 zip 形式随 exe 一起分发（不烤进 exe，控制体积）。
   */
  offlinePacksDirs?: string[]
  /** 官方安装器直启的注入点（测试替身）；缺省 spawnCommand 拉起后不等待。 */
  runRawInstaller?: (installerPath: string) => void
  now?: () => Date
}

export interface AgentCliManager {
  list(): Promise<AgentCliListResult>
  install(id: AgentCliId): Promise<{ entry: AgentCliEntry; logTail: string[] }>
  uninstall(id: AgentCliId): Promise<AgentCliListResult>
  configure(request: AgentCliConfigureRequest): Promise<AgentCliListResult>
  testProvider(request: AgentCliProviderTestInput): Promise<AgentCliProviderTestResult>
}

export class AgentCliError extends Error {}

function nowIso(options: AgentCliManagerOptions): string {
  return (options.now ?? (() => new Date()))().toISOString()
}

/** 回读包内 bin 入口的 JS 文件路径（Windows shim 是 .cmd，验证时直接跑 JS 更稳）。 */
async function resolveBinJs(prefix: string, npmPackage: string): Promise<string> {
  const packageJsonPath = path.join(prefix, 'node_modules', ...npmPackage.split('/'), 'package.json')
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { bin?: Record<string, string> | string }
  const binField = manifest.bin
  let relative: string | null = null
  if (typeof binField === 'string') relative = binField
  else if (typeof binField === 'object' && binField !== null) relative = Object.values(binField)[0] ?? null
  if (!relative) throw new AgentCliError(`包 ${npmPackage} 没有可执行入口（bin），无法验证安装。`)
  const binJs = path.join(prefix, 'node_modules', ...npmPackage.split('/'), relative)
  await stat(binJs)
  return binJs
}

/** 各 CLI 的厂商配置落盘实现。Key 只写目标文件，不进注册表、不进日志。 */
async function writeProviderConfig(options: AgentCliManagerOptions, request: AgentCliConfigureRequest, resolved: { baseUrl: string; model: string }): Promise<void> {
  const definition = getAgentCliDefinition(request.id)
  if (!definition) throw new AgentCliError('未知的 Agent CLI。')
  const home = path.resolve(options.homeDir ?? os.homedir())
  /** 配置目录安全边界：必须仍落在用户主目录内（安全约定，与测试口径一致）。 */
  const dirInHome = (...segments: string[]): string => {
    const target = path.resolve(home, ...segments)
    if (target !== home && !target.startsWith(home + path.sep)) throw new AgentCliError('配置路径越出用户主目录，已中止。')
    return target
  }
  /** 同上，直接产出「已过边界校验的完整文件路径」。 */
  const fileInHome = (...segments: string[]): string => dirInHome(...segments)
  if (definition.configKind === 'qwen-env') {
    // Qwen Code（Gemini CLI 系）读取 ~/.qwen/.env 的 OPENAI_* 变量接入 OpenAI 兼容端点。
    const dir = dirInHome('.qwen')
    await mkdir(dir, { recursive: true })
    const content = [
      `OPENAI_BASE_URL=${resolved.baseUrl}`,
      `OPENAI_API_KEY=${request.apiKey}`,
      `OPENAI_MODEL=${resolved.model}`,
      '',
    ].join('\n')
    await writeFile(path.join(dir, '.env'), content, { encoding: 'utf8', mode: 0o600 })
    return
  }
  if (definition.configKind === 'opencode-json') {
    // OpenCode：opencode.json 里注册 openai-compatible provider 并设默认模型。
    const dir = dirInHome('.config', 'opencode')
    await mkdir(dir, { recursive: true })
    const providerId = `launcher-${request.providerId}`
    const config = {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [providerId]: {
          npm: '@ai-sdk/openai-compatible',
          name: getAgentCliProvider(request.providerId)?.label ?? request.providerId,
          options: {
            baseURL: resolved.baseUrl,
            apiKey: request.apiKey,
          },
        },
      },
      model: `${providerId}/${resolved.model}`,
    }
    await writeFile(path.join(dir, 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return
  }
  if (definition.configKind === 'codex-config') {
    // Codex CLI：config.toml 声明自定义 provider（OpenAI 兼容端点），auth.json 存
    // API-Key 认证（与 codex login --api-key 的落盘格式一致），再持久化一次
    // OPENAI_API_KEY 用户环境变量，覆盖「终端里直接跑 codex」的读取路径。
    const tomlPath = fileInHome('.codex', 'config.toml')
    const authPath = fileInHome('.codex', 'auth.json')
    await mkdir(path.dirname(tomlPath), { recursive: true })
    const configToml = [
      `model = "${resolved.model}"`,
      'model_provider = "launcher"',
      '',
      '[model_providers.launcher]',
      `name = "${getAgentCliProvider(request.providerId)?.label ?? request.providerId}"`,
      `base_url = "${resolved.baseUrl}"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "chat"',
      '',
    ].join('\n')
    const authContent = JSON.stringify({ OPENAI_API_KEY: request.apiKey }, null, 2)
    await writeFile(tomlPath, configToml, { encoding: 'utf8', mode: 0o600 })
    await writeFile(authPath, authContent, { encoding: 'utf8', mode: 0o600 })
    await setUserEnvVar(options, 'OPENAI_API_KEY', request.apiKey)
    return
  }
  if (definition.configKind === 'hermes-env') {
    // Hermes：各服务商读自己的环境变量（Quickstart 文档口径），持久化进用户环境。
    const envName = HERMES_PROVIDER_ENV[request.providerId]
    if (!envName) throw new AgentCliError('该服务商暂无 Hermes 环境变量映射。')
    await setUserEnvVar(options, envName, request.apiKey)
    return
  }
  throw new AgentCliError('该工具暂不支持启动器内配置，请按官方指引完成配置。')
}

/** 把一个用户级环境变量持久化（写入注册表 User 环境，等价 setx）。供 Codex / Hermes 配置使用。 */
async function setUserEnvVar(options: AgentCliManagerOptions, name: string, value: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new AgentCliError('环境变量名非法。')
  // 值经 base64 传入 powershell 解码，避免引号/特殊字符在命令行上被吃掉或注入。
  const encoded = Buffer.from(value, 'utf8').toString('base64')
  const script = `$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));[Environment]::SetEnvironmentVariable('${name}',$v,'User')`
  const fail = () => new AgentCliError('写入用户环境变量失败。')
  if (options.runCommand) {
    const result = await options.runCommand({ executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], env: { ...process.env }, timeoutMs: 30_000 })
    if (result.exitCode !== 0) throw fail()
    return
  }
  const { runCommand } = await import('../command')
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: options.prefixRoot,
    env: { ...process.env },
    timeoutMs: 30_000,
  })
  if (result.exitCode !== 0) throw fail()
}

export function createAgentCliManager(options: AgentCliManagerOptions): AgentCliManager {
  // runCommand 需要 cwd：前缀根在管理器创建时就建好，后续 npm 都以它为工作目录。
  mkdirSync(options.prefixRoot, { recursive: true })
  const fallbackRunner: CommandRunner = async input => {
    // 惰性 import，避免测试替身场景强制加载子进程链。
    const { runCommand } = await import('../command')
    const result = await runCommand(input.executable, input.args, {
      cwd: options.prefixRoot,
      env: input.env,
      timeoutMs: input.timeoutMs,
      onOutput: (text, level) => options.onOutput?.(level, text.replace(/\n$/, '')),
    })
    return { exitCode: result.exitCode, output: result.output }
  }
  const runner: CommandRunner = options.runCommand ?? fallbackRunner

  function prefixDir(): string {
    return path.join(options.prefixRoot, 'prefix')
  }

  function childEnv(extra: Record<string, string>): Record<string, string | undefined> {
    return { ...process.env, ...extra, npm_config_yes: 'true', npm_config_fund: 'false', npm_config_audit: 'false', CI: 'true' }
  }

  async function entryFor(id: AgentCliId): Promise<AgentCliEntry> {
    const definition = getAgentCliDefinition(id)
    if (!definition) throw new AgentCliError('未知的 Agent CLI。')
    const installs = await readAgentCliRegistry(options.registryPath)
    return { definition, record: findAgentCliRecord(installs, id) }
  }

  async function listResult(): Promise<AgentCliListResult> {
    const installs = await readAgentCliRegistry(options.registryPath)
    return {
      entries: AGENT_CLI_DEFINITIONS.map(definition => ({
        definition,
        record: installs.find(item => item.id === definition.id) ?? null,
      })),
      providers: [...AGENT_CLI_PROVIDERS],
    }
  }

  /** 从命令输出里提取语义化版本号。 */
  function parseVersionLine(output: string): string | null {
    const versionLine = output.trim().split(/\r?\n/).find(line => /\d+\.\d+\.\d+/.test(line)) ?? ''
    return versionLine.match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? null
  }

  /** npm 通道安装（默认）：便携 Node + 启动器私有前缀 + 镜像源。 */
  async function installViaNpm(definition: { name: string; npmPackage: string; versionArgs: string[] }): Promise<{ version: string | null; logLines: string[] }> {
    const logLines: string[] = []
    const log = (text: string) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) logLines.push(line)
    }
    const runtime = await options.resolveNode()
    const prefix = prefixDir()
    await mkdir(prefix, { recursive: true })
    const registry = (options.readNpmRegistry ? await options.readNpmRegistry().catch(() => null) : null)?.trim() || 'https://registry.npmmirror.com'
    const env = childEnv({ npm_config_prefix: prefix, npm_config_registry: registry })
    options.onOutput?.('info', `npm 源：${registry}`)

    // runtime.npm 在 Windows 上是 npm.cmd：spawnCommand 会自动经 cmd.exe 包装。
    const installResult = await runner({
      executable: runtime.npm,
      args: ['install', '-g', definition.npmPackage],
      env,
      timeoutMs: INSTALL_TIMEOUT_MS,
    })
    log(installResult.output)
    if (installResult.exitCode !== 0) {
      options.onOutput?.('error', `${definition.name} 安装失败（退出码 ${installResult.exitCode}）。`)
      throw new AgentCliError('npm 安装失败。常见原因：网络中断、镜像不可用。可重试，或在设置里更换 npm 镜像后重试。')
    }

    // 回读实际安装版本并验证可执行。
    const binJs = await resolveBinJs(prefix, definition.npmPackage)
    const verify = await runner({
      executable: runtime.node,
      args: [binJs, ...definition.versionArgs],
      env,
      timeoutMs: VERIFY_TIMEOUT_MS,
    })
    log(verify.output)
    const version = parseVersionLine(verify.output)
    if (verify.exitCode !== 0) {
      options.onOutput?.('error', `${definition.name} 装上了但启动验证失败。`)
      throw new AgentCliError(`安装完成但执行验证失败（退出码 ${verify.exitCode}）。日志已保留，可复制给服务方诊断。`)
    }
    return { version, logLines }
  }

  /** Hermes 通道：中文社区官方 PowerShell 安装脚本（Quickstart 文档的 Windows 原生路径）。 */
  async function installViaHermesInstaller(definition: { name: string }): Promise<{ version: string | null; logLines: string[] }> {
    const logLines: string[] = []
    const log = (text: string) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) logLines.push(line)
    }
    // 官方 Quickstart 的 Windows 原生安装路径：中文社区镜像的 PowerShell 一键脚本。
    // 字面量写死、不拼变量：来源固定，脚本内容不经启动器之手。
    const installScript = 'irm https://res1.hermesagent.org.cn/install.ps1 | iex'
    const installResult = await runner({
      executable: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', installScript],
      env: childEnv({}),
      timeoutMs: HERMES_INSTALL_TIMEOUT_MS,
    })
    log(installResult.output)
    if (installResult.exitCode !== 0) {
      options.onOutput?.('error', `${definition.name} 安装脚本失败（退出码 ${installResult.exitCode}）。`)
      throw new AgentCliError('Hermes 安装脚本执行失败。常见原因：网络中断。可重试，或到中文社区文档查看手动安装步骤。')
    }
    // 安装器会改用户 PATH；本进程环境不会自动刷新，验证前从注册表重读 PATH。
    const verifyScript = `$m=[Environment]::GetEnvironmentVariable('Path','Machine');$u=[Environment]::GetEnvironmentVariable('Path','User');$env:Path="$m;$u"; hermes --version`
    const verify = await runner({
      executable: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', verifyScript],
      env: childEnv({}),
      timeoutMs: VERIFY_TIMEOUT_MS,
    })
    log(verify.output)
    const version = parseVersionLine(verify.output)
    if (verify.exitCode !== 0) {
      options.onOutput?.('error', `${definition.name} 安装脚本执行完，但验证 hermes 命令失败（可能需要重开终端）。`)
      throw new AgentCliError('安装脚本执行完成，但验证 hermes 命令失败。请重开启动器后再试；日志已保留。')
    }
    return { version, logLines }
  }

  /** 内置离线包清单：各候选目录下 manifest.json 的 packs 合并（先到先得，后者补缺）。 */
  interface OfflinePackManifest {
    packs: Record<string, { version?: string; builtAt?: string }>
  }

  function offlineDirs(): string[] {
    return options.offlinePacksDirs ?? []
  }

  function readOfflineManifest(): OfflinePackManifest {
    const packs: OfflinePackManifest['packs'] = {}
    for (const dir of offlineDirs()) {
      try {
        const raw = readFileSync(path.join(dir, 'manifest.json'), 'utf8')
        const parsed = JSON.parse(raw) as OfflinePackManifest
        if (parsed && typeof parsed === 'object' && parsed.packs) {
          for (const [id, entry] of Object.entries(parsed.packs)) {
            if (!packs[id]) packs[id] = entry
          }
        }
      } catch {
        // 该候选目录没有 manifest，跳过。
      }
    }
    return { packs }
  }

  /** 在候选目录里找 <id>/<相对名> 的第一个现存文件。 */
  function findOfflineFile(id: string, relativeName: string): string | null {
    for (const dir of offlineDirs()) {
      const candidate = path.join(dir, id, relativeName)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  /** 内置离线包通道：解压构建期打好的前缀快照到私有前缀，零网络安装。 */
  async function installViaOfflineBundle(definition: { id: AgentCliId; name: string; npmPackage: string; versionArgs: string[] }): Promise<{ version: string | null; logLines: string[]; source: 'offline-bundle' } | null> {
    const zipPath = findOfflineFile(definition.id, 'pack.zip')
    if (!zipPath) return null
    const logLines: string[] = []
    options.onOutput?.('info', `${definition.name}：发现内置离线包，直接解压安装（无需联网）…`)
    try {
      const prefix = prefixDir()
      await mkdir(prefix, { recursive: true })
      // zip 内容以 node_modules/ 为根（构建脚本保证）；解压覆盖旧版本文件。
      new AdmZip(zipPath).extractAllTo(prefix, true)
      const binJs = await resolveBinJs(prefix, definition.npmPackage)
      const runtime = await options.resolveNode()
      const verify = await runner({
        executable: runtime.node,
        args: [binJs, ...definition.versionArgs],
        env: childEnv({ npm_config_prefix: prefix }),
        timeoutMs: VERIFY_TIMEOUT_MS,
      })
      logLines.push(verify.output)
      if (verify.exitCode !== 0) {
        throw new AgentCliError(`离线包解压完成但验证失败（退出码 ${verify.exitCode}）。将回退在线安装。`)
      }
      const manifestVersion = readOfflineManifest().packs[definition.id]?.version ?? null
      return { version: manifestVersion, logLines, source: 'offline-bundle' }
    } catch (error) {
      // 离线包损坏/平台不匹配时回退在线：不能因为内置包坏掉就把用户堵死。
      const message = error instanceof Error ? error.message : String(error)
      options.onOutput?.('error', `${definition.name} 内置离线包安装失败（${message}），改走在线镜像。`)
      return null
    }
  }

  /** 官方安装器直启通道（ZCode 桌面端）：拉起内置的官方安装向导，过程由客户在向导里完成。 */
  async function installViaRawInstaller(definition: { id: AgentCliId; name: string }): Promise<{ version: string | null; logLines: string[] }> {
    const installerPath = findOfflineFile(definition.id, 'ZCode-Setup.exe')
      ?? findOfflineFileEndingWith(definition.id, '.exe')
    if (!installerPath) {
      throw new AgentCliError(`${definition.name} 的离线安装包未内置（offline-packs 目录里没有安装器）。请联网到官方渠道下载。`)
    }
    options.onOutput?.('info', `${definition.name}：正在打开官方安装向导，请在弹出的窗口中完成安装…`)
    const launch = options.runRawInstaller ?? ((exe: string) => {
      void import('../process').then(({ spawnCommand }) => spawnCommand(exe, [], { cwd: path.dirname(exe), env: { ...process.env } }))
    })
    launch(installerPath)
    const manifestVersion = readOfflineManifest().packs[definition.id]?.version ?? null
    const logLines = [`已启动官方安装器：${path.basename(installerPath)}`]
    return { version: manifestVersion, logLines }
  }

  /** 在候选目录里找 <id>/ 下扩展名匹配的第一个文件（raw 安装器文件名带版本号，无法写死）。 */
  function findOfflineFileEndingWith(id: string, suffix: string): string | null {
    for (const dir of offlineDirs()) {
      const subDir = path.join(dir, id)
      try {
        // readdir 同步语义用 existsSync 无法替代，此处阻塞可接受（目录极小）。
        const entries = readdirSync(subDir)
        const hit = entries.find(name => name.toLowerCase().endsWith(suffix))
        if (hit) return path.join(subDir, hit)
      } catch {
        // 子目录不存在，试下一个候选。
      }
    }
    return null
  }

  return {
    async list() {
      return listResult()
    },

    async install(id) {
      const definition = getAgentCliDefinition(id)
      if (!definition) throw new AgentCliError('未知的 Agent CLI。')
      options.onOutput?.('info', `开始安装 ${definition.name}…`)

      // 通道选择：内置安装器直启 → 内置离线包解压（失败自动回退）→ 在线镜像。
      let version: string | null = null
      let logLines: string[] = []
      let source: 'npm' | 'offline-bundle' | 'raw-installer' = 'npm'
      if (definition.installKind === 'raw-installer') {
        const outcome = await installViaRawInstaller(definition)
        version = outcome.version
        logLines = outcome.logLines
        source = 'raw-installer'
      } else if (definition.installKind !== 'hermes-installer') {
        const bundled = await installViaOfflineBundle(definition)
        if (bundled) {
          version = bundled.version
          logLines = bundled.logLines
          source = 'offline-bundle'
        } else {
          const outcome = await installViaNpm(definition)
          version = outcome.version
          logLines = outcome.logLines
          source = 'npm'
        }
      } else {
        const outcome = await installViaHermesInstaller(definition)
        version = outcome.version
        logLines = outcome.logLines
        source = 'npm'
      }

      const now = nowIso(options)
      const existing = (await entryFor(id)).record
      const record: AgentCliInstallRecord = {
        id,
        version,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        source,
        ...(existing?.configuredProvider ? { configuredProvider: existing.configuredProvider, configuredAt: existing.configuredAt } : {}),
      }
      await upsertAgentCliRecord(options.registryPath, record)
      options.onOutput?.('success', source === 'raw-installer'
        ? `${definition.name} 官方安装向导已启动，请在向导中完成安装。`
        : `${definition.name} ${version ? `v${version} ` : ''}安装完成。`)
      return { entry: await entryFor(id), logTail: logLines.slice(-LOG_TAIL_LINES) }
    },

    async uninstall(id) {
      const definition = getAgentCliDefinition(id)
      if (!definition) throw new AgentCliError('未知的 Agent CLI。')
      if (definition.installKind === 'hermes-installer') {
        // Hermes 不在 npm 前缀里：走它自己的清理命令，失败不阻塞记录清除。
        const uninstallScript = '$m=[Environment]::GetEnvironmentVariable(\'Path\',\'Machine\');$u=[Environment]::GetEnvironmentVariable(\'Path\',\'User\');$env:Path="$m;$u"; pip uninstall -y hermes-agent'
        const outcome = await runner({
          executable: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', uninstallScript],
          env: childEnv({}),
          timeoutMs: VERIFY_TIMEOUT_MS * 2,
        }).catch(error => {
          options.onOutput?.('error', `Hermes 卸载命令失败：${error instanceof Error ? error.message : String(error)}（注册表记录仍会清除）`)
          return { exitCode: -1, output: '' }
        })
        if (outcome.exitCode !== 0) {
          options.onOutput?.('info', 'Hermes 自动卸载未成功（可能本来就没装完）；注册表记录已清除。')
        }
        await removeAgentCliRecord(options.registryPath, id)
        options.onOutput?.('success', `${definition.name} 已卸载。`)
        return listResult()
      }
      if (definition.installKind === 'raw-installer') {
        // 桌面端安装器有自己的卸载入口（系统设置/开始菜单），启动器只清自己的记录。
        await removeAgentCliRecord(options.registryPath, id)
        options.onOutput?.('success', `${definition.name} 已从启动器移除；如需彻底卸载，请用系统「应用和功能」里的官方卸载入口。`)
        return listResult()
      }
      const runtime = await options.resolveNode().catch(() => null)
      if (runtime) {
        const env = childEnv({ npm_config_prefix: prefixDir() })
        await runner({
          executable: runtime.npm,
          args: ['uninstall', '-g', definition.npmPackage],
          env,
          timeoutMs: VERIFY_TIMEOUT_MS,
        }).catch(error => {
          options.onOutput?.('error', `npm 卸载命令失败：${error instanceof Error ? error.message : String(error)}（注册表记录仍会清除）`)
          return { exitCode: -1, output: '' }
        })
      }
      // 注册表记录无条件清掉；残留目录尽力删除，删不掉留给下次安装覆盖。
      await removeAgentCliRecord(options.registryPath, id)
      await rm(path.join(prefixDir(), 'node_modules', ...definition.npmPackage.split('/')), { recursive: true, force: true }).catch(() => undefined)
      options.onOutput?.('success', `${definition.name} 已卸载。`)
      return listResult()
    },

    async configure(request) {
      const definition = getAgentCliDefinition(request.id)
      if (!definition) throw new AgentCliError('未知的 Agent CLI。')
      if (!definition.configurable) throw new AgentCliError('该工具暂不支持启动器内配置。')
      if (!request.apiKey.trim()) throw new AgentCliError('请先输入 API Key。')
      const provider = getAgentCliProvider(request.providerId)
      if (!provider) throw new AgentCliError('未知的服务商。')
      const record = (await entryFor(request.id)).record
      if (!record) throw new AgentCliError('请先安装该工具，再配置模型。')
      const resolved = {
        baseUrl: request.baseUrl?.trim() || provider.baseUrl,
        model: request.model?.trim() || provider.model,
      }
      await writeProviderConfig(options, request, resolved)
      const next: AgentCliInstallRecord = {
        ...record,
        configuredProvider: request.providerId,
        configuredAt: nowIso(options),
      }
      await upsertAgentCliRecord(options.registryPath, next)
      options.onOutput?.('success', `${definition.name} 已配置 ${provider.label}。`)
      return listResult()
    },

    async testProvider(request) {
      const provider = getAgentCliProvider(request.providerId)
      if (!provider) throw new AgentCliError('未知的服务商。')
      const baseUrl = request.baseUrl?.trim() || provider.baseUrl
      const model = request.model?.trim() || provider.model
      const startedAt = Date.now()
      try {
        const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${request.apiKey}`,
          },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
          signal: AbortSignal.timeout(20_000),
        })
        const latencyMs = Date.now() - startedAt
        if (response.ok) return { ok: true, latencyMs }
        if (response.status === 401 || response.status === 403) {
          return { ok: false, latencyMs, error: 'API Key 无效或无权限（401/403）。请核对 Key 是否复制完整。' }
        }
        if (response.status === 404) {
          return { ok: false, latencyMs, error: `端点或模型不存在（404）。请确认 baseUrl=${baseUrl} 与模型 ${model} 是否匹配。` }
        }
        if (response.status === 429) {
          return { ok: false, latencyMs, error: '触发限流（429）：Key 有效但额度/频率受限，稍后重试。' }
        }
        const text = await response.text().catch(() => '')
        return { ok: false, latencyMs, error: `服务返回 ${response.status}。${text.slice(0, 160)}` }
      } catch (error) {
        const latencyMs = Date.now() - startedAt
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, latencyMs, error: `连不上服务商（${message}）。请检查网络后重试。` }
      }
    },
  }
}
