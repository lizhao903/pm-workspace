// Package store 定义数据访问的单一入口。API 层只依赖这个接口，不直接碰 SQL。
package store

import (
	"context"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// Actor 描述一次写操作的来源，用于修订历史取证。
type Actor struct {
	Name   string // 默认 "me"
	Source string // ui|api|agent|import
	// Session 是发起这次写入的会话标识（如 Claude Code 的会话 id），可空。
	// 落库时和 Name 拼进 revisions.actor，见 domain.ComposeActor。
	Session string
}

var DefaultActor = Actor{Name: "me", Source: "api"}

// DefaultRunLimit 是不指定条数时返回的执行历史长度。
//
// 这个数字放在接口包而不是各自的实现里：api 的参数默认值、sqlite 的兜底、
// 测试替身的兜底必须是同一个值。三处各写一个 20，其中一处被改掉时不会有任何
// 东西变红——测试在替身上绿，生产返回另一个条数。
const DefaultRunLimit = 20

// DefaultArtifactLimit 同理，是产物列表不指定条数时的一页长度。
// 比执行历史大一档：产物页是个清单，一屏只给 20 条会让「统计全部产物」
// 变成不停翻页。
const DefaultArtifactLimit = 100

// DefaultProgressLimit 是进展列表不指定条数时的长度。一条开发任务一般十几条进展，
// 给 100 足够一次读完，又不会把半年的流水全搬出来。
const DefaultProgressLimit = 100

type Store interface {
	Close() error
	Ping(ctx context.Context) error
	Stats(ctx context.Context) (map[string]any, error) // db 路径/体积/对象数，给状态栏

	// 工作对象类型
	ListObjectTypes(ctx context.Context) ([]*domain.ObjectType, error)
	GetObjectType(ctx context.Context, id string) (*domain.ObjectType, error)
	CreateObjectType(ctx context.Context, t *domain.ObjectType) (*domain.ObjectType, error)
	UpdateObjectType(ctx context.Context, id string, p domain.ObjectTypePatch) (*domain.ObjectType, error)
	DeleteObjectType(ctx context.Context, id string) error // builtin 返回 ErrReadOnly；有对象时返回 ErrConflict

	// 分类树
	ListCategories(ctx context.Context, typeID string, withCounts bool) ([]*domain.Category, error)
	CategoryTree(ctx context.Context, typeID string, withCounts bool) ([]*domain.Category, error)
	GetCategory(ctx context.Context, id string) (*domain.Category, error)
	CreateCategory(ctx context.Context, c *domain.Category) (*domain.Category, error)
	UpdateCategory(ctx context.Context, id string, p domain.CategoryPatch) (*domain.Category, error)
	MoveCategory(ctx context.Context, id string, parentID *string, sortOrder int) (*domain.Category, error)
	// DeleteCategory 删除分类；reassignTo 为 nil 时挂在其下的对象置为未分类，子分类一并处理。
	DeleteCategory(ctx context.Context, id string, reassignTo *string) error

	// 工作对象
	ListObjects(ctx context.Context, f domain.ObjectFilter) (items []*domain.Object, total int, err error)
	GetObject(ctx context.Context, id string) (*domain.Object, error)
	CreateObject(ctx context.Context, o *domain.Object, a Actor) (*domain.Object, error)
	UpdateObject(ctx context.Context, id string, p domain.ObjectPatch, a Actor) (*domain.Object, error)
	DeleteObject(ctx context.Context, id string, hard bool, a Actor) error
	RestoreObject(ctx context.Context, id string, a Actor) (*domain.Object, error)

	// 标签
	ListTags(ctx context.Context) ([]*domain.Tag, error)
	CreateTag(ctx context.Context, name, color string) (*domain.Tag, error)
	UpdateTag(ctx context.Context, id string, name, color *string) (*domain.Tag, error)
	// MergeTags 把 srcID 的对象全部改打 dstID，然后删掉 srcID。
	// 手工打了同义标签之后必然需要，是标签管理最高频的操作。
	MergeTags(ctx context.Context, srcID, dstID string) (*domain.Tag, error)
	DeleteTag(ctx context.Context, id string) error

	// 关联
	ListLinks(ctx context.Context, objectID string) ([]*domain.LinkView, error)
	CreateLink(ctx context.Context, fromID, toID, relation, note string) (*domain.Link, error)
	DeleteLink(ctx context.Context, id string) error

	// 修订历史
	ListRevisions(ctx context.Context, objectID string, limit int) ([]*domain.Revision, error)
	RecentRevisions(ctx context.Context, limit int) ([]*domain.Revision, error)

	// 进展（开发任务闭环）
	//
	// 进展落在 revisions 里（field='progress'），只插入不更新，所以两个会话同时追加
	// 不会互相覆盖——这正是不能让调用方「读出正文、拼上一段、整体写回」的原因。
	// ListProgress 返回**最近** limit 条，最近的在前，和执行历史同一个读法；
	// limit <= 0 取 DefaultProgressLimit。
	ListProgress(ctx context.Context, objectID string, limit int) ([]*domain.Progress, error)
	// AppendProgress 追加一条进展。in.Status 非空时在同一事务里切状态。
	AppendProgress(ctx context.Context, objectID string, in domain.ProgressInput, a Actor) (*domain.Progress, error)
	// ClaimObject 领取：在一个写事务里检查「有没有被别人领走」并改状态、负责人、记进展。
	// 检查和写入必须在同一个事务里，否则两个会话同时领会都通过检查。
	// 被占用时返回 ErrConflict，message 写明是谁、哪个会话。
	ClaimObject(ctx context.Context, objectID string, in domain.ClaimInput, a Actor) (*domain.ClaimResult, error)

	// 快捷访问
	ListShortcutGroups(ctx context.Context) ([]*domain.ShortcutGroup, error)
	CreateShortcutGroup(ctx context.Context, g *domain.ShortcutGroup) (*domain.ShortcutGroup, error)
	UpdateShortcutGroup(ctx context.Context, id string, p domain.ShortcutGroupPatch) (*domain.ShortcutGroup, error)
	// DeleteShortcutGroup 删除分组；组内条目变为未分组，不级联删除。
	DeleteShortcutGroup(ctx context.Context, id string) error

	// ListShortcuts 按 sort_order 返回全部条目；grouped=true 时改为按组嵌套返回（未分组的放在 GroupID 为 nil 的伪组里，由 API 层处理呈现）。
	ListShortcuts(ctx context.Context) ([]*domain.Shortcut, error)
	GetShortcut(ctx context.Context, id string) (*domain.Shortcut, error)
	CreateShortcut(ctx context.Context, s *domain.Shortcut) (*domain.Shortcut, error)
	UpdateShortcut(ctx context.Context, id string, p domain.ShortcutPatch) (*domain.Shortcut, error)
	DeleteShortcut(ctx context.Context, id string) error
	// VisitShortcut 记一次使用：use_count+1、last_used_at=now。
	VisitShortcut(ctx context.Context, id string) (*domain.Shortcut, error)
	// ReorderShortcuts 传一个组内的全量有序 ID 列表，按下标重写 sort_order；groupID 为 nil 表示未分组区。
	ReorderShortcuts(ctx context.Context, groupID *string, ids []string) error

	// Agent 供应商
	ListProviders(ctx context.Context) ([]*domain.AgentProvider, error)
	GetProvider(ctx context.Context, id string) (*domain.AgentProvider, error)
	CreateProvider(ctx context.Context, p *domain.AgentProvider, apiKey string) (*domain.AgentProvider, error)
	UpdateProvider(ctx context.Context, id string, in domain.AgentProviderInput) (*domain.AgentProvider, error)
	DeleteProvider(ctx context.Context, id string) error
	// SetDefaultProvider 保证全局只有一个默认供应商（事务内先清后置）。
	SetDefaultProvider(ctx context.Context, id string) error
	// ProviderAPIKey 取出明文密钥，只允许服务端调模型时使用，绝不能进 HTTP 响应。
	ProviderAPIKey(ctx context.Context, id string) (string, error)

	// 干系人名册。负责人与参与人都指向这里。
	//
	// ListStakeholders 的 includeArchived=false 只返回在岗的（选人时用），
	// true 返回全部（名册管理页用）。两个场景的口径不同，不要合并成一个默认值。
	// 返回的每个人都带 OwnedCount / ParticipatingCount——删除前要看引用，
	// 而让调用方逐个回查就是 N+1。
	ListStakeholders(ctx context.Context, includeArchived bool) ([]*domain.Stakeholder, error)
	GetStakeholder(ctx context.Context, id string) (*domain.Stakeholder, error)
	CreateStakeholder(ctx context.Context, sh *domain.Stakeholder) (*domain.Stakeholder, error)
	UpdateStakeholder(ctx context.Context, id string, p domain.StakeholderPatch) (*domain.Stakeholder, error)
	// DeleteStakeholder 仅在无引用时允许；有对象引用返回 ErrConflict，让调用方改走归档。
	// 「归档而不是删除」和 dict_items 一致：人被历史对象引用过，删掉会留下查不出来源的空位。
	DeleteStakeholder(ctx context.Context, id string) error

	// 任务执行记录（本机 Claude Code）
	// ListTaskRuns 返回该对象**最近** limit 条执行记录，按开始时间倒序（最近的在前）——
	// 和 ListAgentMessages 一样，取最早 N 条是错的。limit <= 0 时取 DefaultRunLimit，
	// 不是「全部」：一个跑了半年的对象，全量返回会把每条的完整 output 一起搬进内存。
	ListTaskRuns(ctx context.Context, objectID string, limit int) ([]*domain.TaskRun, error)
	GetTaskRun(ctx context.Context, id string) (*domain.TaskRun, error)
	CreateTaskRun(ctx context.Context, r *domain.TaskRun) (*domain.TaskRun, error)
	// FinishTaskRun 落最终状态与完整输出。输出可能很大，由调用方自行截断。
	FinishTaskRun(ctx context.Context, id, status string, exitCode int, output, errMsg string) (*domain.TaskRun, error)
	// ResolveWorkdir 取对象的有效工作区：自身没设时回退到所属项目的，都没有返回空串。
	ResolveWorkdir(ctx context.Context, objectID string) (string, error)

	// Agent 会话
	// ListAgentSessions 按 filter 返回会话，最近更新的在前。
	//
	// filter 的两个字段互斥，**都不给就是零条，不是全部**。这个默认值是故意反直觉的：
	// 「全部」在这个产品里没有一个正确的展示位置——抽屉要的是这个对象的，
	// 底部对话框要的是全局的，两边都不该看到对方的。让忘记传 filter 的调用方
	// 拿到空列表，比让它拿到一堆不属于自己的会话好查。
	ListAgentSessions(ctx context.Context, f domain.AgentSessionFilter) ([]*domain.AgentSession, error)
	GetAgentSession(ctx context.Context, id string) (*domain.AgentSession, error)
	CreateAgentSession(ctx context.Context, s *domain.AgentSession) (*domain.AgentSession, error)
	UpdateAgentSession(ctx context.Context, id string, title, workdir, providerID, model *string) (*domain.AgentSession, error)
	DeleteAgentSession(ctx context.Context, id string) error

	// Agent 配置（AG-01b1，0032）。ProviderID 必须是存在的服务商，Model 不校验是否在模型列表里；
	// 名称、头像、触发方式等的校验和默认值在实现里，规则见 docs/api-contract.md「Agent 配置 agents」。
	// ListAgents 新建的在前。DeleteAgent 回删掉的那条；会话不动，之后读出来 agent_deleted 为 true。
	ListAgents(ctx context.Context) ([]*domain.Agent, error)
	GetAgent(ctx context.Context, id string) (*domain.Agent, error)
	CreateAgent(ctx context.Context, in domain.AgentInput) (*domain.Agent, error)
	UpdateAgent(ctx context.Context, id string, in domain.AgentInput) (*domain.Agent, error)
	DeleteAgent(ctx context.Context, id string) (*domain.Agent, error)
	// CountAgentSessions 数挂在这个 Agent 上的会话，删除前的影响检查用。
	CountAgentSessions(ctx context.Context, agentID string) (int, error)

	// 自定义技能（AG-01b2，0033）。内置和插件技能不在库里，由接口层合进列表，见 skills.go。
	// ListSkills 新建的在前。DeleteSkill 回删掉的那条和被摘掉它的 Agent id（按 Agent 新建的在前）。
	ListSkills(ctx context.Context) ([]*Skill, error)
	GetSkill(ctx context.Context, id string) (*Skill, error)
	CreateSkill(ctx context.Context, in SkillInput) (*Skill, error)
	UpdateSkill(ctx context.Context, id string, in SkillInput) (*Skill, error)
	DeleteSkill(ctx context.Context, id string) (*Skill, []string, error)

	// 知识库（AG-01b3，0034），见 kb.go。
	KnowledgeStore

	// Agent 工具授权和要人确认的调用（AG-02a，0035），见 toolgrants.go。
	ToolGrantStore

	// Agent 执行记录（AG-01b4，0036），见 agentruns.go。
	AgentRunStore

	// ListAgentMessages 返回**最近** limit 条消息，但按时间正序（最旧在前）排列，
	// 这样前端拿到就能直接从上往下渲染。limit <= 0 表示全部。
	// 取最早 N 条是错的：对话框要的是「最近说了什么」，而不是「这个会话最开始说了什么」。
	ListAgentMessages(ctx context.Context, sessionID string, limit int) ([]*domain.AgentMessage, error)
	AppendAgentMessage(ctx context.Context, m *domain.AgentMessage) (*domain.AgentMessage, error)

	// 输出产物
	//
	// 这一组取代了 0007 的 ListAgentArtifacts/RecordAgentArtifact。产物不再是
	// agent 会话的附属物：它可能来自内置 agent、Claude Code 执行、用户手工登记，
	// 或别的 agent 通过 MCP 回写。挂在会话下面的话，后三种无处可放。

	// ListArtifacts 按 filter 返回产物，最近登记的在前。
	// total 是**不含 Limit/Offset** 的命中总数，产物页要靠它显示「共 N 件」。
	ListArtifacts(ctx context.Context, f domain.ArtifactFilter) (items []*domain.Artifact, total int, err error)
	GetArtifact(ctx context.Context, id string) (*domain.Artifact, error)
	CreateArtifact(ctx context.Context, in domain.ArtifactInput) (*domain.Artifact, error)
	UpdateArtifact(ctx context.Context, id string, p domain.ArtifactPatch) (*domain.Artifact, error)
	DeleteArtifact(ctx context.Context, id string) error

	// RecordArtifact 是自动来源（agent 写盘、执行后扫目录）的入口：
	// 同一来源范围内路径相同就更新那一条，不新增。
	// 和 CreateArtifact 分开是因为手工登记**需要**能重复——同一个本地文件
	// 先发 Confluence 再发飞书是两条合理记录，去重会把第二条吃掉。
	RecordArtifact(ctx context.Context, in domain.ArtifactInput) (*domain.Artifact, error)

	// ArtifactStats 返回产物页顶部的汇总数。它走的是和 ListArtifacts 同一个
	// filter，所以「筛选后的统计」和「筛选后的列表」永远对得上——
	// 各写一套 WHERE 的话，两个数字会在某个条件下悄悄分叉。
	ArtifactStats(ctx context.Context, f domain.ArtifactFilter) (*domain.ArtifactStats, error)

	// 备份与导出
	Migrations(ctx context.Context) ([]domain.MigrationRecord, error)
	// Snapshot 用 VACUUM INTO 生成一致性快照，不阻塞写入。
	Snapshot(ctx context.Context, dir string) (*domain.BackupInfo, error)
	// Export 导出全库，format 为 json 或 markdown。防数据锁定，也是信任基础。
	Export(ctx context.Context, format string) (filename string, data []byte, err error)

	// 字典（可配置枚举）
	ListDictionaries(ctx context.Context, withItems bool) ([]*domain.Dictionary, error)
	ListDictItems(ctx context.Context, dictID string, typeID *string, includeArchived bool) ([]*domain.DictItem, error)
	CreateDictItem(ctx context.Context, it *domain.DictItem) (*domain.DictItem, error)
	UpdateDictItem(ctx context.Context, id string, p domain.DictItemPatch) (*domain.DictItem, error)
	// ArchiveDictItem 停用/启用。停用的条目已有数据照常显示，但不再出现在新建的下拉里。
	ArchiveDictItem(ctx context.Context, id string, archived bool) (*domain.DictItem, error)
	// DeleteDictItem 仅在引用数为 0 时允许，否则返回 ErrConflict（message 带引用数）。
	DeleteDictItem(ctx context.Context, id string) error
	// DictItemUsage 返回该枚举值被多少条业务数据引用。
	DictItemUsage(ctx context.Context, id string) (int, error)
	ReorderDictItems(ctx context.Context, dictID string, typeID *string, ids []string) error

	// Counts 返回侧栏与工具条的徽标计数。typeID 非空时，聚焦类计数器（Inbox/Today/Week/
	// Overdue/Stalled）按该类型统计；ByType/ByStatus/UncategorizedByType/Total 恒为全局
	// ——侧栏要用它们，它们天然跨类型。混合口径是有意的，不要「统一」成全部按 typeID 过滤。
	Counts(ctx context.Context, typeID string) (*domain.Counts, error)
	// Today 返回今日页的内核卡片（等确认、逾期、今天到期、运行中）。typeID 的语义同 Counts；
	// 逾期、今天到期和 Counts 共用同一份条件，卡片的 Total 必须等于对应的计数器。
	Today(ctx context.Context, typeID string) (*domain.Today, error)
}
