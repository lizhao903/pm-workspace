// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 发布者签名与 TOFU（P2，docs/plugin-spec-v2.md 10.2/10.3）：
//   - 清单 publisher.key 是 ed25519 公钥（raw 32 字节 base64）；Release 的 SHA256SUMS.sig
//     是发布者私钥对 SHA256SUMS 原始字节的签名（base64 单行）；
//   - GitHub 来源：有 publisher.key 就必须有合法签名，否则拒绝安装；验签通过记 verified；
//   - TOFU：第一次见到的「publisher.id -> 公钥」写入 plugin_publisher_keys，之后换 key 拒绝，
//     需要用户显式清理（P2 暂不提供 UI，文档写清命令/流程）。

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const publisherKeysTable = "plugin_publisher_keys"

// verifyPublisherSignature 校验 ed25519 签名（sig 是 base64 原始 64 字节）。
func verifyPublisherSignature(pubB64, sigB64 string, payload []byte) error {
	pubRaw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(pubB64))
	if err != nil || len(pubRaw) != ed25519.PublicKeySize {
		return wrap(ErrValidation, "publisher.key 不是合法 ed25519 公钥（base64 32 字节）")
	}
	sigRaw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sigB64))
	if err != nil || len(sigRaw) != ed25519.SignatureSize {
		return wrap(ErrValidation, "SHA256SUMS.sig 不是合法 ed25519 签名（base64 64 字节）")
	}
	if !ed25519.Verify(ed25519.PublicKey(pubRaw), payload, sigRaw) {
		return wrap(ErrValidation, "发布者签名校验失败：SHA256SUMS 与 publisher.key 不匹配")
	}
	return nil
}

func publisherFingerprint(pubB64 string) string {
	raw, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(pubB64))
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// trustPublisher 计算信任级并在验签通过时做 TOFU 绑定。
// verified=false 且清单带 key 时返回 community（本地目录/离线包无法证明签名来源）。
func (h *Host) trustPublisher(ctx context.Context, m *Manifest, verified bool) (string, error) {
	if m.Publisher == nil || strings.TrimSpace(m.Publisher.Key) == "" {
		return "community", nil
	}
	if !verified {
		return "community", nil
	}
	if err := h.ensurePublisherKeysTable(ctx); err != nil {
		return "", err
	}
	fp := publisherFingerprint(m.Publisher.Key)
	var oldKey string
	err := h.opts.DB.R.QueryRowContext(ctx,
		`SELECT public_key FROM `+publisherKeysTable+` WHERE publisher_id = ?`, m.Publisher.ID).Scan(&oldKey)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		now := nowUTC()
		_, err = h.opts.DB.W.ExecContext(ctx,
			`INSERT INTO `+publisherKeysTable+` (publisher_id, public_key, fingerprint, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`,
			m.Publisher.ID, m.Publisher.Key, fp, formatStateTime(now), formatStateTime(now))
		if err != nil {
			return "", fmt.Errorf("记录发布者公钥失败：%w", err)
		}
	case err != nil:
		return "", fmt.Errorf("读取发布者公钥失败：%w", err)
	case oldKey != m.Publisher.Key:
		return "", wrap(ErrConflict,
			"发布者 %s 的公钥变了（旧 %s，新 %s）。这可能是密钥轮换也可能是冒充；确认来源后清理 %s 里该发布者记录再安装",
			m.Publisher.ID, publisherFingerprint(oldKey), fp, publisherKeysTable)
	default:
		_, _ = h.opts.DB.W.ExecContext(ctx,
			`UPDATE `+publisherKeysTable+` SET last_seen = ? WHERE publisher_id = ?`,
			formatStateTime(nowUTC()), m.Publisher.ID)
	}
	return "verified", nil
}

// ensurePublisherKeysTable 兼容测试/旧库：迁移 0061 会建表，这里再兜底一次。
func (h *Host) ensurePublisherKeysTable(ctx context.Context) error {
	if h.opts.DB == nil {
		return wrap(ErrValidation, "宿主未配置状态库")
	}
	_, err := h.opts.DB.W.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS `+publisherKeysTable+` (
			publisher_id TEXT PRIMARY KEY,
			public_key   TEXT NOT NULL,
			fingerprint  TEXT NOT NULL,
			first_seen   TEXT NOT NULL,
			last_seen    TEXT NOT NULL
		)`)
	if err != nil {
		return fmt.Errorf("初始化发布者公钥表失败：%w", err)
	}
	return nil
}

func publisherIDOf(m *Manifest) string {
	if m.Publisher == nil {
		return ""
	}
	return m.Publisher.ID
}
