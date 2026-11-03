// 技能的缓存键（AG-01b6）。单独一个文件，失效规则和 skills.ts 都从这里引，免得互相 import。
export const skillKeys = {
  all: ['skills'] as const,
  list: ['skills', 'list'] as const,
}
