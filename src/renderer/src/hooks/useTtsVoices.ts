import { useEffect, useState } from 'react'

export interface TtsVoiceInfo {
  shortName: string
  name: string
  gender: string
  locale: string
}

/**
 * 拉取 Edge TTS 音色列表。
 * 主进程侧有进程内缓存，面板与设置页各自的调用不会重复走网络。
 */
export function useTtsVoices(): TtsVoiceInfo[] {
  const [voices, setVoices] = useState<TtsVoiceInfo[]>([])

  useEffect(() => {
    let alive = true
    void window.api.voice.tts.voices().then((list) => {
      if (alive && list && list.length > 0) setVoices(list)
    })
    return () => {
      alive = false
    }
  }, [])

  return voices
}

/** 中文音色优先排序 */
export function sortVoicesZh(list: TtsVoiceInfo[]): TtsVoiceInfo[] {
  return [...list].sort((a, b) => {
    const aZh = a.locale.startsWith('zh') ? 0 : 1
    const bZh = b.locale.startsWith('zh') ? 0 : 1
    if (aZh !== bZh) return aZh - bZh
    return a.shortName.localeCompare(b.shortName)
  })
}
