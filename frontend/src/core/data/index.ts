// 数据访问层（CORE-03a）：模块和插件取数、写数据只走这里，不直接调用 core/api（lint 规则拦着）。
// 这里封装资源级 hook、缓存键和失效规则、统一的错误和加载状态；core/api 只管发请求。
export { dataKeys, normFilter } from './keys'
export { invalidationsFor, applyChange, notifyChange, useNotifyChange } from './invalidate'
export type { Change } from './invalidate'
export { queryClient } from './queryClient'
export { startEventStream, useEventStreamStatus, useEventsLive, onServerEvent, changesFor } from './events'
export type { ServerEvent, EventStreamStatus } from './events'
export { REMINDER_KIND, addReminder, isReminder, notificationsApi, reminderTask, useReadNotification, useUnreadReminders } from './notifications'
export type { AppNotification, NotificationLevel } from './notifications'
export { errorText, retryable } from './errors'
export { QueryState } from './QueryState'
export { useHealth, useObjectTypes, useDictionaries, useDictItems, useStakeholders, useCounts } from './meta'
export { dictItemsApi, useDictItemsAll, saveDictItems, useSaveDictItems } from './dictionaries'
export type { DictSavePlan, EnumTarget } from './dictionaries'
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
export { runFinished, useTaskRuns, useTaskRun, useCancelRun, streamRun, useRunPrompt, startTerminalRun, finishTerminalRun, useFinishRun } from './runs'
export { workdirUsable, useWorkdirCheck, useFsBrowse, useFsShortcuts, useFsRoots, useAddFsRoot, useRemoveFsRoot, fsCrumbs } from './fs'
export {
  useAgentProviders, useProviderModels, providerModelIds, loadProviderModels, defaultProvider, useAgentSessions, useAgentMessages, useCreateAgentSession, usePatchAgentSession,
  useDeleteAgentSession, useRemoveAgentMessages, useRunningAgentSessions, useStopAgentSession, streamChat, streamDecision, streamDebugChat, setFirstMessage, firstMessageOf,
} from './agent'
export type {
  AgentProvider, AgentProviderKind, ProviderTestResult, AgentSession, AgentMessage, AgentMessageRole, AgentSessionInput, AgentSessionPatch, SessionSourceRef,
} from './agent'
export {
  usePlugins, useInstallPlugin, useEnablePlugin, useDisablePlugins, useUninstallPlugin, enabledDependents, installedDependents,
  useUpgradePlugin, newPermissions,
} from './plugins'
export type { PluginInfo, PluginInstallResult, PluginUninstallResult, PluginUpgradeResult } from './plugins'
export {
  todayKeys, useToday, todayCard, reviewCard, overdueCard, dueTodayCard, runningCard, pluginTodayCards, schedulesToday,
  KERNEL_TODAY_CARDS, TODAY_REVIEW, TODAY_OVERDUE, TODAY_DUE, TODAY_RUNNING,
} from './today'
export type { Today, TodayCard, TodayRun } from './today'
export {
  SCHEDULE_RUNS_LIMIT, useSchedules, useScheduleRuns, useLastScheduleRuns, useSchedulePreview, useCreateSchedule, usePatchSchedule,
  useDeleteSchedule, useRunSchedule, useObjectReminders,
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
  useOpenLocalFile, localRawUrl, mergeFilePages, useSetStarred, setStarred, isStarred, PROP_STARRED,
} from './docs'
export type { Category, TagInfo, LocalDir, LocalFileEntry, LocalFileKind, LocalFileList, LocalListReason, LocalFile } from './docs'
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
export {
  INCIDENT_MODULES, INCIDENT_STATUS, incidentsApi, incidentsPagePath, normIncident, openErrors, useIncidents, useIncidentToTask,
  useSetIncidentStatus,
} from './incidents'
export type { Incident, IncidentLevel, IncidentReport, IncidentStatus, IncidentTaskInput, IncidentTaskResult } from './incidents'
export { contactsApi, useContacts, useSetContactStarred } from './contacts'
export type { Contact, ContactPatch } from './contacts'
export {
  PROJECT_TYPE, PROJECT_ROLES, projectView, mergeProjectProps, isLiveProject, saveProject, projectsApi, useProjects, useProject,
  useCreateProject, useSaveProject, useProjectStakeholders,
} from './projects'
// 项目下拉选项（读缓存），插件登记的 SOP 节点用（消息分流）
export { projectOptions } from './projects'
export type { ProjectView, ProjectMark, RelatedDir, ProjectProps, ProjectCreate, ProjectSave, ProjectRole, ProjectStakeholder } from './projects'
export { useSaveContact, useUpdateContact, useDeleteContact } from './contacts'
export type { ContactInput, ContactUpdate, ContactSave, ContactSaved } from './contacts'
export { CONTACT_GROUP_DICT, DEFAULT_CONTACT_GROUP, contactGroupOptions, useCreateContactLinked } from './contacts'
export type { ContactQuick, ContactLinked } from './contacts'
export {
  identitiesApi, useIdentities, useCreateIdentity, useRelinkIdentity, useDeleteIdentity, normExternalId, identitiesByContact, imOf, identityOwner, identityPlan, applyIdentityPlan,
} from './identities'
export type { Identity, IdentityInput, IdentityOp, IdentityFailure } from './identities'
export {
  connectorsApi, connectorsPagePath, normConnector, useConnectorDefs, useConnectors, useCreateConnector, usePatchConnector, useDeleteConnector,
  useTestConnector, useRefreshConnectorTools, useSetConnectorToolModes, useStartConnectorOAuth,
} from './connectors'
export type {
  Connector, ConnectorDef, ConnectorField, ConnectorTool, ConnectorToolDef, ConnectorAuthMode, ConnectorToolMode, ConnectorStatus,
  ConnectorDirection, ConnectorInput, ConnectorPatch, ConnectorTestResult, ConnectorRefreshResult,
  ConnectorOAuthDef, ConnectorOAuthState, ConnectorOAuthStart,
} from './connectors'
export { imChannelsApi, imConversationsKey, useImConversations } from './imChannels'
export type { ImConversationKind, ImConversationList, ImConversationOption } from './imChannels'
export {
  projectStakeholdersApi, useAddProjectStakeholder, useAddProjectStakeholders, usePatchProjectStakeholder, useRemoveProjectStakeholder,
} from './projectStakeholders'
export type { ProjectStakeholderInput, ProjectStakeholderPatch, ProjectStakeholdersAdded } from './projectStakeholders'
export { IM_EXPIRE_DAYS_MAX, IM_QUICK_REPLIES_MAX, IM_QUICK_REPLY_TEXT_MAX, IM_PAGE_MAX, imApi, normMessage, useImMessages, useImMessage, useImAction, useImBatch, useImToTask, useImPendingCount, useImSyncConnector, useImSettings, usePatchImSettings, useImConversationProjects, useSetImConversationProject, useImStartSession } from './im'
export type { ImMaterialKind, ImMessageMaterial, ImMessageThread, ImMaterialSource, ImMaterialLinkInput, ImMaterialLinkResult, ImMessage, ImMsgStatus, ImRelevance, ImAttachment, ImReply, ImAction, ImBatchInput, ImBatchResult, ImTaskInput, ImTaskResult, ImSyncResult, ImSettings, ImQuickReply, ImConversationProject, ImMessageSession, ImSplitTask, ImSessionIntent, ImSessionLinkInput, ImSessionLinkResult, ImStartSessionInput } from './im'
export { imEmailApi, useImBackfillEmails } from './imEmails'
export { IM_CONV_BATCH_MAX, IM_MENTIONS_MAX, IM_SEND_MAX, imGroupsApi, useImConversationSummary, useImMembers, useImSendToConversation, useImSent, useSetImConversationProjects } from './imGroups'
export type { ImConvProjectBatchInput, ImConvProjectBatchResult, ImConvProjectFailure, ImConversationSummary, ImMember, ImMention, ImOutboxItem, ImSendInput } from './imGroups'
export type { ImEmailBackfillResult, ImEmailConflict, ImEmailFilled } from './imEmails'
export {
  MATERIAL_KINDS, MATERIAL_NOTE_MAX, MATERIAL_KIND_GROUPS, projectMaterialsApi, useProjectMaterials, useAddProjectMaterials, usePatchProjectMaterial, useRemoveProjectMaterial,
} from './materials'
export type { MaterialKind, MaterialStatus, ProjectMaterial, ProjectMaterialInput, ProjectMaterialPatch } from './materials'
export { conversationsApi, normConversation, useConversations } from './conversations'
export type { Conversation, ConversationKind } from './conversations'
export {
  projectConversationsApi, useProjectConversations, useBindProjectConversation, useUnbindProjectConversation, useConversationMessages, useAllImMessages,
} from './projectConversations'
export type { ProjectConversation, ConversationMessages } from './projectConversations'
export {
  PROTOTYPE_STATUS, PROTOTYPE_LOG_MAX, PROTOTYPE_EXTERNAL_START, PROTOTYPE_EXTERNAL_STOP, prototypeUp, prototypesApi, prototypesPollMs, mergeLogs, useProjectPrototypes, usePrototypeLogs, useAddPrototype,
  usePatchPrototype, useRemovePrototype, useStartPrototype, useStopPrototype,
} from './prototypes'
export type { PrototypeStatus, ProjectPrototype, PrototypeCrash, PrototypeLogLine, PrototypeLogs, PrototypeInput, PrototypePatch } from './prototypes'
export { EMPTY_STAT, SUMMARY_POLL_MS, projectSummaryApi, projectStats, useProjectSummary, usePendingImMessages } from './projectSummary'
export type { ProjectSummary, ProjectStat } from './projectSummary'
export {
  ATTACHMENT_TAG, ATTACH_KIND, PROP_SKIPPED_ATTACHMENTS, attachmentsApi, needsFetch, attachmentHref, attachmentPreviewHref, previewKind, TEXT_PREVIEW_MAX, useAttachmentText, attachmentContentUrl, attachmentMaterial,
  attachmentAdded, attachmentAddedAs, fmtBytes, skipKey, skippedAttachments, useImAttachmentStorage, useFetchAttachment, useAddAttachmentToProject, useSkipAttachment,
  useSkipAttachments, useAddAttachmentsToProject, useAttachmentTargets,
} from './attachments'
export type {
  ImAttachmentFile, ImAttachmentStorage, PreviewKind, AttachmentRef, AddAttachmentInput, AddAttachmentResult, AddAttachmentsResult, AttachmentProject, AttachmentTargets,
} from './attachments'
export { IM_MATERIAL_TAG, IM_NOTE_MAX, useImToMaterial, useImMaterialSources, useUnlinkImMaterial } from './imMaterials'
export type { ImToMaterialInput, ImToMaterialResult } from './imMaterials'
export {
  TERMINAL_MAX_SESSIONS, TERMINAL_PROTO_IDLE_MS, terminalApi, terminalSocketUrl, useTerminalSessions, useTerminalPrototypes,
  useTerminalProtoAction, useTerminalSettings, usePatchTerminalSettings,
} from './terminal'
export type { TerminalSession, TerminalSessionInput, TerminalSessionCreated, TerminalSettings, TerminalPrototype } from './terminal'
export {
  SOP_RUNS_MAX, sopApi, useSopFlows, useSopNodeTypes, useSopRuns, useSopRun, useStartSopRun, useSopRunAction, useDeleteSopFlow,
  useSopFlow, useSaveSopFlow, useSopAssist, sopIssuesOf, useSopObjectRuns, useSopSettings, usePatchSopSettings, SOP_MODEL_CONCURRENCY_MAX,
  isSopRunRelaunched, sopRunShow,
} from './sop'
export type {
  SopJson, SopField, SopFieldOption, SopCase, SopStepDef, SopFlow, SopNodeType, SopStepStatus, SopRunStatus, SopRunShow, SopRunStep, SopRun,
  SopRunBrief, SopRunSource, SopRunAction, SopStartInput, SopDraft, SopIssue, SopAssistReply, SopAssistInput, SopSettings,
} from './sop'

