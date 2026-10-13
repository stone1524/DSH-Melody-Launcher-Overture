import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findAgentCliRecord, readAgentCliRegistry, removeAgentCliRecord, upsertAgentCliRecord } from '../electron/agent-cli/registry'
import { AGENT_CLI_DEFINITIONS, AGENT_CLI_PROVIDERS, getAgentCliDefinition, getAgentCliProvider } from '../electron/agent-cli/catalog'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-cli-registry-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function record(id: 'qwen-code' | 'opencode' | 'openclaw' | 'codex' | 'hermes', overrides: Partial<Parameters<typeof upsertAgentCliRecord>[1]> = {}): Parameters<typeof upsertAgentCliRecord>[1] {
  return {
    id,
    version: '1.2.3',
    installedAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  }
}

describe('agent-cli registry', () => {
  it('缺失文件时返回空注册表', async () => {
    expect(await readAgentCliRegistry(path.join(dir, 'agents.json'))).toEqual([])
  })

  it('upsert 后能读回，同 id 覆盖不重复', async () => {
    const registryPath = path.join(dir, 'agents.json')
    await upsertAgentCliRecord(registryPath, record('qwen-code'))
    await upsertAgentCliRecord(registryPath, record('opencode'))
    await upsertAgentCliRecord(registryPath, record('qwen-code', { version: '2.0.0' }))
    const installs = await readAgentCliRegistry(registryPath)
    expect(installs).toHaveLength(2)
    expect(findAgentCliRecord(installs, 'qwen-code')?.version).toBe('2.0.0')
  })

  it('remove 是幂等的，且未动过的记录原样保留', async () => {
    const registryPath = path.join(dir, 'agents.json')
    await upsertAgentCliRecord(registryPath, record('qwen-code'))
    await upsertAgentCliRecord(registryPath, record('openclaw'))
    expect(await removeAgentCliRecord(registryPath, 'qwen-code')).toHaveLength(1)
    expect(await removeAgentCliRecord(registryPath, 'qwen-code')).toHaveLength(1)
    const installs = await readAgentCliRegistry(registryPath)
    expect(installs.map(item => item.id)).toEqual(['openclaw'])
  })

  it('损坏或未知版本的注册表按空处理（下次写回即修复）', async () => {
    const registryPath = path.join(dir, 'agents.json')
    await upsertAgentCliRecord(registryPath, record('qwen-code'))
    const raw = await readFile(registryPath, 'utf8')
    await readFile(registryPath, 'utf8')
    // 手工写坏两种坏档：JSON 断裂 / 版本号不认识。
    const { writeFile } = await import('node:fs/promises')
    await writeFile(registryPath, '{broken', 'utf8')
    expect(await readAgentCliRegistry(registryPath)).toEqual([])
    await writeFile(registryPath, JSON.stringify({ version: 99, installs: [] }), 'utf8')
    expect(await readAgentCliRegistry(registryPath)).toEqual([])
    void raw
  })

  it('非法记录（未知 id / 字段类型错）被过滤，不拖垮整个注册表', async () => {
    const registryPath = path.join(dir, 'agents.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      installs: [
        { id: 'not-a-cli', version: '1', installedAt: '', updatedAt: '' },
        { id: 'opencode', version: 42, installedAt: '', updatedAt: '' },
        record('opencode'),
      ],
    }), 'utf8')
    const installs = await readAgentCliRegistry(registryPath)
    expect(installs).toHaveLength(1)
    expect(installs[0].id).toBe('opencode')
  })
})

describe('agent-cli catalog', () => {
  it('目录 id 唯一，且每项都有 npm 包名与版本参数', () => {
    const ids = AGENT_CLI_DEFINITIONS.map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('codex')
    expect(ids).toContain('hermes')
    for (const definition of AGENT_CLI_DEFINITIONS) {
      expect(definition.npmPackage).toMatch(/^[\w@][\w./-]*$/)
      expect(definition.versionArgs.length).toBeGreaterThan(0)
      expect(['qwen-env', 'opencode-json', 'codex-config', 'hermes-env', 'none']).toContain(definition.configKind)
      // configurable 与 configKind 必须一致：none 就不能承诺向导化配置。
      expect(definition.configurable).toBe(definition.configKind !== 'none')
      // hermes 走社区安装脚本通道，其余默认 npm。
      expect(definition.id === 'hermes').toBe(definition.installKind === 'hermes-installer')
    }
  })

  it('getAgentCliDefinition 认识目录里的每一项，拒绝陌生 id', () => {
    for (const definition of AGENT_CLI_DEFINITIONS) {
      expect(getAgentCliDefinition(definition.id)?.id).toBe(definition.id)
    }
    expect(getAgentCliDefinition('claude-code')).toBeNull()
  })

  it('服务商预设的 baseUrl 可直接拼 /chat/completions，模型与控制台齐全', () => {
    for (const provider of AGENT_CLI_PROVIDERS) {
      expect(provider.baseUrl).toMatch(/^https:\/\//)
      expect(provider.baseUrl).not.toMatch(/\/$/)
      expect(provider.model).not.toHaveLength(0)
      expect(provider.consoleUrl).toMatch(/^https:\/\//)
      expect(getAgentCliProvider(provider.id)?.id).toBe(provider.id)
    }
    expect(getAgentCliProvider('openai')).toBeNull()
  })
})
