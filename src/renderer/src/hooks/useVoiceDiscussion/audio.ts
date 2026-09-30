/** 语音讨论 — 音频解码纯函数（无 React 语义，自 useVoiceDiscussion.ts 拆出） */

/** 解码音频 Blob 为 16kHz 单声道 PCM */
export async function decodeToPCM(blob: Blob): Promise<Float32Array> {
  const TARGET_SR = 16000
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new AudioContext()
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
  audioCtx.close()
  const targetLength = Math.ceil(audioBuffer.duration * TARGET_SR)
  const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SR)
  const source = offlineCtx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(offlineCtx.destination)
  source.start()
  const rendered = await offlineCtx.startRendering()
  return rendered.getChannelData(0).slice()
}
