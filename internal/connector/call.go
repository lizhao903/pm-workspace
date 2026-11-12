// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// --- Agent 调用连接器工具（AG-02a）。授权（Agent 的和实例上的）由调用方先算好，这里只管调 ---

// ErrNotCallable：定义没实现 Call，工具只有目录、还不能真的调。
var ErrNotCallable = errors.New("这个连接器的工具还不能调用")

// CallTool 调实例上的一个工具，回对方给的结果文本。暂停、断开、定义不在了、工具不在清单里回 409；
// 定义没实现 Call 回 ErrNotCallable。对方的错误里出现凭证原文时换成 ***。
func (s *Store) CallTool(ctx context.Context, id, tool string, args json.RawMessage) (string, error) {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return "", err
	}
	switch cur.Status {
	case StatusPaused:
		return "", conflict("连接器「%s」已暂停", cur.Name)
	case StatusDisconnected:
		return "", conflict("连接器「%s」已断开", cur.Name)
	}
	found := false
	for _, t := range cur.Tools {
		found = found || t.Name == tool
	}
	if !found {
		return "", conflict("连接器「%s」没有工具 %s，先重新拉取工具清单", cur.Name, tool)
	}
	d, cfg, err := s.callConfig(ctx, cur)
	if err != nil {
		return "", err
	}
	if d.Call == nil {
		return "", ErrNotCallable
	}
	if len(strings.TrimSpace(string(args))) == 0 {
		args = json.RawMessage("{}")
	}
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	out, err := d.Call(cctx, cfg, tool, args)
	if err != nil {
		return "", errors.New(scrub(err.Error(), cfg.secrets))
	}
	return out, nil
}
