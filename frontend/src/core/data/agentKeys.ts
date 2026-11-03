// Agent 会话和服务商的缓存键（AG-01a）。单独一个文件，keys.ts 和失效规则都从这里引。
// 前缀不用 'agent'：keys.ts 的 workdir 校验已经挂在 ['agent', 'workdir'] 下，按前缀失效会把它一起刷掉。
export const agentKeys = {
  providers: ['agent-providers'] as const,
  /** 某个服务商能用的模型，靠「测试连接」拉回来 */
  models: (providerId: string) => ['agent-providers', 'models', providerId] as const,
  sessions: {
    all: ['agent-sessions'] as const,
    /** 全局会话（unscoped=true） */
    unscoped: ['agent-sessions', 'list', { unscoped: true }] as const,
    messages: (sessionId: string) => ['agent-sessions', 'messages', sessionId] as const,
  },
}
