package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"

	_ "modernc.org/sqlite"
)

func TestMigrationsMatchesMigrationFiles(t *testing.T) {
	s, ctx := newStore(t)

	recs, err := s.Migrations(ctx)
	if err != nil {
		t.Fatalf("migrations: %v", err)
	}

	files, err := filepath.Glob(filepath.Join("..", "..", "db", "migrations", "*.sql"))
	if err != nil {
		t.Fatalf("glob migrations: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("migrations 目录下没找到 .sql，测试路径写错了")
	}
	if len(recs) != len(files) {
		t.Fatalf("schema_migrations 有 %d 条，migrations 目录有 %d 个文件", len(recs), len(files))
	}

	for _, m := range recs {
		if !strings.HasSuffix(m.Version, ".sql") {
			t.Errorf("version = %q，期望是迁移文件名", m.Version)
		}
		// checksum 是 sha256 的十六进制，store 层必须返回完整值，截断是 API 层的事。
		if len(m.Checksum) != 64 {
			t.Errorf("%s 的 checksum 长度 = %d，期望 64", m.Version, len(m.Checksum))
		}
		if m.AppliedAt.IsZero() {
			t.Errorf("%s 的 applied_at 是零值", m.Version)
		}
	}
}

func TestSnapshotProducesUsableCopy(t *testing.T) {
	s, ctx := newStore(t)
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "快照里应该能查到我", Tags: []string{"云端"},
	})

	dir := filepath.Join(t.TempDir(), "backups")
	info, err := s.Snapshot(ctx, dir)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	base := filepath.Base(info.Path)
	if !strings.HasPrefix(base, "pm-") || !strings.HasSuffix(base, ".db") {
		t.Errorf("文件名 = %q，期望 pm-YYYYMMDD-HHMMSS.db", base)
	}
	fi, err := os.Stat(info.Path)
	if err != nil {
		t.Fatalf("快照文件不存在: %v", err)
	}
	if fi.Size() == 0 || info.Size != fi.Size() {
		t.Fatalf("Size = %d, 实际文件 %d 字节", info.Size, fi.Size())
	}
	if info.CreatedAt.IsZero() {
		t.Error("CreatedAt 是零值")
	}

	// 只断言文件存在是不够的：VACUUM INTO 写坏了也会留下一个非空文件。
	// 真正拿 sqlite 打开它，把数据查出来才算数。
	snap, err := sql.Open("sqlite", "file:"+info.Path+"?mode=ro")
	if err != nil {
		t.Fatalf("打开快照: %v", err)
	}
	defer func() { _ = snap.Close() }()

	var title string
	if err := snap.QueryRowContext(ctx,
		`SELECT title FROM objects WHERE deleted_at IS NULL`).Scan(&title); err != nil {
		t.Fatalf("从快照查对象: %v", err)
	}
	if title != "快照里应该能查到我" {
		t.Errorf("快照里的标题 = %q", title)
	}
	var tag string
	if err := snap.QueryRowContext(ctx, `SELECT name FROM tags`).Scan(&tag); err != nil {
		t.Fatalf("从快照查标签: %v", err)
	}
	if tag != "云端" {
		t.Errorf("快照里的标签 = %q", tag)
	}
}

// 同一秒内连点两次备份不能失败，也不能互相覆盖。
func TestSnapshotSameSecondGetsSequence(t *testing.T) {
	s, ctx := newStore(t)
	dir := t.TempDir()

	first, err := s.Snapshot(ctx, dir)
	if err != nil {
		t.Fatalf("第一次快照: %v", err)
	}
	second, err := s.Snapshot(ctx, dir)
	if err != nil {
		t.Fatalf("第二次快照: %v", err)
	}
	if first.Path == second.Path {
		t.Fatalf("两次快照落到了同一个文件 %s", first.Path)
	}
	for _, p := range []string{first.Path, second.Path} {
		if fi, err := os.Stat(p); err != nil || fi.Size() == 0 {
			t.Errorf("%s 不是一个有效快照: %v", p, err)
		}
	}
}

