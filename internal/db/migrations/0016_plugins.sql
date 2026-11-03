-- 0016_plugins: 插件状态表（CORE-04a），规范见 docs/plugin-api.md 第 4 节
--
-- 一个插件一行，id 是清单里的插件 id。没有行等于未安装；卸载保留数据时也只是把 installed 置 0，
-- 已确认的权限、安装时间留着，重新安装时界面可以提示「上次确认过这些权限」。
--
-- version 是安装（或上次升级）时的插件版本。换了新二进制、清单版本变了时，
-- 和它对不上就是「可升级」（4.5），这里不自动改写。
--
-- permissions 是用户确认过的权限，JSON 数组；permissions_at 是确认时间。
--
-- 表名不带前缀：插件 id 不能是 plugins（内核保留字），所以 plugins 开头的表不会和插件自己的表撞。

CREATE TABLE plugins (
  id              TEXT PRIMARY KEY,
  installed       INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 0,
  version         TEXT NOT NULL DEFAULT '',
  installed_at    TEXT,
  permissions     TEXT NOT NULL DEFAULT '[]',
  permissions_at  TEXT,
  updated_at      TEXT NOT NULL
);
