// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/kb"
)

// --- 知识库检索工具（AG-01b3）：只能搜会话所挂 Agent 的知识库 ---

const toolKbSearch = "kb_search"

// KbSearchAbility 是 kb_search 归属的内置能力，授权检查在 AG-02a。
const KbSearchAbility = "read_content"

// kbSearchMax 是一次最多回几段。
const kbSearchMax = 10

// withAgentKBs 记下 Agent 挂的知识库；没挂的话不给模型 kb_search。
func (tb *Toolbox) withAgentKBs(a *domain.Agent) {
	if a != nil {
		tb.kbs = append([]string{}, a.KBs...)
	}
}

func (tb *Toolbox) kbDefs() []ToolDef {
	if len(tb.kbs) == 0 {
		return nil
	}
	return []ToolDef{{
		Name: toolKbSearch,
		Description: "在这个 Agent 挂的知识库里按关键词找资料，回命中的段落和出处。" +
			"回答产品、客户、方案相关的问题，或写文档之前，先用它找依据；回答时说明引用的是哪篇。",
		Parameters: obj(props{
			"query": str("要找的问题或关键词，用自然的中文说法即可"),
			"kb_id": str("只搜其中一个知识库时填它的 id；留空搜全部挂着的知识库"),
			"limit": num("最多返回几段，默认 5，最多 10"),
		}, []string{"query"}),
	}}
}

func (tb *Toolbox) kbSearch(ctx context.Context, args map[string]any) ToolResult {
	q := strings.TrimSpace(argStr(args, "query"))
	if q == "" {
		return failed(toolKbSearch, "query 是必填的")
	}
	if len(tb.kbs) == 0 {
		return failed(toolKbSearch, "这个 Agent 没有挂知识库")
	}
	ids := tb.kbs
	if id := strings.TrimSpace(argStr(args, "kb_id")); id != "" {
		if !slices.Contains(tb.kbs, id) {
			return failed(toolKbSearch, fmt.Sprintf("知识库 %s 没有挂在这个 Agent 上，只能搜挂着的：%s", id, strings.Join(tb.kbs, "、")))
		}
		ids = []string{id}
	}
	limit := argInt(args, "limit", kb.DefaultTop)
	if limit <= 0 || limit > kbSearchMax {
		limit = kb.DefaultTop
	}
	_, hits, err := kb.Search(ctx, tb.st, ids, q, limit)
	if err != nil {
		return failed(toolKbSearch, "检索失败")
	}
	if len(hits) == 0 {
		return ToolResult{
			Summary: fmt.Sprintf("在知识库里找「%s」没有命中", q),
			Content: "没有命中。换个说法再找，或者直接告诉用户知识库里没有相关资料。",
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "命中 %d 段：\n", len(hits))
	for i, h := range hits {
		where := h.Source.Type
		if h.Source.Ref != "" {
			where += " " + h.Source.Ref
		}
		fmt.Fprintf(&b, "%d. 《%s》第 %d 段（相关度 %.0f%%，来源 %s）\n%s\n", i+1, h.Title, h.Index+1, h.Score*100, where, h.Text)
	}
	return ToolResult{
		Summary: fmt.Sprintf("在知识库里找「%s」命中 %d 段", q, len(hits)),
		Content: b.String(),
	}
}
