// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 数据访问层（CORE-03a）：模块和插件取数、写数据只走这里，不直接调用 core/api（lint 规则拦着）。
// 这里封装资源级 hook、缓存键和失效规则、统一的错误和加载状态；core/api 只管发请求。
export { dataKeys, normFilter } from './keys'
export { invalidationsFor, applyChange, notifyChange, useNotifyChange } from './invalidate'
export type { Change } from './invalidate'
export { queryClient } from './queryClient'
export { startEventStream, useEventStreamStatus, useEventsLive, onServerEvent, changesFor } from './events'
export type { ServerEvent, EventStreamStatus } from './events'
export { REMINDER_KIND, addReminder, isReminder, notificationsApi, reminderPopup, reminderTask, useReadNotification, useUnreadReminders } from './notifications'
export type { AppNotification, NotificationLevel, ReminderPopup } from './notifications'
export { errorText, retryable } from './errors'
export { QueryState } from './QueryState'
export { useHealth, useObjectTypes, useDictionaries, useDictItems, useStakeholders, useCounts } from './meta'
export { dictItemsApi, useDictItemsAll, saveDictItems, useSaveDictItems } from './dictionaries'
export type { DictSavePlan, EnumTarget } from './dictionaries'
export {
  listAllObjects, useObjects, useAllObjects, useObject, useCreateObject, usePatchObject, useSetStatus, useSetStage, useDeleteObject,
  saveObject, mergeProps, PROP_ACCEPTANCE, PROP_REPO,
} from './objects'
export type { ObjectFilter, ObjectSave } from './objects'
export {
  PROGRESS_LIMIT, PROGRESS_POLL_MS, PROGRESS_KIND_LABEL, progressKindLabel, chronological, shortSession, isInProgress,
  isProgressRevision, revisionSummary, useProgress, useAppendProgress, useApprove,
} from './progress'
export { REVISION_LIMIT, useObjectRevisions, groupRevisions, rejectText, useReject } from './revisions'
export type { RevisionGroup } from './revisions'
export { useArtifacts, useObjectArtifacts, useArtifactStats, useArtifactCount, useRecordArtifact, useArtifactsByObject } from './artifacts'
export { runFinished, useTaskRuns, useTaskRun, useCancelRun, streamRun, decideRunCall, useRunPrompt, startTerminalRun, finishTerminalRun, useFinishRun, useRunPresets, useSaveRunPresets, useRunPermissions, useSaveRunPermissions } from './runs'
export { useRunners, useDetectRunners, useDeepSeekSmoke, useStartDeepSeekSmoke } from './runners'
export { workdirUsable, useWorkdirCheck, useFsBrowse, useFsShortcuts, useFsRoots, useAddFsRoot, useRemoveFsRoot, fsCrumbs } from './fs'
export {
  useAgentProviders, useProviderModels, providerModelIds, loadProviderModels, defaultProvider, useAgentSessions, useAgentMessages, useCreateAgentSession, usePatchAgentSession,
  useDeleteAgentSession, useRemoveAgentMessages, useRunningAgentSessions, useStopAgentSession, useSwitchSessionModel, streamChat, streamDecision, streamDebugChat, setFirstMessage, firstMessageOf,
} from './agent'
export type {
  AgentProvider, AgentProviderKind, ProviderTestResult, AgentSession, AgentMessage, AgentMessageRole, AgentSessionInput, AgentSessionPatch, SessionSourceRef,
} from './agent'
export {
  usePlugins, useInstallPlugin, useEnablePlugin, useDisablePlugins, useUninstallPlugin, enabledDependents, installedDependents,
  useUpgradePlugin, newPermissions, installPermissions,
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
  docsApi, useCategoryTree, useTags, useLocalDirs, useLocalDirFiles, useProjectDocFiles, useLocalFile, useMountLocalDir, useUnmountLocalDir,
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
  PROJECT_TYPE, PROJECT_ROLES, PROJECT_ROLE_DICT, DEFAULT_PROJECT_ROLE, projectRoleItems, defaultProjectRole, useProjectRoles, projectView, mergeProjectProps, isLiveProject, saveProject, projectsApi, useProjects, useProject,
  useCreateProject, useSaveProject, useProjectStakeholders,
} from './projects'
// 项目下拉选项（读缓存），插件登记的 SOP 节点用（消息分流）
export { projectOptions } from './projects'
export type { ProjectView, ProjectMark, RelatedDir, ProjectProps, ProjectCreate, ProjectSave, ProjectRole, ProjectRoleItem, ProjectStakeholder } from './projects'
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
  useTestConnector, useRefreshConnectorTools, useSetConnectorToolModes, useStartConnectorOAuth, useFetchConnectorIcon,
} from './connectors'
export { PLATFORM_DOMAINS, addressFields, connectorLook, detectPlatform, detectedLogo } from './connectorLogo'
export type { ConnectorLook } from './connectorLogo'
export type {
  Connector, ConnectorDef, ConnectorField, ConnectorTool, ConnectorToolDef, ConnectorAuthMode, ConnectorToolMode, ConnectorStatus,
  ConnectorDirection, ConnectorInput, ConnectorPatch, ConnectorTestResult, ConnectorRefreshResult, ConnectorIconFetchResult,
  ConnectorOAuthDef, ConnectorOAuthState, ConnectorOAuthStart,
} from './connectors'
export { imChannelsApi, imConversationsKey, useImConversations } from './imChannels'
export type { ImConversationKind, ImConversationList, ImConversationOption } from './imChannels'
export {
  projectStakeholdersApi, useAddProjectStakeholder, useAddProjectStakeholders, usePatchProjectStakeholder, useRemoveProjectStakeholder,
} from './projectStakeholders'
export type { ProjectStakeholderInput, ProjectStakeholderPatch, ProjectStakeholdersAdded } from './projectStakeholders'
export { IM_EXPIRE_DAYS_MAX, IM_QUICK_REPLIES_MAX, IM_QUICK_REPLY_TEXT_MAX, IM_PAGE_MAX, imApi, normMessage, useImMessages, useImMessage, useImRecentMessages, useImAction, useImBatch, useImToTask, useImPendingCount, useImSyncConnector, useImSettings, usePatchImSettings, useImConversationProjects, useSetImConversationProject, useImStartSession } from './im'
export type { ImMaterialKind, ImMessageMaterial, ImMessageThread, ImMaterialSource, ImMaterialLinkInput, ImMaterialLinkResult, ImMessage, ImMsgStatus, ImRelevance, ImAttachment, ImReply, ImAction, ImBatchInput, ImBatchResult, ImTaskInput, ImTaskResult, ImTaskReply, ImSyncResult, ImSettings, ImQuickReply, ImConversationProject, ImMessageSession, ImSplitTask, ImSessionIntent, ImSessionLinkInput, ImSessionLinkResult, ImStartSessionInput } from './im'
export { imEmailApi, useImBackfillEmails } from './imEmails'
export { IM_CONV_BATCH_MAX, IM_MENTIONS_MAX, IM_SEND_MAX, imGroupsApi, useImConversationSummary, useImMembers, useImSendToConversation, useImSent, useRefillImNames, useSetImConversationProjects } from './imGroups'
export type { ImConvProjectBatchInput, ImConvProjectBatchResult, ImConvProjectFailure, ImConversationSummary, ImMember, ImMention, ImNameFailed, ImNameFilled, ImNameRefillResult, ImOutboxItem, ImSendInput } from './imGroups'
export type { ImEmailBackfillResult, ImEmailConflict, ImEmailFilled } from './imEmails'
// 群组管理补全消息（IM 0.30.0，TSK-0724）
export { useImBackfillConversation } from './imGroups'
export type { ImHistoryBackfillResult, ImHistoryRange } from './imGroups'
// 自动忽略发信人（IM 0.27.0，TSK-0495）
export { findMute, imMutesApi, useCreateImMute, useImMutePending, useImMutes, useRemoveImMute } from './imMutes'
export type { ImMessageMute, ImMute, ImMuteInput, ImMuteResult, ImMuteTarget } from './imMutes'
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
export { PROFILE_COMMANDS, PROFILE_COMMAND_GROUPS, projectProfileApi, projectProfileKeys, useProjectProfile, useProjectProfiles, useSaveProjectProfile } from './projectProfile'
export type { ProfileCommand, ProfileCommandGroup, ProfileCommandKey, ProfileDirState, ProjectProfile, ProjectProfilePatch, ProjectProfileSummary } from './projectProfile'
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
  isSopRunRelaunched, sopRunShow, isSopHeld, useSopPipeline, SOP_CLAUDE_CONCURRENCY_MAX, SOP_TASK_MAX_RUNS_MAX, SOP_TASK_MAX_MINUTES_MAX,
} from './sop'
export type {
  SopJson, SopField, SopFieldOption, SopCase, SopStepDef, SopFlow, SopNodeType, SopStepStatus, SopRunStatus, SopRunShow, SopRunStep, SopRun,
  SopRunBrief, SopRunSource, SopRunAction, SopStartInput, SopDraft, SopIssue, SopAssistReply, SopAssistInput, SopSettings,
  SopSettingsPatch, SopStepQueue, SopStepHold, SopWaitKind, SopWaitingItem, SopPipelineStep, SopPipelineRun, SopClaudeUsage, SopPipelineBudget, SopPipeline,
} from './sop'
// SOP 的定时触发（TSK-0463）：规则存在随流程管理的定时任务里
export { SOP_IM_RELEVANCES, SOP_TRIGGER_IM, SOP_TRIGGER_SCHEDULE } from './sop'
export type { SopIMDraft, SopIMRelevance, SopIMTrigger, SopScheduleDraft, SopScheduleOff } from './sop'
// 结构化条件、节点声明、这一步能拿到的字段（TSK-0490）
export { SOP_COND_OPS, normIssues, useSopStepFields } from './sop'
// 调试（TSK-0491）
export { useSopDebug, useSopIMExplain, useSopSkips } from './sop'
export type { SopDebug, SopDebugAction, SopDebugCond, SopDebugCondItem, SopDebugInput, SopDebugSource, SopDebugStatus, SopDebugStep, SopEffect, SopIMExplain, SopIMExplainFlow, SopIMVerdict, SopSkip, SopSkipReason, SopSkips } from './sop'
export type { SopCond, SopCondItem, SopCondOp, SopFieldGroup, SopFieldInfo, SopOption, SopOutput, SopParam, SopStepFieldsDraft, SopTrigger } from './sop'
// 挂起等服务商恢复（TSK-0392）
export { isSopProviderWait } from './sop'
export type { SopProviderWait } from './sop'
// 没走完和待我处理的执行，不受最近 500 条限制（TSK-0486）
export { fetchSopOpenRuns, sopOpenRunsKey, useSopOpenRuns } from './sop'
// 流程库的文件夹（TSK-0482）
export { SOP_FOLDER_NAME_MAX, SOP_FOLDER_RESERVED, useDeleteSopFolder, useMoveSopFlows, useSaveSopFolder, useSopFolders } from './sop'
export type { SopFolder } from './sop'
// 任务阶段全集和阶段变化历史（AUTO-05、AUTO-12）
export { TASK_STAGES, WAITING_STAGES, taskStageLabel, stageHistoryApi, useStageHistory } from './stageHistory'
export type { TaskStage, StageChange } from './stageHistory'

