package plugin_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// 后端边界规则（CORE-03b 的后端对应，docs/plugin-api.md 3.3）：internal/plugins 下出网走 Core.HTTP(group)，
// 不许用默认客户端绕过域名清单（VID-04a）。测试文件不管，它们连的是 httptest 起的本机假服务。
var bannedHTTP = map[string]bool{"DefaultClient": true, "Get": true, "Post": true, "PostForm": true, "Head": true}

// defaultClientUses 找出 f 里用到 http.DefaultClient、http.Get 之类的位置。
func defaultClientUses(fset *token.FileSet, f *ast.File) []string {
	names := map[string]bool{}
	for _, im := range f.Imports {
		if p, _ := strconv.Unquote(im.Path.Value); p == "net/http" {
			name := "http"
			if im.Name != nil {
				name = im.Name.Name
			}
			names[name] = true
		}
	}
	if len(names) == 0 {
		return nil
	}
	var out []string
	ast.Inspect(f, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if x, ok := sel.X.(*ast.Ident); ok && x.Obj == nil && names[x.Name] && bannedHTTP[sel.Sel.Name] {
			out = append(out, fset.Position(sel.Pos()).String()+" "+x.Name+"."+sel.Sel.Name)
		}
		return true
	})
	return out
}

func TestBoundaryRuleCatchesDefaultClient(t *testing.T) {
	src := `package x
import (
	"net/http"
	h2 "net/http"
)
func a() { _, _ = http.Get("https://example.com"); _ = h2.DefaultClient; _ = &http.Client{} }
func b(http struct{ Get int }) { _ = http.Get }
`
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "x.go", src, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := defaultClientUses(fset, f)
	if len(got) != 2 || !strings.HasSuffix(got[0], "http.Get") || !strings.HasSuffix(got[1], "h2.DefaultClient") {
		t.Fatalf("应只抓到 http.Get、h2.DefaultClient：%v", got)
	}
}

func TestPluginsDoNotUseDefaultHTTPClient(t *testing.T) {
	root := filepath.Join("..", "plugins")
	fset := token.NewFileSet()
	var bad []string
	n := 0
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			return err
		}
		n++
		bad = append(bad, defaultClientUses(fset, f)...)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("internal/plugins 下一个文件都没扫到")
	}
	if len(bad) > 0 {
		t.Fatalf("internal/plugins 出网要走 Core.HTTP(group)，不许用默认客户端：\n%s", strings.Join(bad, "\n"))
	}
}
