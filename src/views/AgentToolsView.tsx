import { Bot, Check, ExternalLink, KeyRound, LoaderCircle, RefreshCw, Trash2, Wrench } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { ModalShell } from '../components/dialogs/ModalShell'
import { errorText } from '../lib/format'
import type { AgentCliEntry, AgentCliListResult, AgentCliProviderPreset, AgentCliProviderTestResult } from '../types'

/**
 * 「Agent 工具」页（Agent Hub Edition）：
 * DSH 整合包体系之外的命令行 Agent——Qwen Code / OpenCode / OpenClaw。
 * 安装走启动器私有 npm 前缀（不污染系统全局），配置向导把国产模型
 * 四选一写进各 CLI 自己的配置文件；API Key 只在客户本人输入时经手，
 * 不进注册表、不上报。
 */

const STATUS_HINTS: Record<string, string> = {
  'qwen-env': '配置写入 ~/.qwen/.env（OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL）',
  'opencode-json': '配置写入 ~/.config/opencode/opencode.json（openai-compatible provider）',
  none: '该工具需要用它自己的交互式命令完成配置（如 openclaw configure），或预约远程陪跑。',
}

export function AgentToolsView() {
  const api = useLauncherApi()
  const [state, setState] = useState<AgentCliListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [logTail, setLogTail] = useState<string[] | null>(null)
  const [configTarget, setConfigTarget] = useState<AgentCliEntry | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setState(await api.agentCliList())
      setError(null)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void reload() }, [reload])

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
      await reload()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(null)
    }
  }

  if (loading && state === null) return <div className="settings-hint">正在读取 Agent 工具目录…</div>
  if (state === null) return <div className="settings-empty"><Bot size={20} />{error ?? '目录读取失败。'}</div>

  return (
    <>
      <div className="settings-panel-heading">
        <div className="settings-panel-title">
          <Bot size={17} /><span>Agent 工具</span>
        </div>
        <div className="settings-market-heading-actions">
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void reload()}>
            <RefreshCw size={14} className={loading ? 'spin' : undefined} />刷新
          </button>
        </div>
      </div>
      <div className="settings-hint">
        这些命令行 Agent 装在<strong>启动器自己的目录</strong>里，不影响系统全局 npm；安装走国内镜像，断点可重试。
        配置模型时 API Key 由你本人输入，只写进该工具自己的配置文件，启动器不留存、不上报。
      </div>
      {error && <div className="error-banner"><span>{error}</span><button type="button" onClick={() => setError(null)}>忽略</button></div>}

      <div className="settings-list">
        {state.entries.map(entry => {
          const { definition, record } = entry
          const installing = busy === `install:${definition.id}`
          const uninstalling = busy === `uninstall:${definition.id}`
          const providerLabel = record?.configuredProvider
            ? state.providers.find(provider => provider.id === record.configuredProvider)?.label ?? record.configuredProvider
            : null
          return (
            <div key={definition.id} className={`settings-row ${installing || uninstalling ? 'is-working' : ''}`}>
              <div className="settings-row-copy">
                <strong>
                  {definition.name}
                  {record?.version && <span className="settings-count"> v{record.version}</span>}
                </strong>
                <span>{definition.tagline}</span>
                <span className="agent-cli-audience">{definition.audience}</span>
                {record && (
                  <span className="agent-cli-status-line">
                    {providerLabel
                      ? <><Check size={12} /> 已配置 {providerLabel}</>
                      : definition.configurable ? '已安装，还没配置模型' : '已安装'}
                  </span>
                )}
              </div>
              <div className="settings-row-actions">
                {installing || uninstalling
                  ? <span className="agent-cli-busy"><LoaderCircle size={15} className="spin" />{installing ? '安装中…' : '卸载中…'}</span>
                  : (
                    <>
                      {record
                        ? (
                          <>
                            {definition.configurable && (
                              <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setConfigTarget(entry)}>
                                <KeyRound size={14} />{providerLabel ? '重新配置' : '配置模型'}
                              </button>
                            )}
                            <button type="button" className="icon-button" title={`卸载 ${definition.name}`} aria-label={`卸载 ${definition.name}`} disabled={busy !== null} onClick={() => void act(`uninstall:${definition.id}`, () => api.agentCliUninstall(definition.id))}>
                              <Trash2 size={16} />
                            </button>
                          </>
                        )
                        : <button type="button" className="primary-command" disabled={busy !== null} onClick={() => void act(`install:${definition.id}`, () => api.agentCliInstall(definition.id).then(result => setLogTail(result.logTail)))}>
                          <Wrench size={14} />安装
                        </button>}
                    </>
                  )}
              </div>
            </div>
          )
        })}
      </div>

      {logTail && logTail.length > 0 && (
        <div className="agent-cli-log">
          <div className="agent-cli-log-head">
            <span>最近一次安装日志（尾部）</span>
            <button type="button" className="icon-button" aria-label="收起日志" onClick={() => setLogTail(null)}><Trash2 size={13} /></button>
          </div>
          <pre>{logTail.join('\n')}</pre>
        </div>
      )}

      {configTarget && (
        <AgentCliConfigDialog
          entry={configTarget}
          providers={state.providers}
          onClose={() => setConfigTarget(null)}
          onSaved={() => {
            setConfigTarget(null)
            void reload()
          }}
        />
      )}
    </>
  )
}

