// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strconv"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 插件用知识库（TSK-0721），接口见 internal/plugin/knowledge.go ---
//
// 读本机文件的拦截和知识库挂目录、/api/fs/read 同一套：库文件、密钥证书类文件不收，数据目录里的不收；
// 例外是数据目录下的附件目录（attachments/，IM 消息附件存在这里，项目资料里「加入资料」的附件指向它），里面的文本文件可以收。
// 整个目录收的时候，目录本身不能是隐藏目录、数据目录或包住数据目录的（同挂目录的 forbiddenMount）。
// 审计按 config 记，操作者记插件（source plugin）：建知识库 knowledge_base/create，挂 Agent agent/update，
// 同步有增删改时 knowledge_base/sync（detail 是条数）。

type pluginKB struct{ s *Server }

var _ plugin.KnowledgeBackend = pluginKB{}

// pluginKBService 是插件同步用的 kb.Service：比 kbService 多放行附件目录，另给整目录的拦截。
func (s *Server) pluginKBService() *kb.Service {
	sv := s.kbService()
	sv.Allow = func(p string) bool {
		real := realPath(p)
		if sensitiveFile(real) {
			return false
		}
		return !s.inDataDir(real) || s.inAttachments(real)
	}
	sv.AllowDir = func(p string) bool { return !s.forbiddenMount(p) }
	return sv
}

// inAttachments：p（已解析软链）在数据目录的附件目录里，且附件目录以下没有隐藏段。
func (s *Server) inAttachments(real string) bool {
	if s.opt.DataDir == "" {
		return false
	}
	rel, ok := within(realPath(filepath.Join(s.opt.DataDir, plugin.AttachmentsSubdir)), real)
	return ok && rel != "." && !hasHiddenSeg(rel)
}

func kbNotFound(err error) error {
	if errors.Is(err, domain.ErrNotFound) {
		return plugin.ErrNoRows
	}
	return err
}

func (p pluginKB) info(ctx context.Context, k *store.KnowledgeBase) (plugin.KnowledgeBaseInfo, error) {
	counts, err := p.s.st.KbCounts(ctx)
	if err != nil {
		return plugin.KnowledgeBaseInfo{}, err
	}
	agents, err := p.s.kbAgents(ctx)
	if err != nil {
		return plugin.KnowledgeBaseInfo{}, err
	}
	out := plugin.KnowledgeBaseInfo{ID: k.ID, Name: k.Name, Desc: k.Desc, Docs: counts[k.ID].Docs, Agents: []string{}}
	for _, a := range agents[k.ID] {
		out.Agents = append(out.Agents, a.ID)
	}
	return out, nil
}

func (p pluginKB) Get(ctx context.Context, id string) (plugin.KnowledgeBaseInfo, error) {
	k, err := p.s.st.GetKnowledgeBase(ctx, id)
	if err != nil {
		return plugin.KnowledgeBaseInfo{}, kbNotFound(err)
	}
	return p.info(ctx, k)
}

func (p pluginKB) note(ctx context.Context, caller, action, targetType, targetID, summary string, detail map[string]any) {
	p.s.opt.Audit.Note(ctx, audit.Entry{Kind: audit.KindConfig, Action: action, TargetType: targetType, TargetID: targetID,
		Actor: caller, Source: "plugin", Summary: summary, Detail: detail})
}

func (p pluginKB) Create(ctx context.Context, caller, name, desc string) (plugin.KnowledgeBaseInfo, error) {
	k, err := p.s.st.CreateKnowledgeBase(ctx, store.KbInput{Name: &name, Desc: &desc})
	if err != nil {
		return plugin.KnowledgeBaseInfo{}, err
	}
	p.note(ctx, caller, "create", "knowledge_base", k.ID, "插件 "+caller+" 新建知识库「"+k.Name+"」",
		map[string]any{"name": k.Name, "plugin": caller})
	return p.info(ctx, k)
}

func (p pluginKB) Sync(ctx context.Context, caller, kbID, origin string, items []plugin.KBItem) (plugin.KBSyncResult, error) {
	k, err := p.s.st.GetKnowledgeBase(ctx, kbID)
	if err != nil {
		return plugin.KBSyncResult{}, kbNotFound(err)
	}
	res, err := p.s.pluginKBService().Reconcile(ctx, k, origin, items)
	if err != nil {
		return plugin.KBSyncResult{}, err
	}
	if res.Added+res.Updated+res.Removed > 0 {
		p.note(ctx, caller, "sync", "knowledge_base", k.ID,
			"插件 "+caller+" 同步知识库「"+k.Name+"」：新增 "+strconv.Itoa(res.Added)+"、更新 "+strconv.Itoa(res.Updated)+"、移除 "+strconv.Itoa(res.Removed),
			map[string]any{"origin": origin, "added": res.Added, "updated": res.Updated, "removed": res.Removed, "failed": res.Failed, "skipped": res.Skipped})
	}
	return *res, nil
}

func (p pluginKB) AttachAgent(ctx context.Context, caller, agentID, kbID string) (bool, error) {
	k, err := p.s.st.GetKnowledgeBase(ctx, kbID)
	if err != nil {
		return false, kbNotFound(err)
	}
	a, err := p.s.st.GetAgent(ctx, agentID)
	if err != nil {
		return false, kbNotFound(err)
	}
	if slices.Contains(a.KBs, k.ID) {
		return false, nil
	}
	kbs := append(slices.Clone(a.KBs), k.ID)
	if _, err := p.s.st.UpdateAgent(ctx, a.ID, domain.AgentInput{KBs: &kbs}); err != nil {
		return false, err
	}
	p.note(ctx, caller, "update", "agent", a.ID, "插件 "+caller+" 把知识库「"+k.Name+"」挂到 Agent「"+a.Name+"」",
		map[string]any{"fields": []string{"kbs"}, "kb_id": k.ID, "plugin": caller})
	return true, nil
}
