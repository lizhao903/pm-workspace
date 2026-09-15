package sqlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// --- schema 状态 ---

// Migrations 返回 schema_migrations 的全部记录。设置页要展示它：
// 用户能看到自己这个库到底跑到了哪一版、文件有没有被换过，
// 这是本地单文件工具的信任基础。checksum 这里返回完整值，截断由 API 层做。
func (s *Store) Migrations(ctx context.Context) ([]domain.MigrationRecord, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("list migrations: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []domain.MigrationRecord{}
	for rows.Next() {
		var m domain.MigrationRecord
		var applied string
		if err := rows.Scan(&m.Version, &m.Checksum, &applied); err != nil {
			return nil, err
		}
		m.AppliedAt = parseTime(applied)
		out = append(out, m)
	}
	return out, rows.Err()
}

// --- 快照 ---

// maxSnapshotsPerSecond 是同一秒内允许的快照数上限，纯粹兜底防死循环。
const maxSnapshotsPerSecond = 100

// Snapshot 用 VACUUM INTO 生成一致性快照。它在一个读事务里把整库重写到新文件，
// 不阻塞并发写入，也不会像直接拷贝 .db 那样漏掉还在 WAL 里的数据。
func (s *Store) Snapshot(ctx context.Context, dir string) (*domain.BackupInfo, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		// 默认落在库文件旁边的 backups/，即默认部署下的 ./data/backups/。
		// 用库路径推导而不是写死相对路径：快照永远和它的来源库待在一起，与进程 cwd 无关。
		dir = filepath.Join(filepath.Dir(s.db.Path), "backups")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolve backup dir: %w", err)
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("create backup dir: %w", err)
	}

	// 时间戳用 UTC，和库里其它时间列同一口径，文件名就能和返回的 CreatedAt 对上。
	stamp := time.Now().UTC().Format("20060102-150405")
	path := ""
	for i := 0; i < maxSnapshotsPerSecond; i++ {
		name := "pm-" + stamp + ".db"
		if i > 0 {
			name = fmt.Sprintf("pm-%s-%d.db", stamp, i+1)
		}
		p := filepath.Join(abs, name)
		// VACUUM INTO 拒绝写已存在的文件，同一秒内点两次备份必然撞名。
		// 这里加序号而不是回 ErrConflict：备份是用户主动发起的动作，
		// 手滑点两下拿到两个文件不算错，弹「冲突」反而让人以为备份坏了。
		if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
			path = p
			break
		} else if err != nil {
			return nil, fmt.Errorf("stat backup target: %w", err)
		}
	}
	if path == "" {
		return nil, conflict("too many snapshots taken within the same second")
	}

	// 走写连接池（单连接）执行，避免和别的长读事务抢同一条连接。VACUUM 不能在事务里跑，
	// 所以这里直接 Exec，不包 withTx。
	if _, err := s.db.W.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		return nil, fmt.Errorf("vacuum into %s: %w", path, err)
	}

	fi, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat snapshot: %w", err)
	}
	return &domain.BackupInfo{
		Path:      path,
		Size:      fi.Size(),
		CreatedAt: fi.ModTime().UTC(),
	}, nil
}

// --- 导出 ---

const (
	ExportJSON     = "json"
	ExportMarkdown = "markdown"
)

// exportObject 是导出用的对象视图：在领域对象之上把 links 一并带出来，
// 这样一条记录自带它的全部上下文（标签在 domain.Object 里已经有了）。
type exportObject struct {
	*domain.Object
	Links []*domain.Link `json:"links"`
}

