// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 插件 → 宿主 broker（brief §4，docs/plugin-spec-v2.md 7.5）。
// 未声明/未授予的权限一律 permission_denied(-32001) 并带 data；未知方法 method_not_found。

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// handleHostCall 处理插件发来的 host.* 请求；把它交给 rpcConn 当 handler。
func (p *pluginProcess) handleHostCall(ctx context.Context, method string, params json.RawMessage) (any, error) {
	p.host.log.Debug("插件调用宿主", "plugin", p.id, "method", method)
	switch method {
	case "host.store.query":
		return p.storeQuery(ctx, params)
	case "host.store.exec":
		return p.storeExec(ctx, params)
	case "host.objects.list":
		return p.objectsList(ctx, params)
	case "host.objects.get":
		return p.objectsGet(ctx, params)
	case "host.settings.get":
		return p.settingsGet(ctx, params)
	case "host.settings.set":
		return p.settingsSet(ctx, params)
	case "host.notify":
		return p.notify(ctx, params)
	case "host.events.publish":
		return p.eventsPublish(ctx, params)
	case "host.http.chunk":
		return p.host.handleHTTPChunk(p.id, params)
	case "host.http.end":
		return p.host.handleHTTPEnd(p.id, params)
	case "host.ws.send":
		return p.host.handleWSSend(p.id, params)
	case "host.ws.close":
		return p.host.handleWSClose(p.id, params)
	case "host.http.request":
		return p.httpRequest(ctx, params)
	case "host.agent.run":
		return p.agentRun(ctx, params)
	case "host.secrets.get":
		return p.secretsGet(ctx, params)
	case "host.secrets.set":
		return p.secretsSet(ctx, params)
	case "host.secrets.delete":
		return p.secretsDelete(ctx, params)
	default:
		return nil, rpcErrorf("method_not_found", "宿主未实现方法 %s", method)
	}
}

// requirePermission 检查清单声明 + 用户授予；不满足回 permission_denied（spec 5.5）。
func (p *pluginProcess) requirePermission(name string) *rpcError {
	declared := containsString(p.manifest.Permissions, name)
	granted := p.hasGranted(name)
	if declared && granted {
		return nil
	}
	return &rpcError{
		Code:    rpcErrorCodes["permission_denied"],
		Message: "插件没有权限 " + name + "（未声明或用户尚未授予）",
		Data: map[string]any{
			"permission": name,
			"declared":   declared,
			"granted":    granted,
		},
	}
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// storeParams 是 host.store.* 的参数。
type storeParams struct {
	SQL  string `json:"sql"`
	Args []any  `json:"args"`
}

func decodeStoreParams(params json.RawMessage) (*storeParams, error) {
	var p storeParams
	dec := json.NewDecoder(bytes.NewReader(params))
	dec.UseNumber()
	if err := dec.Decode(&p); err != nil {
		return nil, rpcErrorf("invalid_params", "host.store 参数不是合法 JSON：%v", err)
	}
	return &p, nil
}

// brokerArgs 把 JSON 参数规整成 database/sql 可用的值。
func brokerArgs(args []any) ([]any, error) {
	out := make([]any, 0, len(args))
	for _, a := range args {
		switch v := a.(type) {
		case json.Number:
			if i, err := v.Int64(); err == nil {
				out = append(out, i)
				continue
			}
			f, err := v.Float64()
			if err != nil {
				return nil, rpcErrorf("validation", "SQL 参数不是合法数字：%v", v)
			}
			out = append(out, f)
		case string, bool, nil:
			out = append(out, v)
		default:
			return nil, rpcErrorf("validation", "SQL 参数只支持字符串/数字/布尔/null")
		}
	}
	return out, nil
}

// stripSQLComments 去掉 SQL 注释（-- 与 /* */），保留字符串/标识符原文。
// 返回去掉注释后的 SQL；注释里的关键字不能用来骗过关键字黑名单。
func stripSQLComments(raw string) (string, error) {
	var out strings.Builder
	quote := byte(0)
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if quote != 0 {
			out.WriteByte(c)
			if c == quote {
				// SQL 字符串里的 '' 是转义，不结束字符串。
				if quote == '\'' && i+1 < len(raw) && raw[i+1] == '\'' {
					out.WriteByte(raw[i+1])
					i++
					continue
				}
				quote = 0
			}
			continue
		}
		switch {
		case c == '\'' || c == '"' || c == '`':
			quote = c
			out.WriteByte(c)
		case c == '[':
			// [identifier]：原样保留到 ]。
			out.WriteByte(c)
			for i++; i < len(raw) && raw[i] != ']'; i++ {
				out.WriteByte(raw[i])
			}
			if i < len(raw) {
				out.WriteByte(']')
			}
		case c == '-' && i+1 < len(raw) && raw[i+1] == '-':
			for i < len(raw) && raw[i] != '\n' {
				i++
			}
			out.WriteByte(' ')
		case c == '/' && i+1 < len(raw) && raw[i+1] == '*':
			i += 2
			for i+1 < len(raw) && !(raw[i] == '*' && raw[i+1] == '/') {
				i++
			}
			i++
			out.WriteByte(' ')
		default:
			out.WriteByte(c)
		}
	}
	if quote != 0 {
		return "", rpcErrorf("validation", "SQL 字符串/标识符没有闭合")
	}
	return strings.TrimSpace(out.String()), nil
}

