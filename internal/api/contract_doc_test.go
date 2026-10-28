package api

import (
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/im"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
)

// recordingMux 收下 routes() 注册的每一条模式，不真的建路由。
type recordingMux struct{ patterns []string }

func (r *recordingMux) HandleFunc(pattern string, _ func(http.ResponseWriter, *http.Request)) {
	r.patterns = append(r.patterns, pattern)
}

func registeredRoutes(t *testing.T) []string {
	t.Helper()
	rec := &recordingMux{}
	// 编译进二进制的第一方插件的路由也要写进契约，和 cmd/pmw 登记的插件保持一致
	plugins := plugin.NewRegistry(plugin.NewMemStateStore(), slog.New(slog.DiscardHandler))
	if err := plugins.Add(projects.New()); err != nil {
		t.Fatal(err)
	}
	if err := plugins.Add(im.New()); err != nil {
		t.Fatal(err)
	}
	(&Server{opt: Options{Plugins: plugins}}).routes(rec)
	if len(rec.patterns) == 0 {
		t.Fatal("一条路由都没收到——routes() 的签名或实现变了，本测试已经失效")
	}
	sort.Strings(rec.patterns)
	return rec.patterns
}

var docRouteRe = regexp.MustCompile(`(GET|POST|PATCH|PUT|DELETE)\s*\|?\s*` + "`?" + `(/api/[^\s` + "`" + `|?)]*)`)

// documentedRoutes 从契约文档里抽出「方法 + 路径」。
//
// 文档写成 markdown 表格（`| GET | ` + "`/api/x`" + ` | 说明 |`），方法和路径被表格分隔符隔开，
// 不是连续的子串——按 "GET /api/x" 去搜会一条都搜不到，而测试会显示成「全都没写」，
// 看起来像文档烂透了，其实是匹配写错了。所以这里按记号抽取，不按字面搜。
//
// 路径上的 query（`/api/categories?type=x`）和结尾标点要剥掉：文档为了说明用法
// 会把示例参数写在路径里，那仍然是同一条路由。
func documentedRoutes(t *testing.T) map[string]bool {
	t.Helper()
	body, err := os.ReadFile("../../docs/api-contract.md")
	if err != nil {
		t.Fatalf("读契约文档: %v", err)
	}
	out := map[string]bool{}
	for _, m := range docRouteRe.FindAllStringSubmatch(string(body), -1) {
		path, _, _ := strings.Cut(m[2], "?")
		path = strings.TrimRight(path, ".,;:")
		out[m[1]+" "+path] = true
	}
	if len(out) == 0 {
		t.Fatal("契约文档里一条路由都没抽出来——多半是文档格式变了，本测试已经失效")
	}
	return out
}

// TestEveryRouteIsInTheContractDoc 守着「后端有这个接口，但契约文档里查不到」。
//
// docs/api-contract.md 是给人看的那份 API 表面。它跟代码脱节不会让任何东西变红——
// 文档不参与编译、不参与测试，烂掉的唯一表现是有人照着它写调用然后发现对不上。
// 这条测试把「新加一条路由」和「在文档里记一笔」绑成一件事。
//
// 只比对「方法 + 路径」这一层。参数、字段、语义靠人写，测试管不了，
// 但至少能保证「有这么个接口」这件事不会漏。
func TestEveryRouteIsInTheContractDoc(t *testing.T) {
	doc := documentedRoutes(t)
	var missing []string
	for _, pat := range registeredRoutes(t) {
		if !doc[pat] {
			missing = append(missing, pat)
		}
	}
	if len(missing) > 0 {
		t.Errorf("下列 %d 条路由在 docs/api-contract.md 里查不到。\n"+
			"要么把它们补进文档，要么它们本来就不该存在：\n  %s",
			len(missing), strings.Join(missing, "\n  "))
	}
}

// TestContractDocHasNoDeadRoutes 反方向：文档里写了、代码里没有。
//
// 比上一条更隐蔽——照着文档写调用的人会拿到 404，而文档本身看起来一切正常。
// 接口被删或改名时最容易留下这种残条。
func TestContractDocHasNoDeadRoutes(t *testing.T) {
	live := map[string]bool{}
	for _, p := range registeredRoutes(t) {
		live[p] = true
	}
	var dead []string
	for pat := range documentedRoutes(t) {
		if !live[pat] {
			dead = append(dead, pat)
		}
	}
	if len(dead) > 0 {
		sort.Strings(dead)
		t.Errorf("文档里写了但代码里不存在的路由（照着它写调用会拿 404）：\n  %s",
			strings.Join(dead, "\n  "))
	}
}