// 批量发起、按输入字段查执行（IM 页批量分诊、处理队列）
export { SOP_BATCH_MAX, SOP_RERUN_REASON_RELAUNCHED, applyRerun, sopBatchApi, triageFlows, useRerunSopRuns, useSopRunsByInput, useStartSopBatch, useStopSopRuns } from './sopBatch'
export type { SopBatchItem, SopBatchResult, SopInputRun, SopRerunAction, SopRerunResult } from './sopBatch'

export { skillKeys } from './skillKeys'
export { skillsApi, skillReadonly, useSkills, useCreateSkill, usePatchSkill, useDeleteSkill } from './skills'
export type { Skill, SkillSource, SkillInput, SkillPatch } from './skills'
export {
  knowledgeBasesApi, useKnowledgeBases, useKbDocs, useKbDocsOf, useKbMissing, useKbSearch, useKbAgents, useCreateKb, usePatchKb,
  useDeleteKb, useAddKbDocs, usePatchKbDoc, useRemoveKbDoc, useReindexKb, useSyncKb, useKbSyncProgress,
} from './knowledgeBases'
export type {
  KnowledgeBase, KbDoc, KbDocSource, KbDocStatus, KbDir, KbEmbed, KbSettings, KbCounts, KbAddInput, KbSettingsInput, KbInput, KbPatch,
  KbDocPatch, KbMissing, KbSyncResult, KbSyncProgress, KbHit, KbSearchResult, KbAgent,
} from './knowledgeBases'