interface ConfigDialogProps {
  entry: AgentCliEntry
  providers: AgentCliProviderPreset[]
  onClose: () => void
  onSaved: () => void
}

function AgentCliConfigDialog({ entry, providers, onClose, onSaved }: ConfigDialogProps) {
  const api = useLauncherApi()
  const [providerId, setProviderId] = useState(providers[0]?.id ?? 'deepseek')
  const [apiKey, setApiKey] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AgentCliProviderTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const provider = providers.find(item => item.id === providerId) ?? providers[0]

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await api.agentCliTestProvider({ providerId, apiKey, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) }))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.agentCliConfigure({ id: entry.definition.id, providerId, apiKey, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) })
      onSaved()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell
      className="agent-cli-dialog"
      titleId="agent-cli-config-title"
      icon={<KeyRound size={19} />}
      title={`配置 ${entry.definition.name} 的模型`}
      onClose={onClose}
      footer={<>
        <button type="button" className="secondary-button" disabled={testing || saving || !apiKey.trim()} onClick={() => void runTest()}>
          {testing ? <LoaderCircle size={14} className="spin" /> : null}测试连通
        </button>
        <button type="button" className="primary-command" disabled={testing || saving || !apiKey.trim()} onClick={() => void save()}>
          {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存配置
        </button>
      </>}
    >
      <div className="settings-hint">
        第 1 步：选模型服务商并去它家控制台申请 API Key；第 2 步：把 Key 粘贴到这里。
        Key 只写进 {entry.definition.name} 自己的配置文件（{STATUS_HINTS[entry.definition.configKind]}）。
      </div>
      <div className="theme-options" role="radiogroup" aria-label="模型服务商">
        {providers.map(item => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={providerId === item.id}
            className={`theme-option ${providerId === item.id ? 'selected' : ''}`}
            onClick={() => { setProviderId(item.id); setTestResult(null) }}
          >
            <span className="agent-cli-provider-name">{item.label}</span>
            {providerId === item.id && <Check size={14} />}
          </button>
        ))}
      </div>
      {provider && (
        <div className="settings-hint">
          控制台：<a href={provider.consoleUrl} onClick={event => { event.preventDefault(); void api.openExternal(provider.consoleUrl) }}>
            {provider.consoleUrl}</a><ExternalLink size={11} />
          （模型服务由该服务商提供并计费，请自行注册与充值）
        </div>
      )}
      <label className="form-field"><span>API Key</span>
        <input type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setTestResult(null) }} placeholder="粘贴你本人的 API Key（启动器不保存）" autoComplete="off" />
      </label>
      <label className="check-field">
        <input type="checkbox" checked={advanced} onChange={event => setAdvanced(event.target.checked)} />
        <span><strong>高级：自定义接口地址 / 模型</strong><small>默认 {provider?.baseUrl} · {provider?.model}；服务商兼容端点有变化时才需要改。</small></span>
      </label>
      {advanced && (
        <>
          <label className="form-field"><span>接口地址</span><input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={provider?.baseUrl} /></label>
          <label className="form-field"><span>模型名</span><input value={model} onChange={event => setModel(event.target.value)} placeholder={provider?.model} /></label>
        </>
      )}
      {testResult && (
        <div className={testResult.ok ? 'agent-cli-test-ok' : 'agent-cli-test-fail'}>
          {testResult.ok
            ? <><Check size={14} /> 连通正常（{testResult.latencyMs}ms）。可以保存配置。</>
            : <>连通失败：{testResult.error}</>}
        </div>
      )}
      {error && <div className="error-banner"><span>{error}</span><button type="button" onClick={() => setError(null)}>忽略</button></div>}
    </ModalShell>
  )
}
