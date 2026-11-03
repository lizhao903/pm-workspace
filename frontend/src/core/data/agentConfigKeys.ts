// Agent 配置的缓存键（AG-01b5）。单独一个文件，失效规则和 agents.ts 都从这里引，免得互相 import。
// 前缀用 'agents'：会话和服务商在 agentKeys（'agent-sessions'、'agent-providers'）下，互不牵连。
export const agentConfigKeys = {
  all: ['agents'] as const,
  list: ['agents', 'list'] as const,
  detail: (id: string) => ['agents', 'get', id] as const,
  /** 删除前的影响检查 */
  impact: (id: string) => ['agents', 'impact', id] as const,
  /** 工具授权（AG-02a），列表卡片的能力标签用 */
  grants: (id: string) => ['agents', 'grants', id] as const,
  /** 场景默认 Agent（0045） */
  scenarios: ['agents', 'scenarios'] as const,
  /** 执行记录（AG-01b4），列表卡片的等确认数和最近运行 */
  runs: ['agents', 'runs'] as const,
  /** 会话页的执行记录（AG-01b8）：按条件的一页、按状态的条数、单条详情，都在 runs 前缀下 */
  runList: (f: Record<string, unknown>) => ['agents', 'runs', 'list', f] as const,
  runCount: (status: string) => ['agents', 'runs', 'count', status] as const,
  run: (id: string) => ['agents', 'runs', 'get', id] as const,
}
