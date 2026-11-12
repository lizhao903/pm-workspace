-- 0015_voiceover: 系列配音配置（TTS-01）
--
-- 系列上记「配音」默认值：音色和语速，跟着「语音合成」插件的可用音色走；空串表示用插件默认音色。
-- 视频没有单独的配音字段，统一继承所在系列；单集视频（没有系列）用插件默认值。
-- 只加列，不动已有数据。

ALTER TABLE video_series ADD COLUMN voice TEXT NOT NULL DEFAULT '';
ALTER TABLE video_series ADD COLUMN voice_speed REAL NOT NULL DEFAULT 1.0;
