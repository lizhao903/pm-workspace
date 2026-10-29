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
export { dictItemsApi, useDictItemsAll, saveDictItems, useSaveDictItems } from './dictionaries'
export type { DictSavePlan } from './dictionaries'
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
  useDeleteAgentSession, streamChat, setFirstMessage, firstMessageOf,
} from './agent'
export type {
  AgentProvider, AgentProviderKind, ProviderTestResult, AgentSession, AgentMessage, AgentMessageRole, AgentSessionInput, AgentSessionPatch,
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
export {
  PROJECT_TYPE, PROJECT_ROLES, projectView, mergeProjectProps, isLiveProject, saveProject, projectsApi, useProjects, useProject,
  useCreateProject, useSaveProject, useProjectStakeholders,
} from './projects'
export type { ProjectView, ProjectMark, RelatedDir, ProjectProps, ProjectCreate, ProjectSave, ProjectRole, ProjectStakeholder } from './projects'
export { useSaveContact, useUpdateContact, useDeleteContact } from './contacts'
export type { ContactInput, ContactUpdate, ContactSave, ContactSaved } from './contacts'
export {
  identitiesApi, useIdentities, normExternalId, identitiesByContact, imOf, identityOwner, identityPlan, applyIdentityPlan,
} from './identities'
export type { Identity, IdentityInput, IdentityOp, IdentityFailure } from './identities'
export {
  connectorsApi, normConnector, useConnectorDefs, useConnectors, useCreateConnector, usePatchConnector, useDeleteConnector,
  useTestConnector, useRefreshConnectorTools, useSetConnectorToolModes,
} from './connectors'
export type {
  Connector, ConnectorDef, ConnectorField, ConnectorTool, ConnectorToolDef, ConnectorAuthMode, ConnectorToolMode, ConnectorStatus,
  ConnectorDirection, ConnectorInput, ConnectorPatch, ConnectorTestResult, ConnectorRefreshResult,
} from './connectors'
export { projectStakeholdersApi, useAddProjectStakeholder, usePatchProjectStakeholder, useRemoveProjectStakeholder } from './projectStakeholders'
export type { ProjectStakeholderInput, ProjectStakeholderPatch } from './projectStakeholders'
export { IM_PAGE_MAX, imApi, normMessage, useImMessages, useImMessage, useImAction, useImToTask, useImPendingCount } from './im'
export type { ImMessage, ImMsgStatus, ImRelevance, ImAttachment, ImReply, ImAction, ImTaskInput, ImTaskResult } from './im'
export {
  MATERIAL_KINDS, projectMaterialsApi, useProjectMaterials, useAddProjectMaterials, usePatchProjectMaterial, useRemoveProjectMaterial,
} from './materials'
export type { MaterialKind, MaterialStatus, ProjectMaterial, ProjectMaterialInput, ProjectMaterialPatch } from './materials'
export { conversationsApi, normConversation, useConversations } from './conversations'
export type { Conversation, ConversationKind } from './conversations'
export {
  projectConversationsApi, useProjectConversations, useBindProjectConversation, useUnbindProjectConversation, useConversationMessages, useAllImMessages,
} from './projectConversations'
export type { ProjectConversation, ConversationMessages } from './projectConversations'
export {
  PROTOTYPE_STATUS, PROTOTYPE_LOG_MAX, prototypesApi, prototypesPollMs, mergeLogs, useProjectPrototypes, usePrototypeLogs, useAddPrototype,
  usePatchPrototype, useRemovePrototype, useStartPrototype, useStopPrototype,
} from './prototypes'
export type { PrototypeStatus, ProjectPrototype, PrototypeCrash, PrototypeLogLine, PrototypeLogs, PrototypeInput, PrototypePatch } from './prototypes'
export { EMPTY_STAT, SUMMARY_POLL_MS, projectSummaryApi, projectStats, useProjectSummary, usePendingImMessages } from './projectSummary'
export type { ProjectSummary, ProjectStat } from './projectSummary'
export {
  ATTACHMENT_TAG, ATTACH_KIND, PROP_SKIPPED_ATTACHMENTS, attachmentsApi, needsFetch, attachmentHref, attachmentContentUrl, attachmentMaterial,
  attachmentAdded, skipKey, skippedAttachments, useImAttachmentStorage, useFetchAttachment, useAddAttachmentToProject, useSkipAttachment,
  useAttachmentTargets,
} from './attachments'
export type {
  ImAttachmentFile, ImAttachmentStorage, AttachmentRef, AddAttachmentInput, AddAttachmentResult, AttachmentProject, AttachmentTargets,
} from './attachments'
export {
  TERMINAL_MAX_SESSIONS, TERMINAL_PROTO_IDLE_MS, terminalApi, terminalSocketUrl, useTerminalSessions, useTerminalPrototypes,
  useTerminalProtoAction,
} from './terminal'
export type { TerminalSession, TerminalSessionInput, TerminalPrototype } from './terminal'
export {
  SOP_RUNS_MAX, sopApi, useSopFlows, useSopNodeTypes, useSopRuns, useSopRun, useStartSopRun, useSopRunAction, useDeleteSopFlow,
} from './sop'
export type {
  SopJson, SopField, SopFieldOption, SopCase, SopStepDef, SopFlow, SopNodeType, SopStepStatus, SopRunStatus, SopRunStep, SopRun,
  SopRunBrief, SopRunAction, SopStartInput,
} from './sop'

export { skillKeys } from './skillKeys'
export { skillsApi, skillReadonly, useSkills, useCreateSkill, usePatchSkill, useDeleteSkill } from './skills'
export type { Skill, SkillSource, SkillInput, SkillPatch } from './skills'
export {
  knowledgeBasesApi, useKnowledgeBases, useKbDocs, useKbDocsOf, useKbMissing, useKbSearch, useKbAgents, useCreateKb, usePatchKb,
  useDeleteKb, useAddKbDocs, usePatchKbDoc, useRemoveKbDoc, useReindexKb, useSyncKb,
} from './knowledgeBases'
export type {
  KnowledgeBase, KbDoc, KbDocSource, KbDocStatus, KbDir, KbEmbed, KbSettings, KbCounts, KbAddInput, KbSettingsInput, KbInput, KbPatch,
  KbDocPatch, KbMissing, KbSyncResult, KbHit, KbSearchResult, KbAgent,
} from './knowledgeBases'

export { agentConfigKeys } from './agentConfigKeys'
export {
  AGENT_RUNS_LIMIT, agentsApi, useAgents, useAgent, useAgentImpact, useAgentGrants, useAgentRuns, useCreateAgent, usePatchAgent,
  useDeleteAgent,
} from './agents'
export type {
  Agent, AgentAvatar, AgentTrigger, AgentTriggerKind, AgentTriggerMatch, AgentInput, AgentPatch, AgentImpact, AgentImpactItem,
  AgentGrants, AgentGrantMode, AgentRunBrief, AgentRunStatus,
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

// 接口层的纯函数和类型照样给模块用：不发请求，不碰缓存
export { localDay, focusParams, changedFields, isApiError, isStreamError, ApiError, StreamError } from '../api'
export type { Focus, ApiErrorCode, ListResult } from '../api'
export type * from '../api/types'
export type {
  RunEvent, ChatEvent, StreamEvent, RunDone, ChatDone, QuestionOption, StreamErrorKind, StreamOptions, RunRequest, ChatRequest,
} from '../api'
