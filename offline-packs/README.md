# offline-packs — 内置离线安装包（构建期产出）

这个目录随便携 exe 一起分发（electron-builder extraResources → `resources/offline-packs/`）。
启动器安装 Agent 工具时的通道优先级：

1. `raw-installer`（ZCode 桌面端）：直接运行本目录 `<id>/` 下的官方安装器 exe
2. `offline-bundle`（npm 类 CLI）：解压本目录 `<id>/pack.zip` 到私有前缀，零网络安装
3. 在线镜像（npmmirror 候选链）：以上都没有时回退

## 目录约定

```
offline-packs/
  manifest.json            # 各工具的版本与构建时间（启动器读它回显版本）
  qwen-code/pack.zip       # 内容以 node_modules/ 为根的私有前缀快照
  opencode/pack.zip
  openclaw/pack.zip
  codex/pack.zip
  zcode/ZCode-Setup-x.y.z.exe   # 官方桌面端安装器（维护者手动放入）
```

## 产出方式

```bash
npm run build:offline-packs
```

该脚本在本机（需网络）用 npmmirror 装「各 Agent CLI 最新版」到独立临时前缀，
逐个打包成 `pack.zip` 并生成 manifest。ZCode 桌面端安装器没有公开直链，
由维护者从官方渠道下载后手动放入 `zcode/` 子目录，脚本会把它登记进 manifest。

## 体积提示

每个 pack.zip 约几 MB 到几十 MB；全部内置会让 exe 明显变大。不需要内置的
工具，删掉对应子目录再打包即可——启动器对缺失的离线包自动回退在线安装。