// sqlTokens 把去注释后的 SQL 按非字母数字下划线切词并大写，供关键字黑名单检查。
// 字符串/标识符内部不参与切词（否则 \'ATTACH\' 这种值会被误判）。
func sqlTokens(raw string) []string {
	var tokens []string
	var cur strings.Builder
	quote := byte(0)
	flush := func() {
		if cur.Len() > 0 {
			tokens = append(tokens, strings.ToUpper(cur.String()))
			cur.Reset()
		}
	}
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if quote != 0 {
			if c == quote {
				if quote == '\'' && i+1 < len(raw) && raw[i+1] == '\'' {
					i++
					continue
				}
				quote = 0
			}
			continue
		}
		switch {
		case c == '\'' || c == '"' || c == '`':
			flush()
			quote = c
		case c == '[':
			flush()
			for i++; i < len(raw) && raw[i] != ']'; i++ {
			}
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_':
			cur.WriteByte(c)
		default:
			flush()
		}
	}
	flush()
	return tokens
}

// normalizeSQL 校验 SQL：单条语句、关键字黑名单（去注释后判断）。
func normalizeSQL(raw string) (string, []string, error) {
	trimmed := strings.TrimSpace(raw)
	// 兼容一条语句后跟分号；中间再出现分号一律当多语句拒绝。
	for strings.HasSuffix(trimmed, ";") {
		trimmed = strings.TrimSpace(strings.TrimSuffix(trimmed, ";"))
	}
	if trimmed == "" {
		return "", nil, rpcErrorf("validation", "SQL 不能为空")
	}
	cleaned, err := stripSQLComments(trimmed)
	if err != nil {
		return "", nil, err
	}
	if strings.Contains(cleaned, ";") {
		return "", nil, rpcErrorf("validation", "一次只允许执行一条 SQL 语句")
	}
	tokens := sqlTokens(cleaned)
	if len(tokens) == 0 {
		return "", nil, rpcErrorf("validation", "无法识别 SQL 语句")
	}
	return cleaned, tokens, nil
}

func hasToken(tokens []string, words ...string) bool {
	for _, t := range tokens {
		for _, w := range words {
			if t == w {
				return true
			}
		}
	}
	return false
}

// readOnlyKeywords 是 host.store.query 允许的语句开头。
var readOnlyKeywords = map[string]bool{
	"SELECT": true, "WITH": true, "EXPLAIN": true, "VALUES": true,
}

// forbiddenAnywhere 是 query/exec 都不允许出现的关键字（DDL / ATTACH / 事务 / 危险 pragma）。
var forbiddenAnywhere = []string{
	"ATTACH", "DETACH", "PRAGMA", "CREATE", "DROP", "ALTER", "VACUUM", "REINDEX",
	"BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "ANALYZE", "LOAD",
}

// queryForbidden 是只读查询里额外禁止的写关键字（防 WITH ... DELETE/INSERT 绕过）。
var queryForbidden = []string{"INSERT", "UPDATE", "DELETE", "REPLACE", "TRUNCATE", "UPSERT"}

// execAllowedKeywords 是 host.store.exec 允许的语句开头（只做 DML）。
var execAllowedKeywords = map[string]bool{
	"INSERT": true, "UPDATE": true, "DELETE": true, "REPLACE": true,
}

func (p *pluginProcess) brokerDBErr() error {
	if p.db == nil {
		return rpcErrorf("unavailable", "插件私有库不可用")
	}
	return nil
}

