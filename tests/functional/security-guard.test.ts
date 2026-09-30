/**
 * 功能测试 — 安全守卫 (security-guard.ts)
 *
 * 测试写入保护、敏感文件检测、SSRF 防护。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  setAllowedWriteRoots,
  checkWriteAccess,
  checkSensitiveFile,
  checkSsrf,
  getAllowedWriteRoots
} from '../../src/main/security-guard'

describe('[功能] 写入保护', () => {
  beforeEach(() => {
    setAllowedWriteRoots([])
  })

  it('空白名单时默认允许', () => {
    const result = checkWriteAccess('/anywhere/file.txt')
    expect(result.allowed).toBe(true)
  })

  it('白名单内路径允许', () => {
    setAllowedWriteRoots(['/tmp/project'])
    expect(checkWriteAccess('/tmp/project/src/index.ts').allowed).toBe(true)
    expect(checkWriteAccess('/tmp/project').allowed).toBe(true)
  })

  it('白名单外路径拒绝', () => {
    setAllowedWriteRoots(['/tmp/project'])
    const result = checkWriteAccess('/etc/passwd')
    expect(result.allowed).toBe(false)
    expect(result.reason).toBeDefined()
  })

  it('路径穿越检测 — 不允许通过 ../ 逃逸', () => {
    setAllowedWriteRoots(['/tmp/project'])
    // normalize 会解析 ../
    const result = checkWriteAccess('/tmp/project/../../../etc/passwd')
    expect(result.allowed).toBe(false)
  })

  it('相似前缀不误判 — /tmp/pro 不应匹配 /tmp/project', () => {
    setAllowedWriteRoots(['/tmp/project'])
    const result = checkWriteAccess('/tmp/pro/secret.txt')
    expect(result.allowed).toBe(false)
  })

  it('getAllowedWriteRoots 返回副本', () => {
    setAllowedWriteRoots(['/tmp/a', '/tmp/b'])
    const roots = getAllowedWriteRoots()
    roots.push('/tmp/c')
    expect(getAllowedWriteRoots()).toHaveLength(2)
  })

  it('空字符串被过滤', () => {
    setAllowedWriteRoots(['', '/tmp/valid', ''])
    expect(getAllowedWriteRoots()).toHaveLength(1)
  })

  it('去重', () => {
    setAllowedWriteRoots(['/tmp/dup', '/tmp/dup', '/tmp/dup'])
    expect(getAllowedWriteRoots()).toHaveLength(1)
  })
})

describe('[功能] 敏感文件检测', () => {
  it('SSH 密钥被阻止', () => {
    expect(checkSensitiveFile('/home/user/.ssh/id_rsa').blocked).toBe(true)
    expect(checkSensitiveFile('/home/user/.ssh/id_ed25519').blocked).toBe(true)
    expect(checkSensitiveFile('/home/user/.ssh/id_ecdsa').blocked).toBe(true)
  })

  it('.env 文件被阻止', () => {
    expect(checkSensitiveFile('/project/.env').blocked).toBe(true)
    expect(checkSensitiveFile('/project/.env.local').blocked).toBe(true)
    expect(checkSensitiveFile('/project/.env.production').blocked).toBe(true)
  })

  it('凭据文件被阻止', () => {
    expect(checkSensitiveFile('/home/user/.npmrc').blocked).toBe(true)
    expect(checkSensitiveFile('/home/user/.netrc').blocked).toBe(true)
    expect(checkSensitiveFile('/home/user/.aws/credentials').blocked).toBe(true)
    expect(checkSensitiveFile('/home/user/.docker/config.json').blocked).toBe(true)
  })

  it('密钥/证书文件被阻止', () => {
    expect(checkSensitiveFile('/server.key').blocked).toBe(true)
    expect(checkSensitiveFile('/cert.pem').blocked).toBe(true)
    expect(checkSensitiveFile('/cert.pfx').blocked).toBe(true)
    expect(checkSensitiveFile('/my.keystore').blocked).toBe(true)
  })

  it('普通文件不阻止', () => {
    expect(checkSensitiveFile('/tmp/test.txt').blocked).toBe(false)
    expect(checkSensitiveFile('/project/src/index.ts').blocked).toBe(false)
    expect(checkSensitiveFile('/home/user/package.json').blocked).toBe(false)
  })
})

describe('[功能] SSRF 防护', () => {
  it('正常公网 URL 不阻止', () => {
    expect(checkSsrf('https://example.com/api').blocked).toBe(false)
    expect(checkSsrf('http://api.deepseek.com/v1').blocked).toBe(false)
  })

  it('云元数据端点被阻止', () => {
    expect(checkSsrf('http://169.254.169.254/latest/meta-data/').blocked).toBe(true)
    expect(checkSsrf('http://metadata.google.internal/computeMetadata/').blocked).toBe(true)
  })

  it('回环地址被阻止', () => {
    expect(checkSsrf('http://localhost/admin').blocked).toBe(true)
    expect(checkSsrf('http://127.0.0.1/admin').blocked).toBe(true)
    expect(checkSsrf('http://[::1]/admin').blocked).toBe(true)
  })

  it('内网 IP 范围被阻止', () => {
    expect(checkSsrf('http://10.0.0.1/internal').blocked).toBe(true)
    expect(checkSsrf('http://192.168.1.1/admin').blocked).toBe(true)
    expect(checkSsrf('http://172.16.0.1/test').blocked).toBe(true)
    expect(checkSsrf('http://172.31.255.255/test').blocked).toBe(true)
  })

  it('非 http/https 协议被阻止', () => {
    expect(checkSsrf('file:///etc/passwd').blocked).toBe(true)
    expect(checkSsrf('ftp://example.com/file').blocked).toBe(true)
    expect(checkSsrf('javascript:alert(1)').blocked).toBe(true)
  })

  it('无效 URL 被阻止', () => {
    expect(checkSsrf('not-a-url').blocked).toBe(true)
    expect(checkSsrf('').blocked).toBe(true)
  })

  it('IPv6 链路本地被阻止', () => {
    expect(checkSsrf('http://[fe80::1]/test').blocked).toBe(true)
    expect(checkSsrf('http://[fc00::1]/test').blocked).toBe(true)
  })
})
