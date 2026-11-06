package domain

import (
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// 产物种类的推断（TSK-0497）。
//
// kind 列是 0031 才加的，之前和之后都有不带 kind 的登记：Claude Code 执行后扫工作目录
// 那条路（source=run）从来没填过，2026-11-06 线上 116 条未分类全是它。界面上显示一个
// 「未分类」既不对也没用——那些就是改过的源码、文档、库文件，按位置一眼看得出来。
//
// 一处推断、两处用：
//   - 登记时 kind 为空就按它补上（CreateArtifact / RecordArtifact），新登记都带 kind；
//   - 读的时候派生 display_kind：kind 非空就是 kind，为空（历史数据）按它推，不改库里的值。
//
// 规则依次是：备注前缀 [commit]/[branch]/[pr]（契约「代码类产物」，0031 回填老数据也是这条）
// → 只有链接的按链接形状和平台 → 有本地路径的按扩展名 → 其他。
// 前端不再自己推一遍：响应里带 display_kind，按任务汇总的接口也按它分组。

var artifactNotePrefix = regexp.MustCompile(`^\[(commit|branch|pr)\]`)

// 只有链接时按链接认：GitHub 的 PR、提交、分支各有固定路径段。
var (
	ghPull   = regexp.MustCompile(`/pull/\d+`)
	ghCommit = regexp.MustCompile(`/commit/[0-9a-fA-F]{6,40}`)
	ghBranch = regexp.MustCompile(`/tree/`)
)

var artifactExtKinds = func() map[string]string {
	m := map[string]string{}
	add := func(kind string, exts ...string) {
		for _, e := range exts {
			m[e] = kind
		}
	}
	add("code", "go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "less", "py", "rs", "java", "kt",
		"swift", "c", "h", "cc", "cpp", "hpp", "m", "rb", "php", "sh", "bash", "zsh", "sql", "vue", "svelte",
		"yaml", "yml", "toml", "mod", "sum", "lock", "gradle", "proto")
	add("doc", "md", "markdown", "mdx", "txt", "rst", "pdf", "doc", "docx", "ppt", "pptx", "key", "pages", "rtf",
		"mmd", "drawio", "odt")
	add("prototype", "html", "htm", "fig", "sketch", "xd")
	add("data", "json", "jsonl", "ndjson", "csv", "tsv", "xls", "xlsx", "numbers", "parquet", "db", "db-wal",
		"db-shm", "sqlite", "sqlite3", "log")
	return m
}()

// 只有链接时，平台本身就说明了是什么：文档平台是文档，设计稿是原型。
var artifactPlatformKinds = map[string]string{
	"confluence": "doc", "feishu": "doc", "gdrive": "doc", "pagehub": "doc", "figma": "prototype",
}

// InferArtifactKind 按备注、链接、平台和本地路径推断产物种类，返回字典 artifact_kind 的内置 key。
// 推不出来返回 other，不返回空串：显示「未分类」等于把判断推回给用户。
func InferArtifactKind(note, url, platform, path string) string {
	if m := artifactNotePrefix.FindStringSubmatch(strings.TrimSpace(note)); m != nil {
		return m[1]
	}
	if path == "" && url != "" {
		u := strings.ToLower(url)
		if strings.Contains(u, "github.com") {
			switch {
			case ghPull.MatchString(u):
				return "pr"
			case ghCommit.MatchString(u):
				return "commit"
			case ghBranch.MatchString(u):
				return "branch"
			}
		}
		if k := artifactPlatformKinds[platform]; k != "" {
			return k
		}
		return "other"
	}
	if path != "" {
		// db-wal、db-shm 这类带连字符的后缀 filepath.Ext 取不到完整的一段，先认整段再认最后一段
		base := strings.ToLower(filepath.Base(path))
		if i := strings.Index(base, "."); i >= 0 {
			if k := artifactExtKinds[base[i+1:]]; k != "" {
				return k
			}
		}
		if k := artifactExtKinds[strings.TrimPrefix(filepath.Ext(base), ".")]; k != "" {
			return k
		}
	}
	return "other"
}

// DisplayKindOf 是响应里的 display_kind：kind 非空就用 kind，否则推断。
func DisplayKindOf(a *Artifact) string {
	if a.Kind != "" {
		return a.Kind
	}
	return InferArtifactKind(a.Note, a.URL, a.Platform, a.Path)
}

// ArtifactObjectSummary 是按工作对象汇总的一行（GET /api/artifacts/by-object，TSK-0497）：
// 任务列表的产出数、产出物视图的每一行都用它，前端不用为每条任务单独请求、也不受列表接口 500 条一页的限制。
type ArtifactObjectSummary struct {
	ObjectID     string         `json:"object_id"`
	ObjectRef    string         `json:"object_ref"`
	ObjectTitle  string         `json:"object_title"`
	ObjectType   string         `json:"object_type"`
	Status       string         `json:"status"`
	ProjectID    *string        `json:"project_id"`
	ProjectTitle string         `json:"project_title"`
	CompletedAt  *time.Time     `json:"completed_at"`
	Total        int            `json:"total"`
	ByKind       map[string]int `json:"by_kind"` // 按 display_kind
	BySource     map[string]int `json:"by_source"`
	LastAt       time.Time      `json:"last_at"` // 最近一次登记的时间
}

// ArtifactsByObject 是按对象汇总的结果。
// ByKind 统计的是除 kind 以外的过滤条件下的全部产物（产出物视图类型按钮上的数），
// Total、Objects 是加上 kind 过滤之后的。
type ArtifactsByObject struct {
	Objects  []ArtifactObjectSummary `json:"objects"`
	Total    int                     `json:"total"`
	ByKind   map[string]int          `json:"by_kind"`
	BySource map[string]int          `json:"by_source"`
}
