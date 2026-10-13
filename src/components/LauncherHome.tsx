import { Bot, Check, ChevronRight, CircleStop, Download, ExternalLink, LoaderCircle, MonitorCheck, Package, Play, SquareArrowOutUpRight } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import packageMetadata from '../../package.json'
import { useLauncherApi } from '../api/client'
import { APP_BRAND_NAME } from '../constants'
import { WidgetZone } from './WidgetZone'
import { errorText } from '../lib/format'
import type { AgentCliListResult, DesktopPluginState, DshInstallationStatus, DshUpdateStatus, HomeTab, InstallProgress, InstalledApplicationAddon, LauncherUpdateStatus, RuntimeState } from '../types'

/**
 * 「启动」tab：8-bit 游戏标题界面。
 * 顶部标题条（品牌+版本）→ 主区双面板（左：DSH START；右：Agent 速装）
 * → 底部消息条（小部件轮播）。与上游「左品牌列 + 右大按钮」的构图彻底区分。
 * DSH 是最深度的对象（START 面板保留完整启动管线），但速装网格让它与
 * 其它 Agent 平级露出；配置等重操作引导去「Agent 工具」页。
 */

interface LauncherHomeProps {
  runtime: RuntimeState
  dshInstallation: DshInstallationStatus
  dshUpdate: DshUpdateStatus | null
  launcherUpdate: LauncherUpdateStatus | null
  installProgress: InstallProgress | null
  busy: boolean
  installingDsh: boolean
  activeRuntimeReplacement: InstalledApplicationAddon | null
  bundleCount: number
  pluginCount: number
  skillCount: number
  presetCount: number
  /** 当前激活整合包（名称 + 绑定 DSH 版本），显示在「切换整合包」入口上。 */
  activePack: { name: string; dshVersion: string | null } | null
  /** 启动过程中主进程的后台活动（如 Office 工具下载进度），非空时顶替「正在启动本地工作台」小字。 */
  launchActivity?: string | null
  onToggleRuntime: () => void
  /** 服务运行中把网页重新拉起来（网页窗口被用户关掉后的唯一找回入口，与侧栏同源）。 */
  onOpenWeb: () => void
  onVersionSelect: () => void
  onUpdateDsh: () => void
  onOpenLauncherUpdate: () => void
  onNavigateTab: (tab: HomeTab) => void
}