export { agentConfigKeys } from './agentConfigKeys'
export {
  AGENT_RUNS_LIMIT, agentsApi, useAgents, useAgent, useAgentImpact, useAgentGrants, useAgentRuns, useCreateAgent, usePatchAgent,
  useDeleteAgent, usePutAgentGrants, useAgentScenarios, usePatchAgentScenarios,
} from './agents'
export type {
  Agent, AgentAvatar, AgentTrigger, AgentTriggerKind, AgentTriggerMatch, AgentInput, AgentPatch, AgentImpact, AgentImpactItem,
  AgentGrants, AgentGrantMode, AgentRunBrief, AgentRunStatus, AgentThinking, AgentScenario,
} from './agents'
export {
  AGENT_RUN_STATUS, AGENT_RUN_PAGE_MAX, TOOL_CALL_STATE, agentRunsApi, useAgentRunList, useAgentRunCounts, useAgentRun,
} from './agentRuns'
export type {
  AgentRun, AgentRunCall, AgentRunDetail, AgentRunFilter, AgentRunTriggerKind, AgentToolCall, AgentToolCallState,
} from './agentRuns'

export { domainKeys } from './domainKeys'
export {
  domainsApi, useDomainSettings, useDomainRoutes, useDomainStatus, useDomainConfig, usePutDomainSettings, useAddDomainRoute,
  usePatchDomainRoute, useDeleteDomainRoute, useCheckDomainRoute,
} from './domains'
export type {
  DomainSettings, DomainSettingsPatch, DomainResolve, DomainProxy, DomainTarget, DomainCheck, DomainRoute, DomainRouteInput,
  DomainRoutePatch, DomainFix, DomainStatusState, DomainStatusItem, DomainStatus, DomainConfigSection, DomainConfig,
} from './domains'

