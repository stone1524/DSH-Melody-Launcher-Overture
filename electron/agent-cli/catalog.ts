// Agent CLI 内置目录：本 fork 支持的四类工具里不属于 DSH 整合包体系的部分。
// 选型文案对应服务资料《07-Agent选型小抄》的界面化改写；DSH 本体走整合包页，不在此列。

import type { AgentCliDefinition, AgentCliProviderPreset } from '../../src/types'

/**
 * 国产模型服务商预设（OpenAI 兼容端点）。
 * baseUrl 必须是「直接拼 /chat/completions 就能打」的完整兼容根路径；
 * 模型名是各家当前文档推荐的对话模型，只作连通性测试与默认值，客户可在高级里改。
 */
export const AGENT_CLI_PROVIDERS: readonly AgentCliProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 开放平台',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    consoleUrl: 'https://platform.deepseek.com/',
  },
  {
    id: 'zhipu',
    label: '智谱 BigModel',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
    consoleUrl: 'https://open.bigmodel.cn/',
  },
  {
    id: 'qwen',
    label: '阿里云百炼（通义）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-coder-plus',
    consoleUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'kimi',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.5',
    consoleUrl: 'https://platform.moonshot.cn/',
  },
] as const

export function getAgentCliProvider(id: string): AgentCliProviderPreset | null {
  return AGENT_CLI_PROVIDERS.find(provider => provider.id === id) ?? null
}

export const AGENT_CLI_DEFINITIONS: readonly AgentCliDefinition[] = [
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    tagline: '阿里官方命令行编程助手，免费额度大，注册即用',
    audience: '想要「装完就能白嫖大量额度」的新手；终端里对话、改代码、跑任务。',
    npmPackage: '@qwen-code/qwen-code',
    versionArgs: ['--version'],
    configKind: 'qwen-env',
    configurable: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    tagline: '开源无锁定的终端编程 Agent，任意模型都能接',
    audience: '想自己挑模型（DeepSeek / GLM / Kimi 均可）又不被单一厂商绑住的用户。',
    npmPackage: 'opencode-ai',
    versionArgs: ['--version'],
    configKind: 'opencode-json',
    configurable: true,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    tagline: '开源个人智能体框架，可接入聊天软件当助理',
    audience: '想体验「个人 AI 助理/智能体」的尝鲜用户；配置步骤多，适合预约远程陪跑。',
    npmPackage: 'openclaw',
    versionArgs: ['--version'],
    configKind: 'none',
    configurable: false,
  },
] as const

export function getAgentCliDefinition(id: string): AgentCliDefinition | null {
  return AGENT_CLI_DEFINITIONS.find(definition => definition.id === id) ?? null
}
