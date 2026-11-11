// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音引擎（常驻）：MediaRecorder、系统音频采集、计时和草稿都放在模块级，不跟录音页组件走。
// 切到别的模块、切浏览器标签页都继续录，只有用户点「停止并转写」才停并保存；页面（Page.tsx）和
// 外壳状态条（RecorderStatus.tsx）都只读这里的状态，保存/上传也在这里做，不依赖组件还在不在。
// 浏览器来源（麦克风、分享声音）走 getUserMedia/getDisplayMedia + MediaRecorder；系统来源走插件 /capture 接口，
// 麦克风+系统声音在停止时把麦克风 Blob 一起交给后端混音。音频和文本都不出本机。
import { useSyncExternalStore } from 'react'
import {
  errorText, queryClient, recordingApi, recordingKeys,
  type RecordingAudioDeviceList,
} from '../../core/data'
import { mediaErrorText, shareErrorText, systemDeviceHint, type CaptureSource } from './model'

export type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'paused' | 'uploading' | 'error'

export type RecorderState = {
  phase: RecorderPhase
  /** 已录时长（毫秒）；按时间戳算，后台标签页定时器被节流也不影响准确性 */
  elapsedMs: number
  title: string
  error: string
  /** 当前/上次用的录音来源；录完保留，下次默认还用这个 */
  source: CaptureSource
  deviceIndex: number | null
  /** 系统来源能采集的设备；没读过是 null */
  devices: RecordingAudioDeviceList | null
  devicesPending: boolean
  devicesError: string
}

/** 录音文件格式优先级：opus 的 webm 最小最稳，Safari 只有 mp4，最后交给浏览器默认 */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
const SOURCE_STORAGE_KEY = 'pmw.recording.source'
const DEVICE_STORAGE_KEY = 'pmw.recording.device'
/** 同一时间只让一个标签页录音，避免两个页面同时开麦克风 */
const TAB_LOCK_NAME = 'pmw-recording'

export function isSystemSource(source: CaptureSource): boolean {
  return source === 'system' || source === 'mic_system'
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* 无痕模式之类，存不了就算了 */ }
}

function storedSource(): CaptureSource {
  const v = readStorage(SOURCE_STORAGE_KEY)
  return v === 'mic' || v === 'share' || v === 'system' || v === 'mic_system' ? v : 'mic'
}

