// electron-builder afterPack 钩子：打包完成后、压 asar/打 exe 前对 app 目录做减法。
// 只删对运行毫无影响的文件；GPU 相关 DLL（d3dcompiler/dxcompiler/vk_swiftshader）一律保留，
// 缺了它们部分显卡/驱动组合会黑屏，不值得为体积冒这个险。
const path = require('node:path')
const { unlink } = require('node:fs/promises')

// Chromium 第三方许可清单，20MB 纯文本。注意：删除后分发物不再自带完整许可
// 文本（Chromium 内部 about:credits 仍有）；若日后对外商用分发，建议恢复。
const REMOVABLE = ['LICENSES.chromium.html']

/** @param {import('app-builder-lib').AfterPackContext} context */
module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context
  if (electronPlatformName !== 'win32') return
  await Promise.all(
    REMOVABLE.map(async (name) => {
      try {
        await unlink(path.join(appOutDir, name))
        console.log(`after-pack: removed ${name}`)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }),
  )
}
