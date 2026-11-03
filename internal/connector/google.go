package connector

// Google 连接器共用的部分（CONN-01e1）：OAuth 配置、连通测试（取账号邮箱）、带令牌请求 Google API。
// Drive 见 google_drive.go，日历归 CONN-01e2。client_id、client_secret 由用户在设置页填，不内置。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// GoogleEndpoints 是 Google 的几个地址。正式登记用零值（全部取默认），测试换成本机假服务的地址。
type GoogleEndpoints struct {
	AuthURL     string // 授权地址
	TokenURL    string // 令牌地址
	UserInfoURL string // OpenID userinfo，连通测试取邮箱
	DriveAPI    string // Drive v3 的根，不带末尾 /
}

// 正式的 Google 地址
const (
	googleAuthURL     = "https://accounts.google.com/o/oauth2/v2/auth"
	googleTokenURL    = "https://oauth2.googleapis.com/token"
	googleUserInfoURL = "https://openidconnect.googleapis.com/v1/userinfo"
	googleDriveAPI    = "https://www.googleapis.com/drive/v3"

	maxGoogleBody = 4 << 20
)

func (e GoogleEndpoints) withDefaults() GoogleEndpoints {
	if e.AuthURL == "" {
		e.AuthURL = googleAuthURL
	}
	if e.TokenURL == "" {
		e.TokenURL = googleTokenURL
	}
	if e.UserInfoURL == "" {
		e.UserInfoURL = googleUserInfoURL
	}
	if e.DriveAPI == "" {
		e.DriveAPI = googleDriveAPI
	}
	e.DriveAPI = strings.TrimRight(e.DriveAPI, "/")
	return e
}

// googleFields 是 Google 连接器共用的配置字段：OAuth 客户端（Web 应用）的 client_id 和 client_secret。
func googleFields() []Field {
	return []Field{
		{Key: "client_id", Label: "Client ID", Kind: "text", Placeholder: "xxxx.apps.googleusercontent.com", Required: true},
		{Key: "client_secret", Label: "Client Secret", Kind: "secret", Required: true},
	}
}

// googleOAuth 是 Google 的 OAuth 配置：openid email 加各自的范围；
// access_type=offline 才会发 refresh_token，prompt=consent 让重新授权时也再发一次。
func googleOAuth(e GoogleEndpoints, scopes ...string) *OAuthSpec {
	return &OAuthSpec{AuthURL: e.AuthURL, TokenURL: e.TokenURL,
		Scopes:        append([]string{"openid", "email"}, scopes...),
		ClientIDField: "client_id", ClientSecretField: "client_secret",
		AuthParams: map[string]string{"access_type": "offline", "prompt": "consent"}}
}

// googleTest 是连通测试：带 access_token 请求 userinfo，账号取邮箱。
func googleTest(e GoogleEndpoints) func(ctx context.Context, cfg Config) (string, error) {
	return func(ctx context.Context, cfg Config) (string, error) {
		var out struct {
			Email string `json:"email"`
		}
		if err := googleGet(ctx, cfg, e.UserInfoURL, nil, &out); err != nil {
			return "", fmt.Errorf("userinfo: %w", err)
		}
		if out.Email == "" {
			return "", errors.New("userinfo 没有返回邮箱，授权时要同意 email 范围")
		}
		return out.Email, nil
	}
}

// googleGet 带令牌 GET 一个 Google 接口，按 JSON 解码进 out。
func googleGet(ctx context.Context, cfg Config, rawURL string, q url.Values, out any) error {
	_, err := googleFetch(ctx, cfg, rawURL, q, out)
	return err
}

// googleFetch 带令牌 GET 一个 Google 接口，回原文（最多 maxGoogleBody），out 非 nil 时顺带按 JSON 解码。
// 错误只带状态码和对方的说明，不带请求头。
func googleFetch(ctx context.Context, cfg Config, rawURL string, q url.Values, out any) ([]byte, error) {
	if len(q) > 0 {
		rawURL += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.AccessToken())
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxGoogleBody+1))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("Google 返回 %d：%s", resp.StatusCode, googleErrMessage(body))
	}
	if len(body) > maxGoogleBody {
		return nil, fmt.Errorf("Google 返回的内容超过 %d MB", maxGoogleBody>>20)
	}
	if out != nil {
		if err := json.Unmarshal(body, out); err != nil {
			return nil, fmt.Errorf("Google 返回的不是合法 JSON：%w", err)
		}
	}
	return body, nil
}

// googleErrMessage 取 Google 错误体里的说明：{"error":{"message":...}} 或 {"error":"...","error_description":"..."}。
func googleErrMessage(body []byte) string {
	var e struct {
		Error json.RawMessage `json:"error"`
		Desc  string          `json:"error_description"`
	}
	if json.Unmarshal(body, &e) == nil && len(e.Error) > 0 {
		var obj struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(e.Error, &obj) == nil && obj.Message != "" {
			return obj.Message
		}
		var s string
		if json.Unmarshal(e.Error, &s) == nil && s != "" {
			if e.Desc != "" {
				s += ": " + e.Desc
			}
			return s
		}
	}
	return "没有说明"
}
