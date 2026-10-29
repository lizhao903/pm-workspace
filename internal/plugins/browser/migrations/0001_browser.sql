-- 0001_browser: 内置浏览器插件的标签页和地址白名单（BR-01a）
--
-- browser_tabs 对照原型 web-next/src/browserdata.ts 的 BrowserTab，多 position（顺序，从 0 起）和 active（是否当前标签）。
-- history 存 JSON 字符串数组，cursor 是当前在 history 的第几条。loading 只在前端内存，不存。
-- 标签整体替换（PUT /api/browser/tabs），最多 50 个，由插件检查。
-- browser_allowlist 是允许嵌入的主机名（BR-02a 用），本机地址 127.0.0.1、localhost 是内置的，不落表；
-- 内网域名后缀由前端带上，不读内网域名插件的表。
-- 时间用 RFC3339 UTC。

CREATE TABLE browser_tabs (
  id         TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL CHECK (kind IN ('home', 'proto', 'drive', 'web')),
  history    TEXT NOT NULL DEFAULT '[]',
  cursor     INTEGER NOT NULL DEFAULT 0,
  pinned     INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE browser_allowlist (
  host       TEXT PRIMARY KEY,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
