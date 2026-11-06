package sop

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 流程库的文件夹（TSK-0482，插件 0.15.0，迁移 0009_folders.sql）：一级文件夹，不分层。
// 流程的 folder_id 为空是「未分类」；删文件夹时里面的流程回未分类，流程本身不动。
// 接口 /api/sop/folders、POST /api/sop/flows/move，契约见 docs/api-contract.md「SOP 编排插件 sop」的「文件夹」。
// 已有流程按名字前缀「xxx · 」自动归类由后台任务 folder_seed 在启用时做一次（seedFolders）。

const (
	maxFolderName = 30
	// maxMove 是一次最多移动几条流程，同批量发起、批量重跑
	maxMove = 200
	// uncategorized 是没放进文件夹的流程的叫法，不能拿来当文件夹名
	uncategorized = "未分类"
	// folderSeedKey 是 sop_settings 里「按前缀归类已经做过」的标记，值是做的时间和建了哪些文件夹
	folderSeedKey = "folders_seeded"
	// folderSep 是名字前缀的分隔：空格、间隔号（U+00B7）、空格，同生产库里「产品经理 · 写周报」这类名字
	folderSep = " · "
)

// reservedFolderNames 是界面上已经占用的叫法：「全部」是不按文件夹筛，「未分类」是没放进文件夹的
var reservedFolderNames = []string{"全部", uncategorized}

// Folder 是一个文件夹，count 是里面的流程数。
type Folder struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Count     int       `json:"count"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// folderIDSQL 是流程实际所在的文件夹：folder_id 指向的文件夹不在了（并发删除时）按未分类算
const folderIDSQL = `(SELECT fd.id FROM sop_folders fd WHERE fd.id = sop_flows.folder_id)`

type folders struct{ c plugin.Core }

func (h *folders) list(w http.ResponseWriter, r *http.Request) {
	out, none, err := listFolders(r.Context(), h.c)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out), "uncategorized": none}})
}

// listFolders 回全部文件夹（按新建先后）和未分类的流程数。
func listFolders(ctx context.Context, c plugin.Core) ([]Folder, int, error) {
	rows, err := c.Store().Query(ctx, `SELECT fd.id, fd.name, fd.created_at, fd.updated_at,
		(SELECT COUNT(*) FROM sop_flows f WHERE f.folder_id = fd.id)
		FROM sop_folders fd ORDER BY fd.created_at, fd.rowid`)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	out := []Folder{}
	for rows.Next() {
		f, err := scanFolder(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	var none int
	if err := c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM sop_flows WHERE `+folderIDSQL+` IS NULL`).Scan(&none); err != nil {
		return nil, 0, err
	}
	return out, none, nil
}

func scanFolder(row plugin.Row) (Folder, error) {
	var f Folder
	var created, updated string
	if err := row.Scan(&f.ID, &f.Name, &created, &updated, &f.Count); err != nil {
		return Folder{}, err
	}
	f.CreatedAt, _ = time.Parse(time.RFC3339, created)
	f.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	return f, nil
}

