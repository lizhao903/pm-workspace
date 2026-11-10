// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 消息抽屉里的「转为商单」（SPEC-videos-16.11，VID-08e）：品牌在 IM 里问报价，转成视频插件的商单。
// 不 import 视频插件，经 core/data 的商单接口读；video 插件没在跑时整节不显示。商单挂在项目下，项目插件没在跑时只给提示。
// 没转过：跳到项目「商单」标签新建，带 message 参数由那边按消息预填询价人、品牌；转过：打开那个商单
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { errorText, useDealProjectResolver, usePlugins, useProjects, useVideoDeals, type ImMessage } from '../../core/data'

const VIDEO_PLUGIN = 'video'
const PROJECTS_PLUGIN = 'projects'
/** 项目插件的路径，商单标签是 /projects/<id>/deals */
const PROJECTS = '/projects'

const dealsPath = (pid: string, q: string) => `${PROJECTS}/${encodeURIComponent(pid)}/deals?${q}`

export function ToDealRow({ msg }: { msg: ImMessage }) {
  const plugins = usePlugins()
  const on = (id: string) => !!plugins.data?.find((p) => p.id === id)?.running
  if (!on(VIDEO_PLUGIN)) return null
  return <DealBody msg={msg} projectsOn={on(PROJECTS_PLUGIN)} />
}

function DealBody({ msg, projectsOn }: { msg: ImMessage; projectsOn: boolean }) {
  const navigate = useNavigate()
  const deals = useVideoDeals()
  const projects = useProjects()
  const resolve = useDealProjectResolver()
  const [busy, setBusy] = useState(false)
  const deal = deals.data?.find((d) => d.source_message_id === msg.id)
  const pids = (projects.data?.data ?? []).filter((p) => !p.deleted_at).map((p) => p.id)

  const toDeal = async () => {
    if (busy) return
    setBusy(true)
    try {
      const pid = await resolve(msg.conversation_id, pids)
      if (pid) navigate(dealsPath(pid, `new=1&message=${encodeURIComponent(msg.id)}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="im-section">商单</div>
      {deal ? (
        <div className="im-act-row">
          <span className="im-muted ellipsis">已转为商单 {deal.brand} · {deal.title}</span>
          {projectsOn && <button type="button" className="im-act" onClick={() => navigate(dealsPath(deal.project_id, `deal=${encodeURIComponent(deal.id)}`))}>打开商单</button>}
        </div>
      ) : !projectsOn ? (
        <div className="im-act-row"><span className="im-muted">商单挂在项目下，项目插件没在跑，转不了</span></div>
      ) : projects.isSuccess && !pids.length ? (
        <div className="im-act-row"><span className="im-muted">还没有项目，先建一个项目再转商单</span></div>
      ) : (
        <div className="im-act-row">
          <button type="button" className="im-act" disabled={busy || deals.isPending || projects.isPending} onClick={() => void toDeal()}>
            {busy ? '找项目中…' : '转为商单'}
          </button>
          <span className="im-muted">询价人、品牌按这条消息预填，商单记下来源</span>
        </div>
      )}
      {deals.isError && <div className="im-err" role="alert">商单没取到：{errorText(deals.error)}</div>}
    </>
  )
}