function storedDevice(): number | null {
  const v = readStorage(DEVICE_STORAGE_KEY)
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

/* ---------- 模块级状态：状态机 + 引擎句柄 ---------- */

function initialState(): RecorderState {
  return {
    phase: 'idle', elapsedMs: 0, title: '', error: '',
    source: storedSource(), deviceIndex: storedDevice(),
    devices: null, devicesPending: false, devicesError: '',
  }
}

let state: RecorderState = initialState()
let stream: MediaStream | null = null
let rec: MediaRecorder | null = null
let chunks: Blob[] = []
/** 录好但还没传上去的音频：保存失败时「重试」只重传，不重新录 */
let blob: Blob | null = null
let mime = 'audio/webm'
/** 后端系统采集要的录音草稿 id */
let draftId: string | null = null
/** 从开始申请授权到录完保存之间禁止重入（连点、StrictMode 双跑 effect） */
let lock = false
/** 每次开始/放弃/停用换一代：申请授权的 await 回来后发现换了代就作废，别把旧流接到新一次录音上 */
let session = 0
let startedAt = 0
let accumulated = 0
let tick: number | null = null
/** 麦克风+系统声音：停止时等 MediaRecorder 的 onstop 把最后一片交回来 */
let micResolve: ((blob?: Blob) => void) | null = null
/** 系统采集开始前麦克风已经录了多久，混音对齐用 */
let micOffset = 0
let systemActive = false
/** 持有的跨标签页锁的放锁函数 */
let releaseTabLock: (() => void) | null = null
let devicesPromise: Promise<RecordingAudioDeviceList | null> | null = null

const listeners = new Set<() => void>()
const savedListeners = new Set<(id: string) => void>()

function emit() {
  for (const fn of [...listeners]) fn()
}

function update(patch: Partial<RecorderState>) {
  state = { ...state, ...patch }
  emit()
}

function getState(): RecorderState {
  return state
}

function nextSession(): number {
  session += 1
  return session
}

function stale(my: number): boolean {
  return my !== session
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 录音界面和外壳状态条都用它读状态；只有状态变化才重渲染 */
export function useRecorder(): RecorderState {
  return useSyncExternalStore(subscribe, getState)
}

/** 保存成功后通知页面跳详情；页面没挂载（用户切走了）就没人听，列表刷新后照样能看到 */
export function subscribeRecorderSaved(fn: (id: string) => void): () => void {
  savedListeners.add(fn)
  return () => { savedListeners.delete(fn) }
}

function notifySaved(id: string) {
  for (const fn of [...savedListeners]) fn(id)
}

/* ---------- 计时：按时间戳算，后台节流不影响时长 ---------- */

function elapsedNow(): number {
  return accumulated + (startedAt ? performance.now() - startedAt : 0)
}

function stopTick() {
  if (tick !== null) window.clearInterval(tick)
  tick = null
}

function startTick() {
  stopTick()
  tick = window.setInterval(() => {
    if (state.phase === 'recording') update({ elapsedMs: elapsedNow() })
  }, 200)
}

/* ---------- 收尾与错误 ---------- */

function stopStream() {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

function detachAndStopRecorder() {
  const r = rec
  rec = null
  micResolve = null
  if (!r) return
  r.onstop = null
  r.ondataavailable = null
  if (r.state !== 'inactive') {
    try { r.stop() } catch { /* 已经停了 */ }
  }
}

/** 启动/采集失败：关掉麦克风和计时，草稿留着给「重试」用 */
function abortEngine() {
  nextSession()
  stopTick()
  stopStream()
  detachAndStopRecorder()
  chunks = []
  micOffset = 0
  systemActive = false
  accumulated = 0
  startedAt = 0
  releaseTab()
  lock = false
}

function failStart(message: string) {
  abortEngine()
  update({ phase: 'error', error: message })
}

/** 保存失败：麦克风已经关了，保留 blob / 草稿，重试只重传 */
function failSave(message: string) {
  update({ phase: 'error', error: message })
  lock = false
  releaseTab()
}

/* ---------- 跨标签页锁 ---------- */

function releaseTab() {
  const release = releaseTabLock
  releaseTabLock = null
  release?.()
}

/** 拿到锁才开录；浏览器不支持 Web Locks 时直接放行 */
async function acquireTabLock(): Promise<boolean> {
  if (releaseTabLock) return true
  if (typeof navigator === 'undefined' || !navigator.locks) return true
  const entered = new Promise<boolean>((resolve) => {
    try {
      void navigator.locks.request(TAB_LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return }
        resolve(true)
        return new Promise<void>((release) => { releaseTabLock = release })
      }).catch(() => resolve(true))
    } catch {
      resolve(true)
    }
  })
  return entered
}

/* ---------- 保存 ---------- */

function buildBlob(): Blob {
  return new Blob(chunks, { type: mime || 'audio/webm' })
}

function resetToIdle() {
  nextSession()
  stopTick()
  draftId = null
  blob = null
  chunks = []
  micResolve = null
  micOffset = 0
  systemActive = false
  accumulated = 0
  startedAt = 0
  mime = 'audio/webm'
  lock = false
  releaseTab()
  update({ phase: 'idle', elapsedMs: 0, title: '', error: '' })
}

async function invalidateList() {
  try { await queryClient.invalidateQueries({ queryKey: recordingKeys.all }) } catch { /* 缓存不可用不影响保存 */ }
}

/** 浏览器来源保存：建草稿（没有就建）→ 上传音频 → 排队转写 */
async function saveBrowser(audio: Blob, durationMs: number) {
  update({ phase: 'uploading', error: '' })
  try {
    let id = draftId
    if (!id) {
      const created = await recordingApi.create({ title: state.title.trim() })
      id = created.id
      draftId = id
    }
    await recordingApi.uploadAudio(id, audio, durationMs)
    void invalidateList()
    blob = null
    resetToIdle()
    notifySaved(id)
  } catch (e) {
    failSave(`保存失败：${errorText(e)}`)
  }
}

/** MediaRecorder 停了：收拾流、组 Blob、进入上传（浏览器来源） */
async function finishBrowser() {
  stopTick()
  const durationMs = Math.round(accumulated)
  const audio = buildBlob()
  chunks = []
  stopStream()
  update({ elapsedMs: durationMs })
  if (!audio.size) {
    failSave('没有录到声音：检查麦克风是否静音，或换一个输入设备再试')
    return
  }
  blob = audio
  await saveBrowser(audio, durationMs)
}

/** MediaRecorder 的 onstop：麦克风+系统声音要先交回最后一片，普通录音直接进保存 */
function handleRecorderStop() {
  const resolve = micResolve
  rec = null
  if (resolve) {
    micResolve = null
    rec = null
    stopStream()
    const audio = buildBlob()
    chunks = []
    resolve(audio.size ? audio : undefined)
    return
  }
  void finishBrowser()
}

/* ---------- 设备 ---------- */

function autoPickDevice(info: RecordingAudioDeviceList) {
  if (!info.devices.length) return
  if (state.deviceIndex != null && info.devices.some((d) => d.index === state.deviceIndex)) return
  const pick = info.devices.find((d) => d.virtual) ?? info.devices[0]
  setRecorderDevice(pick.index)
}

/** 读本机音频设备；系统来源开始录音前会调，页面选来源时也调（半分钟缓存由调用方按需 force） */
export async function ensureDevices(force = false): Promise<RecordingAudioDeviceList | null> {
  if (!force && state.devices) {
    autoPickDevice(state.devices)
    return state.devices
  }
  if (!force && devicesPromise) return devicesPromise
  update({ devicesPending: true, devicesError: '' })
  const p = (async (): Promise<RecordingAudioDeviceList | null> => {
    try {
      const info = await recordingApi.audioDevices()
      update({ devices: info, devicesPending: false })
      autoPickDevice(info)
      return info
    } catch (e) {
      update({ devicesPending: false, devicesError: errorText(e) })
      return null
    } finally {
      devicesPromise = null
    }
  })()
  devicesPromise = p
  return p
}

/* ---------- 开始录音 ---------- */

/** 浏览器来源：麦克风 / 分享标签页或屏幕声音；my 是本代编号，await 回来发现换了一代就作废 */
async function startBrowser(my: number) {
  const source = state.source
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    failStart('浏览器不允许录音：当前页面不是安全上下文。请用 http://127.0.0.1 或 https://localhost 打开工作台（内网 http 域名用不了麦克风）')
    return
  }
  if (typeof MediaRecorder === 'undefined') {
    failStart('这个浏览器不支持录音（没有 MediaRecorder）：换 Chrome、Edge 或新版 Safari 再试')
    return
  }

  let media: MediaStream
  try {
    if (source === 'share') {
      if (!navigator.mediaDevices.getDisplayMedia) {
        failStart('这个浏览器不支持分享标签页声音：换 Chrome、Edge 或新版 Safari，或者改用「麦克风」/「系统声音（本机设备）」')
        return
      }
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      const audioTracks = display.getAudioTracks()
      display.getVideoTracks().forEach((t) => t.stop())
      if (!audioTracks.length) {
        display.getTracks().forEach((t) => t.stop())
        failStart('没拿到共享的声音：分享窗口里要勾选「分享标签页声音」/「分享系统音频」，并且选的是标签页或整个屏幕')
        return
      }
      media = new MediaStream(audioTracks)
    } else {
      media = await navigator.mediaDevices.getUserMedia({ audio: true })
    }
  } catch (e) {
    if (!stale(my)) failStart(source === 'share' ? shareErrorText(e) : mediaErrorText(e))
    return
  }
  // 申请期间被放弃/停用：别把麦克风一直开着
  if (stale(my) || state.phase !== 'requesting') {
    media.getTracks().forEach((t) => t.stop())
    return
  }
  stream = media

  const mimeType = pickMimeType()
  let r: MediaRecorder
  try {
    r = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media)
  } catch {
    failStart('这个浏览器不支持当前的录音格式：换一个浏览器再试')
    return
  }
  mime = r.mimeType || mimeType || 'audio/webm'
  rec = r
  chunks = []
  r.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  r.onstop = handleRecorderStop
  // 用户点浏览器的「停止共享」/拔掉麦克风时音轨会 ended：自动停下来保存已录部分
  media.getAudioTracks().forEach((t) => {
    t.addEventListener('ended', () => {
      if (state.phase === 'recording' || state.phase === 'paused') stopRecording()
    })
  })
  accumulated = 0
  startedAt = performance.now()
  update({ phase: 'recording', elapsedMs: 0 })
  startTick()
  r.start(1000)
}