// 批量发起、按输入字段查执行（IM 页批量分诊、处理队列）
export { SOP_BATCH_MAX, SOP_RERUN_REASON_RELAUNCHED, applyRerun, sopBatchApi, triageFlows, useRerunSopRuns, useSopRunsByInput, useStartSopBatch, useStopSopRuns } from './sopBatch'
export type { SopBatchItem, SopBatchResult, SopInputRun, SopRerunAction, SopRerunResult } from './sopBatch'
// 批量停止（TSK-0717）
export { newSopBatchId, useSopStopPreview, useStopSopWhere } from './sopBatch'
export type { SopRunStatusCounts, SopStopResult, SopStopScope } from './sopBatch'

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
// 项目知识库（TSK-0721）
export { kbPagePath, kbSyncLine, projectKbApi, useBindProjectKb, useProjectKb, useSyncProjectKb } from './projectKb'
export type { ProjectKb, ProjectKbBind, ProjectKbInfo, ProjectKbProblem, ProjectKbSources, ProjectKbSync } from './projectKb'

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
// 分镜和 B-roll 素材（TSK-0456）
export {
  storyboardApi, storyboardKeys, mediaFileUrl, mediaThumbUrl, useShots, useAddShot, usePatchShot, useRemoveShot, useReorderShots, useGenerateShots,
  useAddBrolls, useReorderBrolls, usePatchBroll, useRemoveBroll, useMediaRoots, useAddMediaRoot, useRenameMediaRoot, useRemoveMediaRoot, useMediaBrowse,
} from './storyboard'
export type { VideoShot, VideoBroll, VideoMediaRoot, VideoMediaFile, VideoMediaListing, VideoMediaQuery, GenerateShotsResult } from './storyboard'

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

