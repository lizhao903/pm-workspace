// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 命令面板「任务」组（A-01）：后端 q 搜标题、正文、编号；回车去任务页打开抽屉（?t=<id>）
import { fetchObjects, type WorkObject } from '../../core/data'
import type { CommandDef } from '../../core/plugin'

export const TASK_SEARCH_LIMIT = 6

export function taskCommand(t: WorkObject, root: string): CommandDef {
  return {
    id: 'task.' + t.id,
    group: '任务',
    title: [t.ref, t.title].filter(Boolean).join(' '),
    sub: [t.priority, t.owner_name || '未分配'].filter(Boolean).join(' · '),
    run: ({ shell }) => shell.navigate(`/${root}?t=${encodeURIComponent(t.id)}`),
  }
}

export async function searchTasks(q: string, root: string): Promise<CommandDef[]> {
  const kw = q.trim()
  if (!kw) return []
  const page = await fetchObjects({ type: ['task'], q: kw, limit: TASK_SEARCH_LIMIT })
  return page.data.map((t) => taskCommand(t, root))
}