/** 麦克风 + 系统声音：先开麦克风，再让后端开始录系统音频（反过来会丢开头） */
async function startDual(my: number) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    failStart('浏览器不允许录音：请用 http://127.0.0.1 或 https://localhost 打开工作台')
    return
  }
  let media: MediaStream
  try {
    media = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    if (!stale(my)) failStart(mediaErrorText(e))
    return
  }
  if (stale(my) || state.phase !== 'requesting') {
    media.getTracks().forEach((t) => t.stop())
    return
  }
  stream = media
  const mimeType = pickMimeType()
  let r: MediaRecorder
  try {
    r = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media)
  } catch {
    failStart('这个浏览器不支持当前的录音格式：换一个浏览器再试')
    return
  }
  mime = r.mimeType || mimeType || 'audio/webm'
  rec = r
  chunks = []
  r.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  r.onstop = handleRecorderStop
  r.start(1000)
  const micStartedAt = performance.now()
  micOffset = 0
  await startSystemRemote(my, micStartedAt)
}

/** 建草稿 + 让后端开始采集系统音频；dual 时麦克风已经在录了 */
async function startSystemRemote(my: number, micStartedAt: number) {
  const info = await ensureDevices()
  if (stale(my)) return
  if (!info) {
    failStart(state.devicesError || '正在读取本机音频设备，稍等一下再点「开始录音」')
    return
  }
  if (!info.supported || !info.ffmpeg) {
    failStart(systemDeviceHint(info))
    return
  }
  const device = info.devices.find((d) => d.index === state.deviceIndex) ?? info.devices.find((d) => d.virtual) ?? info.devices[0]
  if (stale(my)) return
  if (!device) {
    failStart(systemDeviceHint(info))
    return
  }
  let id = draftId
  if (!id) {
    try {
      const created = await recordingApi.create({ title: state.title.trim() })
      id = created.id
      draftId = id
    } catch (e) {
      if (!stale(my)) failStart(`建录音失败：${errorText(e)}`)
      return
    }
  }
  if (stale(my)) return
  const reqStart = performance.now()
  try {
    await recordingApi.startCapture(id, device.index)
  } catch (e) {
    if (!stale(my)) failStart(`开始采集系统声音失败：${errorText(e)}`)
    return
  }
  if (stale(my)) {
    // 采集已经起来了但这一代作废（用户放弃/停用）：把后端采集停掉
    try { await recordingApi.cancelCapture(id) } catch { /* 采集可能已经停了 */ }
    return
  }
  systemActive = true
  if (state.source === 'mic_system') micOffset = Math.max(0, reqStart - micStartedAt)
  accumulated = 0
  startedAt = performance.now()
  update({ phase: 'recording', elapsedMs: 0 })
  startTick()
  void invalidateList()
}