export {
  MAX_ENV_KEEP_HOURS, REMOVED_REASON, portRangeError, useCleanupWorktree, usePrepareWorktree, useSaveWorktreeSettings, useTaskWorktrees, useWorktreeSettings,
  worktreeApi, worktreeKeys, worktreeState,
} from './worktrees'
export type { Worktree, WorktreeSettings, WorktreeSettingsPatch } from './worktrees'
export {
  ENV_RELEASE_LABEL, STEP_STATUS_LABEL, TEST_STATUS_LABEL, durationText, testReportUrl, testRunApi, testRunKeys, testShotUrl, testSummary, testTone,
  useReleaseTestEnv, useStartTestRun, useStopTestRun, useTaskTestRuns,
} from './testRuns'
export type { JunitSummary, TestEnvReleaseReason, TestEnvState, TestRun, TestRunStatus, TestStep, TestStepKey, TestStepStatus } from './testRuns'
export {
  RELEASE_PHASE_LABEL, RELEASE_STATUS_LABEL, ROLLBACK_LABEL, releaseApi, releaseKeys, releaseReportUrl, releaseSummary, releaseTone, useStopRelease,
  useTaskReleases,
} from './releases'
export type { Release, ReleasePhase, ReleaseStatus, ReleaseStep, ReleaseStepKey, ReleaseStepStatus, RollbackState } from './releases'
export {
  DECISION_LABEL, IMPL_STATUS_LABEL, PROTO_SYNC_KIND_LABEL, PROTO_SYNC_STATUS_LABEL, PROTO_SYNC_TRIGGER_LABEL, implTone, protoSyncApi, protoSyncKeys,
  protoSyncSummary, protoSyncTone, shortSha, specStatuses, useCancelProtoSync, useProtoSyncHistory, useProtoSyncState, useSaveProtoSyncSettings,
  useTriggerProtoSync,
} from './protoSyncs'
export type {
  ImplStatus, ProtoSync, ProtoSyncCounts, ProtoSyncDecision, ProtoSyncItem, ProtoSyncKind, ProtoSyncSettings, ProtoSyncSettingsPatch, ProtoSyncState,
  ProtoSyncStatus, ProtoSyncTrigger, SyncPoint,
} from './protoSyncs'

