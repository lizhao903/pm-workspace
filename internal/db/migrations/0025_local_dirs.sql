-- 0025_local_dirs: 文档的本机目录挂载（DOC-01a）
--
-- 文档模块的「工作区」除了内置文档库，还能挂本机目录（原型 web-next/src/library.tsx 的 dir:<id>）。
-- 原型在浏览器里读目录、不落库，刷新就没了；这里把挂载存下来，文件由服务端按需读，内容不进库。
-- path 存解析软链后的绝对路径，同一目录只能挂一次；必须落在 /api/fs 的允许根内（挂载时校验）。
-- name 是显示名，默认取目录名；position 是在工作区菜单里的顺序。
-- created_at、updated_at 用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

CREATE TABLE local_dirs (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_local_dirs_position ON local_dirs(position);
