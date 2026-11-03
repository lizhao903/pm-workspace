-- 0004_settings: SOP 插件自己的设置（SOP-07）
--
-- 一项一行，key / value 都是文本。目前只有 model_concurrency：整个插件同时调模型的步骤数，1 到 16，没有这行时按 2。
-- 接口 GET / PATCH /api/sop/settings，改了立即生效。

CREATE TABLE sop_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