export { videoKeys } from './videoKeys'
export {
  videoApi, useVideos, useVideo, useVideoSeries, useCreateVideo, usePatchVideo, useAdvanceVideo, useDecideCheckpoint, useDeleteVideo,
  useVideoArtifacts, useCreateArtifact, usePatchArtifact, useReviewArtifact, useBumpArtifact, useDeleteArtifact,
  useCreateSeries, usePatchSeries, useDeleteSeries,
} from './video'
export type {
  Video, VideoInput, VideoSeries, VideoOrientation, VideoStageKey, VideoCheckpoint, VideoCheckpointStage, VideoCheckpointState,
  VideoArtifact, VideoArtifactInput, VideoArtifactKind, VideoArtifactStatus, VideoArtifactReview, VideoArtifactSource, VideoCoverRatio,
  VideoSeriesInput, VideoRunnerType, VideoStageRunner, VideoRunStatus, VideoLastRun,
} from './video'
export { videoRunnerApi, usePutRunner, useRemoveRunner, useRunStage, useWatchVideoRun } from './videoRunners'
export { videoContentApi, usePutVideoTopic, useArtifactContent, usePutArtifactContent } from './videoContent'
export type { VideoArtifactContent } from './videoContent'
export {
  videoTopicApi, useVideoTopics, useVideoClips, useCreateTopic, usePatchTopic, useMakeTopic, useDeleteTopic,
  useCreateClip, usePatchClip, useClipToTopic, useLinkClip, useDeleteClip,
} from './videoTopics'
export type {
  VideoTopic, VideoTopicInput, VideoTopicStatus, VideoTopicScore, VideoPlatform, VideoClip, VideoClipInput, VideoClipKind,
} from './videoTopics'
export {
  videoDealApi, videoDealKeys, useVideoDeals, useVideoQuoteRef, useCreateDeal, usePatchDeal, useDeleteDeal, useDealReport,
  useDealProjectResolver,
} from './videoDeals'
export type { VideoDeal, VideoDealInput, VideoDealStatus, VideoDealCurrency, VideoQuoteRef, VideoDealReport } from './videoDeals'
export {
  videoPublishApi, videoPublishKeys, useVideoPublishes, useVideoPlatforms, useVideoAccounts, useVideoCovers, usePublishSnapshots, useVideoCoverTests,
  useCreatePublish, usePatchPublish, useDeletePublish, useSubmitPublish, useSyncPublish,
  useCreateCoverTest, usePatchCoverTest, useEvaluateCoverTest, useDecideCoverTest, useDeleteCoverTest,
} from './videoPublish'
export type {
  VideoPublish, VideoPublishInput, VideoPublishStatus, VideoPublishCheck, VideoMetrics, VideoMetricSnapshot, VideoSnapshots, VideoPublishRule,
  VideoPlatformCap, VideoPlatformInfo, VideoAccount, VideoAccountRole, VideoCoverTest, VideoCoverTestInput, VideoCoverTestPatch, VideoCoverTestMode,
  VideoCoverTestStatus, VideoCoverTestArm, VideoCoverTestState,
} from './videoPublish'
export { videoCalendarApi, videoCalendarKeys, useVideoCalendar, calendarPollMs, isVideoEvent } from './videoCalendar'
export type { VideoCalendar, VideoCalendarItem, VideoCalendarKind, VideoCalendarRange, VideoCalendarTone } from './videoCalendar'

