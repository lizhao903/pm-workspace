// 项目档案（AUTO-04）：项目插件的 /api/projects/{id}/profile 读写一个项目的档案，/api/projects/profiles 列档案摘要（分类用）。
// 契约见 docs/api-contract.md「项目插件 / 项目档案」。档案只在档案标签里改，存完把返回的档案直接写回缓存，不另发事件。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isApiError, request, requestList } from '../api'

/**
 * 档案里能存的命令，顺序即界面顺序，分两组（AUTO-10）：
 * test 组由任务工作区的「运行测试」执行（smoke 一直是测试环境上的冒烟）；
 * release 组由发布 pipeline 在任务工作区里执行，version、package 在上线审批前跑，其余审批后才跑
 */
export const PROFILE_COMMANDS = [
  { key: 'build', label: '构建', group: 'test', hint: '测试前先构建' },
  { key: 'test', label: '测试', group: 'test', hint: '单测、接口、端到端；截图和 junit 写进 $TEST_REPORT_DIR' },
  { key: 'test_env', label: '起测试环境', group: 'test', hint: '后台起临时测试环境，监听 $PORT' },
  { key: 'smoke', label: '冒烟（测试环境）', group: 'test', hint: '在测试环境上跑的冒烟，不碰生产' },
  { key: 'version', label: '版本号与更新日志', group: 'release', hint: '审批前跑：把版本号写进 $RELEASE_DIR/version.txt、更新日志写进 $RELEASE_DIR/changelog.md；没写 version.txt 取输出最后一行' },
  { key: 'package', label: '打包', group: 'release', hint: '审批前跑：在工作区里打包，不碰生产；可用 $RELEASE_VERSION' },
  { key: 'preflight', label: '发布前检查', group: 'release', hint: '上线审批后才跑：备份数据库、核对密钥；没过不发布、不回滚' },
  { key: 'release', label: '发布', group: 'release', hint: '上线审批后才跑：发布到生产；没填就发起不了发布' },
  { key: 'prod_smoke', label: '线上冒烟', group: 'release', hint: '上线审批后才跑：发布后检查线上；没过自动回滚' },
  { key: 'rollback', label: '回滚', group: 'release', hint: '上线审批后才跑：发布或线上冒烟没过时自动执行' },
] as const
export type ProfileCommandGroup = (typeof PROFILE_COMMANDS)[number]['group']
/** 命令分组的标题和说明 */
export const PROFILE_COMMAND_GROUPS: { key: ProfileCommandGroup; label: string; hint: string }[] = [
  { key: 'test', label: '测试环境', hint: '任务工作区的「运行测试」按顺序执行：构建、起测试环境、测试、冒烟；可用变量 PORT、WORKTREE、TASK_REF、TEST_REPORT_DIR' },
  { key: 'release', label: '发布', hint: '发布 pipeline 在任务工作区里执行，审批前只跑版本号与打包；可用变量 WORKTREE、TASK_REF、RELEASE_ID、RELEASE_DIR、RELEASE_VERSION' },
]
export type ProfileCommandKey = (typeof PROFILE_COMMANDS)[number]['key']

/**
 * 一条命令：dir 相对代码库目录，空串就在代码库根目录；timeout_sec 为 0 表示用执行方的默认值。
 * ready 只有 test_env：测试环境的就绪检查，空等端口能连上，/ 开头是本机端口上的路径，也可以写本机 http 地址（AUTO-08）
 */
export type ProfileCommand = { command: string; dir: string; timeout_sec: number; ready?: string }

export type ProjectProfile = {
  project_id: string
  intro: string
  keywords: string[]
  platforms: string[]
  code_dir: string
  proto_dir: string
  prd_dir: string
  /** 只含设了的命令 */
  commands: Partial<Record<ProfileCommandKey, ProfileCommand>>
  owner_ids: string[]
  acceptor_ids: string[]
  /** 项目目录（对象 workdir），只读；代码库没设时摘要里沿用它 */
  root: string
  /** 没建过档案时为 null */
  created_at: string | null
  updated_at: string | null
}

/** PATCH 每个字段整体替换，没传的不动；commands 也整体替换 */
export type ProjectProfilePatch = Partial<Pick<ProjectProfile,
  'intro' | 'keywords' | 'platforms' | 'code_dir' | 'proto_dir' | 'prd_dir' | 'commands' | 'owner_ids' | 'acceptor_ids'>>

export type ProfileDirState = { path: string; state: 'ok' | 'missing' | 'unset'; inherited?: boolean }

/** 档案摘要的一行：只列建过档案、没进回收站的项目 */
export type ProjectProfileSummary = {
  project_id: string
  name: string
  ref: string
  intro: string
  keywords: string[]
  platforms: string[]
  dirs: Record<'code' | 'prototype' | 'prd', ProfileDirState>
  dirs_ready: boolean
  commands: ProfileCommandKey[]
  updated_at: string
}

const one = (id: string) => `/api/projects/${encodeURIComponent(id)}/profile`

const norm = (p: ProjectProfile): ProjectProfile => ({
  ...p,
  keywords: p.keywords ?? [], platforms: p.platforms ?? [], commands: p.commands ?? {},
  owner_ids: p.owner_ids ?? [], acceptor_ids: p.acceptor_ids ?? [],
})

export const projectProfileApi = {
  get: async (id: string, signal?: AbortSignal) => norm(await request<ProjectProfile>('GET', one(id), { signal })),
  patch: async (id: string, body: ProjectProfilePatch) => norm(await request<ProjectProfile>('PATCH', one(id), { body })),
  list: async (signal?: AbortSignal) => (await requestList<ProjectProfileSummary>('/api/projects/profiles', { signal })).data,
}

export const projectProfileKeys = {
  all: ['project-profile'] as const,
  of: (id: string) => ['project-profile', id] as const,
  list: ['project-profile', '*list'] as const,
}

const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

export function useProjectProfile(projectId: string) {
  return useQuery({
    queryKey: projectProfileKeys.of(projectId),
    queryFn: ({ signal }) => projectProfileApi.get(projectId, signal),
    retry: noRetry404,
  })
}

export function useProjectProfiles() {
  return useQuery({ queryKey: projectProfileKeys.list, queryFn: ({ signal }) => projectProfileApi.list(signal), retry: noRetry404 })
}

/** 存档案：成功后把返回的档案写回缓存，摘要列表标脏 */
export function useSaveProjectProfile(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: ProjectProfilePatch) => projectProfileApi.patch(projectId, patch),
    onSuccess: (p) => {
      qc.setQueryData(projectProfileKeys.of(projectId), p)
      void qc.invalidateQueries({ queryKey: projectProfileKeys.list })
    },
  })
}