export {
  etfKeys, etfApi, useEtfFunds, useEtfDaily, useEtfMetrics, useEtfAnomalies, useEtfRules, useAckEtfAnomaly, useCreateEtfRule,
  usePatchEtfRule, useCollectEtf,
} from './etf'
export type {
  EtfFund, EtfDaily, EtfMetrics, EtfAnomaly, EtfRule, EtfRuleInput, EtfRulePatch, EtfCollectResult, EtfAnomalyFilter, EtfSeverity,
  EtfAnomalyStatus, EtfOperator, EtfScope, EtfPremiumBasis,
} from './etf'

export {
  tradeKeys, tradeApi, useTradeSources, useTradeWatchlists, useTradeInstrumentSearch, useTradeInstrument, useTradeKlines, useAddWatchlist,
  usePatchWatchlist, useRemoveWatchlist, useTradeLive,
} from './trade'
export type {
  TradeMarket, TradeKind, TradeInterval, TradeInstrument, TradeWatchlist, TradeSource, TradeSourceHealth, TradeDataStatus, TradeQuote,
  TradeLevel, TradeBook, TradeFunding, TradeKline, TradeKlineMeta, TradeLive, TradeLiveTransport, TradeLiveOptions,
} from './trade'

export {
  tradeAlertKeys, tradeAlertsApi, useTradeAlerts, useTradeAlertValues, useTradeAlertPreview, useTradeAlertEvents, useCreateTradeAlert,
  usePatchTradeAlert, useRemoveTradeAlert, useRearmTradeAlert, useReadTradeAlertEvents, useTradeAlertFired, useTradeInstrumentMap,
} from './tradeAlerts'
export type {
  TradeAlert, TradeAlertCond, TradeAlertNotify, TradeAlertInput, TradeAlertEvent, TradeAlertFired, TradeAlertImStatus, TradeAlertValue,
  TradeAlertValueStatus, TradeAlertEventPage,
} from './tradeAlerts'

export {
  tradeStrategyKeys, tradeStrategyApi, useTradeStrategies, useTradeBacktests, useTradeBacktest, useTradeBacktestCompare, useCreateTradeStrategy,
  usePatchTradeStrategy, useRemoveTradeStrategy, useStartTradeBacktest, useRerunTradeBacktest, useRemoveTradeBacktest, useSweepTradeBacktest,
} from './tradeStrategy'
export type {
  TradeIndicator, TradeCompare, TradeOperand, TradeRule, TradeRuleGroup, TradeStrategyMode, TradeDirection, TradeStrategy, TradeStrategyInput,
  TradeBacktestStatus, TradeBacktestConfig, TradeBacktestTrade, TradeBacktestStats, TradeEquityPoint, TradeBacktestResult, TradeSweepPoint,
  TradeSweep, TradeBacktest, TradeBacktestBrief, TradeBacktestStart,
} from './tradeStrategy'

