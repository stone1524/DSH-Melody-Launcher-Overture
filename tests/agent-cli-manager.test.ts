import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_CLI_DEFINITIONS } from '../electron/agent-cli/catalog'
import { createAgentCliManager, type AgentCliManagerOptions, type CommandRunnerInput, type CommandRunnerResult } from '../electron/agent-cli/manager'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-cli-manager-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface StubState {
  calls: { executable: string; args: string[]; env: Record<string, string | undefined> }[]
  installSucceeds: boolean
  verifySucceeds: boolean
  versionOutput: string
}

/** 目录里允许出现的 npm 包白名单（全部来自内置目录），stub 只为它们伪造安装结果。 */
const KNOWN_PACKAGES = new Set(AGENT_CLI_DEFINITIONS.map(definition => definition.npmPackage))

async function fakeInstallPackage(prefix: string, packageName: string): Promise<void> {
  if (!KNOWN_PACKAGES.has(packageName)) throw new Error(`stub 只认识目录内的包名：${packageName}`)
  // 显式边界校验（安全约定）：目标必须仍落在 prefix 内，杜绝任何形式的越出。
  const root = path.resolve(prefix)
  const pkgDir = path.resolve(root, 'node_modules', ...packageName.split('/'))
  if (pkgDir !== root && !pkgDir.startsWith(root + path.sep)) throw new Error('stub 路径越出前缀目录')
  await mkdir(pkgDir, { recursive: true })
  await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: packageName, version: '9.9.9', bin: { [packageName]: 'bin/cli.js' } }), 'utf8')
  await mkdir(path.join(pkgDir, 'bin'), { recursive: true })
  await writeFile(path.join(pkgDir, 'bin', 'cli.js'), 'console.log("1.0.0")', 'utf8')
}

function stubRunner(state: StubState) {
  return async (input: CommandRunnerInput): Promise<CommandRunnerResult> => {
    state.calls.push({ executable: input.executable, args: input.args, env: input.env })
    if (input.args.includes('install')) {
      if (!state.installSucceeds) return { exitCode: 1, output: 'npm ERR! network' }
      const pkg = input.args[input.args.length - 1]
      if (typeof pkg !== 'string') return { exitCode: 1, output: 'stub: no package arg' }
      await fakeInstallPackage(input.env.npm_config_prefix ?? '', pkg)
      return { exitCode: 0, output: 'added 1 package in 3s' }
    }
    if (input.args.some(arg => typeof arg === 'string' && /bin[\\/]cli\.js$/.test(arg))) {
      return state.verifySucceeds
        ? { exitCode: 0, output: state.versionOutput }
        : { exitCode: 1, output: 'boom' }
    }
    return { exitCode: 0, output: '' }
  }
}

function makeOptions(overrides: Partial<AgentCliManagerOptions> = {}): AgentCliManagerOptions {
  return {
    registryPath: path.join(dir, 'agents.json'),
    prefixRoot: path.join(dir, 'agent-cli'),
    resolveNode: async () => ({ node: path.join(dir, 'node.exe'), npm: path.join(dir, 'npm.cmd') }),
    onOutput: () => undefined,
    ...overrides,
  }
}

