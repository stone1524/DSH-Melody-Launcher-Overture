// 构建期离线包生成器：把各 Agent CLI 的「完整前缀快照」打包成离线 zip。
//
// 单包 tgz 装不上（缺依赖树），所以快照的是「在干净前缀里 npm install -g 之后的
// 整个 node_modules」——启动器运行时解压到客户机的私有前缀即可直接运行
// （bin 入口由启动器按 package.json 的 bin 字段直接定位，不依赖 npm shim 的绝对路径）。
//
// 用法：npm run build:offline-packs
// 需要网络（npmmirror）。产物写入项目根 offline-packs/，随 electron-builder 分发。

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { DSH_PACKAGE_NAME } from '../src/constants'

/** 要生成离线包的 npm 类 Agent CLI（与 electron/agent-cli/catalog.ts 对齐）。 */
const NPM_AGENTS = [
  { id: 'qwen-code', pkg: '@qwen-code/qwen-code' },
  { id: 'opencode', pkg: 'opencode-ai' },
  { id: 'openclaw', pkg: 'openclaw' },
  { id: 'codex', pkg: '@openai/codex' },
] as const

const REGISTRY = 'https://registry.npmmirror.com'
const OUT_ROOT = path.resolve(import.meta.dirname, '../offline-packs')

interface PackOutcome {
  id: string
  version: string | null
  sizeBytes: number
}

async function main(): Promise<void> {
  const { runCommand } = await import('../electron/command')
  const scratch = await mkdtemp(path.join(tmpdir(), 'offline-packs-'))
  const outcomes: PackOutcome[] = []

  for (const agent of NPM_AGENTS) {
    const prefix = path.join(scratch, agent.id, 'prefix')
    await mkdir(path.join(prefix, 'node_modules'), { recursive: true })
    console.log(`[offline-packs] 安装 ${agent.pkg} …`)
    const install = await runCommand('npm.cmd', [
      'install', '-g', `${agent.pkg}@latest`,
      '--prefix', prefix,
      '--registry', REGISTRY,
      '--yes', '--fund', 'false', '--audit', 'false',
    ], {
      cwd: scratch,
      env: { ...process.env, CI: 'true' },
      timeoutMs: 10 * 60 * 1000,
      onOutput: () => undefined,
    })
    if (install.exitCode !== 0) {
      console.error(`[offline-packs] ${agent.pkg} 安装失败，跳过（退出码 ${install.exitCode}）`)
      continue
    }
    // 回读实际版本（与启动器同一条路径：包内 package.json）。
    const pkgJsonPath = path.join(prefix, 'node_modules', ...agent.pkg.split('/'), 'package.json')
    let version: string | null = null
    try {
      const manifest = JSON.parse(await readFile(pkgJsonPath, 'utf8')) as { version?: string }
      version = manifest.version ?? null
    } catch {
      version = null
    }

    const packDir = path.join(OUT_ROOT, agent.id)
    await rm(packDir, { recursive: true, force: true })
    await mkdir(packDir, { recursive: true })
    const zip = new AdmZip()
    zip.addLocalFolder(path.join(prefix, 'node_modules'), 'node_modules')
    const zipPath = path.join(packDir, 'pack.zip')
    zip.writeZip(zipPath)
    const size = (await readFile(zipPath)).byteLength
    outcomes.push({ id: agent.id, version, sizeBytes: size })
    console.log(`[offline-packs] ${agent.id} @ ${version ?? '?'} → ${zipPath}（${Math.round(size / 1024 / 1024)}MB）`)
    await rm(path.join(scratch, agent.id), { recursive: true, force: true })
  }

  // ZCode 桌面端：维护者手动放入安装器 exe；这里只登记进 manifest。
  const zcodeDir = path.join(OUT_ROOT, 'zcode')
  const { readdir } = await import('node:fs/promises')
  let zcodeVersion: string | null = null
  try {
    const files = await readdir(zcodeDir)
    const installer = files.find(name => name.toLowerCase().endsWith('.exe'))
    if (installer) {
      const versionMatch = installer.match(/(\d+\.\d+\.\d+)/)
      zcodeVersion = versionMatch?.[1] ?? null
      console.log(`[offline-packs] zcode 桌面端安装器已就位：${installer}`)
    } else {
      console.log('[offline-packs] zcode/ 目录里没有安装器 exe，未内置 ZCode 桌面端。')
    }
  } catch {
    console.log('[offline-packs] zcode/ 目录不存在，未内置 ZCode 桌面端。')
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    registry: REGISTRY,
    dshNote: `DSH 依赖树大（${DSH_PACKAGE_NAME} 82+ 依赖、含 116MB LibreOffice 组件），走 npmmirror 国内直连，不内置离线包。`,
    packs: Object.fromEntries(outcomes.map(outcome => [outcome.id, { version: outcome.version, builtAt: new Date().toISOString() }]))
    // zcode 有安装器时才登记。
    ,
  } as Record<string, unknown>
  if (zcodeVersion) {
    ;(manifest.packs as Record<string, unknown>).zcode = { version: zcodeVersion, builtAt: new Date().toISOString() }
  }
  await mkdir(OUT_ROOT, { recursive: true })
  await writeFile(path.join(OUT_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[offline-packs] manifest.json 已生成（${outcomes.length} 个 npm 包${zcodeVersion ? ' + zcode 桌面端' : ''}）。`)
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
}

void main().catch(error => {
  console.error('[offline-packs] 失败：', error)
  process.exit(1)
})