export {
  tradePaperKeys, tradePaperApi, tradePlaceError, tradeKillPartial, useTradeAccounts, useTradePositions, useTradeOrders, useTradeFillWatch,
  useTradeRuns, useTradeRun, useTradeRisk, useTradeHalts, useTradeHaltEvents, useCreateTradeAccount, usePlaceTradeOrder, useModifyTradeOrder,
  useCancelTradeOrder, useCancelAllTradeOrders, useCloseTradePosition, useCreateTradeRun, useTradeRunAction, usePatchTradeRisk, useKillTrading,
  useReleaseHalt,
} from './tradePaper'
export type {
  TradeAccount, TradeAccountInput, TradeOrderSide, TradeOrderType, TradeOrderStatus, TradeOrderSource, TradeOrder, TradeOrderInput,
  TradeOrderQuery, TradeOrderPage, TradePosition, TradeRunStatus, TradeRunLog, TradeRunHolding, TradeRun, TradeRunInput, TradeRunPage,
  TradeRiskDay, TradeRiskRules, TradeRisk, TradeKillResult, TradeHalt, TradePlaceError, TradeReconBrief,
} from './tradePaper'
export {
  tradeLiveKeys, tradeLiveApi, evidenceKind, TRADE_PLUGIN_ID, TRADE_LIVE_PERM, useTradeLiveSnapshot, useTradeLiveFills, useTradeRecon,
  useTradeRecons, useTradeAudit, useTradeLiveGate, useCreateLiveAccount, useRemoveTradeAccount, useConnectTradeAccount,
  useDisconnectTradeAccount, useRecheckRecon, useResolveRecon, useConfirmLiveCheck, useRevokeLiveCheck, useSetLiveSwitch,
  useGrantTradeLive, useRevokeTradeLive,
} from './tradeLive'
export type {
  TradeLiveBalance, TradeLivePosition, TradeLiveOrder, TradeLiveFill, TradeLiveSnapshot, TradeReconItem, TradeRecon, TradeReconRecord,
  TradeAudit, TradeLiveEvidence, TradeLiveCheckState, TradeLiveCheckKey, TradeLiveCheck, TradeLiveRecord, TradeLiveGate, TradeLiveAccountInput,
} from './tradeLive'
// B 站组件（TSK-0455）
export {
  videoBiliApi, videoBiliKeys, biliGuardOf, biliNeedsLogin, newClientMsgId, BILI_TEXT_MAX, useBiliAccounts, useBiliOverview, useBiliSessions,
  useBiliMessages, useBiliQRCode, useBiliPoll, useBiliLogout, useBiliRefreshOverview, useBiliRefreshSessions, useBiliSyncTalker, useBiliSend,
} from './videoBili'
export type {
  BiliAccount, BiliLogin, BiliGuard, BiliSnapshot, BiliTrend, BiliTrendMetric, BiliOverview, BiliSession, BiliMessage, BiliMessageStatus,
  BiliQRCode, BiliPoll, BiliPollState, BiliSessions, BiliMessages,
} from './videoBili'
// 录音转写插件 recording（M1 + M4a + M5）
export {
  recordingKeys, recordingApi, recordingAudioUrl, recordingFileUrl, recordingLive, recordingPolling,
  useRecordingList, useRecording, useRecordingFiles, useRecordingSpeakers, useVoiceprints, useRecordingSettings, useRecordingMeta,
  useCreateRecording, useUploadAudio, useRetranscribe, usePatchRecording, useDeleteRecording,
  useGenerateMinutes, useStartSop, useConfirmTodo, useIgnoreTodo, useDiarize, useRenameSpeaker, useBindSpeaker,
  useDeleteVoiceprint, useSaveSettings, useDownloadModel, useDeleteModel,
} from './recording'
export type {
  RecordingStatus, RecordingJobStatus, RecordingJob, Segment, RecordingSummary, Recording, RecordingInput, RecordingPatch,
  RecordingListFilter, ToolInfo, ModelStatus, ModelInfo, RecordingSettings, RecordingSettingsInput, RecordingMeta,
  RecordingAction, RecordingProject, RecordingGoal, RecordingQuestion, RecordingFlowNode, RecordingFlowEdge, RecordingFlow,
  RecordingTreeNode, RecordingTree, RecordingDiagrams, RecordingMinutes, RecordingFile, RecordingFileKind, TodoKind, TodoStatus,
  RecordingTodo, TodoConfirmInput, RecordingSopResult, RecordingSpeaker, Voiceprint,
} from './recording'
