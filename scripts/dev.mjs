#!/usr/bin/env node
/**
 * 开发/预览启动器。
 *
 * 背景：当 `ELECTRON_RUN_AS_NODE=1` 存在时，electron.exe 会以「纯 Node 进程」运行，
 * electron 内置模块不可用（require('electron') 退化为 npm 包的路径字符串），
 * 主进程启动即失败 → 窗口无内容 = 黑屏。
 * 注入型环境（IDE/Agent 终端、CI）常带此变量，故在此统一剥离。
 *
 * 同时剥离 NODE_OPTIONS：某些宿主注入的 shim 会拦截批量文件删除，
 * 导致 electron-vite 清空 out/ 失败而中断构建。
 *
 * 用法：node scripts/dev.mjs [dev|preview]    （npm run dev / npm start 已接入）
 */
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const task = process.argv[2] || 'dev'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

const env = { ...process.env }
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
  if (env[key] !== undefined) {
    console.log(`[launch] 已剥离 ${key}`)
    delete env[key]
  }
}

const child = spawn(process.execPath, [bin, task], { stdio: 'inherit', env, cwd: root })
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