/** 开始录音：按当前来源走浏览器或后端系统采集；只有空闲/上次失败时能起 */
export async function startRecording(): Promise<void> {
  if (lock) return
  if (state.phase !== 'idle' && state.phase !== 'error') return
  lock = true
  const my = nextSession()
  blob = null
  chunks = []
  update({ phase: 'requesting', error: '' })
  const locked = await acquireTabLock()
  if (stale(my)) { releaseTab(); return }
  if (!locked) {
    lock = false
    update({ phase: 'error', error: '另一个标签页正在录音：先停掉那边的录音再试' })
    return
  }
  try {
    if (state.source === 'mic' || state.source === 'share') await startBrowser(my)
    else if (state.source === 'mic_system') await startDual(my)
    else await startSystemRemote(my, 0)
  } catch (e) {
    if (!stale(my)) failStart(`录音没开起来：${errorText(e)}`)
  }
}

/* ---------- 暂停 / 继续 / 停止 / 放弃 / 重试 ---------- */

export function pauseRecording() {
  const r = rec
  if (!r || r.state !== 'recording' || isSystemSource(state.source)) return
  accumulated += performance.now() - startedAt
  stopTick()
  update({ elapsedMs: Math.round(accumulated), phase: 'paused' })
  r.pause()
}

export function resumeRecording() {
  const r = rec
  if (!r || r.state !== 'paused') return
  startedAt = performance.now()
  update({ phase: 'recording' })
  startTick()
  r.resume()
}

/** 停止麦克风录制，等 onstop 交回最后一块音频（麦克风+系统声音用） */
function stopMicRecorder(): Promise<Blob | undefined> {
  const r = rec
  if (!r) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    micResolve = resolve
    if (r.state === 'inactive') {
      micResolve = null
      stopStream()
      resolve(undefined)
      return
    }
    r.stop()
  })
}

