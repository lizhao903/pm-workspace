import { isRouteErrorResponse, useRouteError } from 'react-router'

export function RouteError() {
  const err = useRouteError()
  let msg = '页面出错了'
  if (isRouteErrorResponse(err)) msg = err.status === 404 ? '页面不存在' : err.status + ' ' + err.statusText
  else if (err instanceof Error) msg = err.message
  return (
    <section className="shell-placeholder">
      <h1>出错了</h1>
      <p>{msg}</p>
    </section>
  )
}
