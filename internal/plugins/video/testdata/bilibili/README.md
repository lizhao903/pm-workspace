B 站开放平台的响应样例，给 bilibili_test.go 的本机假服务端用（VID-04b）。

- 形状按开放平台文档写，账号、openid、BV 号、request_id、地址都是编的，不含真实账号信息。
- 真实接通（VID-04c）时用真实返回对一遍，对不上的改这里和 bilibili.go。
- `user_stat.json` 是 `/arcopen/fn/data/user/stat`（TSK-0455，B 站组件取粉丝、关注、过审稿件数），数字是编的。
