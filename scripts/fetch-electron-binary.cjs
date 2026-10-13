// 临时脚本：npm install 时 Electron 二进制下载因网络失败后的补跑入口。
// 直接 require 官方 install.js——__dirname 属于该模块自身，dist/path.txt 会落在正确位置。
// 用法：ELECTRON_MIRROR 可用时自动走 npmmirror 镜像。
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
require('../node_modules/electron/install.js');
