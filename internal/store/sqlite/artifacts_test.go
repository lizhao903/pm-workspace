package sqlite

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func strp(s string) *string { return &s }

func mustArtifact(t *testing.T, s *Store, ctx context.Context, in domain.ArtifactInput) *domain.Artifact {
	t.Helper()
	a, err := s.CreateArtifact(ctx, in)
	if err != nil {
		t.Fatalf("登记产物 %+v: %v", in, err)
	}
	return a
}

// TestArtifactNeedsAtLeastOneLocation 守的是这张表存在的前提：
// 一条既没有本地路径也没有链接的产物指不到任何东西，它只会让「共 N 件」变大。
func TestArtifactNeedsAtLeastOneLocation(t *testing.T) {
	s, ctx := newStore(t)

	if _, err := s.CreateArtifact(ctx, domain.ArtifactInput{Title: "空的"}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("两个位置都空应报 ErrValidation，得到 %v", err)
	}
	// 只有链接、只有路径都要放行。
	mustArtifact(t, s, ctx, domain.ArtifactInput{URL: "https://x/1"})
	mustArtifact(t, s, ctx, domain.ArtifactInput{Path: "/tmp/a.md"})

	// 改到只剩空也要拦。这条单独验，是因为它走的是另一段代码（UpdateArtifact
	// 在内存里算出改完的样子再判断），而库里的 CHECK 给出的报错用户看不懂。
	a := mustArtifact(t, s, ctx, domain.ArtifactInput{URL: "https://x/2"})
	if _, err := s.UpdateArtifact(ctx, a.ID, domain.ArtifactPatch{URL: strp("")}); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("清空唯一的链接应报 ErrValidation，得到 %v", err)
	}
}

// TestArtifactPathIsAbsoluteAndRelIsDerived 守「只存一个路径」这条约定。
func TestArtifactPathIsAbsoluteAndRelIsDerived(t *testing.T) {
	s, ctx := newStore(t)

	// 给相对路径 + 基准目录，应当替调用方拼成绝对路径。
	a := mustArtifact(t, s, ctx, domain.ArtifactInput{
		Path: "docs/方案.md", BaseDir: "/tmp/wd", Source: domain.ArtifactSourceAgent,
	})
	if a.Path != "/tmp/wd/docs/方案.md" {
		t.Errorf("Path = %q，期望拼成绝对路径", a.Path)
	}
	if a.RelPath != "docs/方案.md" {
		t.Errorf("RelPath = %q，期望 docs/方案.md", a.RelPath)
	}

	// 没有基准目录时，相对路径退回绝对路径而不是一串 ../..。
	b := mustArtifact(t, s, ctx, domain.ArtifactInput{Path: "/opt/x/y.md"})
	if b.RelPath != "/opt/x/y.md" {
		t.Errorf("没有 base_dir 时 RelPath 应等于 Path，得到 %q", b.RelPath)
	}

	// 文件不在基准目录下时同理：返回 "../../opt/x/y.md" 既打不开也看不出在哪。
	c := mustArtifact(t, s, ctx, domain.ArtifactInput{Path: "/opt/x/y.md", BaseDir: "/tmp/wd"})
	if c.RelPath != "/opt/x/y.md" {
		t.Errorf("越出 base_dir 时 RelPath 应退回绝对路径，得到 %q", c.RelPath)
	}

	// 标题留空时用文件名兜底，列表里不出现没有名字的行。
	if a.Title != "方案.md" {
		t.Errorf("标题应回落到文件名，得到 %q", a.Title)
	}
}

