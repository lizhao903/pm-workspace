// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package workspace 读写工作台配置（CORE-10a，0023）。
// 工作台只决定菜单（模块、分组、默认模块、标识）和需要哪些插件，不隔离数据。
package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// timeLayout 定长毫秒 UTC，字符串比较即时间比较。
const timeLayout = "2006-01-02T15:04:05.000Z"

const (
	maxName      = 100
	maxRole      = 50
	maxDesc      = 200
	maxGroups    = 30
	maxGroupName = 30
	maxModules   = 100
	maxPlugins   = 50
	maxMarkText  = 4
	// maxImage 是标识图片 data URL 的长度上限：原型限 1MB 文件，base64 后约 1.37MB。
	maxImage = 1_400_000
)

var (
	moduleRe  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	pluginRe  = regexp.MustCompile(`^[a-z][a-z0-9_]{1,23}$`) // 和插件清单 id 的规则一致
	groupIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
	iconRe    = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	colorRe   = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)
)

// Group 是菜单里的一组；Name 留空只分隔不显示标题，Collapsed 是一级菜单里折起来。
type Group struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Modules   []string `json:"modules"`
	Collapsed bool     `json:"collapsed"`
}

// Mark 是左上角的标识：文字或内置图标，或者上传的图片（data URL）。
type Mark struct {
	Text  string `json:"text"`
	Color string `json:"color"`
	Image string `json:"image,omitempty"`
	Icon  string `json:"icon,omitempty"`
}

// Workspace 是一个工作台。Modules 按分组顺序摊平，读的时候算。
type Workspace struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Role        string    `json:"role"`
	Description string    `json:"description"`
	Groups      []Group   `json:"groups"`
	Modules     []string  `json:"modules"`
	Home        string    `json:"home"`
	Mark        *Mark     `json:"mark"`
	Plugins     []string  `json:"plugins"`
	Template    string    `json:"template"`
	Position    int       `json:"position"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// TemplateGroup 是模板里的一组，新建工作台时再生成分组 id。
type TemplateGroup struct {
	Name    string   `json:"name"`
	Modules []string `json:"modules"`
}

// Template 是预设模板，只读。
type Template struct {
	ID          string          `json:"id"`
	Role        string          `json:"role"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Groups      []TemplateGroup `json:"groups"`
	Modules     []string        `json:"modules"`
	Home        string          `json:"home"`
	Mark        *Mark           `json:"mark"`
	Plugins     []string        `json:"plugins"`
}

// Input 是新建的字段。给了 Template 时没给的字段从模板取；都没给时是只有「今日」的空白工作台。
type Input struct {
	Template    string    `json:"template"`
	Name        string    `json:"name"`
	Role        *string   `json:"role"`
	Description *string   `json:"description"`
	Groups      *[]Group  `json:"groups"`
	Home        string    `json:"home"`
	Mark        *Mark     `json:"mark"`
	Plugins     *[]string `json:"plugins"`
}

// Patch 是修改的字段，nil 为不改；groups、plugins 整体替换，mark 传 null 清掉。
type Patch struct {
	Name        *string         `json:"name"`
	Role        *string         `json:"role"`
	Description *string         `json:"description"`
	Groups      *[]Group        `json:"groups"`
	Home        *string         `json:"home"`
	Mark        json.RawMessage `json:"mark"`
	Plugins     *[]string       `json:"plugins"`
}

// Store 读写 workspaces 和 workspace_templates。
type Store struct {
	db  *db.DB
	now func() time.Time
}

func New(d *db.DB) *Store { return &Store{db: d, now: time.Now} }

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", domain.ErrValidation, fmt.Sprintf(format, a...))
}

// --- 模板 ---

