// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 知识库（AG-01b3，0034） ---

const (
	kbCols    = `id, name, description, sources, auto_sync, dirs, chunk_size, overlap, top, embed, created_at, updated_at`
	kbDocCols = `id, kb_id, title, source_type, source_ref, text, chunks, status, excluded, error, created_at, updated_at, origin, origin_key`
)

// 长度和个数上限，按字符数
const (
	kbNameMax    = 100
	kbDescMax    = 500
	kbSourcesMax = 50
	kbDirsMax    = 50
	kbTitleMax   = 300
	kbEmbedMax   = 200
	kbTopMax     = 20
	// KbTextMax 是一篇资料正文的上限（字节），和读本地文件的 1MB 一致
	KbTextMax = 1 << 20
)

// 切分设置的可选值，和原型 kbskills.tsx 的 CHUNK_SIZES、OVERLAPS 一致
var (
	kbChunkSizes = []int{200, 300, 500, 800, 1200}
	kbOverlaps   = []int{0, 30, 50, 100}
)

// kbFTSOff 让测试模拟 SQLite 不支持 FTS5，走逐块匹配。
var kbFTSOff = false

func defaultKbSettings() store.KbSettings {
	return store.KbSettings{AutoSync: true, Dirs: []store.KbDir{}, ChunkSize: 300, Overlap: 50, Top: kb.DefaultTop}
}

func scanKb(sc rowScanner) (*store.KnowledgeBase, error) {
	var k store.KnowledgeBase
	var sources, dirs, embed, created, updated string
	if err := sc.Scan(&k.ID, &k.Name, &k.Desc, &sources, &k.Settings.AutoSync, &dirs, &k.Settings.ChunkSize,
		&k.Settings.Overlap, &k.Settings.Top, &embed, &created, &updated); err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(sources), &k.Sources)
	_ = json.Unmarshal([]byte(dirs), &k.Settings.Dirs)
	_ = json.Unmarshal([]byte(embed), &k.Settings.Embed)
	k.Sources = nonNilStrs(k.Sources)
	if k.Settings.Dirs == nil {
		k.Settings.Dirs = []store.KbDir{}
	}
	k.CreatedAt, k.UpdatedAt = parseTime(created), parseTime(updated)
	return &k, nil
}

