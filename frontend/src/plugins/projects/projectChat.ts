// 在项目里开会话（SPEC-projects-10.5、3.6）：Agent 标签的「对话」和概览的「和它对话」共用。
// 后端会话没有 project_id：建成全局会话，工作目录用项目目录，会话 id 记进项目的 props.session_ids。
// 建好后在项目的 Agent 标签里就地打开（地址 ?s=<会话 id>），不跳到会话页
import { useState } from 'react'
import { errorText, projectView, useCreateAgentSession, useSaveProject, type WorkObject } from '../../core/data'
import { addSession } from './agentModel'

export const SESSIONS_PATH = '/conversations'
export const NEW_TITLE = '新会话'
/** 项目里就地打开的会话记在地址的这个参数上 */
export const SESSION_PARAM = 's'

/** 在项目里开会话：建会话、记进项目，再交给 onOpen 在项目里打开 */
export function useProjectChat(project: WorkObject, onOpen: (sessionId: string) => void) {
  const p = projectView(project)
  const create = useCreateAgentSession()
  const save = useSaveProject()
  const [err, setErr] = useState('')
  const start = (agentId: string) => {
    setErr('')
    create.mutate({ title: NEW_TITLE, agent_id: agentId, workdir: p.root }, {
      onError: (e) => setErr(`会话没建起来：${errorText(e)}`),
      onSuccess: (s) => {
        // 记进项目时先读回最新的 props，别处刚开的会话不会被盖掉
        save.mutate({ id: p.id, props: { session_ids: addSession(p.sessionIds, s.id) } }, {
          onError: (e) => setErr(`会话建好了，但没记到项目里：${errorText(e)}`),
          onSuccess: () => onOpen(s.id),
        })
      },
    })
  }
  return { start, pending: create.isPending || save.isPending, err }
}
