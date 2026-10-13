# Agent Hub 优化报告（v1.0.3 → v1.0.4）

- 日期：2026-10-13
- 范围：交付体积、依赖治理、构建配置与 CI、代码质量抽查、深度安全扫描分诊
- 基线：`E:\agent-hub-build`（2026-10-16:46 产物）；源码 `E:\agent hub\agent-launcher`
- 检查方式：全量 vitest + tsc --noEmit + app.asar 解包分析 + win-unpacked 体积画像 + 构建/CI 配置审查 + 源码引用追踪 + Mimosa 深度安全扫描（分诊结论见 [SECURITY-SCAN-TRIAGE.md](SECURITY-SCAN-TRIAGE.md)：433 条发现 → 3 项真实修复，其余为误报/已防护/设计固有）

## 基线状态（优化前）

| 项 | 值 |
| --- | --- |
| vitest | **953 passed / 11 skipped / 0 failed**（104 个文件） |
| tsc --noEmit | 0 错误 |
| portable exe | `Agent-Hub-1.0.3-portable.exe` = **94,568,138 B（90.2 MiB）** |
| win-unpacked | 387 MB |
| app.asar | 37 MB（其中解包后 node_modules 占 42 MB 原始体积） |
| locales | 47 MB / 55 种语言 |
| README 徽标 | 「tests 933 passing」（已过时，实际 953） |

> 注：README 写 933，实测 953 —— 以实测为准。

## 问题清单

状态：✅ 已修复｜📋 建议后续处理

### P1 体积类

