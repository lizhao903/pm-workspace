-- 0008_publish_snapshots: 发布记录扩展、平台账号、数据按天快照（VID-05a）
--
-- 对照原型 web-next/src/videodata.ts 的 Publish、PlatformAccount、MetricSnapshot、Metrics。
-- 发布记录加 account_id、tag_list（标签 JSON 数组，tags 和内核表重名，同 video_clips）、category、collection，和发布前校验结果 checks（JSON 数组，按平台规则算）。
-- metrics 列还是 JSON，扩展的曝光、点击率等存在里面，不加列。
-- 平台账号挂连接器实例（connector_id 是内核连接器 id，不建外键；手动登记的账号存空串），一个实例只挂一个账号由插件检查。
-- 快照每次回填、拉取追加一条，不覆盖；平台不提供的指标存 NULL。day 是发布后第几天，满一天算 1，不足一天也算 1。
-- 快照没有对外的 id，按 rowid 排先后；发布记录删掉时快照一起删。

ALTER TABLE video_publishes ADD COLUMN account_id TEXT NOT NULL DEFAULT '';

ALTER TABLE video_publishes ADD COLUMN tag_list TEXT NOT NULL DEFAULT '[]';

ALTER TABLE video_publishes ADD COLUMN category TEXT NOT NULL DEFAULT '';

ALTER TABLE video_publishes ADD COLUMN collection TEXT NOT NULL DEFAULT '';

ALTER TABLE video_publishes ADD COLUMN checks TEXT;

CREATE TABLE video_accounts (
  id           TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL,
  handle       TEXT NOT NULL,
  uid          TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'main',
  caps         TEXT NOT NULL DEFAULT '[]',
  followers    INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX video_accounts_by_platform ON video_accounts(platform, created_at);

CREATE TABLE video_metric_snapshots (
  publish_id       TEXT NOT NULL REFERENCES video_publishes(id) ON DELETE CASCADE,
  day              INTEGER NOT NULL,
  source           TEXT NOT NULL,
  views            INTEGER NOT NULL,
  likes            INTEGER NOT NULL,
  comments         INTEGER NOT NULL,
  shares           INTEGER NOT NULL,
  impressions      INTEGER,
  ctr              REAL,
  avg_watch_sec    REAL,
  completion       REAL,
  favorites        INTEGER,
  coins            INTEGER,
  followers_gained INTEGER,
  updated_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX video_metric_snapshots_by_publish ON video_metric_snapshots(publish_id, day);