// dir 为空时落在库文件旁边的 backups/。
func TestSnapshotDefaultDir(t *testing.T) {
	s, ctx := newStore(t)

	info, err := s.Snapshot(ctx, "")
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	want := filepath.Join(filepath.Dir(s.db.Path), "backups")
	if got := filepath.Dir(info.Path); got != want {
		t.Errorf("默认目录 = %q, 期望 %q", got, want)
	}
}

// seedExportFixture 造一份覆盖各种字段的数据，供导出用例共用。
func seedExportFixture(t *testing.T, s *Store, ctx context.Context) (objects int, apiKey string) {
	t.Helper()

	a := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "云端导出需求", Body: "正文一行\n正文两行",
		Status: "doing", Priority: "P1", Owner: "me",
		CategoryID: pstr("cat_req_prod_cloud"), Tags: []string{"云端", "导出"},
	})
	b := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "配套待办", Status: "todo", Priority: "P2",
		Tags: []string{"导出"},
	})
	// 归档的要进导出（是真实数据），软删的不进（那是用户已经扔掉的）。
	arch := mustCreate(t, s, ctx, &domain.Object{TypeID: "note", Title: "归档笔记"})
	if _, err := s.UpdateObject(ctx, arch.ID,
		domain.ObjectPatch{Archived: boolPtr(true)}, store.DefaultActor); err != nil {
		t.Fatalf("archive: %v", err)
	}
	trash := mustCreate(t, s, ctx, &domain.Object{TypeID: "note", Title: "回收站里的笔记"})
	if err := s.DeleteObject(ctx, trash.ID, false, store.DefaultActor); err != nil {
		t.Fatalf("soft delete: %v", err)
	}

	if _, err := s.CreateLink(ctx, a.ID, b.ID, domain.RelBlocks, "先做需求"); err != nil {
		t.Fatalf("create link: %v", err)
	}

	// 供应商带一把真密钥：导出里绝不能出现它。
	apiKey = "sk-super-secret-must-not-leak-0xdeadbeef"
	if _, err := s.CreateProvider(ctx, &domain.AgentProvider{
		Name: "测试供应商", Kind: domain.ProviderOpenAI, Model: "gpt-4o",
	}, apiKey); err != nil {
		t.Fatalf("create provider: %v", err)
	}

	return 3, apiKey // a / b / arch，trash 不算
}

func boolPtr(b bool) *bool { return &b }