// exportBundle 是 JSON 导出的顶层结构。
//
// 这里刻意不包含 agent_providers：那张表里有 API 密钥（明文或可还原的形式），
// 而导出文件天生就是拿去随手分享、丢网盘、贴聊天窗的东西。一旦把密钥写进去，
// 用户不会意识到自己刚把模型账号一起发出去了。要迁移供应商配置请重新填一遍。
type exportBundle struct {
	ExportedAt     time.Time               `json:"exported_at"`
	Version        string                  `json:"version"`
	ObjectTypes    []*domain.ObjectType    `json:"object_types"`
	Categories     []*domain.Category      `json:"categories"`
	Objects        []*exportObject         `json:"objects"`
	Tags           []*domain.Tag           `json:"tags"`
	Links          []*domain.Link          `json:"links"`
	ShortcutGroups []*domain.ShortcutGroup `json:"shortcut_groups"`
	Shortcuts      []*domain.Shortcut      `json:"shortcuts"`
	Dictionaries   []*domain.Dictionary    `json:"dictionaries"`
}

// Export 导出全库。format 为 json（结构化，可再导入）或 markdown（人类可读归档）。
//
// markdown 这一路的目的是防数据锁定：就算这个工具哪天没了、Go 编不过了、
// SQLite 文件打不开了，导出的 Markdown 还能用任何文本编辑器读。
func (s *Store) Export(ctx context.Context, format string) (string, []byte, error) {
	format = strings.ToLower(strings.TrimSpace(format))
	if format != ExportJSON && format != ExportMarkdown {
		return "", nil, validation("format", "must be json or markdown")
	}

	b, err := s.collectExport(ctx)
	if err != nil {
		return "", nil, err
	}

	stamp := b.ExportedAt.Format("20060102-150405")
	if format == ExportMarkdown {
		data, err := s.renderMarkdown(ctx, b)
		if err != nil {
			return "", nil, err
		}
		return "pm-export-" + stamp + ".md", data, nil
	}

	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return "", nil, fmt.Errorf("encode export: %w", err)
	}
	data = append(data, '\n')
	return "pm-export-" + stamp + ".json", data, nil
}

