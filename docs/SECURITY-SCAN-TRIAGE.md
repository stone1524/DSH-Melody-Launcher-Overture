# Mimosa 深度安全扫描分诊报告（v1.0.4）

## 扫描标识

| 项 | 值 |
| --- | --- |
| scan ID | `scan-2026-10-13T09-15-52.486Z-f8c3289a1930` |
| seal | `sha256:cdec82c2e7cff34f5dfa17a2c2db99f3cea0746f558d619ed9f2ae6a9e901799` |
| 产物目录 | `C:\Users\15248\.mimosa\security-scans\project-cb55faf3f61f031d875fa961\scan-2026-10-13T09-15-52.486Z-f8c3289a1930` |
| 深度 | deep（静态分析，`evidenceBoundary: static_only_no_runtime_execution`） |
| 覆盖 | 256 文件解析、0 读失败、0 解析失败；调用图 10890 函数 / 14113 边；覆盖状态 partial（动态派发调用图不完整，见 coverage.json gaps） |
| 发现总数 | 433（high 207 / medium 226） |
| 依赖风险 | 390 包扫描，0 条公告命中（离线公告库可用） |

> 本报告为人工分诊结论；不据此宣称「项目完全安全」。Mimosa 的覆盖状态为
> partial（inconclusive），未验证的动态派发路径不在本报告保证范围内。

## 分诊总览

433 条发现按根因聚为 6 簇。**真实修复 3 项，其余为误报 / 已有防护 / 设计固有**：

| 簇 | 数量 | 严重度 | 分诊结论 |
| --- | --- | --- | --- |
| addLocalFile 路径穿越（main.js） | 307 | high | **误报**：`addLocalFile` 是 adm-zip 库内部函数（压缩进 `dist-electron/main.js:1657` 的第三方代码），应用源码零调用；污点链终止在捆绑库代码内 |
| 不可信解释器输入（spawn） | 48 | high | **设计固有 + 已缓解**：启动 .cmd/.bat 必须经 cmd.exe；已有批处理引号转义 + 换行/空字符拒绝（process.ts:95-102）+ 上游 `isSafePackageName`/`isSafeRepositoryName` 形状白名单（ipc.ts/installer.ts/desktop-plugins.ts 等 10+ 处） |
| 疑似跨文件污点 | 54 | medium | **误报为主**：污点源均为环境变量/本地设置（本地桌面应用，非远端输入）；其中「子进程环境选择解释器」一条已修复（见修复 #1） |
| 路径穿越（静态，16 处源码） | 16 | high | **13 处已有防护**（assertInside 边界检查 / safeArchivePath / readdir 枚举 / 字符类白名单，逐处证据见下表）；**2 处修复**（#2 #3）；1 处接受（只读列举，无写入原语） |
| 不可信程序选择 | 7 | high | **设计固有**：按产品职责从发现路径拉起 node.exe/CLI；修复 #1 收敛了其中解释器来源 |
| SSRF | 6 | medium | **接受**：目标均为固定主机（raw.githubusercontent / api.github / codeload.github）+ 用户自配镜像；「从用户选择的源拉取」是产品核心功能 |

## 路径穿越 16 处逐条证据

| 位置 | 动态片段 | 防护 | 结论 |
| --- | --- | --- | --- |
| ai-repository-source.ts:253 | safeRelative | join 后 resolve + 前缀边界检查（:255-256） | 已防护 |
| credentials-ref-repair.ts:216 | dshHome + 常量文件名 | 配置值 + 常量拼接 | 已防护 |
| dsh-credentials-compat.ts:253 | backupRoot + entry.name | readdir 枚举名（不含分隔符） | 已防护 |
| dsh-market.ts:698 | settings.profileName | settings.ts:110 写入时 `isSafeProfileName`（字符类无 `/` `\`，造不出 `..` 段） | 已防护 |
| dsh-usage.ts:207 | project + sessionId | readdir 枚举 + 本地会话表；仅只读列举，无写入 | 接受（低危） |
| installer.ts:1034 | 包名 | `replace(/[^a-z0-9._-]+/gi,'-')` 消毒（:1032） | 已防护 |
| ipc.ts:131 | file: 路径 | resolve 后 `candidate === root \|\| startsWith(root+sep)` 边界（:135） | 已防护 |
| main.ts:334 | packageName | ——（依赖名可来自导入包的 package.json，`..` 段可越出插件体目录，cp 写入原语） | **修复 #2** |
| official-pack.ts:225 | version | ——（version 来自远端 Release 元数据，未消毒直拼文件名） | **修复 #3** |
| pack-scan.ts:674 | preset.name | join 后 `assertInside`（:675） | 已防护 |
| pack-zip.ts:794 | fileName | safeArchivePath + 拒绝 `/` + `assertInside`（:790-795） | 已防护 |
| plugin-source.ts:92 | commit | `assertInside(cacheRoot, destination)`（:94）+ 子目录 `../` 检查（:88） | 已防护 |
| preset-install.ts:247 | safeRelative | safeArchivePath + `assertInside`（:242-248） | 已防护 |
| process-supervisor.ts:152 | 常量文件名 | 常量拼接 | 已防护 |
| profile-service.ts:284 | entry.name | readdir + `isSafeProfileName` 过滤（:283） | 已防护 |
| session-transfer.ts:283 | item.name | readdir 枚举名 | 已防护 |

## 已实施的修复（3 项）

1. **electron/process.ts（解释器来源收敛）**：`.cmd/.bat` 的解释器原取 `environment.ComSpec`（传给子进程的环境，其中可能混有整合包配置键）→ 改为只认启动器自身 `process.env.ComSpec || 'cmd.exe'`。解释器是启动器的工具选择，不应由目标环境决定。
2. **electron/main.ts（依赖名门禁）**：`fillMissingDependencies` 复用兄弟 profile 插件体时，`missing` 里的包名未过形状校验就进 `path.join(..., ...packageName.split('/'), version)`；导入的整合包属不可信输入，依赖名携带 `..` 段即获得越出 `.dsh-launcher-plugin-bodies` 的写入原语。现在先过 `isSafePackageName`，非法名直接跳过。
3. **electron/official-pack.ts（版本消毒）**：`officialPackAssetName` 把远端 Release 元数据里的 version 原样拼进下载文件名 → 先 `replace(/[^0-9A-Za-z._+-]/g, '_')` 消毒，与 installer.ts 对本地版本的处理同款。

## 验证

- [x] vitest 953 passed / 11 skipped / 0 failed（修复后）
- [x] tsc --noEmit 零错误（修复后）
- [x] 修复触及主进程运行时 → 按约定重打包 portable + setup 至 E:\agent-hub-build 并做启动验证（结果见 OPTIMIZATION-REPORT.md 验证记录）

## 后续建议（未实施）

- 扫描范围包含了 `dist/`、`dist-electron/` 编译产物与捆绑库代码，是 307+ 条误报的来源。建议给 Mimosa 配置忽略构建输出目录（或在打包前扫描），让下次深扫的信号噪声比可读。
- coverage 状态 partial：动态派发调用图不完整。若后续需要更强保证，可补运行时验证类扫描。
