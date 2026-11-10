// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 「生效工作区」的计算：对象自己设了就用自己的，没设就向上取所属项目的。
// 详情页的字段和执行页的顶部都要用同一套判断，所以抽出来一处。
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { WorkObject } from '../../lib/types'

/** 内置项目类型的 id，与后端 object_types 对齐 */
export const PROJECT_TYPE_ID = 'project'

export interface EffectiveWorkdir {
  /** 对象自己设的值 */
  own: string
  /** 从所属项目继承来的值 */
  inherited: string
  /** 继承来源项目的标题，用于「继承自项目 XXX」 */
  fromProject: string
  /** 实际生效的目录，空串表示没有 */
  value: string
  source: 'own' | 'inherited' | 'none'
  /** 还在拉项目信息，此时先别急着报「未设置」 */
  loading: boolean
}

export function useEffectiveWorkdir(object: WorkObject): EffectiveWorkdir {
  const own = object.workdir ?? ''
  const projectId = object.project_id
  const [inherited, setInherited] = useState('')
  const [fromProject, setFromProject] = useState(object.project_title ?? '')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // 自己有值就不必问项目；项目对象自身也不继承
    if (own || !projectId || object.type_id === PROJECT_TYPE_ID) {
      setInherited(''); setFromProject(object.project_title ?? ''); setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    // 后端可能还没上线，失败一律按「没有继承值」，不弹错误
    void api.object(projectId)
      .then((p) => { if (alive) { setInherited(p.workdir ?? ''); setFromProject(p.title) } })
      .catch(() => { if (alive) { setInherited(''); setFromProject(object.project_title ?? '') } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [own, projectId, object.type_id, object.project_title])

  const value = own || inherited
  return {
    own,
    inherited,
    fromProject,
    value,
    source: own ? 'own' : inherited ? 'inherited' : 'none',
    loading,
  }
}