// TestRecordArtifactDedupsWithinScopeOnly 是去重口径的核心：
// 自动来源在自己的范围内去重，手工登记不受影响。
//
// 两边都要验。只验「同会话去重」的话，一个把去重扩大到全表的改动不会变红——
// 而它的后果是用户手工登记的第二条记录被安静地吃掉，看上去像保存失败。
func TestRecordArtifactDedupsWithinScopeOnly(t *testing.T) {
	s, ctx := newStore(t)
	sess := mustSession(t, s, ctx, "会话")
	other := mustSession(t, s, ctx, "另一个会话")
	const p = "/tmp/wd/docs/方案.md"

	first, err := s.RecordArtifact(ctx, domain.ArtifactInput{
		SessionID: &sess.ID, Path: p, BaseDir: "/tmp/wd", Size: 100,
		Source: domain.ArtifactSourceAgent,
	})
	if err != nil {
		t.Fatalf("记产物: %v", err)
	}
	second, err := s.RecordArtifact(ctx, domain.ArtifactInput{
		SessionID: &sess.ID, Path: p, BaseDir: "/tmp/wd", Size: 250,
		Source: domain.ArtifactSourceAgent,
	})
	if err != nil {
		t.Fatalf("覆盖写: %v", err)
	}
	// id 要复用：前端可能已经拿它当列表 key 了。
	if second.ID != first.ID {
		t.Errorf("同会话同路径应复用 id，%q -> %q", first.ID, second.ID)
	}
	if second.Size != 250 {
		t.Errorf("size 应更新为最后一次的值，得到 %d", second.Size)
	}

	// 换一个会话写同一个文件：那是另一次产出，不该合并。
	if _, err := s.RecordArtifact(ctx, domain.ArtifactInput{
		SessionID: &other.ID, Path: p, BaseDir: "/tmp/wd", Source: domain.ArtifactSourceAgent,
	}); err != nil {
		t.Fatalf("另一个会话记同名产物: %v", err)
	}

	// 手工登记同一个文件发两个平台：两条都要留下。
	for _, u := range []string{"https://x.atlassian.net/wiki/1", "https://feishu.cn/docx/2"} {
		mustArtifact(t, s, ctx, domain.ArtifactInput{Path: p, URL: u})
	}

	items, total, err := s.ListArtifacts(ctx, domain.ArtifactFilter{})
	if err != nil {
		t.Fatalf("列产物: %v", err)
	}
	if total != 4 || len(items) != 4 {
		t.Fatalf("期望 4 条（同会话合并 1 + 另一会话 1 + 手工 2），得到 total=%d len=%d", total, len(items))
	}
}

// TestArtifactSurvivesObjectHardDelete 守 ON DELETE SET NULL。
//
// 这条如果退化成 CASCADE，表现是「删掉一条需求，当初发出去的 Confluence 地址
// 从本机永久消失」，没有报错也没有提示。
func TestArtifactSurvivesObjectHardDelete(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "会被删掉的任务"})

	a := mustArtifact(t, s, ctx, domain.ArtifactInput{
		ObjectID: &obj.ID, URL: "https://x.atlassian.net/wiki/99", Platform: "confluence",
	})
	if err := s.DeleteObject(ctx, obj.ID, true, store.DefaultActor); err != nil {
		t.Fatalf("硬删对象: %v", err)
	}

	got, err := s.GetArtifact(ctx, a.ID)
	if err != nil {
		t.Fatalf("产物应当还在，得到 %v", err)
	}
	if got.ObjectID != nil {
		t.Errorf("归属应被置空，得到 %v", *got.ObjectID)
	}
	if got.URL != "https://x.atlassian.net/wiki/99" {
		t.Errorf("链接不该丢，得到 %q", got.URL)
	}
	// 未归属的产物必须仍然出现在全量列表里，否则等于换个方式丢掉了它。
	items, _, err := s.ListArtifacts(ctx, domain.ArtifactFilter{Unscoped: true})
	if err != nil || len(items) != 1 {
		t.Errorf("未归属过滤应返回 1 条，得到 %d 条 err=%v", len(items), err)
	}
}