func (s *Store) ListKnowledgeBases(ctx context.Context) ([]*store.KnowledgeBase, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT `+kbCols+` FROM knowledge_bases ORDER BY created_at DESC, rowid DESC`)
	if err != nil {
		return nil, fmt.Errorf("list knowledge bases: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []*store.KnowledgeBase{}
	for rows.Next() {
		k, err := scanKb(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *Store) GetKnowledgeBase(ctx context.Context, id string) (*store.KnowledgeBase, error) {
	k, err := scanKb(s.db.R.QueryRowContext(ctx, `SELECT `+kbCols+` FROM knowledge_bases WHERE id = ?`, id))
	if noRows(err) {
		return nil, notFound("knowledge base")
	}
	if err != nil {
		return nil, fmt.Errorf("get knowledge base: %w", err)
	}
	return k, nil
}

// CreateKnowledgeBase 名称必填（SPEC-settings-14.6），没给的设置取默认值（原型 defaultSettings，模型留空）。
func (s *Store) CreateKnowledgeBase(ctx context.Context, in store.KbInput) (*store.KnowledgeBase, error) {
	k := &store.KnowledgeBase{Sources: []string{}, Settings: defaultKbSettings()}
	if err := s.applyKbInput(ctx, k, in); err != nil {
		return nil, err
	}
	k.ID = idgen.Prefixed("kb")
	now := agentTime()
	sources, dirs, embed := kbJSON(k)
	if _, err := s.db.W.ExecContext(ctx, `INSERT INTO knowledge_bases (`+kbCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		k.ID, k.Name, k.Desc, sources, k.Settings.AutoSync, dirs, k.Settings.ChunkSize, k.Settings.Overlap,
		k.Settings.Top, embed, now, now); err != nil {
		return nil, fmt.Errorf("insert knowledge base: %w", err)
	}
	return s.GetKnowledgeBase(ctx, k.ID)
}

// UpdateKnowledgeBase 只改给了的字段。目录里已有的路径保留原来的同步时间。
func (s *Store) UpdateKnowledgeBase(ctx context.Context, id string, in store.KbInput) (*store.KnowledgeBase, error) {
	k, err := s.GetKnowledgeBase(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := s.applyKbInput(ctx, k, in); err != nil {
		return nil, err
	}
	sources, dirs, embed := kbJSON(k)
	res, err := s.db.W.ExecContext(ctx, `UPDATE knowledge_bases SET name=?, description=?, sources=?, auto_sync=?, dirs=?,
		chunk_size=?, overlap=?, top=?, embed=?, updated_at=? WHERE id=?`,
		k.Name, k.Desc, sources, k.Settings.AutoSync, dirs, k.Settings.ChunkSize, k.Settings.Overlap, k.Settings.Top,
		embed, agentTime(), id)
	if err != nil {
		return nil, fmt.Errorf("update knowledge base: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, notFound("knowledge base")
	}
	return s.GetKnowledgeBase(ctx, id)
}

func kbJSON(k *store.KnowledgeBase) (sources, dirs, embed string) {
	a, _ := json.Marshal(nonNilStrs(k.Sources))
	d := k.Settings.Dirs
	if d == nil {
		d = []store.KbDir{}
	}
	b, _ := json.Marshal(d)
	c, _ := json.Marshal(k.Settings.Embed)
	return string(a), string(b), string(c)
}

// applyKbInput 把给了的字段校验后写到 k 上。
func (s *Store) applyKbInput(ctx context.Context, k *store.KnowledgeBase, in store.KbInput) error {
	if in.Name != nil {
		k.Name = strings.TrimSpace(*in.Name)
	}
	if k.Name == "" {
		return agentInvalid("名称还没填")
	}
	if utf8.RuneCountInString(k.Name) > kbNameMax {
		return agentInvalid("名称最多 %d 字", kbNameMax)
	}
	if in.Desc != nil {
		k.Desc = strings.TrimSpace(*in.Desc)
		if utf8.RuneCountInString(k.Desc) > kbDescMax {
			return agentInvalid("说明最多 %d 字", kbDescMax)
		}
	}
	if in.Sources != nil {
		src := []string{}
		for _, id := range *in.Sources {
			id = strings.TrimSpace(id)
			if id == "" || slices.Contains(src, id) {
				continue
			}
			var typ string
			err := s.db.R.QueryRowContext(ctx, `SELECT type_id FROM categories WHERE id = ?`, id).Scan(&typ)
			if noRows(err) || (err == nil && typ != "doc") {
				return agentInvalid("文档分类 %s 不存在", id)
			}
			if err != nil {
				return fmt.Errorf("check category: %w", err)
			}
			src = append(src, id)
		}
		if len(src) > kbSourcesMax {
			return agentInvalid("文档分类最多选 %d 个", kbSourcesMax)
		}
		k.Sources = src
	}
	if p := in.Settings; p != nil {
		st := &k.Settings
		if p.AutoSync != nil {
			st.AutoSync = *p.AutoSync
		}
		if p.ChunkSize != nil {
			if !slices.Contains(kbChunkSizes, *p.ChunkSize) {
				return agentInvalid("每段字数只能是 200、300、500、800、1200")
			}
			st.ChunkSize = *p.ChunkSize
		}
		if p.Overlap != nil {
			if !slices.Contains(kbOverlaps, *p.Overlap) {
				return agentInvalid("段间重叠只能是 0、30、50、100 字")
			}
			st.Overlap = *p.Overlap
		}
		if st.Overlap > st.ChunkSize/2 {
			return agentInvalid("段间重叠不能超过每段字数的一半")
		}
		if p.Top != nil {
			if *p.Top < 1 || *p.Top > kbTopMax {
				return agentInvalid("返回条数在 1 到 %d 之间", kbTopMax)
			}
			st.Top = *p.Top
		}
		if p.Embed != nil {
			e := store.KbEmbed{ProviderID: strings.TrimSpace(p.Embed.ProviderID), Model: strings.TrimSpace(p.Embed.Model)}
			if utf8.RuneCountInString(e.ProviderID) > kbEmbedMax || utf8.RuneCountInString(e.Model) > kbEmbedMax {
				return agentInvalid("向量化模型最多 %d 字", kbEmbedMax)
			}
			st.Embed = e
		}
		if p.Dirs != nil {
			prev := map[string]*time.Time{}
			for _, d := range st.Dirs {
				prev[d.Path] = d.SyncedAt
			}
			dirs := []store.KbDir{}
			for _, d := range *p.Dirs {
				path := strings.TrimSpace(d.Path)
				if path == "" {
					continue
				}
				if slices.ContainsFunc(dirs, func(x store.KbDir) bool { return x.Path == path }) {
					return agentInvalid("这个目录已经挂上了：%s", path)
				}
				dirs = append(dirs, store.KbDir{Path: path, AutoSync: d.AutoSync, SyncedAt: prev[path]})
			}
			if len(dirs) > kbDirsMax {
				return agentInvalid("本地目录最多挂 %d 个", kbDirsMax)
			}
			st.Dirs = dirs
		}
	}
	return nil
}

// DeleteKnowledgeBase 删知识库和它的文档、切块，同一个事务里从挂着它的 Agent 的 kbs 里摘掉（SPEC-settings-14.7）。
func (s *Store) DeleteKnowledgeBase(ctx context.Context, id string) (*store.KnowledgeBase, []string, error) {
	k, err := s.GetKnowledgeBase(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	fts := s.kbFTS(ctx)
	detached := []string{}
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if fts {
			if _, err := tx.ExecContext(ctx, `DELETE FROM kb_chunks_fts WHERE rowid IN
				(SELECT c.id FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE d.kb_id = ?)`, id); err != nil {
				return fmt.Errorf("delete kb fts: %w", err)
			}
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM knowledge_bases WHERE id = ?`, id)
		if err != nil {
			return fmt.Errorf("delete knowledge base: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return notFound("knowledge base")
		}
		rows, err := tx.QueryContext(ctx, `SELECT id, kbs FROM agents
			WHERE EXISTS (SELECT 1 FROM json_each(agents.kbs) WHERE value = ?)
			ORDER BY created_at DESC, rowid DESC`, id)
		if err != nil {
			return fmt.Errorf("find agents with kb: %w", err)
		}
		type hit struct {
			id  string
			kbs []string
		}
		var hits []hit
		for rows.Next() {
			var h hit
			var raw string
			if err := rows.Scan(&h.id, &raw); err != nil {
				_ = rows.Close()
				return err
			}
			_ = json.Unmarshal([]byte(raw), &h.kbs)
			hits = append(hits, h)
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		now := agentTime()
		for _, h := range hits {
			left, _ := json.Marshal(nonNilStrs(slices.DeleteFunc(h.kbs, func(x string) bool { return x == id })))
			if _, err := tx.ExecContext(ctx, `UPDATE agents SET kbs = ?, updated_at = ? WHERE id = ?`, string(left), now, h.id); err != nil {
				return fmt.Errorf("detach kb: %w", err)
			}
			detached = append(detached, h.id)
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return k, detached, nil
}

func (s *Store) SetKbDirSynced(ctx context.Context, kbID, path string, at time.Time) error {
	k, err := s.GetKnowledgeBase(ctx, kbID)
	if err != nil {
		return err
	}
	t := at.UTC().Truncate(time.Millisecond)
	found := false
	for i := range k.Settings.Dirs {
		if k.Settings.Dirs[i].Path == path {
			k.Settings.Dirs[i].SyncedAt = &t
			found = true
		}
	}
	if !found {
		return nil
	}
	_, dirs, _ := kbJSON(k)
	if _, err := s.db.W.ExecContext(ctx, `UPDATE knowledge_bases SET dirs = ? WHERE id = ?`, dirs, kbID); err != nil {
		return fmt.Errorf("set kb dir synced: %w", err)
	}
	return nil
}

func (s *Store) KbCounts(ctx context.Context) (map[string]store.KbCounts, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT kb_id, COUNT(*),
		SUM(status = 'indexed'), SUM(status = 'pending'), SUM(status = 'failed'), SUM(excluded),
		SUM(status = 'indexed' AND excluded = 0), SUM(CASE WHEN status = 'indexed' AND excluded = 0 THEN chunks ELSE 0 END), MAX(updated_at)
		FROM kb_docs GROUP BY kb_id`)
	if err != nil {
		return nil, fmt.Errorf("kb counts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]store.KbCounts{}
	for rows.Next() {
		var id string
		var c store.KbCounts
		var last sql.NullString
		if err := rows.Scan(&id, &c.Docs, &c.Indexed, &c.Pending, &c.Failed, &c.Excluded, &c.Searchable, &c.Chunks, &last); err != nil {
			return nil, err
		}
		c.LastAt = parseNullTime(last)
		out[id] = c
	}
	return out, rows.Err()
}

// --- 文档 ---

func scanKbDoc(sc rowScanner) (*store.KbDoc, error) {
	var d store.KbDoc
	var created, updated string
	if err := sc.Scan(&d.ID, &d.KbID, &d.Title, &d.Source.Type, &d.Source.Ref, &d.Text, &d.Chunks, &d.Status,
		&d.Excluded, &d.Error, &created, &updated, &d.Origin, &d.OriginKey); err != nil {
		return nil, err
	}
	d.CreatedAt, d.UpdatedAt = parseTime(created), parseTime(updated)
	return &d, nil
}

func (s *Store) ListKbDocs(ctx context.Context, kbID string) ([]*store.KbDoc, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT `+kbDocCols+` FROM kb_docs WHERE kb_id = ?
		ORDER BY created_at DESC, rowid DESC`, kbID)
	if err != nil {
		return nil, fmt.Errorf("list kb docs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []*store.KbDoc{}
	for rows.Next() {
		d, err := scanKbDoc(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) GetKbDoc(ctx context.Context, kbID, docID string) (*store.KbDoc, error) {
	d, err := scanKbDoc(s.db.R.QueryRowContext(ctx, `SELECT `+kbDocCols+` FROM kb_docs WHERE id = ? AND kb_id = ?`, docID, kbID))
	if noRows(err) {
		return nil, notFound("knowledge base doc")
	}
	if err != nil {
		return nil, fmt.Errorf("get kb doc: %w", err)
	}
	return d, nil
}

func checkKbDoc(d *store.KbDoc) error {
	d.Title = strings.TrimSpace(d.Title)
	if d.Title == "" {
		return agentInvalid("标题还没填")
	}
	if utf8.RuneCountInString(d.Title) > kbTitleMax {
		return agentInvalid("标题最多 %d 字", kbTitleMax)
	}
	if len(d.Text) > KbTextMax {
		return agentInvalid("正文太长，最多 1MB")
	}
	switch d.Source.Type {
	case store.KbSrcLibrary, store.KbSrcDir, store.KbSrcUpload, store.KbSrcLink, store.KbSrcNote:
	case store.KbSrcFile:
		// 本机单个文件只能由插件同步加（TSK-0721）
		if d.Origin == "" {
			return agentInvalid("本机文件只能由插件同步加进知识库")
		}
	default:
		return agentInvalid("来源只能是 library、dir、upload、link、note、file")
	}
	return nil
}

func (s *Store) CreateKbDoc(ctx context.Context, d *store.KbDoc) (*store.KbDoc, error) {
	if err := checkKbDoc(d); err != nil {
		return nil, err
	}
	id := idgen.Prefixed("kd")
	now := agentTime()
	if _, err := s.db.W.ExecContext(ctx, `INSERT INTO kb_docs (`+kbDocCols+`) VALUES (?,?,?,?,?,?,0,?,?,'',?,?,?,?)`,
		id, d.KbID, d.Title, d.Source.Type, d.Source.Ref, d.Text, store.KbPending, d.Excluded, now, now, d.Origin, d.OriginKey); err != nil {
		if strings.Contains(err.Error(), "FOREIGN KEY") {
			return nil, notFound("knowledge base")
		}
		return nil, fmt.Errorf("insert kb doc: %w", err)
	}
	return s.GetKbDoc(ctx, d.KbID, id)
}

// UpdateKbDoc 改标题、正文、来源地址、排除；正文或标题变了才动 updated_at。
func (s *Store) UpdateKbDoc(ctx context.Context, d *store.KbDoc) (*store.KbDoc, error) {
	cur, err := s.GetKbDoc(ctx, d.KbID, d.ID)
	if err != nil {
		return nil, err
	}
	d.Source.Type = cur.Source.Type
	// 谁加进来的不随修改变（TSK-0721）
	d.Origin, d.OriginKey = cur.Origin, cur.OriginKey
	if err := checkKbDoc(d); err != nil {
		return nil, err
	}
	updated := cur.UpdatedAt.UTC().Format("2006-01-02T15:04:05.000Z")
	if d.Title != cur.Title || d.Text != cur.Text || d.Source.Ref != cur.Source.Ref {
		updated = agentTime()
	}
	if _, err := s.db.W.ExecContext(ctx, `UPDATE kb_docs SET title=?, source_ref=?, text=?, excluded=?, updated_at=? WHERE id=?`,
		d.Title, d.Source.Ref, d.Text, d.Excluded, updated, d.ID); err != nil {
		return nil, fmt.Errorf("update kb doc: %w", err)
	}
	return s.GetKbDoc(ctx, d.KbID, d.ID)
}

func (s *Store) IndexKbDoc(ctx context.Context, docID, status, errMsg string, chunks []store.KbChunk) (*store.KbDoc, error) {
	var kbID string
	if err := s.db.R.QueryRowContext(ctx, `SELECT kb_id FROM kb_docs WHERE id = ?`, docID).Scan(&kbID); err != nil {
		if noRows(err) {
			return nil, notFound("knowledge base doc")
		}
		return nil, fmt.Errorf("get kb doc: %w", err)
	}
	fts := s.kbFTS(ctx)
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if fts {
			if _, err := tx.ExecContext(ctx, `DELETE FROM kb_chunks_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE doc_id = ?)`, docID); err != nil {
				return fmt.Errorf("delete kb fts: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM kb_chunks WHERE doc_id = ?`, docID); err != nil {
			return fmt.Errorf("delete kb chunks: %w", err)
		}
		for _, c := range chunks {
			res, err := tx.ExecContext(ctx, `INSERT INTO kb_chunks (doc_id, idx, start_at, end_at, text) VALUES (?,?,?,?,?)`,
				docID, c.Index, c.Start, c.End, c.Text)
			if err != nil {
				return fmt.Errorf("insert kb chunk: %w", err)
			}
			if fts {
				rowid, _ := res.LastInsertId()
				if _, err := tx.ExecContext(ctx, `INSERT INTO kb_chunks_fts (rowid, tokens) VALUES (?, ?)`, rowid, kb.IndexTokens(c.Text)); err != nil {
					return fmt.Errorf("insert kb fts: %w", err)
				}
			}
		}
		_, err := tx.ExecContext(ctx, `UPDATE kb_docs SET status = ?, error = ?, chunks = ? WHERE id = ?`, status, errMsg, len(chunks), docID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.GetKbDoc(ctx, kbID, docID)
}

func (s *Store) DeleteKbDocs(ctx context.Context, kbID string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	fts := s.kbFTS(ctx)
	args := append([]any{kbID}, anySlice(ids)...)
	return s.withTx(ctx, func(tx *sql.Tx) error {
		if fts {
			if _, err := tx.ExecContext(ctx, `DELETE FROM kb_chunks_fts WHERE rowid IN (SELECT c.id FROM kb_chunks c
				JOIN kb_docs d ON d.id = c.doc_id WHERE d.kb_id = ? AND d.id IN (`+placeholders(len(ids))+`))`, args...); err != nil {
				return fmt.Errorf("delete kb fts: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM kb_docs WHERE kb_id = ? AND id IN (`+placeholders(len(ids))+`)`, args...); err != nil {
			return fmt.Errorf("delete kb docs: %w", err)
		}
		return nil
	})
}

// --- 检索 ---

// kbFTS 确认 FTS5 索引在：第一次用到时建表并把已有切块补进去；SQLite 不支持 FTS5 时回 false，调用方逐块匹配。
func (s *Store) kbFTS(ctx context.Context) bool {
	if kbFTSOff {
		return false
	}
	var n int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'kb_chunks_fts'`).Scan(&n); err == nil && n > 0 {
		return true
	}
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'kb_chunks_fts'`).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
		if _, err := tx.ExecContext(ctx, `CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(tokens, tokenize = "`+kb.FTSTokenize+`")`); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT id, text FROM kb_chunks`)
		if err != nil {
			return err
		}
		type row struct {
			id   int64
			text string
		}
		var all []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.text); err != nil {
				_ = rows.Close()
				return err
			}
			all = append(all, r)
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, r := range all {
			if _, err := tx.ExecContext(ctx, `INSERT INTO kb_chunks_fts (rowid, tokens) VALUES (?, ?)`, r.id, kb.IndexTokens(r.text)); err != nil {
				return err
			}
		}
		return nil
	})
	return err == nil
}

func (s *Store) KbSearchCandidates(ctx context.Context, kbIDs []string, terms []string) ([]*store.KbCandidate, error) {
	out := []*store.KbCandidate{}
	if len(kbIDs) == 0 || len(terms) == 0 {
		return out, nil
	}
	for _, id := range kbIDs {
		base := `SELECT c.doc_id, d.kb_id, d.title, d.source_type, d.source_ref, c.idx, c.start_at, c.end_at, c.text
			FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
			WHERE d.kb_id = ? AND d.status = 'indexed' AND d.excluded = 0`
		order := ` ORDER BY d.created_at DESC, d.rowid DESC, c.idx`
		var rows *sql.Rows
		var err error
		if s.kbFTS(ctx) {
			rows, err = s.db.R.QueryContext(ctx, base+` AND c.id IN (SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?)`+order,
				id, kb.MatchQuery(terms))
		}
		if rows == nil {
			// 没有 FTS5，或查询没过 FTS5 的语法：逐块匹配
			rows, err = s.db.R.QueryContext(ctx, base+order, id)
		}
		if err != nil {
			return nil, fmt.Errorf("kb search: %w", err)
		}
		for rows.Next() {
			var c store.KbCandidate
			if err := rows.Scan(&c.DocID, &c.KbID, &c.Title, &c.Source.Type, &c.Source.Ref, &c.Index, &c.Start, &c.End, &c.Text); err != nil {
				_ = rows.Close()
				return nil, err
			}
			out = append(out, &c)
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}
