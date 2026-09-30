/**
 * wsl.exe 输出解码 — wsl.exe 的 stdout 是 UTF-16LE 编码。
 *
 * 关键坑：不能用 execFile 默认的 UTF-8 解码后再调 `str.toString('utf16le')` ——
 * String.prototype.toString 会忽略参数（no-op），UTF-8 解码后的字符串夹满 \0，
 * 后续 includes() 匹配全部失效。必须以 encoding:'buffer' 接收原始字节再解码。
 */
export function decodeWslOutput(buf: Buffer): string {
  return buf
    .toString('utf16le')
    .replace(/\0/g, '')
    .replace(/\r/g, '')
    .trim()
}

/** 识别「CPU 虚拟化未启用」类错误 — 命中时返回用户可操作的提示，未命中返回 null。
 *  WSL2 创建 VM 失败（HCS_E_HYPERV_NOT_INSTALLED）的绝大多数根因是 BIOS 未开 VT-x/AMD-V。 */
export function matchWslVirtualizationError(text: string): string | null {
  if (
    text.includes('HCS_E_HYPERV_NOT_INSTALLED') ||
    text.includes('HCS_E_SERVICE_NOT_AVAILABLE') ||
    /VT-x|AMD-V|SVM mode/i.test(text) ||
    text.includes('虚拟化')
  ) {
    return 'CPU 虚拟化未启用且 WSL1 不可用 — 请重启进入 BIOS 开启 VT-x/AMD-V（Intel）或 SVM 模式（AMD）后重试'
  }
  return null
}
