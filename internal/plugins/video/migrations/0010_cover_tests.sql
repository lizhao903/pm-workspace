-- 0010_cover_tests: 封面 A/B 测试（VID-05b）
--
-- 对照原型 web-next/src/videodata.ts 的 CoverTest、CoverTestArm、Artifact.archived。
-- 一次测试挂 2 到 5 组，一组一张封面（cover_id 是 video_artifacts.id），小号分发时对应一条发布记录（publish_id），
-- 平台原生测试、分链接时曝光、点击率记在组上；封面、发布记录删掉时组照留，不建外键，判定时读不到就算没数据。
-- min_gap 是点击率第一领先第二的比例（0.2 即 20%）；winner_id 是胜出的封面，ended_at 是判出结果的时间。
-- 封面输掉后归档（cover_archived），记录和文件都留着；只有封面用这一列。

ALTER TABLE video_artifacts ADD COLUMN cover_archived INTEGER NOT NULL DEFAULT 0;

CREATE TABLE video_cover_tests (
  id              TEXT PRIMARY KEY,
  video_id        TEXT NOT NULL REFERENCES video_videos(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  mode            TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  min_days        INTEGER NOT NULL DEFAULT 7,
  min_impressions INTEGER NOT NULL DEFAULT 10000,
  min_gap         REAL NOT NULL DEFAULT 0.2,
  winner_id       TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'running',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX video_cover_tests_by_video ON video_cover_tests(video_id, created_at);

CREATE INDEX video_cover_tests_by_status ON video_cover_tests(status);

CREATE TABLE video_cover_test_arms (
  test_id     TEXT NOT NULL REFERENCES video_cover_tests(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  cover_id    TEXT NOT NULL,
  publish_id  TEXT NOT NULL DEFAULT '',
  impressions INTEGER,
  ctr         REAL,
  PRIMARY KEY (test_id, position)
);

CREATE INDEX video_cover_test_arms_by_publish ON video_cover_test_arms(publish_id) WHERE publish_id <> '';
