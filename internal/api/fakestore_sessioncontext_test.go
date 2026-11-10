// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// SetAgentSessionInstruction 是 S-2（0057）的会话追加要求写入口。
// 和 sqlite 一样去首尾空白、不存在的会话回 ErrNotFound；不进 store.Store 接口，
// 所以单独在这个文件里给替身补上，不动 fakestore_test.go。
func (f *fakeStore) SetAgentSessionInstruction(_ context.Context, id, instruction string) (*domain.AgentSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sess, ok := f.sessions[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	sess.Instruction = strings.TrimSpace(instruction)
	sess.UpdatedAt = time.Now()
	c := f.effectiveSession(sess)
	c.MessageCount = len(f.messages[id])
	return c, nil
}
