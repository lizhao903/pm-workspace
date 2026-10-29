// 视频创作插件（VID-01c）的缓存键，单独一个文件，免得和 keys.ts 互相引用。视频、系列都在 video 前缀下
export const videoKeys = {
  all: ['video'] as const,
  videos: ['video', 'list'] as const,
  video: (id: string) => ['video', 'detail', id] as const,
  series: ['video', 'series'] as const,
  /** 一集的产出物（VID-01d） */
  artifacts: (videoId: string) => ['video', 'artifacts', videoId] as const,
  /** 选题、素材箱（VID-08c），都是一次取完 */
  topics: ['video', 'topics'] as const,
  clips: ['video', 'clips'] as const,
}