func (p *pluginProcess) storeQuery(ctx context.Context, params json.RawMessage) (any, error) {
	if err := p.brokerDBErr(); err != nil {
		return nil, err
	}
	in, rerr := decodeStoreParams(params)
	if rerr != nil {
		return nil, rerr
	}
	sqlText, tokens, rerr := normalizeSQL(in.SQL)
	if rerr != nil {
		return nil, rerr
	}
	if !readOnlyKeywords[tokens[0]] {
		return nil, rpcErrorf("validation", "host.store.query 只允许只读查询（收到 %s）", tokens[0])
	}
	if hasToken(tokens, forbiddenAnywhere...) || hasToken(tokens, queryForbidden...) {
		return nil, rpcErrorf("validation", "host.store.query 不允许 DDL/ATTACH/事务/写操作")
	}
	args, rerr := brokerArgs(in.Args)
	if rerr != nil {
		return nil, rerr
	}
	rows, err := p.db.R.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, rpcErrorf("validation", "查询失败：%v", err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, rpcErrorf("internal", "读取列名失败：%v", err)
	}
	items := make([]map[string]any, 0, 16)
	for rows.Next() {
		if len(items) >= 10000 {
			return nil, rpcErrorf("validation", "查询结果超过 10000 行")
		}
		values := make([]any, len(columns))
		ptrs := make([]any, len(columns))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, rpcErrorf("internal", "读取查询结果失败：%v", err)
		}
		item := make(map[string]any, len(columns))
		for i, c := range columns {
			item[c] = normalizeSQLValue(values[i])
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, rpcErrorf("internal", "遍历查询结果失败：%v", err)
	}
	return map[string]any{"columns": columns, "rows": items}, nil
}

func normalizeSQLValue(v any) any {
	switch v := v.(type) {
	case []byte:
		return string(v)
	case time.Time:
		return v.UTC().Format(time.RFC3339)
	default:
		return v
	}
}

func (p *pluginProcess) storeExec(ctx context.Context, params json.RawMessage) (any, error) {
	if err := p.brokerDBErr(); err != nil {
		return nil, err
	}
	in, rerr := decodeStoreParams(params)
	if rerr != nil {
		return nil, rerr
	}
	sqlText, tokens, rerr := normalizeSQL(in.SQL)
	if rerr != nil {
		return nil, rerr
	}
	if !execAllowedKeywords[tokens[0]] {
		return nil, rpcErrorf("validation", "host.store.exec 只允许 INSERT/UPDATE/DELETE/REPLACE（收到 %s；DDL/事务/ATTACH 请走包内 migrations）", tokens[0])
	}
	if hasToken(tokens, forbiddenAnywhere...) {
		return nil, rpcErrorf("validation", "host.store.exec 不允许 DDL/ATTACH/事务等关键字")
	}
	args, rerr := brokerArgs(in.Args)
	if rerr != nil {
		return nil, rerr
	}
	res, err := p.db.W.ExecContext(ctx, sqlText, args...)
	if err != nil {
		return nil, rpcErrorf("validation", "执行失败：%v", err)
	}
	affected, _ := res.RowsAffected()
	lastID, _ := res.LastInsertId()
	return map[string]any{"rows_affected": affected, "last_insert_id": lastID}, nil
}

func (p *pluginProcess) kernelDBErr() error {
	if p.host.opts.DB == nil {
		return rpcErrorf("unavailable", "宿主未配置内核库")
	}
	return nil
}

