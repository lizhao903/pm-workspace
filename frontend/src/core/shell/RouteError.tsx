// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useState } from 'react'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router'
import { incidentsPagePath } from '../data'
import { isChunkError, reportFrontError, type ReportResult } from './errorReport'
import { checkBuild, type BuildCheck } from './staleBuild'

const LOOPED_DETAIL = '页面的代码分包没加载出来；服务器上已是新版本，自动刷新过一次后页面仍是旧版本'

export function RouteError() {
  const err = useRouteError()
  const chunk = isChunkError(err)
  // 先看是不是服务换了新版本、页面还是旧的；是就自动刷新，不停在「出错了」
  const [checking, setChecking] = useState(!isRouteErrorResponse(err))
  const [build, setBuild] = useState<BuildCheck | null>(null)
  // 检查完仍是错误的记成运行异常（INC-01b）；404 这类路由响应不是缺陷，不报。
  // 分包没取到而服务也连不上（多半在重启）时下不了「版本一致」的结论，不报，提示稍后重新加载
  const [reported, setReported] = useState<ReportResult | null>(null)
  useEffect(() => {
    if (!checking) return
    let live = true
    void checkBuild().then((st) => {
      if (!live || st === 'reloading') return
      setBuild(st)
      setChecking(false)
      if (chunk && st === 'unreachable') return
      void reportFrontError(chunk ? 'chunk' : 'route', err, undefined, chunk && st === 'looped' ? LOOPED_DETAIL : undefined)
        .then((r) => { if (live) setReported(r) })
    })
    return () => { live = false }
  }, [checking, err, chunk])

  let msg = '页面出错了'
  if (isRouteErrorResponse(err)) msg = err.status === 404 ? '页面不存在' : err.status + ' ' + err.statusText
  else if (err instanceof Error) msg = err.message
  if (checking) return <section className="shell-placeholder"><p>正在加载…</p></section>
  return (
    <section className="shell-placeholder">
      <h1>出错了</h1>
      {chunk && (
        <p>{build === 'unreachable' ? '页面代码没加载出来：连不上工作台服务，可能正在重启。稍等几秒再点「重新加载」。' : '页面代码没加载出来，点「重新加载」再试一次。'}</p>
      )}
      <p className={chunk ? 'shell-placeholder-note' : undefined}>{msg}</p>
      {reported?.ok && (
        <p className="shell-placeholder-note">这个错误已记到 <Link to={incidentsPagePath(reported.id)}>设置 / 运行异常</Link>，可以在那里转成研发任务</p>
      )}
      <p><button type="button" className="btn btn-outline btn-sm" onClick={() => location.reload()}>重新加载</button></p>
    </section>
  )
}