export { browserKeys } from './browserKeys'
export { BROWSER_MAX_STORED_TABS, browserApi, useBrowserGoogle, useBrowserGoogleLogin, useBrowserGoogleLogout, useBrowserAllowlist, useAddBrowserAllow } from './browser'
export type {
  BrowserTabKind, BrowserTabRecord, BrowserGoogleConn, BrowserGoogleAccount, BrowserGoogleState, BrowserOAuthStart, BrowserGoogleLogin,
  BrowserGoogleLogout, BrowserAllowEntry,
} from './browser'

export { fetchObjects, fetchContacts, fetchIdentities } from './search'

// 接口层的纯函数和类型照样给模块用：不发请求，不碰缓存
export { localDay, focusParams, changedFields, isApiError, isStreamError, ApiError, StreamError } from '../api'
export type { Focus, ApiErrorCode, ListResult } from '../api'
export type * from '../api/types'
export type {
  RunEvent, ChatEvent, StreamEvent, RunDone, ChatDone, QuestionOption, StreamErrorKind, StreamOptions, RunRequest, ChatRequest,
  DebugChatMessage, DebugChatRequest,
} from '../api'
export { UPDATE_POLL_MS, updateApi, useStartUpdate, useUpdateStatus, type UpdateCommit, type UpdateJob, type UpdateStatus, type UpdateStep } from './update'
