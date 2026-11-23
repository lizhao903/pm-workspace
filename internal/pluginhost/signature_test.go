// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
)

func testPublisherKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv, base64.StdEncoding.EncodeToString(pub)
}

func TestVerifyPublisherSignature(t *testing.T) {
	pub, priv, pubB64 := testPublisherKey(t)
	payload := []byte("abc  file.tar.gz\n")
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))
	if err := verifyPublisherSignature(pubB64, sig, payload); err != nil {
		t.Fatalf("签名应通过：%v", err)
	}
	if err := verifyPublisherSignature(pubB64, sig, []byte("tampered")); err == nil {
		t.Fatal("篡改 payload 应失败")
	}
	sig2 := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte("other")))
	if err := verifyPublisherSignature(pubB64, sig2, payload); err == nil {
		t.Fatal("错误签名应失败")
	}
	_ = pub
}

func TestSignedGitHubReleaseVerified(t *testing.T) {
	pub, priv, pubB64 := testPublisherKey(t)
	dir := t.TempDir()
	obj := testManifestObj(platformKey(), "bin/hello_world")
	obj["publisher"] = map[string]any{"id": "github:o", "key": pubB64}
	writeTestPackage(t, dir, obj)
	fx := newGithubFixture(t, dir)
	fx.sigB64 = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(fx.sums)))
	withGithubAPIBase(t, fx.srv.URL)
	h := newTestHost(t, Options{HTTPClient: fx.client()})
	pv, err := h.Resolve(context.Background(), Source{Type: "github", URL: "https://github.com/o/r"})
	if err != nil {
		t.Fatalf("Resolve 签名 Release：%v", err)
	}
	if pv.Tier != "verified" {
		t.Fatalf("验签通过时 preview.Tier 应为 verified：%+v", pv.Tier)
	}
	info, err := h.Install(context.Background(), Source{Type: "github", URL: "https://github.com/o/r"},
		[]string{"objects:read", "notify"})
	if err != nil {
		t.Fatalf("Install：%v", err)
	}
	if info.Tier != "verified" || info.PublisherID != "github:o" {
		t.Fatalf("安装后信任级不对：%+v", info)
	}
	_ = pub
}

func TestSignedReleaseRejectsMissingOrBadSignature(t *testing.T) {
	_, priv, pubB64 := testPublisherKey(t)
	dir := t.TempDir()
	obj := testManifestObj(platformKey(), "bin/hello_world")
	obj["publisher"] = map[string]any{"id": "github:o", "key": pubB64}
	writeTestPackage(t, dir, obj)
	fx := newGithubFixture(t, dir)
	withGithubAPIBase(t, fx.srv.URL)
	h := newTestHost(t, Options{HTTPClient: fx.client()})
	if _, err := h.Resolve(context.Background(), Source{Type: "github", URL: "https://github.com/o/r"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("缺 SHA256SUMS.sig 应拒绝，得到 %v", err)
	}
	fx.sigB64 = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte("wrong bytes")))
	if _, err := h.Resolve(context.Background(), Source{Type: "github", URL: "https://github.com/o/r"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("签名不匹配应拒绝，得到 %v", err)
	}
}

func TestPublisherKeyTOFU(t *testing.T) {
	h := newTestHost(t, Options{})
	ctx := context.Background()
	_, priv, pub1 := testPublisherKey(t)
	m := &Manifest{Publisher: &Publisher{ID: "github:o", Key: pub1}}
	if tier, err := h.trustPublisher(ctx, m, true); err != nil || tier != "verified" {
		t.Fatalf("首次验签应 verified：%v %s", err, tier)
	}
	// 同一 key 再来一次：仍 verified。
	if _, err := h.trustPublisher(ctx, m, true); err != nil {
		t.Fatalf("同 key 重复应通过：%v", err)
	}
	// 换 key：TOFU 拒绝。
	_, _, pub2 := testPublisherKey(t)
	m2 := &Manifest{Publisher: &Publisher{ID: "github:o", Key: pub2}}
	if _, err := h.trustPublisher(ctx, m2, true); !errors.Is(err, ErrConflict) {
		t.Fatalf("换公钥应 ErrConflict，得到 %v", err)
	}
	_ = priv
}