func (p *pluginProcess) objectsList(ctx context.Context, params json.RawMessage) (any, error) {
	if rerr := p.requirePermission("objects:read"); rerr != nil {
		return nil, rerr
	}
	if err := p.kernelDBErr(); err != nil {
		return nil, err
	}
	var in struct {
		Limit int `json:"limit"`
	}
	if len(params) > 0 {
		_ = json.Unmarshal(params, &in)
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	rows, err := p.host.opts.DB.R.QueryContext(ctx, `
		SELECT id, type_id, title FROM objects
		WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, rpcErrorf("internal", "读取对象失败：%v", err)
	}
	defer rows.Close()
	items := make([]map[string]any, 0, limit)
	for rows.Next() {
		var id, typ, title string
		if err := rows.Scan(&id, &typ, &title); err != nil {
			return nil, rpcErrorf("internal", "读取对象失败：%v", err)
		}
		items = append(items, map[string]any{"id": id, "type": typ, "title": title})
	}
	if err := rows.Err(); err != nil {
		return nil, rpcErrorf("internal", "读取对象失败：%v", err)
	}
	return map[string]any{"items": items}, nil
}

func (p *pluginProcess) objectsGet(ctx context.Context, params json.RawMessage) (any, error) {
	if rerr := p.requirePermission("objects:read"); rerr != nil {
		return nil, rerr
	}
	if err := p.kernelDBErr(); err != nil {
		return nil, err
	}
	var in struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(params, &in); err != nil || strings.TrimSpace(in.ID) == "" {
		return nil, rpcErrorf("invalid_params", "host.objects.get 需要 id")
	}
	var (
		id, typ, title, status, priority, propsJSON string
		createdAt, updatedAt                        string
	)
	err := p.host.opts.DB.R.QueryRowContext(ctx, `
		SELECT id, type_id, title, status, priority, props, created_at, updated_at
		FROM objects WHERE id = ? AND deleted_at IS NULL`, in.ID).
		Scan(&id, &typ, &title, &status, &priority, &propsJSON, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, rpcErrorf("not_found", "对象 %s 不存在", in.ID)
	}
	if err != nil {
		return nil, rpcErrorf("internal", "读取对象失败：%v", err)
	}
	var props any = map[string]any{}
	if propsJSON != "" {
		_ = json.Unmarshal([]byte(propsJSON), &props)
	}
	return map[string]any{
		"id": id, "type": typ, "title": title, "status": status,
		"priority": priority, "props": props,
		"created_at": createdAt, "updated_at": updatedAt,
	}, nil
}

// settingsGet 读插件自己的设置（隐式权限，天然隔离）。
func (p *pluginProcess) settingsGet(ctx context.Context, params json.RawMessage) (any, error) {
	if err := p.brokerDBErr(); err != nil {
		return nil, err
	}
	var in struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(params, &in); err != nil || strings.TrimSpace(in.Key) == "" {
		return nil, rpcErrorf("invalid_params", "host.settings.get 需要 key")
	}
	var raw string
	err := p.db.R.QueryRowContext(ctx,
		`SELECT value FROM `+settingsTable+` WHERE key = ?`, in.Key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return map[string]any{"value": nil}, nil
	}
	if err != nil {
		return nil, rpcErrorf("internal", "读取设置失败：%v", err)
	}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return map[string]any{"value": raw}, nil
	}
	return map[string]any{"value": value}, nil
}

func (p *pluginProcess) settingsSet(ctx context.Context, params json.RawMessage) (any, error) {
	if err := p.brokerDBErr(); err != nil {
		return nil, err
	}
	var in struct {
		Key   string `json:"key"`
		Value any    `json:"value"`
	}
	if err := json.Unmarshal(params, &in); err != nil || strings.TrimSpace(in.Key) == "" {
		return nil, rpcErrorf("invalid_params", "host.settings.set 需要 key")
	}
	if len(in.Key) > 128 {
		return nil, rpcErrorf("validation", "设置 key 过长")
	}
	raw, err := json.Marshal(in.Value)
	if err != nil {
		return nil, rpcErrorf("validation", "设置 value 不是合法 JSON：%v", err)
	}
	_, err = p.db.W.ExecContext(ctx, `
		INSERT INTO `+settingsTable+` (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, in.Key, string(raw))
	if err != nil {
		return nil, rpcErrorf("internal", "保存设置失败：%v", err)
	}
	return map[string]any{"ok": true}, nil
}

func (p *pluginProcess) notify(ctx context.Context, params json.RawMessage) (any, error) {
	if rerr := p.requirePermission("notify"); rerr != nil {
		return nil, rerr
	}
	var in struct {
		Level string `json:"level"`
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return nil, rpcErrorf("invalid_params", "host.notify 参数不是合法 JSON：%v", err)
	}
	in.Title = strings.TrimSpace(in.Title)
	in.Body = strings.TrimSpace(in.Body)
	if in.Title == "" && in.Body == "" {
		return nil, rpcErrorf("invalid_params", "host.notify 需要 title 或 body")
	}
	if p.host.opts.Notifier == nil {
		return nil, rpcErrorf("unavailable", "宿主未配置通知能力")
	}
	if err := p.host.opts.Notifier.Notify(ctx, p.id, in.Title, in.Body); err != nil {
		return nil, rpcErrorf("internal", "发送通知失败：%v", err)
	}
	return map[string]any{"ok": true}, nil
}

// nowUTC 抽出来方便测试（当前实现直接取系统时间）。
var nowUTC = func() time.Time { return time.Now().UTC() }

// FrontendCall 让插件前端（浏览器里的 ctx.host.call）触发同一套 broker 能力。
// 方向与 handleHostCall 相同（插件 → 宿主），但发起方是可信的宿主前端；权限仍按
// 「清单声明 + 用户授予」逐项校验，前端绕不过去。P1-a 只放行只读对象、插件设置与通知。
func (h *Host) FrontendCall(ctx context.Context, id, method string, params json.RawMessage) (json.RawMessage, error) {
	p := h.lookupProc(id)
	if p == nil {
		return nil, wrap(ErrNotRunning, "插件 %s 未运行", id)
	}
	out, err := p.handleHostCall(ctx, method, params)
	if err != nil {
		var re *rpcError
		if errors.As(err, &re) {
			switch re.Code {
			case rpcErrorCodes["permission_denied"]:
				return nil, wrap(ErrPermission, "%s", re.Message)
			case rpcErrorCodes["not_found"]:
				return nil, wrap(ErrNotFound, "%s", re.Message)
			case rpcErrorCodes["validation"], rpcErrorCodes["method_not_found"], rpcErrorCodes["invalid_params"]:
				return nil, wrap(ErrValidation, "%s", re.Message)
			}
		}
		return nil, err
	}
	data, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	return data, nil
}
