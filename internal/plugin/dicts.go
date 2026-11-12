// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
)

// 插件只读查内核枚举字典的条目（TSK-0718）：项目插件按「项目干系人角色」字典校验 role。
// 写字典走内核接口（设置 / 枚举值），插件不改。

// DictItemInfo 是字典里的一条；停用的 Archived 为 true。
type DictItemInfo struct {
	Key      string
	Label    string
	Archived bool
	// Default 是 meta.default 为 true 的条目（新建时的默认值）。
	Default bool
}

// DictReader 只读查字典条目。Item 没有这条（或字典不存在）返回 ErrNoRows；Items 按 sort_order，含停用的。
type DictReader interface {
	Item(ctx context.Context, dictID, key string) (DictItemInfo, error)
	Items(ctx context.Context, dictID string) ([]DictItemInfo, error)
}

func (c *core) Dicts() DictReader { return dictReader{c} }

type dictReader struct{ c *core }

const dictItemCols = `key, label, archived_at IS NOT NULL, IFNULL(json_extract(meta, '$.default'), 0) = 1`

func (r dictReader) Item(ctx context.Context, dictID, key string) (DictItemInfo, error) {
	d := r.c.db()
	if d == nil {
		return DictItemInfo{}, ErrNoStore
	}
	var it DictItemInfo
	err := d.R.QueryRowContext(ctx, `SELECT `+dictItemCols+` FROM dict_items
		WHERE dict_id = ? AND type_id IS NULL AND key = ?`, dictID, key).Scan(&it.Key, &it.Label, &it.Archived, &it.Default)
	if err != nil {
		return DictItemInfo{}, err
	}
	return it, nil
}

func (r dictReader) Items(ctx context.Context, dictID string) ([]DictItemInfo, error) {
	d := r.c.db()
	if d == nil {
		return nil, ErrNoStore
	}
	rows, err := d.R.QueryContext(ctx, `SELECT `+dictItemCols+` FROM dict_items
		WHERE dict_id = ? AND type_id IS NULL ORDER BY sort_order, key`, dictID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []DictItemInfo
	for rows.Next() {
		var it DictItemInfo
		if err := rows.Scan(&it.Key, &it.Label, &it.Archived, &it.Default); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}