// TestArtifactFilterAndStatsAgree 守「列表和统计同源」。
//
// 两处各写一套 WHERE 的话，某个条件下「列表 7 行」和「统计说共 9 件」会分叉，
// 而两个数字都不会报错。这里对每一种过滤都同时查两边，比对总数。
func TestArtifactFilterAndStatsAgree(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "任务"})
	yes, no := true, false

	// 本地 + 已发云端（一份东西两个位置）
	mustArtifact(t, s, ctx, domain.ArtifactInput{
		ObjectID: &obj.ID, Path: "/tmp/wd/a.md", BaseDir: "/tmp/wd",
		URL: "https://x.atlassian.net/wiki/1", Platform: "confluence", Size: 100,
	})
	// 只在本地，还没发出去
	mustArtifact(t, s, ctx, domain.ArtifactInput{
		ObjectID: &obj.ID, Path: "/tmp/wd/b.md", BaseDir: "/tmp/wd", Size: 50,
	})
	// 只在云端，且没有归属
	mustArtifact(t, s, ctx, domain.ArtifactInput{
		URL: "https://feishu.cn/docx/2", Platform: "feishu",
	})

	cases := []struct {
		name string
		f    domain.ArtifactFilter
		want int
	}{
		{"全部", domain.ArtifactFilter{}, 3},
		{"某个对象", domain.ArtifactFilter{ObjectID: obj.ID}, 2},
		{"未归属", domain.ArtifactFilter{Unscoped: true}, 1},
		{"按平台", domain.ArtifactFilter{Platform: "confluence"}, 1},
		{"已发出去的", domain.ArtifactFilter{HasURL: &yes}, 2},
		{"还没发出去的本地文件", domain.ArtifactFilter{HasURL: &no}, 1},
		{"没有本地副本的", domain.ArtifactFilter{HasPath: &no}, 1},
		{"关键词命中路径", domain.ArtifactFilter{Q: "b.md"}, 1},
		{"关键词命中链接", domain.ArtifactFilter{Q: "feishu"}, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			items, total, err := s.ListArtifacts(ctx, c.f)
			if err != nil {
				t.Fatalf("列产物: %v", err)
			}
			st, err := s.ArtifactStats(ctx, c.f)
			if err != nil {
				t.Fatalf("统计: %v", err)
			}
			if total != c.want || len(items) != c.want {
				t.Errorf("列表 total=%d len=%d，期望 %d", total, len(items), c.want)
			}
			if st.Total != c.want {
				t.Errorf("统计 total=%d，期望 %d（与列表分叉了）", st.Total, c.want)
			}
		})
	}

	// local + remote 可以大于 total：一份东西两个位置，两边都算。
	// 这不是 bug，所以专门断住——将来有人「修」成互斥划分时会在这里看到理由。
	st, err := s.ArtifactStats(ctx, domain.ArtifactFilter{})
	if err != nil {
		t.Fatalf("统计: %v", err)
	}
	if st.Local != 2 || st.Remote != 2 || st.Total != 3 {
		t.Errorf("local=%d remote=%d total=%d，期望 2/2/3", st.Local, st.Remote, st.Total)
	}
	// 体积只累加有本地路径的：云端产物 size 恒为 0，混进去会让体积统计失真。
	if st.TotalSize != 150 {
		t.Errorf("total_size = %d，期望 150（只算本地的两条）", st.TotalSize)
	}
	if st.Unscoped != 1 {
		t.Errorf("unscoped = %d，期望 1", st.Unscoped)
	}
	if st.ByPlatform["confluence"] != 1 || st.ByPlatform["local"] != 1 || st.ByPlatform["feishu"] != 1 {
		t.Errorf("按平台分组 = %v，期望 confluence/local/feishu 各 1", st.ByPlatform)
	}
}

// TestUpdateArtifactObjectIDThreeStates 守 **string 那一层。
// 少了它，「把产物移出这个对象」和「不动它」在 JSON 里长得一模一样，
// 而且不会报错，只是没生效。
func TestUpdateArtifactObjectIDThreeStates(t *testing.T) {
	s, ctx := newStore(t)
	a1 := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "任务一"})
	a2 := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "任务二"})
	art := mustArtifact(t, s, ctx, domain.ArtifactInput{ObjectID: &a1.ID, URL: "https://x/1"})

	// 不给：不改。
	got, err := s.UpdateArtifact(ctx, art.ID, domain.ArtifactPatch{Note: strp("备注")})
	if err != nil {
		t.Fatalf("改备注: %v", err)
	}
	if got.ObjectID == nil || *got.ObjectID != a1.ID {
		t.Errorf("没给 object_id 时归属不该变，得到 %v", got.ObjectID)
	}

	// 给值：改挂过去。
	moved := &a2.ID
	if got, err = s.UpdateArtifact(ctx, art.ID, domain.ArtifactPatch{ObjectID: &moved}); err != nil {
		t.Fatalf("改挂: %v", err)
	}
	if got.ObjectID == nil || *got.ObjectID != a2.ID {
		t.Errorf("应改挂到任务二，得到 %v", got.ObjectID)
	}

	// 给 nil：解除归属。
	var cleared *string
	if got, err = s.UpdateArtifact(ctx, art.ID, domain.ArtifactPatch{ObjectID: &cleared}); err != nil {
		t.Fatalf("解除归属: %v", err)
	}
	if got.ObjectID != nil {
		t.Errorf("应解除归属，得到 %v", *got.ObjectID)
	}
}

// TestDeleteArtifactRejectsUnknown 保证删不存在的返回 404 而不是静默成功——
// 前端据此判断要不要把那一行从列表里移掉。
func TestDeleteArtifactRejectsUnknown(t *testing.T) {
	s, ctx := newStore(t)
	if err := s.DeleteArtifact(ctx, "art_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("期望 ErrNotFound，得到 %v", err)
	}
}

