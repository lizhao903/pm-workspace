# 声纹 POC 脚本（M5）

用 FunASR（fsmn-vad + CAM++）验证离线说话人分离与声纹注册匹配。结论与方案见
[`docs/recording-voiceprint-poc.md`](../../docs/recording-voiceprint-poc.md)。

## 环境

```bash
python3 -m venv --system-site-packages /tmp/m5-poc/venv   # 复用系统 torch
/tmp/m5-poc/venv/bin/pip install funasr librosa soundfile
```

首次运行会自动从 ModelScope 下载：
- `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch`（4.7MB）
- `iic/speech_campplus_sv_zh-cn_16k-common`（28MB）

## 跑

```bash
cd scripts/voiceprint-poc
python3 gen_audio.py                                    # 合成双人对话 + 注册音频（需 macOS say）
/tmp/m5-poc/venv/bin/python poc_diarize.py              # 方案 A：VAD + CAM++ 分块 + 谱聚类
/opt/homebrew/bin/whisper-cli -m /tmp/whisper-bench/models/ggml-large-v3-turbo.bin \
  -f audio/dialog16k.wav -oj -of whisper_dialog_turbo -l zh -nfa
/tmp/m5-poc/venv/bin/python poc_whisper_segments.py     # 方案 B：whisper 段落 + CAM++ + 层次聚类
```

脚本会打印真值对比、准确率、注册声纹余弦相似度，并写 `poc_result.json` / `poc_whisper_result.json`。
