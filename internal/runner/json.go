// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"bytes"
	"encoding/json"
)

// jsonObject 按给定顺序拼一个 JSON 对象。
//
// 用它而不是 map[string]any：map 的键会被 encoding/json 排成字典序，
// 于是 type 会跑到中间去。流事件是人要盯着看的东西（浏览器的网络面板、
// curl 的输出），type 在第一位才读得下去。
func jsonObject(kv ...any) ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i := 0; i+1 < len(kv); i += 2 {
		if i > 0 {
			b.WriteByte(',')
		}
		k, err := json.Marshal(kv[i])
		if err != nil {
			return nil, err
		}
		v, err := json.Marshal(kv[i+1])
		if err != nil {
			return nil, err
		}
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}
