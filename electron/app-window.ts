import { BrowserWindow, screen } from 'electron'
import os from 'node:os'
import type { WindowMode } from '../src/types'
import { attachWindowShadow, showWindowShadow, syncWindowShadow } from './window-shadow'
import { resolveWindowModeTarget, type WindowSize } from './window-bounds'

/** 主窗口的创建、尺寸模式切换，以及发往渲染层的消息通道。 */

// 一级导航改造后：启动页与管理界面共用同一个固定尺寸窗口（PCL2 式单窗换页）。
export const WINDOW_MODES: Record<WindowMode, WindowSize> = {
  launcher: { width: 1080, height: 700, minWidth: 960, minHeight: 620 },
  manager: { width: 1080, height: 700, minWidth: 960, minHeight: 620 },
}

const WINDOW_BACKGROUND_COLOR = '#00000000'
// 不透明窗口（Win11 路径）在首帧画出前的底色，取夜间主题的 chrome 色。
const OPAQUE_BACKGROUND_COLOR = '#161d26'

/**
 * Win11（build ≥ 22000）有原生圆角与窗口阴影，不需要透明分层窗口。
 * 透明窗在 Windows 上最大化/还原后偶发「合成器停在旧帧」——窗口矩形变了、
 * 屏幕画面不重绘（实测间歇复现，invalidate 与关闭渲染节流都救不了呈现层），
 * 属 DWM 对分层窗口的呈现缺陷。Win11 走不透明原生路径整类消失；Win10 无原生
 * 圆角，维持透明 + 自绘阴影的旧行为。
 */
export function hasNativeRoundCorners(): boolean {
  return process.platform === 'win32' && Number(os.release().split('.')[2] ?? 0) >= 22000
}

export function isWindowMode(value: unknown): value is WindowMode {
  return value === 'launcher' || value === 'manager'
}

export interface CreateWindowOptions {
  preloadPath: string
  iconPath: string
  /** 开发模式下的 Vite 地址；缺省则加载打包后的 index.html。 */
  devServerUrl?: string
  indexPath: string
  onClosed: () => void
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const initialSize = WINDOW_MODES.launcher
  const transparent = !hasNativeRoundCorners()
  const window = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: initialSize.minWidth,
    minHeight: initialSize.minHeight,
    // 透明路径：让渲染层的圆角外壳直接成为窗口外缘；Win11 路径：不透明 +
    // 原生圆角，渲染层的圆角与窗口圆角在深色主题下视觉一致。
    backgroundColor: transparent ? WINDOW_BACKGROUND_COLOR : OPAQUE_BACKGROUND_COLOR,
    transparent,
    frame: false,
    // WS_THICKFRAME restores the native shadow but also paints an unavoidable
    // black activation outline. A separate click-through shadow window is used.
    thickFrame: false,
    // Keep the Windows compositor's corner clipping. This is independent of
    // thickFrame: the latter stays disabled to avoid the black activation
    // outline, while roundedCorners restores the v0.1.1 window silhouette.
    roundedCorners: true,
    hasShadow: true,
    icon: options.iconPath,
    title: 'Agent Hub',
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 启动器是常驻实时 UI（进度/日志/日报）；且节流会让被遮挡窗口在最大化后
      // 停在旧帧不重绘（Win10 透明路径仍需要这一层缓解），这里直接关掉。
      backgroundThrottling: false,
    },
  })

  window.setMenuBarVisibility(false)
  // Re-assert the compositor shadow after creating a borderless window.
  window.setHasShadow(true)
  // 透明路径（Win10）的补充缓解：最大化/还原时主动请求一次全量重绘。
  const invalidate = () => window.webContents.invalidate()
  if (transparent) {
    window.on('maximize', invalidate)
    window.on('unmaximize', invalidate)
  }
  window.once('closed', options.onClosed)
  if (transparent) attachWindowShadow(window)
  window.once('ready-to-show', () => {
    window.show()
    showWindowShadow(window)
  })

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl)
  } else {
    void window.loadFile(options.indexPath)
  }
  return window
}

export function applyWindowMode(window: BrowserWindow | null, mode: WindowMode): void {
  if (!window || window.isDestroyed()) return

  const size = WINDOW_MODES[mode]
  if (window.isMaximized()) window.unmaximize()

  // Windows may expose a newly resized region before Chromium paints its next
  // frame. Keep the fallback aligned with the shell color so no gray/white
  // square is exposed during the resize. （透明路径才需要；不透明路径的底色
  // 是常量，重设一个带 alpha 的值反而没有意义。）
  if (hasNativeRoundCorners()) window.setBackgroundColor(OPAQUE_BACKGROUND_COLOR)
  else window.setBackgroundColor(WINDOW_BACKGROUND_COLOR)

  const current = window.getBounds()
  const workArea = screen.getDisplayMatching(current).workArea
  const { bounds, resizeNeeded } = resolveWindowModeTarget(current, size, workArea)
  const targetMinWidth = Math.min(size.minWidth, bounds.width)
  const targetMinHeight = Math.min(size.minHeight, bounds.height)

  if (!resizeNeeded) {
    // 尺寸一致（或本来就贴合）：只对齐限制，位置一律不动——
    // 切开发人员选项不再把用户挪好的窗口拽回屏幕中央。
    window.setMinimumSize(targetMinWidth, targetMinHeight)
    return
  }

  // 仅当工作区装不下设计尺寸时单次 setBounds 收缩（保持窗口中心）。
  // 不再做 100ms 逐帧缩放动画：那是"卡一下再跳走"观感的来源。
  window.setMinimumSize(targetMinWidth, targetMinHeight)
  window.setBounds(bounds)
  syncWindowShadow(window)
}

/**
 * 发往渲染层的单一出口。
 * 「窗口是否还活着」的判断原本在三处推送逻辑里各写了一遍，这里收敛为一处。
 */
export interface RendererChannel {
  send(channel: string, payload: unknown): void
}

export function createRendererChannel(getWindow: () => BrowserWindow | null): RendererChannel {
  return {
    send(channel, payload) {
      const window = getWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(channel, payload)
    },
  }
}
