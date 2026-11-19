// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 按工作目录认定项目（TSK-0841 复盘）：IM 转出来的任务常常没挂项目，交给执行时用户在弹窗里手选了某个项目的目录，
// 结果提示词里没有「所属项目」（原型目录、原型规则），也不合项目执行白名单。现在任务没挂项目时，
// 拿这次执行的工作目录和各项目的目录比：项目工作目录（对象 workdir 列）、项目档案的代码库、原型库、需求文档目录
// （经插件钩子 Registrar.ProjectDirs 取）。两边都解析软链（EvalSymlinks）后比，工作目录等于或位于某个目录之下就算命中；
// 命中多个取路径最长（最具体）的；最长的有两个不同项目并列时不猜、按没命中处理。只影响这一次执行，不改任务的 project_id。

// 目录种类：项目工作目录，另外三种见 plugin.ProjectDir*。
const projectDirWorkdir = "workdir"

// projectDirLabel 是目录种类在提示词里的说法。
var projectDirLabel = map[string]string{
	projectDirWorkdir:          "项目工作目录",
	plugin.ProjectDirCode:      "项目档案的代码库目录",
	plugin.ProjectDirPrototype: "项目档案的原型库目录",
	plugin.ProjectDirPRD:       "项目档案的需求文档目录",
}

// runProjectRef 是这次执行按哪个项目处理。ByDir 为真表示任务本身没挂项目、按工作目录认定，
// Kind、Dir 是命中的那个目录（Dir 原样，未解析软链）。
type runProjectRef struct {
	ID    string
	ByDir bool
	Kind  string
	Dir   string
}

// projectDirCand 是参与比较的一个项目目录；real 是解析软链后的绝对路径。
type projectDirCand struct {
	ProjectID string
	Kind      string
	Dir       string
	real      string
}

// runProjectOf 定这次执行按哪个项目处理：任务挂了项目就是它（不管工作目录在哪）；
// 没挂时按工作目录认定，认不出来回 nil。查询出错按认不出来处理并记日志，不能因为辅助信息让执行起不来。
func (s *Server) runProjectOf(ctx context.Context, o *domain.Object, workdir string) *runProjectRef {
	if o == nil {
		return nil
	}
	if o.ProjectID != nil && strings.TrimSpace(*o.ProjectID) != "" {
		return &runProjectRef{ID: strings.TrimSpace(*o.ProjectID)}
	}
	workdir = strings.TrimSpace(workdir)
	if workdir == "" || !filepath.IsAbs(workdir) {
		return nil
	}
	cands, err := s.projectDirCands(ctx)
	if err != nil {
		s.log.Warn("list project dirs failed", "err", err)
		return nil
	}
	c, ok := matchProjectDir(workdir, cands)
	if !ok {
		return nil
	}
	return &runProjectRef{ID: c.ProjectID, ByDir: true, Kind: c.Kind, Dir: c.Dir}
}

// projectDirCands 收集没删的项目的工作目录和档案目录。档案目录的项目已删（或不是项目）的丢掉；
// 项目插件没装、停用或还没升到 0.21.0（ErrNoProjectDirs）时只比项目工作目录。
func (s *Server) projectDirCands(ctx context.Context) ([]projectDirCand, error) {
	live := map[string]bool{}
	var out []projectDirCand
	const page = 200
	for off := 0; ; off += page {
		items, total, err := s.st.ListObjects(ctx, domain.ObjectFilter{TypeIDs: []string{projectType}, Limit: page, Offset: off})
		if err != nil {
			return nil, err
		}
		for _, o := range items {
			if o.DeletedAt != nil || o.TypeID != projectType {
				continue
			}
			live[o.ID] = true
			if d := strings.TrimSpace(o.Workdir); d != "" {
				out = append(out, projectDirCand{ProjectID: o.ID, Kind: projectDirWorkdir, Dir: d})
			}
		}
		if len(items) < page || off+page >= total {
			break
		}
	}
	if s.opt.Plugins != nil {
		dirs, err := s.opt.Plugins.ProjectDirs(ctx)
		if err != nil && !errors.Is(err, plugin.ErrNoProjectDirs) {
			s.log.Warn("list project profile dirs failed", "err", err)
		}
		for _, d := range dirs {
			if live[d.ProjectID] {
				out = append(out, projectDirCand{ProjectID: d.ProjectID, Kind: d.Kind, Dir: strings.TrimSpace(d.Dir)})
			}
		}
	}
	return out, nil
}

// matchProjectDir 找工作目录落在哪个项目目录里：两边都解析软链，等于或位于其下算命中，取最长的；
// 最长的不止一个项目时回没命中（不替用户挑）。同一个项目多个目录并列时取先出现的（工作目录在档案目录前面）。
func matchProjectDir(workdir string, cands []projectDirCand) (projectDirCand, bool) {
	wd := realPath(workdir)
	var best projectDirCand
	bestLen, tie := -1, false
	for _, c := range cands {
		if c.Dir == "" || !filepath.IsAbs(c.Dir) {
			continue
		}
		if c.real == "" {
			c.real = realPath(c.Dir)
		}
		if _, ok := within(c.real, wd); !ok {
			continue
		}
		switch n := len(c.real); {
		case n > bestLen:
			best, bestLen, tie = c, n, false
		case n == bestLen && c.ProjectID != best.ProjectID:
			tie = true
		}
	}
	if bestLen < 0 || tie {
		return projectDirCand{}, false
	}
	return best, true
}