// Templates 全部预设模板，按原型的顺序。
func (s *Store) Templates(ctx context.Context) ([]Template, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT id, role, name, description, groups, home, mark, plugins FROM workspace_templates ORDER BY position, id`)
	if err != nil {
		return nil, fmt.Errorf("list workspace templates: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Template{}
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

func (s *Store) template(ctx context.Context, id string) (*Template, error) {
	row := s.db.R.QueryRowContext(ctx,
		`SELECT id, role, name, description, groups, home, mark, plugins FROM workspace_templates WHERE id = ?`, id)
	t, err := scanTemplate(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, invalid("template: no such template %q", id)
	}
	return t, err
}

// --- 工作台 ---

// List 全部工作台，按 position。
func (s *Store) List(ctx context.Context) ([]Workspace, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT `+cols+` FROM workspaces ORDER BY position, created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Workspace{}
	for rows.Next() {
		w, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *w)
	}
	return out, rows.Err()
}

// Get 取一个；不存在回 ErrNotFound。
func (s *Store) Get(ctx context.Context, id string) (*Workspace, error) {
	return s.get(ctx, s.db.R, id)
}

func (s *Store) get(ctx context.Context, q *sql.DB, id string) (*Workspace, error) {
	w, err := scan(q.QueryRowContext(ctx, `SELECT `+cols+` FROM workspaces WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: workspace %s", domain.ErrNotFound, id)
	}
	return w, err
}

// Create 新建一个工作台，排在最后。
func (s *Store) Create(ctx context.Context, in Input) (*Workspace, error) {
	w := &Workspace{Groups: []Group{{Name: "", Modules: []string{"today"}}}, Home: "today", Plugins: []string{}}
	if in.Template != "" {
		t, err := s.template(ctx, in.Template)
		if err != nil {
			return nil, err
		}
		w.Name, w.Role, w.Description, w.Home, w.Mark, w.Plugins, w.Template = t.Name, t.Role, t.Description, t.Home, t.Mark, t.Plugins, t.ID
		w.Groups = make([]Group, len(t.Groups))
		for i, g := range t.Groups {
			w.Groups[i] = Group{Name: g.Name, Modules: g.Modules}
		}
	}
	if strings.TrimSpace(in.Name) != "" || in.Template == "" {
		w.Name = in.Name
	}
	if in.Role != nil {
		w.Role = *in.Role
	}
	if in.Description != nil {
		w.Description = *in.Description
	}
	if in.Groups != nil {
		w.Groups = *in.Groups
	}
	if in.Mark != nil {
		w.Mark = in.Mark
	}
	if in.Plugins != nil {
		w.Plugins = *in.Plugins
	}
	home := in.Home
	if home == "" && contains(flatten(w.Groups), w.Home) {
		home = w.Home // 没给 home 时沿用模板的，模板的默认模块被去掉了就取第一个
	}
	if err := normalize(w, home); err != nil {
		return nil, err
	}
	w.ID = idgen.Prefixed("ws")
	now := s.now().UTC().Truncate(time.Millisecond)
	w.CreatedAt, w.UpdatedAt = now, now
	groups, mark, plugins, err := encode(w)
	if err != nil {
		return nil, err
	}
	// position 在同一条语句里算，写池单连接，不会两条拿到同一个值
	row := s.db.W.QueryRowContext(ctx,
		`INSERT INTO workspaces (id, name, role, description, groups, home, mark, plugins, template, position, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM workspaces), ?, ?) RETURNING position`,
		w.ID, w.Name, w.Role, w.Description, groups, w.Home, mark, plugins, w.Template, now.Format(timeLayout), now.Format(timeLayout))
	if err := row.Scan(&w.Position); err != nil {
		return nil, fmt.Errorf("insert workspace: %w", err)
	}
	return w, nil
}

// Update 改字段。改了分组没给 home、原来的默认模块又被关掉时，换成第一个模块（和原型 withGroups 一致）。
func (s *Store) Update(ctx context.Context, id string, p Patch) (*Workspace, error) {
	w, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, err
	}
	if p.Name != nil {
		w.Name = *p.Name
	}
	if p.Role != nil {
		w.Role = *p.Role
	}
	if p.Description != nil {
		w.Description = *p.Description
	}
	if p.Groups != nil {
		w.Groups = *p.Groups
	}
	if p.Plugins != nil {
		w.Plugins = *p.Plugins
	}
	if len(p.Mark) > 0 {
		var m *Mark
		if err := json.Unmarshal(p.Mark, &m); err != nil {
			return nil, invalid("mark: %v", err)
		}
		w.Mark = m
	}
	home := w.Home
	if p.Home != nil {
		if home = *p.Home; home == "" {
			return nil, invalid("home must not be empty")
		}
	} else if !contains(flatten(w.Groups), home) {
		home = "" // normalize 里取第一个
	}
	if err := normalize(w, home); err != nil {
		return nil, err
	}
	w.UpdatedAt = s.now().UTC().Truncate(time.Millisecond)
	groups, mark, plugins, err := encode(w)
	if err != nil {
		return nil, err
	}
	res, err := s.db.W.ExecContext(ctx,
		`UPDATE workspaces SET name = ?, role = ?, description = ?, groups = ?, home = ?, mark = ?, plugins = ?, updated_at = ? WHERE id = ?`,
		w.Name, w.Role, w.Description, groups, w.Home, mark, plugins, w.UpdatedAt.Format(timeLayout), id)
	if err != nil {
		return nil, fmt.Errorf("update workspace: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, fmt.Errorf("%w: workspace %s", domain.ErrNotFound, id)
	}
	return w, nil
}

