// 一格里的 xterm：连后端会话的 WebSocket（二进制收发终端字节，文本帧是 JSON 控制消息），见契约「终端收发」。
// 断线自动重连（带 after 只补发没收到的）；会话没了显示「会话已结束」，shell 退出显示退出码，两种都能「重新打开」。
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { terminalApi, terminalSocketUrl } from '../../core/data'
import { cwdFromOsc7 } from './model'

type Status = { kind: 'connecting' | 'open' | 'reconnecting' | 'gone' } | { kind: 'exited'; code: number }

const RETRY_MS = [500, 1000, 2000, 4000, 8000]

/** 颜色和字体写在 terminal.css 的 --term-* 变量里，这里按生效的样式读 */
function themeOf(el: HTMLElement) {
  const cs = getComputedStyle(el)
  const v = (k: string) => cs.getPropertyValue(k).trim() || undefined
  return {
    font: v('--mono') ?? 'monospace',
    theme: {
      background: v('--term-bg'), foreground: v('--term-fg'), cursor: v('--term-cursor'), selectionBackground: v('--term-sel'),
      black: v('--term-c0'), red: v('--term-c1'), green: v('--term-c2'), yellow: v('--term-c3'),
      blue: v('--term-c4'), magenta: v('--term-c5'), cyan: v('--term-c6'), white: v('--term-c7'),
    },
  }
}

export function XTerm({ session, active, focused, onFocus, onCwd, onSplit, onReopen, onClose }: {
  session: string
  /** 所在标签是当前标签（看得见） */
  active: boolean
  focused: boolean
  onFocus: () => void
  onCwd: (cwd: string) => void
  onSplit: (dir: 'row' | 'col') => void
  /** gone：会话已经没了，不用再删 */
  onReopen: (gone: boolean) => void
  onClose: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'connecting' })
  // 回调放 ref 里，连接只随会话变
  const cb = useRef({ onFocus, onCwd, onSplit })
  useEffect(() => { cb.current = { onFocus, onCwd, onSplit } })

  useEffect(() => {
    const host = hostRef.current!
    const { font, theme } = themeOf(host)
    const term = new Terminal({ fontFamily: font, fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    const enc = new TextEncoder()
    let ws: WebSocket | null = null
    let pos = 0 // 已收到的字节位置
    let tries = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let ended = false

    const send = (data: string | Uint8Array<ArrayBuffer>) => { if (ws?.readyState === WebSocket.OPEN) ws.send(data) }
    const sendSize = () => send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    const refit = () => {
      if (!host.offsetWidth || !host.offsetHeight) return // 藏起来的标签不算
      try {
        fit.fit()
      } catch {
        // 还没排好版
      }
    }

    // 会话还在不在：断线重连失败时问一次列表
    const checkGone = async () => {
      try {
        const all = await terminalApi.list()
        if (!all.some((s) => s.id === session)) {
          ended = true
          setStatus({ kind: 'gone' })
          return true
        }
      } catch {
        // 后端整个连不上，接着重连
      }
      return false
    }

    const connect = (after?: number) => {
      const sock = new WebSocket(terminalSocketUrl(session, after))
      sock.binaryType = 'arraybuffer'
      ws = sock
      sock.onopen = () => { tries = 0; setStatus({ kind: 'open' }); refit(); sendSize() }
      sock.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          const b = new Uint8Array(e.data as ArrayBuffer)
          pos += b.byteLength
          term.write(b)
          return
        }
        let m: { type?: string; from?: number; code?: number }
        try {
          m = JSON.parse(e.data)
        } catch {
          return
        }
        if (m.type === 'replay' && typeof m.from === 'number') pos = m.from
        if (m.type === 'exit') {
          ended = true
          setStatus({ kind: 'exited', code: m.code ?? 0 })
        }
      }
      sock.onclose = (e) => {
        if (ws !== sock || ended) return
        if (e.code === 1013) { connect(pos); return } // 输出积压被踢，马上补
        setStatus({ kind: 'reconnecting' })
        void (async () => {
          if (e.code === 1001 || tries > 0) { if (await checkGone()) return }
          retry = setTimeout(() => connect(pos), RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)])
        })()
      }
    }

    term.onData((d) => send(enc.encode(d)))
    term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)))
    term.onResize(sendSize)
    term.parser.registerOscHandler(7, (data) => {
      const cwd = cwdFromOsc7(data)
      if (cwd) cb.current.onCwd(cwd)
      return true
    })
    // ⌘D 向右拆分、⇧⌘D 向下拆分，不进 shell
    term.attachCustomKeyEventHandler((e) => {
      if (e.metaKey && e.code === 'KeyD') {
        if (e.type === 'keydown') { e.preventDefault(); cb.current.onSplit(e.shiftKey ? 'col' : 'row') }
        return false
      }
      return true
    })
    const onIn = () => cb.current.onFocus()
    term.textarea?.addEventListener('focus', onIn)

    let raf = 0
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(refit) })
    ro.observe(host)
    refit()
    // 先看会话还在不在：刷新前服务重启过的话，不去连一个已经没了的会话
    void checkGone().then((gone) => { if (!gone && !ended) connect() })

    return () => {
      ended = true
      clearTimeout(retry)
      cancelAnimationFrame(raf)
      ro.disconnect()
      term.textarea?.removeEventListener('focus', onIn)
      const sock = ws
      ws = null
      sock?.close()
      term.dispose()
      termRef.current = null
    }
  }, [session])

  // 成为焦点格、切回这个标签时把光标给它
  useEffect(() => {
    if (focused && active && status.kind !== 'gone' && status.kind !== 'exited') termRef.current?.focus()
  }, [focused, active, status.kind])

  return (
    <div className="term-xterm-wrap">
      <div className="term-xterm" ref={hostRef} />
      {status.kind === 'reconnecting' && <div className="term-banner">连接已断开，正在重连</div>}
      {(status.kind === 'gone' || status.kind === 'exited') && (
        <div className="term-ended">
          <span>{status.kind === 'exited' ? `进程已退出（退出码 ${status.code}）` : '会话已结束'}</span>
          <span className="term-ended-acts">
            <button type="button" className="term-act" onClick={(e) => { e.stopPropagation(); onReopen(status.kind === 'gone') }}>重新打开</button>
            {status.kind === 'exited' && (
              <button type="button" className="term-act" onClick={(e) => { e.stopPropagation(); onClose() }}>关闭窗格</button>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
