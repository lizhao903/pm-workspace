package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// client 是工作台 HTTP API 的瘦客户端。
//
// MCP server 一律走 API 而不直连 SQLite：校验规则（状态集、分类与类型同源、
// 字典枚举等）都长在 store 里，直连数据库会把它们全绕过去；而且工作台本身
// 常驻运行，两个进程同时写同一个 SQLite 文件也不安全。
type client struct {
	base string
	hc   *http.Client

	// 类型目录用于把 status key 渲染成人话（进行中(doing)）。它变动极少，
	// 缓存一小段时间，省掉每次列表渲染都多打一次 HTTP。
	mu     sync.Mutex
	cat    *catalog
	catAt  time.Time
	catTTL time.Duration
}

func newClient(base string) *client {
	return &client{
		base:   strings.TrimRight(strings.TrimSpace(base), "/"),
		hc:     &http.Client{Timeout: 20 * time.Second},
		catTTL: 30 * time.Second,
	}
}

// meta 对应列表接口的分页信息。
type meta struct {
	Total  int `json:"total"`
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}

// envelope 是 API 的统一响应信封，成功走 data/meta，失败走 error。
type envelope struct {
	Data  json.RawMessage `json:"data"`
	Meta  *meta           `json:"meta"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// errWorkbenchDown 是「工作台没起」的哨兵错误，文案要可操作——
// 把 connection refused 原样抛给模型，它只会反复重试同一个调用。
var errWorkbenchDown = errors.New("工作台未运行")

func (c *client) downError(cause error) error {
	return fmt.Errorf(`%w：连不上 %s。

工作台没有在运行，或没有监听这个地址。请在项目根目录先把它启动起来：

    make run          # 或者
    ./bin/pmw         # 已构建过二进制的话

确认启动成功（终端会打印「产品工作台已启动: http://127.0.0.1:7777」）后重试本次调用。
若工作台跑在别的端口，请改 .mcp.json 里 pm-workspace 的 --api 参数。

底层错误：%v`, errWorkbenchDown, c.base, cause)
}

// do 发一次请求并解开信封。out 为 nil 时丢弃 data。
func (c *client) do(ctx context.Context, method, path string, query url.Values, body any, out any) (*meta, error) {
	u := c.base + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}

	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("序列化请求体失败: %w", err)
		}
		rdr = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// 让变更历史能区分出「这条是 Agent 改的」。白名单见 internal/api/params.go。
	req.Header.Set("X-Actor-Source", "agent")

	resp, err := c.hc.Do(req)
	if err != nil {
		if errors.Is(err, syscall.ECONNREFUSED) || isDialError(err) {
			return nil, c.downError(err)
		}
		return nil, fmt.Errorf("请求 %s %s 失败: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("读取响应失败: %w", err)
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("工作台返回了非 JSON 响应（HTTP %d）：%s", resp.StatusCode, snippet(raw))
	}
	if env.Error != nil {
		// 把 API 的原始 message 原样带出去：它已经写明是哪个字段/哪个取值不合法，
		// 模型照着改就能自愈，重新包装反而丢信息。
		return nil, fmt.Errorf("工作台拒绝了这次请求（%s）：%s", env.Error.Code, env.Error.Message)
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("工作台返回 HTTP %d：%s", resp.StatusCode, snippet(raw))
	}
	if out != nil && len(env.Data) > 0 {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return nil, fmt.Errorf("解析响应数据失败: %w", err)
		}
	}
	return env.Meta, nil
}

// isDialError 兜住「拨号阶段就失败」的各种形态（连接被拒、地址不可达、DNS 解析失败）。
func isDialError(err error) bool {
	s := err.Error()
	return strings.Contains(s, "connection refused") ||
		strings.Contains(s, "no such host") ||
		strings.Contains(s, "connect: ")
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

// --- 具体端点 ---

func (c *client) listObjects(ctx context.Context, q url.Values) ([]*domain.Object, *meta, error) {
	var items []*domain.Object
	m, err := c.do(ctx, http.MethodGet, "/api/objects", q, nil, &items)
	return items, m, err
}

func (c *client) getObject(ctx context.Context, id string) (*domain.Object, error) {
	var o domain.Object
	if _, err := c.do(ctx, http.MethodGet, "/api/objects/"+url.PathEscape(id), nil, nil, &o); err != nil {
		return nil, err
	}
	return &o, nil
}

func (c *client) createObject(ctx context.Context, body map[string]any) (*domain.Object, error) {
	var o domain.Object
	if _, err := c.do(ctx, http.MethodPost, "/api/objects", nil, body, &o); err != nil {
		return nil, err
	}
	return &o, nil
}

func (c *client) updateObject(ctx context.Context, id string, patch map[string]any) (*domain.Object, error) {
	var o domain.Object
	if _, err := c.do(ctx, http.MethodPatch, "/api/objects/"+url.PathEscape(id), nil, patch, &o); err != nil {
		return nil, err
	}
	return &o, nil
}

func (c *client) createLink(ctx context.Context, fromID string, body map[string]any) (*domain.LinkView, error) {
	var lv domain.LinkView
	path := "/api/objects/" + url.PathEscape(fromID) + "/links"
	if _, err := c.do(ctx, http.MethodPost, path, nil, body, &lv); err != nil {
		return nil, err
	}
	return &lv, nil
}

func (c *client) listObjectTypes(ctx context.Context) ([]*domain.ObjectType, error) {
	var items []*domain.ObjectType
	_, err := c.do(ctx, http.MethodGet, "/api/object-types", nil, nil, &items)
	return items, err
}

func (c *client) listStakeholders(ctx context.Context) ([]*domain.Stakeholder, error) {
	var items []*domain.Stakeholder
	_, err := c.do(ctx, http.MethodGet, "/api/stakeholders", nil, nil, &items)
	return items, err
}

// resolveStakeholder 把人名换成干系人 id。
//
// MCP 这层收人名而不是 id，是因为调用方是模型：它手上有「李钊」，没有 stk_xxx，
// 强行要 id 只会逼出「先查一次再调一次」的两步，而中间那步经常被省掉。
//
// 找不到时必须**报错**，不能返回空 id 静默放行。owner_id 传空串的语义是「清空负责人」——
// 把一个打错的名字变成「清空」，结果是把别人的负责人抹掉，而调用方以为改成功了。
func (c *client) resolveStakeholder(ctx context.Context, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", nil // 空串是合法的「清空负责人」
	}
	people, err := c.listStakeholders(ctx)
	if err != nil {
		return "", err
	}
	names := make([]string, 0, len(people))
	for _, p := range people {
		if p.Name == name {
			return p.ID, nil
		}
		names = append(names, p.Name)
	}
	if len(names) == 0 {
		return "", fmt.Errorf("干系人名册还是空的，没有叫「%s」的人。先在工作台的「设置 → 干系人」里把人建出来", name)
	}
	sort.Strings(names)
	return "", fmt.Errorf("没有叫「%s」的干系人。现有：%s。名字要完全一致（不做模糊匹配——匹配错人意味着任务派给了别人）",
		name, strings.Join(names, "、"))
}

func (c *client) listDictionaries(ctx context.Context) ([]*domain.Dictionary, error) {
	var items []*domain.Dictionary
	q := url.Values{"with_items": {"true"}}
	_, err := c.do(ctx, http.MethodGet, "/api/dictionaries", q, nil, &items)
	return items, err
}

func (c *client) categoryTree(ctx context.Context, typeID string) ([]*domain.Category, error) {
	q := url.Values{"tree": {"true"}, "counts": {"true"}}
	if typeID != "" {
		q.Set("type", typeID)
	}
	var items []*domain.Category
	_, err := c.do(ctx, http.MethodGet, "/api/categories", q, nil, &items)
	return items, err
}

func (c *client) counts(ctx context.Context, typeID string) (*domain.Counts, error) {
	q := url.Values{}
	if typeID != "" {
		q.Set("type", typeID)
	}
	var out domain.Counts
	if _, err := c.do(ctx, http.MethodGet, "/api/counts", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *client) recentRevisions(ctx context.Context, limit int) ([]*domain.Revision, error) {
	q := url.Values{"limit": {fmt.Sprint(limit)}}
	var items []*domain.Revision
	_, err := c.do(ctx, http.MethodGet, "/api/revisions", q, nil, &items)
	return items, err
}

func (c *client) objectRevisions(ctx context.Context, objectID string, limit int) ([]*domain.Revision, error) {
	q := url.Values{"limit": {fmt.Sprint(limit)}}
	path := "/api/objects/" + url.PathEscape(objectID) + "/revisions"
	var items []*domain.Revision
	_, err := c.do(ctx, http.MethodGet, path, q, nil, &items)
	return items, err
}