func TestExportJSON(t *testing.T) {
	s, ctx := newStore(t)
	wantObjects, apiKey := seedExportFixture(t, s, ctx)

	name, data, err := s.Export(ctx, "json")
	if err != nil {
		t.Fatalf("export json: %v", err)
	}
	if !strings.HasPrefix(name, "pm-export-") || !strings.HasSuffix(name, ".json") {
		t.Errorf("文件名 = %q，期望 pm-export-<日期>.json", name)
	}

	var bundle struct {
		ObjectTypes []json.RawMessage `json:"object_types"`
		Categories  []json.RawMessage `json:"categories"`
		Tags        []json.RawMessage `json:"tags"`
		Links       []json.RawMessage `json:"links"`
		Shortcuts   []json.RawMessage `json:"shortcuts"`
		Dicts       []json.RawMessage `json:"dictionaries"`
		Objects     []struct {
			Ref   string            `json:"ref"`
			Title string            `json:"title"`
			Tags  []string          `json:"tags"`
			Links []json.RawMessage `json:"links"`
		} `json:"objects"`
	}
	if err := json.Unmarshal(data, &bundle); err != nil {
		t.Fatalf("导出的 JSON 解析不回来: %v", err)
	}

	if len(bundle.Objects) != wantObjects {
		t.Errorf("导出 %d 个对象，期望 %d（归档算、回收站不算）", len(bundle.Objects), wantObjects)
	}
	for _, o := range bundle.Objects {
		if o.Title == "回收站里的笔记" {
			t.Error("软删的对象被导出来了")
		}
	}
	if len(bundle.ObjectTypes) != 6 {
		t.Errorf("object_types = %d，期望 6", len(bundle.ObjectTypes))
	}
	if len(bundle.Categories) == 0 || len(bundle.Tags) == 0 || len(bundle.Dicts) == 0 {
		t.Errorf("categories/tags/dictionaries 有空的：%d/%d/%d",
			len(bundle.Categories), len(bundle.Tags), len(bundle.Dicts))
	}
	if len(bundle.Links) != 1 {
		t.Errorf("links = %d，期望 1", len(bundle.Links))
	}

	var withLink, withTags int
	for _, o := range bundle.Objects {
		if len(o.Links) > 0 {
			withLink++
		}
		if len(o.Tags) > 0 {
			withTags++
		}
	}
	if withLink != 2 {
		t.Errorf("挂着 link 的对象 = %d，期望 2（关联的两端都要带上）", withLink)
	}
	if withTags != 2 {
		t.Errorf("挂着 tag 的对象 = %d，期望 2", withTags)
	}

	// 密钥一个字节都不能漏：既不能有 api_key 这个字段，也不能有密钥原文。
	text := string(data)
	for _, forbidden := range []string{"api_key", "apiKey", "agent_providers", "providers", apiKey} {
		if strings.Contains(text, forbidden) {
			t.Errorf("导出文件里出现了 %q —— 导出件会被随手分享出去，绝不能带密钥", forbidden)
		}
	}
}

func TestExportMarkdown(t *testing.T) {
	s, ctx := newStore(t)
	_, apiKey := seedExportFixture(t, s, ctx)

	name, data, err := s.Export(ctx, "markdown")
	if err != nil {
		t.Fatalf("export markdown: %v", err)
	}
	if !strings.HasPrefix(name, "pm-export-") || !strings.HasSuffix(name, ".md") {
		t.Errorf("文件名 = %q，期望 pm-export-<日期>.md", name)
	}
	if len(data) == 0 {
		t.Fatal("markdown 导出是空的")
	}

	md := string(data)
	// 防数据锁定的前提是这份 Markdown 自己就读得懂：要有中文标题、分类树、
	// 状态与优先级的显示名，而不是一串 doing / P1。
	for _, want := range []string{
		"# 产品工作台数据导出",
		"## 需求池",
		"### 分类",
		"- 产品功能",
		"  - 云端平台",
		"云端导出需求",
		"- 状态：进行中",
		"- 优先级：高",
		"- 分类：产品功能 / 云端平台",
		"- 标签：云端、导出",
		"正文一行",
		"归档笔记",
		"阻塞",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown 里缺少 %q", want)
		}
	}
	if strings.Contains(md, "回收站里的笔记") {
		t.Error("软删的对象被导出来了")
	}
	for _, forbidden := range []string{"api_key", apiKey, "测试供应商"} {
		if strings.Contains(md, forbidden) {
			t.Errorf("markdown 里出现了 %q，导出件不能带供应商密钥", forbidden)
		}
	}
}

func TestExportRejectsUnknownFormat(t *testing.T) {
	s, ctx := newStore(t)
	for _, f := range []string{"", "csv", "pdf"} {
		if _, _, err := s.Export(ctx, f); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("format=%q 的 err = %v, 期望 ErrValidation", f, err)
		}
	}
}

// 空库也要能导出：新用户第一次点导出不该报错。
func TestExportEmptyDatabase(t *testing.T) {
	s, ctx := newStore(t)
	for _, f := range []string{"json", "markdown"} {
		if _, data, err := s.Export(ctx, f); err != nil || len(data) == 0 {
			t.Errorf("空库导出 %s: err=%v len=%d", f, err, len(data))
		}
	}
}
