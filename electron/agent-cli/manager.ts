// Agent CLI 工具管理器：安装 / 卸载 / 厂商配置 / 连通性测试的编排层。
//
// 与 DSH 整合包体系刻意平行：这些 CLI 不进 DSH 家目录，而是装进启动器私有的
// npm 前缀目录（userData/agent-cli/prefix），不污染用户系统全局 npm。
// 运行时依赖全部注入（node 解析器、命令执行器、fetch），测试用替身。

import { mkdirSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentCliConfigureRequest,
  AgentCliEntry,
  AgentCliId,
  AgentCliInstallRecord,
  AgentCliListResult,
  AgentCliProviderTestInput,
  AgentCliProviderTestResult,
} from '../../src/types'
import { AGENT_CLI_DEFINITIONS, AGENT_CLI_PROVIDERS, getAgentCliDefinition, getAgentCliProvider } from './catalog'
import { findAgentCliRecord, readAgentCliRegistry, removeAgentCliRecord, upsertAgentCliRecord } from './registry'

/** 安装日志保留的尾部行数（随结果返回，完整日志走 output 事件流）。 */
const LOG_TAIL_LINES = 40
/** npm 安装硬顶：镜像正常时 1–2 分钟，留足慢网余量。 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
/** 版本验证/卸载超时。 */
const VERIFY_TIMEOUT_MS = 30_000

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
  const home = options.homeDir ?? os.homedir()
  if (definition.configKind === 'qwen-env') {
    // Qwen Code（Gemini CLI 系）读取 ~/.qwen/.env 的 OPENAI_* 变量接入 OpenAI 兼容端点。
    const dir = path.join(home, '.qwen')
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
    const dir = path.join(home, '.config', 'opencode')
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
  throw new AgentCliError('该工具暂不支持启动器内配置，请按官方指引完成配置。')
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

  return {
    async list() {
      return listResult()
    },

    async install(id) {
      const definition = getAgentCliDefinition(id)
      if (!definition) throw new AgentCliError('未知的 Agent CLI。')
      const logLines: string[] = []
      const log = (text: string) => {
        for (const line of text.split(/\r?\n/)) if (line.trim()) logLines.push(line)
      }
      options.onOutput?.('info', `开始安装 ${definition.name}（npm 走国内镜像，约 1–3 分钟）…`)

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
      const versionLine = verify.output.trim().split(/\r?\n/).find(line => /\d+\.\d+\.\d+/.test(line)) ?? ''
      const version = /v?(\d+\.\d+\.\d+)/.exec(versionLine)?.[1] ?? null
      if (verify.exitCode !== 0) {
        options.onOutput?.('error', `${definition.name} 装上了但启动验证失败。`)
        throw new AgentCliError(`安装完成但执行验证失败（退出码 ${verify.exitCode}）。日志已保留，可复制给服务方诊断。`)
      }

      const now = nowIso(options)
      const existing = (await entryFor(id)).record
      const record: AgentCliInstallRecord = {
        id,
        version,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        ...(existing?.configuredProvider ? { configuredProvider: existing.configuredProvider, configuredAt: existing.configuredAt } : {}),
      }
      await upsertAgentCliRecord(options.registryPath, record)
      options.onOutput?.('success', `${definition.name} ${version ? `v${version} ` : ''}安装完成。`)
      return { entry: await entryFor(id), logTail: logLines.slice(-LOG_TAIL_LINES) }
    },

    async uninstall(id) {
      const definition = getAgentCliDefinition(id)
      if (!definition) throw new AgentCliError('未知的 Agent CLI。')
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
