// 内置浏览器（BR-01b）的缓存键，单独一个文件，免得和 keys.ts 互相引用。
// 标签页只在启动时读一次（之后以页面上的为准，整体 PUT 回去），不进缓存；这里只有 Google 账号状态
export const browserKeys = {
  all: ['browser'] as const,
  google: ['browser', 'google'] as const,
}
