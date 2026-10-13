import { Bot, Check, ChevronRight, CircleStop, Download, ExternalLink, LoaderCircle, MonitorCheck, Package, Play, SquareArrowOutUpRight } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import packageMetadata from '../../package.json'
import { useLauncherApi } from '../api/client'
import { APP_BRAND_NAME } from '../constants'
import { WidgetZone } from './WidgetZone'
import { errorText } from '../lib/format'
import type { AgentCliListResult, DesktopPluginState, DshInstallationStatus, DshUpdateStatus, HomeTab, InstallProgress, InstalledApplicationAddon, LauncherUpdateStatus, RuntimeState } from '../types'

/**
 * 「启动」tab：Agent Hub 首页。左列品牌（鲸鱼娘/名称/版本），
 * 右列 = Agent 速装网格（六个工具一屏可见）+ 小部件轮播区 + 底部 DSH 动作区。
 * DSH 是这台启动器最深度的对象（大启动按钮保留），但不再独占首页——
 * 其余 Agent 与它平级露出，详情与配置去「Agent 工具」页。
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
  // 零包引导态：没有激活包（通常是删光了整合包）时，首页两个按钮都指向整合包页引导新建。
  const noPack = !activePack && !runtime.running && !busy
  // 官方桌面端检测：装了桌面端，大按钮就直接唤醒它（而不是起网页版）。
  const [desktop, setDesktop] = useState<DesktopPluginState | null>(null)
  useEffect(() => {
    void api.desktopStatus().then(setDesktop).catch(() => setDesktop(null))
  }, [api])
  const desktopInstalled = Boolean(desktop?.installed)

  // 大按钮动作分流：运行中→停止；零包→引导建包；有桌面端→唤桌面；其余→网页版（含首装下载）。
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
    ? `停止 ${runtime.applicationAddonName ?? 'DSH'}`
    : noPack
      ? '新建整合包'
      : installingDsh
        ? installProgress?.indeterminate ? '安装进行中' : `安装 DSH ${installProgress?.percent ?? 0}%`
        : needsInstallation
          ? '下载安装 DSH'
          : desktopInstalled
            ? '启动 DSH 桌面端'
            : busy ? '请稍候…' : activeRuntimeReplacement ? `启动 ${activeRuntimeReplacement.name}` : '启动 DSH'
  const startHint = busy
    ? (installingDsh ? installProgress?.message ?? '正在准备本地 DSH' : runtime.running ? '正在停止本地服务' : launchActivity ?? '正在启动本地工作台')
    : noPack
      ? '先创建一个整合包环境'
      : runtime.running
        ? '结束本地服务'
        : needsInstallation
          ? '首次使用需要完成本地部署'
          : desktopInstalled
            ? '检测到官方桌面端，直接唤醒'
            : activeRuntimeReplacement ? '由应用加载项托管 DSH' : '启动本地工作台'

  return (
    <div className="launcher-home">
      <section className="home-brand">
        <div className="home-brand-head">
          <img className="home-brand-logo" src={`${import.meta.env.BASE_URL}whale-avatar.png`} alt="" width={112} height={112} draggable={false} />
          <h1 className="home-brand-name">
            <strong>Agent</strong>
            <span>Hub</span>
          </h1>
          <p className="home-brand-tagline">多 Agent 一键安装 · 本地工作台</p>
        </div>
        <div className="home-brand-meta">
          <span className="home-brand-version">v{packageMetadata.version}</span>
        </div>
      </section>

      <section className="home-side">
        <AgentQuickStrip dshInstallation={dshInstallation} onNavigateTab={onNavigateTab} />
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
        <div className="home-actions">
        <div className="home-start-row">
          <button
            type="button"
            className={`launcher-start-button ${runtime.running ? 'stop' : ''}`}
            onClick={handleStart}
            disabled={busy}
            title={noPack ? '先到「整合包」页新建或导入一个整合包' : desktopInstalled ? '检测到官方桌面端，直接唤醒' : undefined}
          >
            {busy ? <LoaderCircle className="spin" size={24} /> : noPack ? <Package size={24} /> : runtime.running ? <CircleStop size={24} /> : desktopInstalled ? <MonitorCheck size={24} /> : needsInstallation ? <Download size={24} /> : <Play size={25} fill="currentColor" />}
            <span>
              <small>{startHint}</small>
              <strong>{startLabel}</strong>
            </span>
          </button>
          {/* 运行中的第二分段：网页窗口被关掉后，这里是一键找回的入口（与左侧停止段等宽同构）。 */}
          {runtime.running && runtime.url && (
            <button type="button" className="launcher-start-button launcher-open-web" onClick={onOpenWeb} disabled={busy} title="在浏览器中重新打开 DSH 网页工作台">
              <SquareArrowOutUpRight size={24} />
              <span>
                <small>浏览器中访问</small>
                <strong>打开网页</strong>
              </span>
            </button>
          )}
        </div>
        <button type="button" className="launcher-utility-button home-version-button" onClick={onVersionSelect} title={activePack ? '切换到其它整合包' : '创建或导入整合包'}>
          <Package size={20} className="home-version-icon" />
          <span className="home-version-copy">
            <small>{activePack ? '当前整合包' : '还没有整合包'}</small>
            <strong>{activePack ? `${activePack.name}${activePack.dshVersion ? ` · DSH ${activePack.dshVersion}` : ''}` : '新建整合包'}</strong>
          </span>
          <ChevronRight size={16} className="home-version-chevron" />
        </button>
        </div>
      </section>
    </div>
  )
}

/**
 * 「Agent 速装」网格：DSH 领衔 + 六个 CLI/桌面端工具平铺在首页，状态与一键安装就地可见。
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
    <div className="agent-quick">
      <div className="agent-quick-head">
        <Bot size={14} />
        <span>Agent 速装</span>
        <button type="button" className="agent-quick-more" onClick={() => onNavigateTab('agents')}>
          配置与详情<ChevronRight size={12} />
        </button>
      </div>
      {error && <div className="agent-quick-error">{error}</div>}
      <div className="agent-quick-grid">
        {/* DSH 领衔卡：安装/启动走下方大按钮与整合包页，卡片点击跳「整合包」。 */}
        <button
          type="button"
          className={`agent-quick-card ${dshInstallation.installed ? 'installed' : ''}`}
          onClick={() => onNavigateTab('packs')}
          title="DeepSeek Harness：本启动器最深度的本地工作台，安装与启动在下方大按钮"
        >
          <span className="agent-quick-name">
            DeepSeek Harness
            <i className="agent-quick-offline">本体</i>
          </span>
          <span className="agent-quick-state">
            {dshInstallation.installed
              ? <><Check size={11} />已安装{dshInstallation.version ? ` v${dshInstallation.version}` : ''}</>
              : <>未安装 · 下方大按钮</>}
          </span>
        </button>
        {(state?.entries ?? []).map(({ definition, record }) => {
          const working = busyId === definition.id
          return (
            <button
              key={definition.id}
              type="button"
              className={`agent-quick-card ${record ? 'installed' : ''}`}
              onClick={() => onNavigateTab('agents')}
              title={`${definition.name}：${record ? '已安装，点此查看配置' : definition.tagline}`}
            >
              <span className="agent-quick-name">
                {definition.name}
                {record?.source === 'offline-bundle' && <i className="agent-quick-offline">离线</i>}
              </span>
              <span className="agent-quick-state">
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
                  className="agent-quick-install"
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
        {!state && <span className="agent-quick-state">正在读取工具目录…</span>}
      </div>
    </div>
  )
}
