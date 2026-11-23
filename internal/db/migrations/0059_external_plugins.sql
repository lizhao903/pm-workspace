-- powered by dsh - https://github.com/deepseek-ai/deepseek-harness
--
-- 0059_external_plugins: 外部插件宿主的状态（P1-a，docs/plugin-community-plan.md）
--
-- 一行是一个装过的外部插件（清单 v2，docs/plugin-spec-v2.md）。内核库只存状态和清单原文：
-- 包本身在 <DataDir>/external-plugins/packages/<id>/<version>/，插件私有数据在
-- <DataDir>/external-plugins/data/<id>/data.db，都不进内核库，全量导出也不含这张表。
--
--   source_type/source_ref 是安装来源（dir|archive|github + 路径或 URL）；
--   manifest 是清单原文（JSON），读出来再解析，避免内核库跟着清单字段升级改表；
--   permissions 是清单声明的权限（JSON 数组），granted 是用户确认后授予的（JSON 数组）；
--   enabled 是用户意愿（0/1），是否真的在跑看宿主的进程表；
--   last_error 记最近一次启用/运行失败的原因，启动时的 best-effort 拉起失败只写这里。
--
-- 只加不改：已有插件状态在 plugins 表（0016），这张表只给外部插件用。

CREATE TABLE external_plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  package_sha256 TEXT NOT NULL DEFAULT '',
  install_dir TEXT NOT NULL,
  manifest TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  granted TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT ''
);
