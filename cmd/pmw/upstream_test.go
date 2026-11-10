// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDevUpstream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.URL.Path)
	}))
	defer srv.Close()
	u := upstreams{}
	if err := u.Set("API.telegram.org=" + srv.URL); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"api.telegram.org", "x=ftp://a", "=http://a"} {
		if err := (upstreams{}).Set(bad); err == nil {
			t.Fatalf("%q 应报错", bad)
		}
	}
	c := &http.Client{Transport: upstreamTransport{to: u, base: http.DefaultTransport}}
	resp, err := c.Get("https://api.telegram.org/bot1:x/getMe")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(b) != "/bot1:x/getMe" {
		t.Fatalf("改投后路径应不变：%q", b)
	}
}
