// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/kb"
)

// 知识库句柄（TSK-0721），见 docs/plugin-api.md 2.0。
// 插件按自己的资料同步知识库（项目插件的「项目资料同步到知识库」节点）：取、建知识库，Sync 让知识库里「本插件 + scope」名下的篇目
// 和插件给的资料一致（新的加、变了的重新索引、没了的移出），人工加的和别的插件、别的 scope 加的不动；AttachAgent 把知识库挂到 Agent。
// 实现在内核接口层（internal/api/kbplugin.go）：读本机文件和知识库挂目录同一套拦截，记审计（操作者记插件）。
// cmd/pmw 经 api.New 接上；没接上时每个方法回 ErrNoKnowledge。

type (
	// KBItem 是插件要放进知识库的一条资料：file、dir、note、link、library。
	KBItem = kb.Item
	// KBSyncResult 是一次同步的结果：新增、更新、移除、没变、跳过、失败的条数，失败和跳过的原因（各最多 50 条）。
	KBSyncResult = kb.ReconcileResult
	// KBProblem 是一条没收进来的资料和原因。
	KBProblem = kb.Problem
)

// KBItem.Kind 的取值。
const (
	KBItemFile    = kb.ItemFile
	KBItemDir     = kb.ItemDir
	KBItemNote    = kb.ItemNote
	KBItemLink    = kb.ItemLink
	KBItemLibrary = kb.ItemLibrary
)

// KnowledgeBaseInfo 是插件看到的一个知识库：Docs 是篇数，Agents 是挂着它的 Agent id（按 Agent 新建的在前）。
type KnowledgeBaseInfo struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Desc   string   `json:"desc"`
	Docs   int      `json:"docs"`
	Agents []string `json:"agents"`
}

// KnowledgeService 是插件用知识库的入口（Core.Knowledge()）。
type KnowledgeService interface {
	// Get 读一个知识库，不存在回 ErrNoRows。
	Get(ctx context.Context, id string) (KnowledgeBaseInfo, error)
	// Create 建一个知识库（默认切分设置、不选分类、不挂目录），记审计。名称规则同 POST /api/knowledge-bases。
	Create(ctx context.Context, name, desc string) (KnowledgeBaseInfo, error)
	// Sync 让知识库里 origin「<插件 id>:<scope>」名下的篇目和 items 一致，scope 不能为空（例：项目 id）。
	// 知识库不存在回 ErrNoRows；正在同步回冲突错误（domain.ErrConflict）。
	Sync(ctx context.Context, kbID, scope string, items []KBItem) (KBSyncResult, error)
	// AttachAgent 把知识库挂到 Agent 的 kbs，已经挂着回 false；Agent 或知识库不存在回 ErrNoRows。记审计。
	AttachAgent(ctx context.Context, agentID, kbID string) (bool, error)
}

// KnowledgeBackend 是内核的实现，caller 是调用的插件 id，origin 已经拼好。
type KnowledgeBackend interface {
	Get(ctx context.Context, id string) (KnowledgeBaseInfo, error)
	Create(ctx context.Context, caller, name, desc string) (KnowledgeBaseInfo, error)
	Sync(ctx context.Context, caller, kbID, origin string, items []KBItem) (KBSyncResult, error)
	AttachAgent(ctx context.Context, caller, agentID, kbID string) (bool, error)
}

// ErrNoKnowledge：注册表没接上知识库的实现（测试里没接时）。
var ErrNoKnowledge = errors.New("知识库还没接上")

type knowledgeBox struct{ b KnowledgeBackend }

// SetKnowledge 接上知识库的实现，可以在 Start 之后调（用时现取）。
func (r *Registry) SetKnowledge(b KnowledgeBackend) { r.knowledge.Store(&knowledgeBox{b}) }

func (c *core) Knowledge() KnowledgeService { return knowledgeService{c} }

type knowledgeService struct{ c *core }

func (k knowledgeService) backend() (KnowledgeBackend, error) {
	if r := k.c.reg; r != nil {
		if b := r.knowledge.Load(); b != nil && b.b != nil {
			return b.b, nil
		}
	}
	return nil, ErrNoKnowledge
}

func (k knowledgeService) Get(ctx context.Context, id string) (KnowledgeBaseInfo, error) {
	b, err := k.backend()
	if err != nil {
		return KnowledgeBaseInfo{}, err
	}
	return b.Get(ctx, id)
}

func (k knowledgeService) Create(ctx context.Context, name, desc string) (KnowledgeBaseInfo, error) {
	b, err := k.backend()
	if err != nil {
		return KnowledgeBaseInfo{}, err
	}
	return b.Create(ctx, k.c.id, name, desc)
}

func (k knowledgeService) Sync(ctx context.Context, kbID, scope string, items []KBItem) (KBSyncResult, error) {
	scope = strings.TrimSpace(scope)
	if scope == "" {
		return KBSyncResult{}, fmt.Errorf("同步知识库要给 scope")
	}
	b, err := k.backend()
	if err != nil {
		return KBSyncResult{}, err
	}
	return b.Sync(ctx, k.c.id, kbID, k.c.id+":"+scope, items)
}

func (k knowledgeService) AttachAgent(ctx context.Context, agentID, kbID string) (bool, error) {
	b, err := k.backend()
	if err != nil {
		return false, err
	}
	return b.AttachAgent(ctx, k.c.id, agentID, kbID)
}