describe('agent-cli manager', () => {
  it('list 返回目录与 providers，未安装时 record 为空', async () => {
    const manager = createAgentCliManager(makeOptions())
    const result = await manager.list()
    expect(result.entries.map(item => item.definition.id)).toEqual(['qwen-code', 'opencode', 'openclaw', 'codex', 'hermes'])
    expect(result.entries.every(item => item.record === null)).toBe(true)
    expect(result.providers.map(provider => provider.id)).toEqual(['deepseek', 'zhipu', 'qwen', 'kimi'])
  })

  it('install 走私有前缀 + 镜像源，成功后写注册表并回读版本', async () => {
    const state: StubState = { calls: [], installSucceeds: true, verifySucceeds: true, versionOutput: 'qwen-code/9.9.9' }
    const manager = createAgentCliManager(makeOptions({ runCommand: stubRunner(state), readNpmRegistry: async () => 'https://mirror.example.com' }))
    const { entry, logTail } = await manager.install('qwen-code')

    const installCall = state.calls.find(call => call.args.includes('install'))
    expect(installCall).toBeDefined()
    expect(installCall?.env.npm_config_registry).toBe('https://mirror.example.com')
    expect(installCall?.env.npm_config_prefix).toContain(path.join('agent-cli', 'prefix'))
    expect(installCall?.args.at(-1)).toBe('@qwen-code/qwen-code')

    expect(entry.record?.version).toBe('9.9.9')
    expect(logTail.length).toBeGreaterThan(0)
  })

  it('install 失败时抛错且不写注册表', async () => {
    const state: StubState = { calls: [], installSucceeds: false, verifySucceeds: true, versionOutput: '' }
    const manager = createAgentCliManager(makeOptions({ runCommand: stubRunner(state) }))
    await expect(manager.install('opencode')).rejects.toThrow(/npm 安装失败/)
    expect((await manager.list()).entries.find(item => item.definition.id === 'opencode')?.record).toBeNull()
  })

  it('verify 失败（装上了跑不起来）同样抛错，不留下成功记录', async () => {
    const state: StubState = { calls: [], installSucceeds: true, verifySucceeds: false, versionOutput: '' }
    const manager = createAgentCliManager(makeOptions({ runCommand: stubRunner(state) }))
    await expect(manager.install('qwen-code')).rejects.toThrow(/执行验证失败/)
    expect((await manager.list()).entries.find(item => item.definition.id === 'qwen-code')?.record).toBeNull()
  })

  it('uninstall 清注册表记录（npm 命令失败也不阻塞）', async () => {
    const state: StubState = { calls: [], installSucceeds: true, verifySucceeds: true, versionOutput: '1.0.0' }
    const manager = createAgentCliManager(makeOptions({ runCommand: stubRunner(state) }))
    await manager.install('openclaw')
    const result = await manager.uninstall('openclaw')
    expect(result.entries.find(item => item.definition.id === 'openclaw')?.record).toBeNull()
  })

  it('configure 写 qwen-env 配置文件（Key 只进文件不进注册表），未安装时拒绝', async () => {
    const state: StubState = { calls: [], installSucceeds: true, verifySucceeds: true, versionOutput: '1.0.0' }
    const home = path.join(dir, 'home')
    const manager = createAgentCliManager(makeOptions({ runCommand: stubRunner(state), homeDir: home }))
    await expect(manager.configure({ id: 'qwen-code', providerId: 'deepseek', apiKey: 'sk-test' })).rejects.toThrow(/请先安装/)

    await manager.install('qwen-code')
    const result = await manager.configure({ id: 'qwen-code', providerId: 'deepseek', apiKey: 'sk-test' })
    expect(result.entries.find(item => item.definition.id === 'qwen-code')?.record?.configuredProvider).toBe('deepseek')

    const envFile = await readFile(path.join(home, '.qwen', '.env'), 'utf8')
    expect(envFile).toContain('OPENAI_API_KEY=sk-test')
    expect(envFile).toContain('OPENAI_BASE_URL=https://api.deepseek.com/v1')
    expect(envFile).toContain('OPENAI_MODEL=deepseek-chat')
    const raw = await readFile(path.join(dir, 'agents.json'), 'utf8')
    expect(raw).not.toContain('sk-test')
  })

  it('configure 写 opencode-json（provider + model），openclaw 不支持向导化配置', async () => {
    const state: StubState = { calls: [], installSucceeds: true, verifySucceeds: true, versionOutput: '1.0.0' }
    const home = path.join(dir, 'home')
    const manager = createAgentCliManager(makeOptions({ runCommand: stubRunner(state), homeDir: home }))
    await manager.install('opencode')
    await manager.configure({ id: 'opencode', providerId: 'zhipu', apiKey: 'k', model: 'glm-5.3-air' })
    const config = JSON.parse(await readFile(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8')) as { model: string; provider: Record<string, { options: { baseURL: string } }> }
    expect(config.model).toBe('launcher-zhipu/glm-5.3-air')
    expect(Object.values(config.provider)[0].options.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4')

    await manager.install('openclaw')
    await expect(manager.configure({ id: 'openclaw', providerId: 'deepseek', apiKey: 'k' })).rejects.toThrow(/暂不支持/)
  })

  it('configure 写 codex-config（config.toml + auth.json + 用户环境变量）', async () => {
    const state: StubState = { calls: [], installSucceeds: true, verifySucceeds: true, versionOutput: '1.0.0' }
    const home = path.join(dir, 'home')
    const envCalls: { name: string; value: string }[] = []
    const runner = stubRunner(state)
    const manager = createAgentCliManager(makeOptions({
      runCommand: async input => {
        // 拦截 powershell 环境变量写入，验证 base64 值可解码且与 Key 一致。
        if (input.executable === 'powershell.exe' && input.args.some(arg => arg.includes('SetEnvironmentVariable'))) {
          const script = input.args[input.args.indexOf('-Command') + 1]
          const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1] ?? ''
          envCalls.push({ name: /SetEnvironmentVariable\('([^']+)'/u.exec(script)?.[1] ?? '', value: Buffer.from(encoded, 'base64').toString('utf8') })
          return { exitCode: 0, output: '' }
        }
        return runner(input)
      },
      homeDir: home,
    }))
    await manager.install('codex')
    const result = await manager.configure({ id: 'codex', providerId: 'kimi', apiKey: 'sk-kimi' })

    expect(result.entries.find(item => item.definition.id === 'codex')?.record?.configuredProvider).toBe('kimi')
    const toml = await readFile(path.join(home, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain('model_provider = "launcher"')
    expect(toml).toContain('base_url = "https://api.moonshot.cn/v1"')
    expect(toml).toContain('model = "kimi-k2.5"')
    const auth = JSON.parse(await readFile(path.join(home, '.codex', 'auth.json'), 'utf8')) as { OPENAI_API_KEY: string }
    expect(auth.OPENAI_API_KEY).toBe('sk-kimi')
    expect(envCalls).toEqual([{ name: 'OPENAI_API_KEY', value: 'sk-kimi' }])
    // 注册表绝不存 Key。
    const raw = await readFile(path.join(dir, 'agents.json'), 'utf8')
    expect(raw).not.toContain('sk-kimi')
  })

  it('configure 写 hermes-env（服务商对应的环境变量名）', async () => {
    const state: StubState = { calls: [], installSucceeds: true, verifySucceeds: true, versionOutput: '1.0.0' }
    const home = path.join(dir, 'home')
    const envCalls: { name: string; value: string }[] = []
    const runner = stubRunner(state)
    const manager = createAgentCliManager(makeOptions({
      runCommand: async input => {
        if (input.executable === 'powershell.exe' && input.args.some(arg => arg.includes('SetEnvironmentVariable'))) {
          const script = input.args[input.args.indexOf('-Command') + 1]
          const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1] ?? ''
          envCalls.push({ name: /SetEnvironmentVariable\('([^']+)'/u.exec(script)?.[1] ?? '', value: Buffer.from(encoded, 'base64').toString('utf8') })
          return { exitCode: 0, output: '' }
        }
        return runner(input)
      },
      homeDir: home,
    }))
    await manager.install('hermes')
    await manager.configure({ id: 'hermes', providerId: 'qwen', apiKey: 'sk-dash' })
    expect(envCalls).toEqual([{ name: 'DASHSCOPE_API_KEY', value: 'sk-dash' }])
  })

  it('testProvider 按状态码给出可读原因，网络异常转中文提示', async () => {
    const manager = createAgentCliManager(makeOptions({
      fetchImpl: (async (url: string | URL | Request) => {
        const target = String(url)
        if (target.includes('deepseek')) return new Response('{}', { status: 401 })
        if (target.includes('bigmodel')) return new Response('{}', { status: 429 })
        throw new Error('ECONNRESET')
      }) as typeof fetch,
    }))
    const ok401 = await manager.testProvider({ providerId: 'deepseek', apiKey: 'bad' })
    expect(ok401.ok).toBe(false)
    expect(ok401.error).toContain('Key 无效')
    const rate429 = await manager.testProvider({ providerId: 'zhipu', apiKey: 'k' })
    expect(rate429.error).toContain('限流')
    const netFail = await manager.testProvider({ providerId: 'kimi', apiKey: 'k' })
    expect(netFail.ok).toBe(false)
    expect(netFail.error).toContain('连不上服务商')
  })
})
