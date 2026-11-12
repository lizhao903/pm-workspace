// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 内网域名（DOM-01b）的缓存键，单独一个文件，免得和 keys.ts 互相引用。设置、路由、本机状态、生成的配置都在 domains 前缀下
export const domainKeys = {
  all: ['domains'] as const,
  settings: ['domains', 'settings'] as const,
  routes: ['domains', 'routes'] as const,
  status: ['domains', 'status'] as const,
  config: ['domains', 'config'] as const,
}