// TestArtifactFillsSizeFromDisk 守「手工登记也要有体积」。
//
// 不读盘的话，「本地占用」这个统计永远是 0 B——而一个永远是 0 的数字
// 比不显示更糟，它看起来像是算过的。
func TestArtifactFillsSizeFromDisk(t *testing.T) {
	s, ctx := newStore(t)
	dir := t.TempDir()
	f := filepath.Join(dir, "方案.md")
	if err := os.WriteFile(f, []byte("一二三四五"), 0o644); err != nil {
		t.Fatal(err)
	}

	a := mustArtifact(t, s, ctx, domain.ArtifactInput{Path: f})
	if a.Size != 15 { // 5 个汉字 × 3 字节
		t.Errorf("大小 = %d，期望 15（应当去读文件）", a.Size)
	}

	// 调用方给了就不覆盖：Agent 写盘那条路上传的是它刚写出去的字节数，
	// 那个值比事后 stat 更权威（文件可能已经被别人改了）。
	b := mustArtifact(t, s, ctx, domain.ArtifactInput{Path: f, Size: 999})
	if b.Size != 999 {
		t.Errorf("显式给的大小被覆盖成了 %d", b.Size)
	}

	// 路径不存在不报错，体积留 0。为了一个附属信息拒掉整条登记，
	// 只会让用户干脆不登记。
	c := mustArtifact(t, s, ctx, domain.ArtifactInput{Path: filepath.Join(dir, "还没产出.md")})
	if c.Size != 0 {
		t.Errorf("不存在的文件体积应为 0，得到 %d", c.Size)
	}
}

// TestDetectPlatformFromURL 守「后端认平台」。
//
// 这件事只写在前端的话，四条登记渠道里只有界面那一条会经过它——
// MCP 回写、Agent 写盘、执行扫目录全都落进「其他」。统计页上
// 「东西都发到哪儿去了」这一列就此失效，而它不报错，只显示成
// 「大部分产物的平台是：其他」。
func TestDetectPlatformFromURL(t *testing.T) {
	s, ctx := newStore(t)

	cases := []struct{ name, url, want string }{
		{"Confluence", "https://mycorp.atlassian.net/wiki/spaces/PM/pages/123/方案", "confluence"},
		{"Jira", "https://mycorp.atlassian.net/browse/AAA-1", "jira"},
		{"飞书", "https://xx.feishu.cn/docx/abcdef", "feishu"},
		{"Google Docs", "https://docs.google.com/document/d/xyz", "gdrive"},
		{"Figma", "https://www.figma.com/file/abc", "figma"},
		{"认不出来的", "https://例子.example/一个页面", "other"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := mustArtifact(t, s, ctx, domain.ArtifactInput{URL: c.url})
			if a.Platform != c.want {
				t.Errorf("平台 = %q，期望 %q", a.Platform, c.want)
			}
		})
	}

	// 只有本地路径时是 local，不去认（没有链接可认）。
	if a := mustArtifact(t, s, ctx, domain.ArtifactInput{Path: "/tmp/a.md"}); a.Platform != "local" {
		t.Errorf("纯本地产物平台 = %q，期望 local", a.Platform)
	}
	// 调用方显式给了就不覆盖——用户在表单里改过的选择必须留住。
	if a := mustArtifact(t, s, ctx, domain.ArtifactInput{
		URL: "https://mycorp.atlassian.net/wiki/1", Platform: "other",
	}); a.Platform != "other" {
		t.Errorf("显式指定的平台被覆盖成了 %q", a.Platform)
	}
	// 自动来源也要经过识别：这是最容易漏的一条，因为它不经过界面。
	if a, err := s.RecordArtifact(ctx, domain.ArtifactInput{
		URL: "https://xx.feishu.cn/docx/zzz", Source: domain.ArtifactSourceMCP,
	}); err != nil || a.Platform != "feishu" {
		t.Errorf("RecordArtifact 的平台 = %v err=%v，期望 feishu", a, err)
	}
}

// TestCreateArtifactRejectsUnknownSource 守 source 白名单。
// 写错一个字母不会报错，只会在统计页多出一个永远是 1 的分组。
func TestCreateArtifactRejectsUnknownSource(t *testing.T) {
	s, ctx := newStore(t)
	if _, err := s.CreateArtifact(ctx, domain.ArtifactInput{
		URL: "https://x/1", Source: "agnet",
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("未知来源应报 ErrValidation，得到 %v", err)
	}
}