// Delete 删一个工作台，只删配置不动数据。预设的也能删（和原型一致），模板还在，可以从模板重建；
// 最后一个不让删，否则前端没有菜单可用。
func (s *Store) Delete(ctx context.Context, id string) error {
	res, err := s.db.W.ExecContext(ctx,
		`DELETE FROM workspaces WHERE id = ? AND (SELECT COUNT(*) FROM workspaces) > 1`, id)
	if err != nil {
		return fmt.Errorf("delete workspace: %w", err)
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil
	}
	if _, err := s.get(ctx, s.db.W, id); err != nil {
		return err
	}
	return fmt.Errorf("%w: cannot delete the last workspace", domain.ErrConflict)
}

// --- 校验 ---

// normalize 去空白、校验、补分组 id、算 Modules 和 Home；home 为空时取第一个模块。
func normalize(w *Workspace, home string) error {
	w.Name = strings.TrimSpace(w.Name)
	w.Role = strings.TrimSpace(w.Role)
	w.Description = strings.TrimSpace(w.Description)
	if w.Name == "" {
		return invalid("name is required")
	}
	if err := maxLen("name", w.Name, maxName); err != nil {
		return err
	}
	if err := maxLen("role", w.Role, maxRole); err != nil {
		return err
	}
	if err := maxLen("description", w.Description, maxDesc); err != nil {
		return err
	}
	if err := normalizeGroups(w.Groups); err != nil {
		return err
	}
	w.Modules = flatten(w.Groups)
	if len(w.Modules) == 0 {
		return invalid("groups: at least one module is required")
	}
	if len(w.Modules) > maxModules {
		return invalid("groups: more than %d modules", maxModules)
	}
	if home == "" {
		home = w.Modules[0]
	}
	if !contains(w.Modules, home) {
		return invalid("home %q is not one of the enabled modules", home)
	}
	w.Home = home
	if err := normalizeMark(w.Mark); err != nil {
		return err
	}
	plugins, err := normalizePlugins(w.Plugins)
	if err != nil {
		return err
	}
	w.Plugins = plugins
	return nil
}

func normalizeGroups(gs []Group) error {
	if len(gs) > maxGroups {
		return invalid("groups: more than %d groups", maxGroups)
	}
	ids, mods := map[string]bool{}, map[string]bool{}
	for i := range gs {
		g := &gs[i]
		g.ID = strings.TrimSpace(g.ID)
		g.Name = strings.TrimSpace(g.Name)
		if g.ID != "" {
			if !groupIDRe.MatchString(g.ID) {
				return invalid("groups[%d].id %q: only letters, digits, _ and -, up to 40", i, g.ID)
			}
			if ids[g.ID] {
				return invalid("groups[%d].id %q is duplicated", i, g.ID)
			}
			ids[g.ID] = true
		}
		if err := maxLen(fmt.Sprintf("groups[%d].name", i), g.Name, maxGroupName); err != nil {
			return err
		}
		if g.Modules == nil {
			g.Modules = []string{}
		}
		for _, m := range g.Modules {
			if !moduleRe.MatchString(m) {
				return invalid("groups[%d]: module key %q must be lowercase letters, digits and _", i, m)
			}
			if mods[m] {
				return invalid("groups: module %q appears more than once", m)
			}
			mods[m] = true
		}
	}
	// 没给 id 的分组补 g1、g2…，跳过已占用的
	n := 0
	for i := range gs {
		for gs[i].ID == "" {
			n++
			if id := "g" + strconv.Itoa(n); !ids[id] {
				gs[i].ID, ids[id] = id, true
			}
		}
	}
	return nil
}