func getFolder(ctx context.Context, c plugin.Core, id string) (Folder, error) {
	f, err := scanFolder(c.Store().QueryRow(ctx, `SELECT fd.id, fd.name, fd.created_at, fd.updated_at,
		(SELECT COUNT(*) FROM sop_flows f WHERE f.folder_id = fd.id) FROM sop_folders fd WHERE fd.id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return Folder{}, apiErr(errNotFound, "文件夹 %s 不存在", id)
	}
	return f, err
}

// folderByName 按名字找文件夹，不分大小写；没有回 errNotFound。
func folderByName(ctx context.Context, c plugin.Core, name string) (Folder, error) {
	var id string
	err := c.Store().QueryRow(ctx, `SELECT id FROM sop_folders WHERE name = ? COLLATE NOCASE`, name).Scan(&id)
	if errors.Is(err, plugin.ErrNoRows) {
		return Folder{}, apiErr(errNotFound, "没有叫「%s」的文件夹", name)
	}
	if err != nil {
		return Folder{}, err
	}
	return getFolder(ctx, c, id)
}

// readFolderName 取 body 里的 name：去首尾空白后 1 到 30 字，不能是「全部」「未分类」。
func readFolderName(raw map[string]json.RawMessage) (string, error) {
	v, ok := raw["name"]
	if !ok {
		return "", apiErr(errValidation, "name 是必填的")
	}
	var name string
	if err := json.Unmarshal(v, &name); err != nil {
		return "", apiErr(errValidation, "name 必须是字符串")
	}
	return checkFolderName(name)
}

func checkFolderName(name string) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", apiErr(errValidation, "文件夹名称不能为空")
	case utf8.RuneCountInString(name) > maxFolderName:
		return "", apiErr(errValidation, "文件夹名称最多 %d 字", maxFolderName)
	}
	for _, x := range reservedFolderNames {
		if strings.EqualFold(name, x) {
			return "", apiErr(errValidation, "「%s」是界面上已经占用的叫法，换个名字", x)
		}
	}
	return name, nil
}

// nameTaken 是同名（不分大小写）的另一个文件夹已经在了；except 是改名时的自己。
func nameTaken(ctx context.Context, c plugin.Core, name, except string) error {
	var id string
	err := c.Store().QueryRow(ctx, `SELECT id FROM sop_folders WHERE name = ? COLLATE NOCASE AND id <> ?`, name, except).Scan(&id)
	if errors.Is(err, plugin.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return apiErr(errConflict, "已经有叫「%s」的文件夹了", name)
}

func (h *folders) add(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	name, err := readFolderName(raw)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	f, err := createFolder(r.Context(), h.c, name)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": f})
}

// createFolder 新建一个文件夹，name 已经校验过；同名的已经在回 errConflict。
func createFolder(ctx context.Context, c plugin.Core, name string) (Folder, error) {
	if err := nameTaken(ctx, c, name, ""); err != nil {
		return Folder{}, err
	}
	id := idgen.Prefixed("sfd")
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := c.Store().Exec(ctx, `INSERT INTO sop_folders (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
		id, name, now, now)
	if err != nil {
		return Folder{}, err
	}
	// 查重和插入之间别处建了同名的：唯一索引挡住，按重名回
	if n, _ := res.RowsAffected(); n == 0 {
		return Folder{}, apiErr(errConflict, "已经有叫「%s」的文件夹了", name)
	}
	return getFolder(ctx, c, id)
}

func (h *folders) rename(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := getFolder(ctx, h.c, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	name, err := readFolderName(raw)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := nameTaken(ctx, h.c, name, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `UPDATE sop_folders SET name = ?, updated_at = ? WHERE id = ?`, name, now, id); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			err = apiErr(errConflict, "已经有叫「%s」的文件夹了", name)
		}
		fail(w, r, h.c, err)
		return
	}
	f, err := getFolder(ctx, h.c, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": f})
}

// remove 删文件夹：先把里面的流程放回未分类（不升版本、不改 updated_at），再删文件夹；回放回了几条。
func (h *folders) remove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := getFolder(ctx, h.c, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	res, err := h.c.Store().Exec(ctx, `UPDATE sop_flows SET folder_id = NULL WHERE folder_id = ?`, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	moved, _ := res.RowsAffected()
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM sop_folders WHERE id = ?`, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]int64{"moved": moved}})
}

// readFolderID 认 body 里的 folder_id：字符串或 null，空串和 null 都是未分类；给了不存在的文件夹 400。
// ok 为 false 是 body 里没有这个键。
func readFolderID(ctx context.Context, c plugin.Core, raw map[string]json.RawMessage) (id *string, ok bool, err error) {
	v, ok := raw["folder_id"]
	if !ok {
		return nil, false, nil
	}
	if string(v) == "null" {
		return nil, true, nil
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return nil, true, apiErr(errValidation, "folder_id 必须是字符串或 null")
	}
	if s = strings.TrimSpace(s); s == "" {
		return nil, true, nil
	}
	if _, err := getFolder(ctx, c, s); err != nil {
		if errors.Is(err, errNotFound) {
			return nil, true, apiErr(errValidation, "文件夹 %s 不存在", s)
		}
		return nil, true, err
	}
	return &s, true, nil
}

// move 把流程移进一个文件夹（folder_id 为 null 是移回未分类）：只改归属，不升版本、不改 updated_at。
func (h *folders) move(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var ids []string
	if v, ok := raw["flow_ids"]; !ok || json.Unmarshal(v, &ids) != nil || len(ids) == 0 || len(ids) > maxMove {
		fail(w, r, h.c, apiErr(errValidation, "flow_ids 要是 1 到 %d 个流程 id", maxMove))
		return
	}
	v, ok := raw["folder_id"]
	if !ok {
		fail(w, r, h.c, apiErr(errValidation, "folder_id 是必填的：文件夹 id，移回未分类写 null"))
		return
	}
	// 文件夹不存在是 404（移到哪里是这个接口的主语），流程不存在是 400
	var folder *string
	if string(v) != "null" {
		var s string
		if json.Unmarshal(v, &s) != nil {
			fail(w, r, h.c, apiErr(errValidation, "folder_id 必须是字符串或 null"))
			return
		}
		if s = strings.TrimSpace(s); s != "" {
			if _, err := getFolder(ctx, h.c, s); err != nil {
				fail(w, r, h.c, err)
				return
			}
			folder = &s
		}
	}
	seen := map[string]bool{}
	var missing []string
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if _, err := (&flows{c: h.c}).get(ctx, id); errors.Is(err, errNotFound) {
			missing = append(missing, id)
		} else if err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	if len(missing) > 0 {
		fail(w, r, h.c, apiErr(errValidation, "流程 %s 不存在", strings.Join(missing, "、")))
		return
	}
	var moved int64
	for id := range seen {
		n, err := setFolder(ctx, h.c, id, folder)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		moved += n
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]int64{"moved": moved}})
}

// setFolder 改一条流程的归属，不升版本、不改 updated_at；文件夹在这期间被删了就不改（回 0）。
func setFolder(ctx context.Context, c plugin.Core, flowID string, folder *string) (int64, error) {
	var res sql.Result
	var err error
	if folder == nil {
		res, err = c.Store().Exec(ctx, `UPDATE sop_flows SET folder_id = NULL WHERE id = ?`, flowID)
	} else {
		res, err = c.Store().Exec(ctx, `UPDATE sop_flows SET folder_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM sop_folders WHERE id = ?)`,
			*folder, flowID, *folder)
	}
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

/* ---------- 按名字前缀自动归类（启用时做一次） ---------- */

// folderPrefix 是流程名里「前缀 · 名称」的前缀：按第一个「 · 」切开，两边去空白后都不为空、
// 前缀不超过 30 字、不是「全部」「未分类」才算；否则回空串。
func folderPrefix(name string) string {
	head, rest, ok := strings.Cut(name, folderSep)
	if !ok {
		return ""
	}
	head, rest = strings.TrimSpace(head), strings.TrimSpace(rest)
	if head == "" || rest == "" {
		return ""
	}
	if _, err := checkFolderName(head); err != nil {
		return ""
	}
	return head
}

// seedResult 是一次自动归类的结果，日志和测试用。
type seedResult struct {
	Done    bool           // false 是之前已经做过，这次什么都没做
	Folders []string       // 用到的文件夹，按第一次出现的先后；已经有同名文件夹的直接用那个
	Moved   map[string]int // 文件夹名 → 归进去的流程数
}

// seedFolders 按名字前缀把未分类的流程归进文件夹，只做一次（sop_settings 的 folders_seeded 记着）：
//   - 只看 folder_id 为空的流程，已经在文件夹里的不动；不改流程名、不升版本、不改 updated_at；
//   - 前缀相同（不分大小写）的归进同一个文件夹，文件夹名用第一次出现的写法，按流程新建先后建；
//   - 已经有同名文件夹（用户先建了）就归进那一个，不另建。
//
// 中途失败（进程被杀）时标记还没写，下次启用重做：文件夹按名字认、流程只归未分类的，重做不会重复建、不会覆盖。
// 新装的插件第一次启用时一条流程都没有，直接记上标记，之后建的「xxx · 」流程不会被自动归类。
func seedFolders(ctx context.Context, c plugin.Core) (seedResult, error) {
	var at string
	err := c.Store().QueryRow(ctx, `SELECT value FROM sop_settings WHERE key = ?`, folderSeedKey).Scan(&at)
	if err == nil {
		return seedResult{}, nil
	}
	if !errors.Is(err, plugin.ErrNoRows) {
		return seedResult{}, err
	}
	rows, err := c.Store().Query(ctx, `SELECT id, name FROM sop_flows WHERE `+folderIDSQL+` IS NULL ORDER BY created_at, rowid`)
	if err != nil {
		return seedResult{}, err
	}
	type flowName struct{ id, prefix string }
	var list []flowName
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			_ = rows.Close()
			return seedResult{}, err
		}
		if p := folderPrefix(name); p != "" {
			list = append(list, flowName{id, p})
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return seedResult{}, err
	}
	out := seedResult{Done: true, Moved: map[string]int{}}
	ids := map[string]string{} // 小写前缀 → 文件夹 id
	names := map[string]string{}
	for _, x := range list {
		k := strings.ToLower(x.prefix)
		fid, ok := ids[k]
		if !ok {
			f, err := folderByName(ctx, c, x.prefix)
			if errors.Is(err, errNotFound) {
				f, err = createFolder(ctx, c, x.prefix)
			}
			if err != nil {
				return seedResult{}, err
			}
			fid, ids[k], names[k] = f.ID, f.ID, f.Name
			out.Folders = append(out.Folders, f.Name)
		}
		res, err := c.Store().Exec(ctx, `UPDATE sop_flows SET folder_id = ? WHERE id = ? AND folder_id IS NULL`, fid, x.id)
		if err != nil {
			return seedResult{}, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			out.Moved[names[k]]++
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	note, _ := json.Marshal(map[string]any{"at": now, "folders": out.Folders, "moved": out.Moved})
	if _, err := c.Store().Exec(ctx, `INSERT INTO sop_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING`,
		folderSeedKey, string(note), now); err != nil {
		return seedResult{}, err
	}
	return out, nil
}

func folderSeedJob(ctx context.Context, c plugin.Core) error {
	res, err := seedFolders(ctx, c)
	if err != nil {
		return fmt.Errorf("按名字前缀归类流程：%w", err)
	}
	if res.Done {
		c.Log().Info("sop folders seeded", "folders", res.Folders, "moved", res.Moved)
	}
	return nil
}
