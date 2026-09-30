import { describe, it, expect } from 'vitest'
import { decodeWslOutput, matchWslVirtualizationError } from '../../src/main/tools/AgentWorkspace/wsl-decode'

describe('decodeWslOutput — wsl.exe UTF-16LE 输出解码', () => {
  it('解码 UTF-16LE 编码的发行版列表', () => {
    const buf = Buffer.from('Debian\r\n', 'utf16le')
    expect(decodeWslOutput(buf)).toBe('Debian')
  })

  it('解码含 CJK 字符的状态输出（isWslFunctional 的「需要」匹配依赖此行为）', () => {
    const buf = Buffer.from('此应用程序需要启用虚拟机平台', 'utf16le')
    expect(decodeWslOutput(buf)).toContain('需要')
  })

  it('多行输出保留换行结构、剔除 \r', () => {
    const buf = Buffer.from('Debian\r\nUbuntu\r\n', 'utf16le')
    expect(decodeWslOutput(buf)).toBe('Debian\nUbuntu')
  })

  it('解码历史 bug 场景 — UTF-8 解码后夹满 \\0 的字节序列', () => {
    // 旧实现把 UTF-16LE 字节按 UTF-8 解码成夹 \0 的字符串再 toString('utf16le')（no-op），
    // 导致 includes('debian') 永远 false；新实现对原始字节正确解码
    const legacyBrokenBytes = Buffer.from('D\x00e\x00b\x00i\x00a\x00n\x00', 'latin1')
    expect(decodeWslOutput(legacyBrokenBytes)).toBe('Debian')
  })

  it('空 Buffer 返回空字符串', () => {
    expect(decodeWslOutput(Buffer.alloc(0))).toBe('')
  })
})

describe('matchWslVirtualizationError — 虚拟化类错误识别', () => {
  it('命中 HCS_E_HYPERV_NOT_INSTALLED 错误码（真实报错场景）', () => {
    const text = '错误码: Wsl/InstallDistro/Service/RegisterDistro/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED'
    expect(matchWslVirtualizationError(text)).toContain('BIOS')
  })

  it('命中中文「虚拟化」提示', () => {
    expect(matchWslVirtualizationError('请确保在 BIOS 中启用虚拟化')).toContain('BIOS')
  })

  it('命中 VT-x/AMD-V/SVM 关键词', () => {
    expect(matchWslVirtualizationError('VT-x is disabled')).toContain('BIOS')
    expect(matchWslVirtualizationError('enable SVM mode in BIOS')).toContain('BIOS')
  })

  it('无关错误返回 null', () => {
    expect(matchWslVirtualizationError('download failed: timeout')).toBeNull()
    expect(matchWslVirtualizationError('')).toBeNull()
  })
})
