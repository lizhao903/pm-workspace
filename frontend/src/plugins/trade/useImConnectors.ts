// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useMemo } from 'react'
import { useConnectorDefs, useConnectors } from '../../core/data'

/** 即时通讯类的连接器（不看连接状态，同原型）；状态不是已连接的标出来（SPEC-monitor-0.2） */
export function useImConnectors() {
  const defs = useConnectorDefs()
  const list = useConnectors()
  return useMemo(() => {
    const im = new Set((defs.data ?? []).filter((d) => d.category === 'im').map((d) => d.tool))
    return (list.data ?? []).filter((c) => im.has(c.tool)).map((c) => ({ id: c.id, name: c.name, status: c.status }))
  }, [defs.data, list.data])
}