export function LauncherHome({
  runtime,
  dshInstallation,
  dshUpdate,
  launcherUpdate,
  installProgress,
  busy,
  installingDsh,
  activeRuntimeReplacement,
  bundleCount,
  pluginCount,
  skillCount,
  presetCount,
  activePack,
  launchActivity,
  onToggleRuntime,
  onOpenWeb,
  onVersionSelect,
  onUpdateDsh,
  onOpenLauncherUpdate,
  onNavigateTab,
}: LauncherHomeProps) {
  const api = useLauncherApi()
  const needsInstallation = !dshInstallation.installed && !activeRuntimeReplacement
  // 零包引导态：没有激活包（通常是删光了整合包）时，START 按钮指向整合包页引导新建。
  const noPack = !activePack && !runtime.running && !busy
  // 官方桌面端检测：装了桌面端，START 就直接唤醒它（而不是起网页版）。
  const [desktop, setDesktop] = useState<DesktopPluginState | null>(null)
  useEffect(() => {
    void api.desktopStatus().then(setDesktop).catch(() => setDesktop(null))
  }, [api])
  const desktopInstalled = Boolean(desktop?.installed)

  // START 分流：运行中→停止；零包→引导建包；有桌面端→唤桌面；其余→网页版（含首装下载）。
  const handleStart = () => {
    if (!noPack && desktopInstalled && !runtime.running) {
      void api.desktopOpen()
      return
    }
    if (noPack) {
      onVersionSelect()
      return
    }
    onToggleRuntime()
  }
  const startLabel = runtime.running
    ? `STOP · ${runtime.applicationAddonName ?? 'DSH'}`
    : noPack
      ? '新建整合包'
      : installingDsh
        ? installProgress?.indeterminate ? '安装进行中' : `安装 DSH ${installProgress?.percent ?? 0}%`
        : needsInstallation
          ? '下载安装 DSH'
          : desktopInstalled
            ? '唤醒 DSH 桌面端'
            : busy ? '请稍候…' : activeRuntimeReplacement ? `启动 ${activeRuntimeReplacement.name}` : 'START · 启动 DSH'
  const startHint = busy
    ? (installingDsh ? installProgress?.message ?? '正在准备本地 DSH' : runtime.running ? '正在停止本地服务' : launchActivity ?? '正在启动本地工作台')
    : noPack
      ? '先创建一个整合包环境'
      : runtime.running
        ? '本地工作台运行中 · 结束服务'
        : needsInstallation
          ? '首次使用需要完成本地部署'
          : desktopInstalled
            ? '检测到官方桌面端，直接唤醒'
            : activeRuntimeReplacement ? '由应用加载项托管 DSH' : '启动本地网页工作台'

  return (
    <div className="hub-home">
      <header className="hub-titlebar">
        <img className="hub-titlebar-logo" src={`${import.meta.env.BASE_URL}whale-avatar.png`} alt="" width={30} height={30} draggable={false} />
        <span className="hub-titlebar-name">{APP_BRAND_NAME.toUpperCase()}</span>
        <span className="hub-titlebar-ver">v{packageMetadata.version}</span>
        <span className="hub-titlebar-note">多 Agent 一键安装 · 本地工作台</span>
      </header>

      <div className="hub-main">
        {/* 左：快报面板（AI 日报/更新提示），给足高度——内容型信息值得大版面。 */}
        <section className="hub-panel hub-feed-panel">
          <div className="hub-panel-head">快报 · 更新与 AI 日报</div>
          <div className="hub-feed-body">
            <WidgetZone
              dshUpdate={dshUpdate}
              launcherUpdate={launcherUpdate}
              busy={busy}
              dshVersion={dshInstallation.version ?? null}
              bundleCount={bundleCount}
              pluginCount={pluginCount}
              skillCount={skillCount}
              presetCount={presetCount}
              onUpdateDsh={onUpdateDsh}
              onOpenLauncherUpdate={onOpenLauncherUpdate}
              onNavigateTab={onNavigateTab}
            />
          </div>
        </section>

        {/* 右：Agent 速装网格。 */}
        <section className="hub-panel hub-agents-panel">
          <AgentQuickStrip dshInstallation={dshInstallation} onNavigateTab={onNavigateTab} />
        </section>
      </div>

      {/* 底：START 横条。整合包默认用官方包自动导入，不在此暴露切换入口（管理收进设置）。 */}
      <div className="hub-start-bar">
        <div className="hub-start-bar-head">▶ START · DEEPSEEK HARNESS</div>
        <div className="hub-start-bar-state">
          <span className="hub-start-state-row">
            <b>DSH</b>
            {dshInstallation.installed
              ? <span>v{dshInstallation.version ?? '?'} · 就绪</span>
              : <span className="hub-state-warn">未安装</span>}
          </span>
          <span className="hub-start-state-row">
            <b>整合包</b>
            {activePack
              ? <span>{activePack.name}{activePack.dshVersion ? ` · DSH ${activePack.dshVersion}` : ''}</span>
              : <span className="hub-state-warn">首次启动自动导入官方包</span>}
          </span>
          <span className="hub-start-state-row">
            <b>状态</b>
            {runtime.running
              ? <span className="hub-state-run">运行中</span>
              : <span>待命</span>}
          </span>
        </div>
        <button
          type="button"
          className={`launcher-start-button ${runtime.running ? 'stop' : ''}`}
          onClick={handleStart}
          disabled={busy}
          title={noPack ? '首次启动会自动导入官方整合包' : desktopInstalled ? '检测到官方桌面端，直接唤醒' : undefined}
        >
          {busy ? <LoaderCircle className="spin" size={24} /> : noPack ? <Package size={24} /> : runtime.running ? <CircleStop size={24} /> : desktopInstalled ? <MonitorCheck size={24} /> : needsInstallation ? <Download size={24} /> : <Play size={25} fill="currentColor" />}
          <span>
            <small>{startHint}</small>
            <strong>{startLabel}</strong>
          </span>
        </button>
        {runtime.running && runtime.url && (
          <button type="button" className="hub-start-sub-button" onClick={onOpenWeb} disabled={busy} title="在浏览器中重新打开 DSH 网页工作台">
            <SquareArrowOutUpRight size={14} />打开网页
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 「Agent 速装」网格：DSH 之外的六个 CLI/桌面端工具平铺，状态与一键安装就地可见。
 * 自取数（同 DesktopPackRow 的自足模式）；配置等重操作引导去「Agent 工具」页。
 */
function AgentQuickStrip({ dshInstallation, onNavigateTab }: { dshInstallation: DshInstallationStatus; onNavigateTab: (tab: HomeTab) => void }) {
  const api = useLauncherApi()
  const [state, setState] = useState<AgentCliListResult | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setState(await api.agentCliList())
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [api])

  useEffect(() => { void reload() }, [reload])

  const install = async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      await api.agentCliInstall(id)
      await reload()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <div className="hub-panel-head">AGENT 速装 · CLI 与桌面端</div>
      {error && <div className="agent-quick-error">{error}</div>}
      <div className="hub-agents-grid">
        {/* DSH 已在左侧 START 面板作为头牌；此网格聚焦 CLI/桌面端工具。 */}
        {(state?.entries ?? []).map(({ definition, record }) => {
          const working = busyId === definition.id
          return (
            <button
              key={definition.id}
              type="button"
              className={`hub-agent-card ${record ? 'installed' : ''}`}
              onClick={() => onNavigateTab('agents')}
              title={`${definition.name}：${record ? '已安装，点此查看配置' : definition.tagline}`}
            >
              <span className="hub-agent-name">
                {definition.name}
                {record?.source === 'offline-bundle' && <i className="agent-quick-offline">离线</i>}
              </span>
              <span className="hub-agent-state">
                {working
                  ? <><LoaderCircle size={11} className="spin" />安装中…</>
                  : record?.source === 'raw-installer'
                    ? <><ExternalLink size={11} />向导已启动</>
                    : record
                      ? <><Check size={11} />已安装{record.version ? ` v${record.version}` : ''}</>
                      : <>未安装</>}
              </span>
              {!record && !working && (
                <span
                  className="hub-agent-install"
                  role="button"
                  tabIndex={0}
                  onClick={event => { event.stopPropagation(); void install(definition.id) }}
                  onKeyDown={event => { if (event.key === 'Enter') { event.stopPropagation(); void install(definition.id) } }}
                >
                  安装
                </span>
              )}
            </button>
          )
        })}
        {!state && <span className="hub-agent-state">正在读取工具目录…</span>}
      </div>
      <div className="hub-agents-foot">
        <button type="button" className="hub-agents-more" onClick={() => onNavigateTab('agents')}>
          配置与详情<ChevronRight size={12} />
        </button>
      </div>
    </>
  )
}