func normalizeMark(m *Mark) error {
	if m == nil {
		return nil
	}
	m.Text = strings.TrimSpace(m.Text)
	if err := maxLen("mark.text", m.Text, maxMarkText); err != nil {
		return err
	}
	if m.Color != "" && !colorRe.MatchString(m.Color) {
		return invalid("mark.color %q must be #rgb or #rrggbb", m.Color)
	}
	if m.Icon != "" && !iconRe.MatchString(m.Icon) {
		return invalid("mark.icon %q must be a built-in icon key", m.Icon)
	}
	if m.Image != "" {
		if !strings.HasPrefix(m.Image, "data:image/") {
			return invalid("mark.image must be a data:image/ URL")
		}
		if len(m.Image) > maxImage {
			return invalid("mark.image is larger than 1MB")
		}
	}
	return nil
}

func normalizePlugins(ps []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, p := range ps {
		p = strings.TrimSpace(p)
		if !pluginRe.MatchString(p) {
			return nil, invalid("plugins: %q is not a valid plugin id", p)
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if len(out) > maxPlugins {
		return nil, invalid("plugins: more than %d", maxPlugins)
	}
	return out, nil
}

func maxLen(field, v string, n int) error {
	if utf8.RuneCountInString(v) > n {
		return invalid("%s is longer than %d characters", field, n)
	}
	return nil
}

func flatten(gs []Group) []string {
	out := []string{}
	for _, g := range gs {
		out = append(out, g.Modules...)
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// --- 编解码 ---

const cols = `id, name, role, description, groups, home, mark, plugins, template, position, created_at, updated_at`

func encode(w *Workspace) (groups, mark, plugins string, err error) {
	gb, err := json.Marshal(w.Groups)
	if err != nil {
		return "", "", "", fmt.Errorf("workspace groups: %w", err)
	}
	mb, err := json.Marshal(w.Mark)
	if err != nil {
		return "", "", "", fmt.Errorf("workspace mark: %w", err)
	}
	pb, err := json.Marshal(w.Plugins)
	if err != nil {
		return "", "", "", fmt.Errorf("workspace plugins: %w", err)
	}
	return string(gb), string(mb), string(pb), nil
}

type scanner interface{ Scan(dest ...any) error }

func scan(r scanner) (*Workspace, error) {
	var (
		w                     Workspace
		groups, mark, plugins string
		ca, ua                string
	)
	if err := r.Scan(&w.ID, &w.Name, &w.Role, &w.Description, &groups, &w.Home, &mark, &plugins,
		&w.Template, &w.Position, &ca, &ua); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(groups), &w.Groups); err != nil {
		return nil, fmt.Errorf("workspace %s groups: %w", w.ID, err)
	}
	if err := json.Unmarshal([]byte(mark), &w.Mark); err != nil {
		return nil, fmt.Errorf("workspace %s mark: %w", w.ID, err)
	}
	if err := json.Unmarshal([]byte(plugins), &w.Plugins); err != nil {
		return nil, fmt.Errorf("workspace %s plugins: %w", w.ID, err)
	}
	if w.Groups == nil {
		w.Groups = []Group{}
	}
	for i := range w.Groups {
		if w.Groups[i].Modules == nil {
			w.Groups[i].Modules = []string{}
		}
	}
	if w.Plugins == nil {
		w.Plugins = []string{}
	}
	w.Modules = flatten(w.Groups)
	w.CreatedAt, _ = time.Parse(timeLayout, ca)
	w.UpdatedAt, _ = time.Parse(timeLayout, ua)
	return &w, nil
}

func scanTemplate(r scanner) (*Template, error) {
	var (
		t                     Template
		groups, mark, plugins string
	)
	if err := r.Scan(&t.ID, &t.Role, &t.Name, &t.Description, &groups, &t.Home, &mark, &plugins); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(groups), &t.Groups); err != nil {
		return nil, fmt.Errorf("workspace template %s groups: %w", t.ID, err)
	}
	if err := json.Unmarshal([]byte(mark), &t.Mark); err != nil {
		return nil, fmt.Errorf("workspace template %s mark: %w", t.ID, err)
	}
	if err := json.Unmarshal([]byte(plugins), &t.Plugins); err != nil {
		return nil, fmt.Errorf("workspace template %s plugins: %w", t.ID, err)
	}
	t.Modules = []string{}
	for _, g := range t.Groups {
		t.Modules = append(t.Modules, g.Modules...)
	}
	if t.Plugins == nil {
		t.Plugins = []string{}
	}
	return &t, nil
}