| # | 状态 | 问题 | 证据 | 处理 | 收益 |
| --- | --- | --- | --- | --- | --- |
| 1 | ✅ | **asar 内打包了整套生产依赖 node_modules**，而所有依赖已被 vite 打进 dist/dist-electron，纯属双份携带 | asar 解包 node_modules=42MB；`dist-electron/main.js` 内含 27 处 adm-zip 打包标记；electron/ 源码无任何 `require()` 动态引用 | 把 `@xmldom/xmldom` `adm-zip` `lucide-react` `react` `react-dom` `yaml` `yauzl` `yazl` 移到 devDependencies，生产 dependencies 清空 | asar 37MB → 4MB（含 #2 #3 #5 收益） |
| 2 | ✅ | **koffi 是死依赖**：electron/ 与 src/ 零引用（window-shadow.ts 已改纯 CSS 阴影实现），但仍在 dependencies 且走 extraResources 复制二进制、被 asar.unpacked 解包 | `grep -rn koffi electron/ src/` = 0 处；无动态 require | 从 dependencies 删除；删除 build.extraResources 的 koffi 段 | asar -4MB + resources/koffi 目录消失 |
| 3 | ✅ | **react-markdown / remark-gfm 是死依赖**：全项目（src/electron/tests/index.html）零引用，却拖进整棵 unified/remark 依赖树进 asar | `grep -rn "react-markdown\|remark-gfm"` = 0 处 | 从 dependencies 删除 | asar -3MB 级 |
| 4 | ✅ | **携带 55 种语言包（47MB）**，界面只有简中（+英文兜底） | win-unpacked/locales 47MB、55 个 .pak | 构建配置加 `electronLanguages: [en-US, zh-CN, zh-TW]` | win-unpacked -45MB 级 |
| 5 | ✅ | **生产构建带 sourcemap**（dist 内 1.6MB .map；map 还会让 asar 膨胀），终端用户用不到且泄露源码结构 | `build.sourcemap: true`（vite.config.ts）；dist/assets/*.map 实测 1.6MB | vite.config.ts 改 `sourcemap: false`（dev 不受影响） | dist -1.6MB |
| 6 | ✅ | **demo-api（2182 行 mock API）无条件进生产包**：`src/api/client.ts:22` 动态 import 无环境守卫，生产渲染层永远走不到（preload 提供 window.api） | client.ts 的 resolve 逻辑；demo-api-*.js chunk 71KB + map 176KB | 加 `import.meta.env.DEV` 守卫，生产构建 tree-shake 掉整个 chunk | dist -250KB 级 |
| 7 | ✅ | **未启用压缩上限** | package.json build 无 compression 配置 | `compression: "maximum"` | portable/installer 再降数 MB |
| 8 | ✅ | **win-unpacked 携带 20MB LICENSES.chromium.html** | win-unpacked 根目录实测 20MB | 新增 `scripts/after-pack.cjs`（afterPack 钩子）删除该文件。⚠️ 法律提示：这是 Chromium 第三方许可文本，删除后分发物不再携带完整许可清单（Chromium 内部 about:credits 仍含），商用分发前建议恢复 | win-unpacked -20MB |
| 9 | 📋 | **whale-avatar.png 370KB 未压缩**（public/ 静态资源直通 dist） | dist/whale-avatar.png 370KB | 建议用 tinypng/oxipng 压到 ~150KB；需装工具或手动处理，本次未动 | ~200KB |
| 10 | 📋 | **dxcompiler.dll 25MB**（Electron 43 自带，D3D 着色器编译） | win-unpacked 实测 | 删除可再省 25MB（unpacked 口径），但在部分 GPU/驱动组合下有渲染风险，本次不动 | （风险换体积，不建议） |

### P2 构建 / 发布流程类

| # | 状态 | 问题 | 证据 | 处理 |
| --- | --- | --- | --- | --- |
| 11 | ✅ | **只有 portable 交付形态**，portable 每次启动要解压全部文件到 %TEMP%，启动慢、留垃圾、被杀软误报概率高 | package.json `win.target: ["portable"]` | 增加 `nsis` target（辅助式安装器：可选目录、建桌面/开始菜单快捷方式、per-user 免管理员），artifactName `Agent-Hub-${version}-setup.exe` |
| 12 | ✅ | **package.json repository/homepage 仍指向上游 rirko/dsh-melody-launcher**，而本 fork 已独立演进（README 徽标指向 Miyazawai fork） | package.json 对比 README 徽标 | 改为 `github.com/Miyazawai/DSH-Melody-Launcher-Overture` |
| 13 | ✅ | **CI artifact 名过时**：叫 `DSH-Launcher-portable`（产品已更名 Agent Hub，且现在含安装器） | .github/workflows/build.yml | 改名 `Agent-Hub-artifacts`；`release/*.exe` 通配已自动覆盖两种 exe，无需改路径 |
| 14 | ✅ | **package:win 脚本写死 portable** | `"electron-builder --win portable"` | 改 `electron-builder --win`（跟随配置的全部 target） |
| 15 | 📋 | **offline-packs 构建脚本产物不进 git**，`zcode/` 安装器需维护者手动放入（README 已写明，属设计而非缺陷） | scripts/build-offline-packs.mts、offline-packs/README.md | 维持现状，无需处理 |

### P3 代码质量类

| # | 状态 | 问题 | 证据 | 处理 |
| --- | --- | --- | --- | --- |
| 16 | ✅ | README 测试徽标数字过时（933 vs 实测 953） | README.md 徽标 | 更新为 953+ |
| 17 | ✅ | CHANGELOG 缺 v1.0.4 条目 | CHANGELOG.md | 补 v1.0.4 发布说明 |
| 18 | 📋 | **dist-electron 出现同名库多份 chunk**（command-*.js ×3、process-*.js ×3、zip-writer-*.js ×2）：main 与 snapshot-pack-worker 两个入口各自拉一份共享模块 | dist-electron 目录实测 | 可用 rollup manualChunks 合并，收益 ~几百 KB 压缩前；改动构建分块策略有一定回归风险，建议需要时再做 |
| 19 | 📋 | 主进程 90+ 模块单层平铺（electron/ 目录），无子域分组（仅 agent-cli/ 一个子目录） | electron/ 目录列表 | 结构性重组收益在可维护性、无行为收益；fork 已确认按自己方向走，建议在下次功能迭代时按域分组（pack*、plugin*、skill*、dsh*、desktop* 等） |
| 20 | 📋 | src/demo-api.ts 2182 行、SettingsView.tsx 1568 行、types.ts 1548 行、use-launcher-store.ts 1383 行，单文件偏大 | wc -l 统计 | 属重构议题，无行为收益，本次不动 |

## 体积收益（实测）

| 口径 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| portable exe | 94,568,138 B（90.2 MiB） | **84,708,408 B（80.8 MiB）** | **-9.4 MiB（-10.4%）** |
| win-unpacked | 387 MB | **287 MB** | **-100 MB（-26%）** |
| app.asar | 37 MB | **4 MB** | -89% |
| locales | 47 MB / 55 语言 | 2 MB / 3 语言 | -96% |
| dist（渲染层产物） | 5 MB（含 1.6MB map + demo chunk） | 3 MB（0 map、0 demo） | -40% |
| 新增交付物 | — | Agent-Hub-1.0.4-setup.exe（85,015,894 B）+ .blockmap | NSIS 安装器 |

> 说明：portable 的绝对收益小于 win-unpacked，因为其体积主体是 Electron 运行时
> （unpacked 216MB，压缩后 ~55-60MB），该部分不可削减；asar 与 locales 的削减
> 在 NSIS/LZMA 压缩后折算约 10MB。

## 验证记录（2026-10-13 全部通过）

- [x] vitest 全绿：**953 passed / 11 skipped / 0 failed**（改动前后同数）
- [x] tsc --noEmit 零错误
- [x] electron-builder 26.15.3 产出 `Agent-Hub-1.0.4-portable.exe` + `Agent-Hub-1.0.4-setup.exe` 至 E:\agent-hub-build（日志确认 `no node modules returned`、`after-pack: removed LICENSES.chromium.html`、两 exe 均通过 signtool 签名步骤）
- [x] 新 portable exe 启动验证：electron 进程带 "Agent Hub" 主窗口正常出现，验证后关闭
- [x] asar 复检：仅含 dist / dist-electron / package.json，零 node_modules、零 sourcemap、零 demo chunk
- [x] 旧 Agent-Hub-1.0.3-portable.exe 已按约定清除

### P4 安全扫描类（Mimosa deep，433 条发现，详见 SECURITY-SCAN-TRIAGE.md）

| # | 状态 | 问题 | 证据 | 处理 |
| --- | --- | --- | --- | --- |
| 21 | ✅ | 子进程环境可决定批处理解释器（ComSpec） | process.ts:130 原取 `environment.ComSpec` | 只认启动器自身环境的 ComSpec |
| 22 | ✅ | 导入包依赖名未过白名单即进路径拼接（`..` 段写入原语） | main.ts fillMissingDependencies 循环 | `isSafePackageName` 门禁，非法名跳过 |
| 23 | ✅ | 远端 Release version 未消毒直拼下载文件名 | official-pack.ts officialPackAssetName | 与 installer.ts 同款字符消毒 |
| 24 | 📋 | 扫描范围含 dist/dist-electron 编译产物与捆绑库，产生 307+ 条 addLocalFile 误报 | main.js:1657 为 adm-zip 库压缩代码 | 建议后续配置忽略构建输出目录 |
| 25 | 📋 | 覆盖状态 partial：动态派发调用图不完整 | coverage.json gaps | 如需更强保证补运行时验证 |

## 改动文件清单

见同版本 git commit（本地提交，未 push）。
