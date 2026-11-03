-- 0004_topics: 选题库和素材箱（VID-08a）
--
-- 对照原型 web-next/src/topicdata.ts 的 Topic、TopicScore、Clip。
-- 打分 score 拆成 demand、fit、effort 三列；tags、platforms 存 JSON 数组。
-- 列名不用 tags：内核有 tags 表，插件 Store 会把同名标识符当成越界访问拦下，改叫 tag_list。
-- 选题和素材多对多，关联放 video_topic_clips，原型两边的 clip_ids、topic_ids 都从这张表读，按关联先后排。
-- 选题立项后 video_id 指向生成的视频；视频删掉时清空，选题留着。系列删掉时选题的 series_id 清空。
-- 素材来源可追溯：评论带发布记录 id（publish_id，发布记录删掉时清空），IM 消息带消息 id（message_id，
-- 插件读不到 im 的表，只存不查，不建外键）。

CREATE TABLE video_topics (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  angle       TEXT NOT NULL DEFAULT '',
  audience    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'idea',
  demand      INTEGER NOT NULL DEFAULT 3,
  fit         INTEGER NOT NULL DEFAULT 3,
  effort      INTEGER NOT NULL DEFAULT 3,
  tag_list    TEXT NOT NULL DEFAULT '[]',
  series_id   TEXT REFERENCES video_series(id) ON DELETE SET NULL,
  platforms   TEXT NOT NULL DEFAULT '[]',
  outline     TEXT NOT NULL DEFAULT '',
  planned_at  TEXT,
  video_id    TEXT REFERENCES video_videos(id) ON DELETE SET NULL,
  drop_reason TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX video_topics_by_status ON video_topics(status, created_at);
CREATE INDEX video_topics_by_series ON video_topics(series_id) WHERE series_id IS NOT NULL;
CREATE UNIQUE INDEX video_topics_by_video ON video_topics(video_id) WHERE video_id IS NOT NULL;

CREATE TABLE video_clips (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  heat       INTEGER,
  tag_list   TEXT NOT NULL DEFAULT '[]',
  starred    INTEGER NOT NULL DEFAULT 0,
  triaged    INTEGER NOT NULL DEFAULT 0,
  publish_id TEXT REFERENCES video_publishes(id) ON DELETE SET NULL,
  message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX video_clips_by_created ON video_clips(created_at);
CREATE INDEX video_clips_todo ON video_clips(created_at) WHERE triaged = 0;
CREATE INDEX video_clips_by_publish ON video_clips(publish_id) WHERE publish_id IS NOT NULL;
CREATE INDEX video_clips_by_message ON video_clips(message_id) WHERE message_id <> '';

CREATE TABLE video_topic_clips (
  topic_id TEXT NOT NULL REFERENCES video_topics(id) ON DELETE CASCADE,
  clip_id  TEXT NOT NULL REFERENCES video_clips(id) ON DELETE CASCADE,
  at       TEXT NOT NULL,
  PRIMARY KEY (topic_id, clip_id)
);

CREATE INDEX video_topic_clips_by_clip ON video_topic_clips(clip_id);