/** 系统音频停止：停采集，把麦克风一起交给后端混音；保存完通知页面 */
async function stopSystem() {
  if (state.phase !== 'recording') return
  stopTick()
  const durationMs = Math.round(elapsedNow())
  update({ phase: 'uploading', elapsedMs: durationMs })
  const id = draftId
  if (!id) {
    failSave('录音草稿不见了，重新录一次')
    return
  }
  try {
    let mic: Blob | undefined
    if (state.source === 'mic_system') mic = await stopMicRecorder()
    await recordingApi.stopCapture(id, { mic, durationMs, micOffsetMs: micOffset })
    systemActive = false
    void invalidateList()
    resetToIdle()
    notifySaved(id)
  } catch (e) {
    failSave(`保存失败：${errorText(e)}`)
  }
}

/** 停止：浏览器来源交给 MediaRecorder（onstop 里保存），系统来源走后端 /capture/stop */
export function stopRecording() {
  if (isSystemSource(state.source)) {
    void stopSystem()
    return
  }
  const r = rec
  if (!r) return
  if (r.state === 'recording') accumulated += performance.now() - startedAt
  stopTick()
  update({ elapsedMs: Math.round(accumulated) })
  r.stop()
}

/** 放弃：丢掉半截录音；系统来源还要停掉后端采集、删掉草稿 */
export function discardRecording() {
  nextSession()
  const id = draftId
  const wasSystem = isSystemSource(state.source) && systemActive
  stopTick()
  stopStream()
  detachAndStopRecorder()
  chunks = []
  blob = null
  draftId = null
  accumulated = 0
  startedAt = 0
  systemActive = false
  micOffset = 0
  lock = false
  releaseTab()
  update({ phase: 'idle', elapsedMs: 0, title: '', error: '' })
  if (!id) return
  void (async () => {
    if (wasSystem) {
      try { await recordingApi.cancelCapture(id) } catch { /* 采集可能已经停了 */ }
    }
    try { await recordingApi.remove(id) } catch { /* 草稿可能已经没了 */ }
    void invalidateList()
  })()
}

/** 失败重试：有录好的 Blob 就只重传音频；否则按当前来源重新开录 */
export function retryRecording() {
  if (blob) {
    void saveBrowser(blob, Math.round(accumulated))
    return
  }
  void startRecording()
}

/* ---------- 设置项 ---------- */

export function setRecorderTitle(title: string) {
  update({ title })
}

export function setRecorderSource(source: CaptureSource) {
  if (state.phase !== 'idle' && state.phase !== 'error') return
  writeStorage(SOURCE_STORAGE_KEY, source)
  update({ source })
  if (isSystemSource(source)) void ensureDevices()
}

export function setRecorderDevice(index: number) {
  if (!Number.isInteger(index) || index < 0) return
  writeStorage(DEVICE_STORAGE_KEY, String(index))
  update({ deviceIndex: index })
}

/* ---------- 生命周期 ---------- */

/** 插件停用时收尾：正在录就照常停并保存（用户没点停止也先存下来），空转就清掉 */
export function disposeRecorder() {
  if (state.phase === 'recording' || state.phase === 'paused') {
    stopRecording()
    return
  }
  if (state.phase === 'uploading') return
  abortEngine()
  update({ phase: 'idle', elapsedMs: 0, error: '' })
}

/** 测试用：把模块级状态清干净，避免用例之间串 */
export function resetRecorderForTest() {
  abortEngine()
  draftId = null
  blob = null
  chunks = []
  mime = 'audio/webm'
  savedListeners.clear()
  devicesPromise = null
  state = { ...initialState(), source: 'mic', deviceIndex: null, devices: null }
  emit()
}

/** 测试/调试用：不走 hook 读当前状态 */
export function getRecorderState(): RecorderState {
  return state
}

if (typeof window !== 'undefined') {
  // 录音中刷新/关页会丢；浏览器只能提示，拦不住
  window.addEventListener('beforeunload', (e) => {
    if (state.phase === 'recording' || state.phase === 'paused' || state.phase === 'uploading') {
      e.preventDefault()
      e.returnValue = ''
    }
  })
  // 从后台标签页切回来：定时器可能被节流到 1 分钟一次，立刻按时间戳刷新一次计时
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.phase === 'recording') update({ elapsedMs: elapsedNow() })
  })
}
