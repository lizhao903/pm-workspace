-- 0001_video: 视频创作插件的系列、视频、检查点、发布记录（VID-01a）
--
-- 对照原型 web-next/src/videodata.ts 的 Series、Video、Checkpoint、Publish。
-- 原型的 desc 列名改成 description。时间用 RFC3339 UTC。
-- 系列的 stale（改过共用部分还没同步的集）不单独存：记在视频的 stale 列上，读系列时按集数汇总；
-- 视频删掉或移出系列，待同步跟着没了。
-- 视频的 orientations 存 JSON 数组；规划检查通过后锁定，由插件检查。
-- project_id 是内核项目对象（objects.id，type=project），不建外键：插件迁移只建本插件前缀的表，
-- 项目软删了视频照样留着。
-- 检查点每个视频 4 行（plan、ch1、audio、distribution），新建视频时一起写。
-- 产出物（Artifact）是 VID-01b，发布记录的 cover_id 先按字符串存。

CREATE TABLE video_series (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  intro       TEXT NOT NULL DEFAULT '',
  outro       TEXT NOT NULL DEFAULT '',
  template    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE video_videos (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  project_id   TEXT,
  series_id    TEXT REFERENCES video_series(id),
  episode      INTEGER,
  orientations TEXT NOT NULL DEFAULT '[]',
  stage        TEXT NOT NULL DEFAULT 'script',
  root         TEXT NOT NULL DEFAULT '',
  chapters     INTEGER NOT NULL DEFAULT 0,
  stale        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX video_videos_by_series ON video_videos(series_id, episode);
CREATE INDEX video_videos_by_project ON video_videos(project_id);

CREATE TABLE video_checkpoints (
  video_id TEXT NOT NULL REFERENCES video_videos(id) ON DELETE CASCADE,
  stage    TEXT NOT NULL,
  state    TEXT NOT NULL DEFAULT 'pending',
  note     TEXT NOT NULL DEFAULT '',
  at       TEXT,
  PRIMARY KEY (video_id, stage)
);

CREATE TABLE video_publishes (
  id           TEXT PRIMARY KEY,
  video_id     TEXT NOT NULL REFERENCES video_videos(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,
  variant      TEXT NOT NULL,
  cover_id     TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'planned',
  scheduled_at TEXT,
  published_at TEXT,
  url          TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  metrics      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX video_publishes_by_video ON video_publishes(video_id, created_at);
