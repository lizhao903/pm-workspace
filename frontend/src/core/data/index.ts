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

// 接口层的纯函数和类型照样给模块用：不发请求，不碰缓存
export { localDay, focusParams, changedFields, isApiError, isStreamError, ApiError, StreamError } from '../api'
export type { Focus, ApiErrorCode, ListResult } from '../api'
export type * from '../api/types'
export type {
  RunEvent, ChatEvent, StreamEvent, RunDone, ChatDone, QuestionOption, StreamErrorKind, StreamOptions, RunRequest, ChatRequest,
} from '../api'
