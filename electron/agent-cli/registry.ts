// Agent CLI 安装注册表（userData/agents.json）。
// 只记录「装了什么、什么版本、配置过哪家」，绝不存 API Key——Key 只进各 CLI 自己的配置文件。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentCliId, AgentCliInstallRecord } from '../../src/types'
import { getAgentCliDefinition } from './catalog'

const REGISTRY_VERSION = 1

interface AgentCliRegistryFile {
  version: number
  installs: AgentCliInstallRecord[]
}

export function isValidAgentCliId(value: unknown): value is AgentCliId {
  return typeof value === 'string' && getAgentCliDefinition(value) !== null
}

function isValidRecord(value: unknown): value is AgentCliInstallRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (!isValidAgentCliId(record.id)) return false
  if (record.version !== null && typeof record.version !== 'string') return false
  if (typeof record.installedAt !== 'string' || typeof record.updatedAt !== 'string') return false
  if (record.configuredProvider !== undefined && typeof record.configuredProvider !== 'string') return false
  if (record.configuredAt !== undefined && typeof record.configuredAt !== 'string') return false
  return true
}

/** 读注册表；文件缺失或损坏时返回空注册表（损坏不打断用户，下次写回即修复）。 */
export async function readAgentCliRegistry(registryPath: string): Promise<AgentCliInstallRecord[]> {
  let text: string
  try {
    text = await readFile(registryPath, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return []
    const file = parsed as Record<string, unknown>
    if (file.version !== REGISTRY_VERSION || !Array.isArray(file.installs)) return []
    return file.installs.filter(isValidRecord)
  } catch {
    return []
  }
}

async function writeRegistry(registryPath: string, installs: AgentCliInstallRecord[]): Promise<void> {
  const file: AgentCliRegistryFile = { version: REGISTRY_VERSION, installs }
  const text = `${JSON.stringify(file, null, 2)}\n`
  await mkdir(path.dirname(registryPath), { recursive: true })
  await writeFile(registryPath, text, 'utf8')
}

/** 新增或更新一条记录（按 id 覆盖，保持其余记录顺序）。 */
export async function upsertAgentCliRecord(registryPath: string, record: AgentCliInstallRecord): Promise<AgentCliInstallRecord[]> {
  const installs = await readAgentCliRegistry(registryPath)
  const next = installs.filter(item => item.id !== record.id)
  next.push(record)
  await writeRegistry(registryPath, next)
  return next
}

/** 删除一条记录；不存在时静默成功（幂等）。 */
export async function removeAgentCliRecord(registryPath: string, id: AgentCliId): Promise<AgentCliInstallRecord[]> {
  const installs = await readAgentCliRegistry(registryPath)
  const next = installs.filter(item => item.id !== id)
  if (next.length === installs.length) return next
  await writeRegistry(registryPath, next)
  return next
}

export function findAgentCliRecord(installs: AgentCliInstallRecord[], id: AgentCliId): AgentCliInstallRecord | null {
  return installs.find(item => item.id === id) ?? null
}
