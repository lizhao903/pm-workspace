package webui

import (
	"io/fs"
	"regexp"
	"testing"
)

// index.html 里引用的 /assets 文件必须都嵌进来了。两套前端都往同一个 dist 落，
// 换前端时没清干净或拷了一半，build 照样通过，跑起来却是白屏，这里提前拦住。
var assetRef = regexp.MustCompile(`(?:src|href)="/(assets/[^"]+)"`)

func TestEmbeddedIndexAssetsExist(t *testing.T) {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		t.Fatal(err)
	}
	b, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		t.Skip("dist 里没有 index.html，前端未构建")
	}
	for _, m := range assetRef.FindAllSubmatch(b, -1) {
		name := string(m[1])
		if _, err := fs.Stat(sub, name); err != nil {
			t.Errorf("index.html 引用的 %s 没有嵌进二进制", name)
		}
	}
}
