// 数据访问层（CORE-03a）：模块和插件取数、写数据只走这里，不直接调用 core/api（lint 规则拦着）。
// 这里封装资源级 hook、缓存键和失效规则、统一的错误和加载状态；core/api 只管发请求。
export { dataKeys, normFilter } from './keys'
export { invalidationsFor, applyChange, notifyChange, useNotifyChange } from './invalidate'
export type { Change } from './invalidate'
export { queryClient } from './queryClient'
export { startEventStream, useEventStreamStatus, useEventsLive, onServerEvent, changesFor } from './events'
export type { ServerEvent, EventStreamStatus } from './events'
export { errorText, retryable } from './errors'
export { QueryState } from './QueryState'
export { useHealth, useObjectTypes, useDictionaries, useDictItems, useStakeholders, useCounts } from './meta'
export {
  listAllObjects, useObjects, useAllObjects, useObject, useCreateObject, usePatchObject, useSetStatus, useDeleteObject,
  saveObject, mergeProps, PROP_ACCEPTANCE, PROP_REPO,
} from './objects'
export type { ObjectFilter, ObjectSave } from './objects'
export {
  PROGRESS_LIMIT, PROGRESS_POLL_MS, PROGRESS_KIND_LABEL, progressKindLabel, chronological, shortSession, isInProgress,
  isProgressRevision, revisionSummary, useProgress, useAppendProgress, useApprove,
} from './progress'
export { REVISION_LIMIT, useObjectRevisions, groupRevisions, rejectText, useReject } from './revisions'
export type { RevisionGroup } from './revisions'
export { useArtifacts, useObjectArtifacts, useArtifactStats, useArtifactCount, useRecordArtifact } from './artifacts'
export { runFinished, useTaskRuns, useTaskRun, useCancelRun, streamRun } from './runs'
export { workdirUsable, useWorkdirCheck, useFsBrowse, useFsShortcuts } from './fs'
export {
  useAgentProviders, useProviderModels, useAgentSessions, useAgentMessages, useCreateAgentSession, usePatchAgentSession,
  useDeleteAgentSession, streamChat,
} from './agent'
export type {
  AgentProvider, AgentProviderKind, ProviderTestResult, AgentSession, AgentMessage, AgentMessageRole, AgentSessionInput, AgentSessionPatch,
} from './agent'
export {
  usePlugins, useInstallPlugin, useEnablePlugin, useDisablePlugins, useUninstallPlugin, enabledDependents, installedDependents,
} from './plugins'
export type { PluginInfo, PluginInstallResult, PluginUninstallResult } from './plugins'
export {
  todayKeys, useToday, todayCard, reviewCard, overdueCard, dueTodayCard, runningCard, pluginTodayCards, schedulesToday,
  KERNEL_TODAY_CARDS, TODAY_REVIEW, TODAY_OVERDUE, TODAY_DUE, TODAY_RUNNING,
} from './today'
export type { Today, TodayCard, TodayRun } from './today'
export {
  SCHEDULE_RUNS_LIMIT, useSchedules, useScheduleRuns, useLastScheduleRuns, useSchedulePreview, useCreateSchedule, usePatchSchedule,
  useDeleteSchedule, useRunSchedule,
} from './schedules'
export type {
  Schedule, ScheduleRule, ScheduleFreq, ScheduleAction, ScheduleActionKind, ScheduleRun, ScheduleRunStatus, ScheduleInput, SchedulePatch,
  SchedulePreview,
} from './schedules'
export {
  useWorkspaces, useWorkspaceTemplates, useCreateWorkspace, usePatchWorkspace, useDeleteWorkspace, applyPatch as applyWorkspacePatch,
} from './workspaces'
export type {
  Workspace, WorkspaceGroup, WorkspaceGroupInput, WorkspaceMark, WorkspaceTemplate, WorkspaceInput, WorkspacePatch,
} from './workspaces'
export {
  docsApi, useCategoryTree, useTags, useLocalDirs, useLocalDirFiles, useLocalFile, useMountLocalDir, useUnmountLocalDir,
  useSetStarred, setStarred, isStarred, PROP_STARRED,
} from './docs'
export type { Category, TagInfo, LocalDir, LocalFileEntry, LocalFileList, LocalFile } from './docs'
export {
  DELIVERIES_MAX, SIGNATURE_HEADER, DELIVERY_HEADER, hookPath, useWebhooks, useWebhookDeliveries, useLastDeliveries, useWebhookUsages,
  useCreateWebhook, usePatchWebhook, useRotateWebhookSecret, useDeleteWebhook, usePushWebhook,
} from './webhooks'
export type {
  Webhook, WebhookWithSecret, WebhookInput, WebhookPatch, WebhookMapping, WebhookDefaults, WebhookUsage, Delivery, DeliveryResult,
  LastDelivery,
} from './webhooks'
export {
  providersApi, useProviderChecks, useCreateProvider, usePatchProvider, useDeleteProvider, useSetDefaultProvider, useTestProvider,
} from './providers'
export type { ProviderProtocol, ProviderInput, ProviderPatch, ProviderCheck } from './providers'
export { contactsApi, useContacts, useSetContactStarred } from './contacts'
export type { Contact, ContactPatch } from './contacts'

// 接口层的纯函数和类型照样给模块用：不发请求，不碰缓存
export { localDay, focusParams, changedFields, isApiError, isStreamError, ApiError, StreamError } from '../api'
export type { Focus, ApiErrorCode, ListResult } from '../api'
export type * from '../api/types'
export type {
  RunEvent, ChatEvent, StreamEvent, RunDone, ChatDone, QuestionOption, StreamErrorKind, StreamOptions, RunRequest, ChatRequest,
} from '../api'
