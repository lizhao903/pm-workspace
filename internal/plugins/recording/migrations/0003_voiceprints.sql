-- 0003_voiceprints: M5 的说话人分离与声纹（0.3.0，见 docs/recording-transcription-design.md §14）。
--
-- recording_speakers：每条录音识别出的说话人，一条录音一行一位说话人。
--   label 是稳定标识（spk_1…，按首次出现顺序）；name 是用户改过的显示名（空串=没改）；
--   contact_id / contact_name 是绑定或自动匹配到的联系人和绑定时的快照；
--   similarity 是与已登记声纹的最高余弦相似度，detected 表示是自动匹配（不是手动绑定）；
--   embedding 是该簇质心（float32 192 维小端），绑定联系人时原样写进 recording_voiceprints；
--   model 是声纹模型名（campplus_cn_common），segments / duration_ms 是分到的段落数和总时长。
-- recording_segments.speaker（0001 已有）存 label；删录音连带删 recording_speakers，不删已登记的声纹。
--
-- recording_voiceprints：联系人声纹，一个联系人一条，可来自任意一次录音的说话人绑定；
-- embedding 是 float32 192 维小端质心，source_recording_id 是登记这条声纹的录音。
-- 声纹属于联系人资料，删录音不删；联系人删了以后条目留着，查询时按 contact_id 查不到名字。
--
-- 声纹相关设置加 5 列（auto_diarize / python_path / voiceprint_model_dir / max_speakers / match_threshold）。
-- 时间用 RFC3339 UTC。

ALTER TABLE recording_settings ADD COLUMN auto_diarize INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recording_settings ADD COLUMN python_path TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_settings ADD COLUMN voiceprint_model_dir TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_settings ADD COLUMN max_speakers INTEGER NOT NULL DEFAULT 8;
ALTER TABLE recording_settings ADD COLUMN match_threshold REAL NOT NULL DEFAULT 0.65;

CREATE TABLE recording_speakers (
  recording_id TEXT NOT NULL,
  label        TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  contact_id   TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  similarity   REAL NOT NULL DEFAULT 0,
  detected     INTEGER NOT NULL DEFAULT 0,
  embedding    BLOB,
  model        TEXT NOT NULL DEFAULT '',
  segments     INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (recording_id, label)
);

CREATE INDEX recording_speakers_by_contact ON recording_speakers(contact_id);

CREATE TABLE recording_voiceprints (
  contact_id          TEXT PRIMARY KEY,
  embedding           BLOB NOT NULL,
  model               TEXT NOT NULL,
  source_recording_id TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