// collectExport 把全库读进内存。个人工具的数据量以万条计，一次性读完比流式简单得多。
func (s *Store) collectExport(ctx context.Context) (*exportBundle, error) {
	b := &exportBundle{ExportedAt: time.Now().UTC(), Version: Version}

	var err error
	if b.ObjectTypes, err = s.ListObjectTypes(ctx); err != nil {
		return nil, err
	}
	if b.Categories, err = s.ListCategories(ctx, "", false); err != nil {
		return nil, err
	}
	if b.Tags, err = s.ListTags(ctx); err != nil {
		return nil, err
	}
	if b.ShortcutGroups, err = s.ListShortcutGroups(ctx); err != nil {
		return nil, err
	}
	if b.Shortcuts, err = s.ListShortcuts(ctx); err != nil {
		return nil, err
	}
	if b.Dictionaries, err = s.ListDictionaries(ctx, true); err != nil {
		return nil, err
	}
	if b.Links, err = s.allLinks(ctx); err != nil {
		return nil, err
	}

	objs, err := s.allObjects(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.fillExportTags(ctx, objs); err != nil {
		return nil, err
	}

	// 把关联按两端挂回对象上，导出的每条记录自带它的关系网。
	byID := make(map[string]*exportObject, len(objs))
	b.Objects = make([]*exportObject, 0, len(objs))
	for _, o := range objs {
		eo := &exportObject{Object: o, Links: []*domain.Link{}}
		byID[o.ID] = eo
		b.Objects = append(b.Objects, eo)
	}
	for _, l := range b.Links {
		if eo, ok := byID[l.FromID]; ok {
			eo.Links = append(eo.Links, l)
		}
		if eo, ok := byID[l.ToID]; ok && l.ToID != l.FromID {
			eo.Links = append(eo.Links, l)
		}
	}
	return b, nil
}

// allObjects 读出全部对象，不分页。归档的要带上（那是真实数据），
// 回收站里软删的不带（那是用户已经扔掉的东西，混进归档只会是噪音）。
func (s *Store) allObjects(ctx context.Context) ([]*domain.Object, error) {
	rows, err := s.db.R.QueryContext(ctx,
		objectSelect+` WHERE o.deleted_at IS NULL ORDER BY o.type_id, o.ref`)
	if err != nil {
		return nil, fmt.Errorf("export objects: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.Object{}
	for rows.Next() {
		o, err := scanObject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// fillExportTags 一次查全表的标签映射。不用 objects.fillTags 是因为那边按 id IN (...) 绑参，
// 全量导出时会撞上 SQLite 的参数个数上限。
func (s *Store) fillExportTags(ctx context.Context, objs []*domain.Object) error {
	if len(objs) == 0 {
		return nil
	}
	byID := make(map[string]*domain.Object, len(objs))
	for _, o := range objs {
		byID[o.ID] = o
	}
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT ot.object_id, t.name FROM object_tags ot
		 JOIN tags t ON t.id = ot.tag_id ORDER BY ot.object_id, t.name`)
	if err != nil {
		return fmt.Errorf("export object tags: %w", err)
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var oid, name string
		if err := rows.Scan(&oid, &name); err != nil {
			return err
		}
		if o, ok := byID[oid]; ok {
			o.Tags = append(o.Tags, name)
		}
	}
	return rows.Err()
}

func (s *Store) allLinks(ctx context.Context) ([]*domain.Link, error) {
	rows, err := s.db.R.QueryContext(ctx,
		// 同 revisions：created_at 是秒级，同刻建的多条 link 要靠 rowid 定先后，
		// 否则每次导出顺序都可能不同，两份备份的 diff 里全是顺序噪音。
		`SELECT id, from_id, to_id, relation, note, created_at FROM links ORDER BY created_at, rowid`)
	if err != nil {
		return nil, fmt.Errorf("export links: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.Link{}
	for rows.Next() {
		var l domain.Link
		var created string
		if err := rows.Scan(&l.ID, &l.FromID, &l.ToID, &l.Relation, &l.Note, &created); err != nil {
			return nil, err
		}
		l.CreatedAt = parseTime(created)
		out = append(out, &l)
	}
	return out, rows.Err()
}

// --- Markdown 渲染 ---

// renderMarkdown 按工作对象类型分章，每个对象一节，分类树用嵌套列表。
func (s *Store) renderMarkdown(ctx context.Context, b *exportBundle) ([]byte, error) {
	var sb strings.Builder

	// 各种 key 到显示名的映射：导出件是给人读的，不能满篇 P0 / doing / relates。
	priority := map[string]string{}
	relation := map[string]string{}
	for _, d := range b.Dictionaries {
		var into map[string]string
		switch d.ID {
		case domain.DictPriority:
			into = priority
		case domain.DictLinkRelation:
			into = relation
		default:
			continue
		}
		for _, it := range d.Items {
			into[it.Key] = it.Label
		}
	}

	catByID := make(map[string]*domain.Category, len(b.Categories))
	for _, c := range b.Categories {
		catByID[c.ID] = c
	}
	objByID := make(map[string]*domain.Object, len(b.Objects))
	for _, o := range b.Objects {
		objByID[o.ID] = o.Object
	}

	sb.WriteString("# 产品工作台数据导出\n\n")
	sb.WriteString("- 导出时间：" + b.ExportedAt.Format(time.RFC3339) + "\n")
	sb.WriteString("- 工具版本：" + b.Version + "\n")
	sb.WriteString(fmt.Sprintf("- 工作对象：%d 条（不含回收站）\n", len(b.Objects)))
	sb.WriteString(fmt.Sprintf("- 标签：%d 个　关联：%d 条\n\n", len(b.Tags), len(b.Links)))

	for _, t := range b.ObjectTypes {
		items := []*exportObject{}
		for _, o := range b.Objects {
			if o.TypeID == t.ID {
				items = append(items, o)
			}
		}
		cats := []*domain.Category{}
		for _, c := range b.Categories {
			if c.TypeID == t.ID {
				cats = append(cats, c)
			}
		}
		if len(items) == 0 && len(cats) == 0 {
			continue
		}

		statuses := map[string]string{}
		for _, st := range t.Statuses {
			statuses[st.Key] = st.Label
		}

		sb.WriteString("\n## " + t.Plural + "\n\n")
		if len(cats) > 0 {
			sb.WriteString("### 分类\n\n")
			writeCategoryTree(&sb, buildTree(cloneCategories(cats)), 0)
			sb.WriteString("\n")
		}
		if len(items) == 0 {
			continue
		}

		sb.WriteString("### 明细\n\n")
		for _, o := range items {
			writeObject(&sb, o, statuses, priority, relation, catByID, objByID)
		}
	}
	return []byte(sb.String()), nil
}

// cloneCategories 复制一层引用，buildTree 会改写 Children，不能拿 bundle 里那份原地改。
func cloneCategories(cats []*domain.Category) []*domain.Category {
	out := make([]*domain.Category, len(cats))
	for i, c := range cats {
		cp := *c
		out[i] = &cp
	}
	return out
}

func writeCategoryTree(sb *strings.Builder, nodes []*domain.Category, depth int) {
	for _, n := range nodes {
		sb.WriteString(strings.Repeat("  ", depth) + "- " + n.Name + "\n")
		writeCategoryTree(sb, n.Children, depth+1)
	}
}

func writeObject(sb *strings.Builder, o *exportObject, statuses, priority, relation map[string]string,
	cats map[string]*domain.Category, objs map[string]*domain.Object) {

	sb.WriteString("#### " + o.Ref + " " + o.Title + "\n\n")

	line := func(label, value string) {
		if value != "" {
			sb.WriteString("- " + label + "：" + value + "\n")
		}
	}
	line("编号", o.Ref)
	line("状态", label(statuses, o.Status))
	line("优先级", label(priority, o.Priority))
	line("分类", categoryPath(cats, o.CategoryID))
	if len(o.Tags) > 0 {
		line("标签", strings.Join(o.Tags, "、"))
	}
	line("负责人", o.Owner)
	if o.ProjectID != nil {
		if p, ok := objs[*o.ProjectID]; ok {
			line("所属项目", p.Ref+" "+p.Title)
		}
	}
	if o.DueAt != nil {
		line("到期", o.DueAt.Format("2006-01-02"))
	}
	if o.ArchivedAt != nil {
		line("已归档", o.ArchivedAt.Format("2006-01-02"))
	}
	line("创建", o.CreatedAt.Format("2006-01-02 15:04"))
	line("更新", o.UpdatedAt.Format("2006-01-02 15:04"))

	if len(o.Links) > 0 {
		sb.WriteString("- 关联：\n")
		for _, l := range o.Links {
			peerID := l.ToID
			dir := ""
			if l.FromID != o.ID {
				peerID, dir = l.FromID, "（反向）"
			}
			peer := peerID
			if p, ok := objs[peerID]; ok {
				peer = p.Ref + " " + p.Title
			}
			sb.WriteString("  - " + label(relation, l.Relation) + dir + " → " + peer + "\n")
		}
	}

	if strings.TrimSpace(o.Body) != "" {
		sb.WriteString("\n" + strings.TrimRight(o.Body, "\n") + "\n")
	}
	sb.WriteString("\n")
}

// label 取字典里的显示名，查不到就回落成原始 key——宁可显示裸值，也不要把数据丢掉。
func label(m map[string]string, key string) string {
	if key == "" {
		return ""
	}
	if v, ok := m[key]; ok && v != "" {
		return v
	}
	return key
}

// categoryPath 顺着 parent_id 走到根，拼成「产品功能 / 云端平台」这种人话路径。
func categoryPath(cats map[string]*domain.Category, id *string) string {
	if id == nil {
		return ""
	}
	names := []string{}
	for cur, hop := cats[*id], 0; cur != nil && hop < 32; hop++ {
		names = append(names, cur.Name)
		if cur.ParentID == nil {
			break
		}
		cur = cats[*cur.ParentID]
	}
	// 是从叶子往根走出来的，反转一下才是「根 / 叶」的阅读顺序。
	for i, j := 0, len(names)-1; i < j; i, j = i+1, j-1 {
		names[i], names[j] = names[j], names[i]
	}
	return strings.Join(names, " / ")
}
