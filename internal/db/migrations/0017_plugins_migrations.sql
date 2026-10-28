-- 0017_plugins_migrations: 插件迁移的应用记录（CORE-05），规范见 docs/plugin-api.md 2.4
--
-- 插件的迁移放在插件自己的目录、从 0001 单独编号，和内核的 schema_migrations 分开记：
-- 一行是一个插件的一个迁移文件，file 就是这个插件内的迁移版本（例 0001_items.sql）。
-- checksum 是文件内容的 sha256，启动时比对，不一致拒绝启动并指出插件和文件。
-- plugin_version 是应用这条迁移时插件清单里的版本，升级排查时用。
--
-- 不对 plugins 表建外键：卸载保留数据时插件状态和迁移记录都留着，下次安装跳过已应用的迁移。

CREATE TABLE plugins_migrations (
  plugin_id       TEXT NOT NULL,
  file            TEXT NOT NULL,
  checksum        TEXT NOT NULL,
  plugin_version  TEXT NOT NULL DEFAULT '',
  applied_at      TEXT NOT NULL,
  PRIMARY KEY (plugin_id, file)
);
