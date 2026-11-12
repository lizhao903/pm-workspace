# powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import subprocess, wave, json, os

A, B = "Tingting", "Grandpa (中文（中国大陆）)"  # 女声 / 男声（zh_CN）
turns = [
    (A, "大家好，我们开始今天的项目评审。先看一下官网改版的进度。"),
    (B, "前端这边方案已经定稿，首页和产品页这周能提测，但是后台接口还有两个没联调完。"),
    (A, "后台接口是哪个部分？影响提测时间吗？"),
    (B, "主要是订单查询和退款流程。如果这周五还联调不完，提测要往后推三天。"),
    (A, "那这样，订单查询先加班联调，退款流程可以放到下一期，先保证主流程上线。"),
    (B, "可以，我下午和后台确认一下排期，明天给你结论。"),
    (A, "好，另外 S E O 迁移的方案也要在这周出一版，预算单独报。"),
    (B, "收到，我让外包团队周四前给方案。"),
    (A, "行，今天就到这里，下次例会再对进度。"),
]
enroll = [
    (A, "我的名字是林悦，负责产品和项目管理工作，今天来参加这个会议。"),
    (B, "我叫王强，是研发负责人，主要负责后端和基础设施这一块。"),
]

def synth(text, voice, out_aiff):
    subprocess.run(["say", "-v", voice, "-o", out_aiff, text], check=True)

def to_pcm16k(src, dst):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst], check=True)

def read_wav(p):
    with wave.open(p, "rb") as w:
        return w.readframes(w.getnframes())

os.makedirs("audio", exist_ok=True)
segments = []
parts = []
pos = 0
for i, (voice, text) in enumerate(turns):
    aiff = f"audio/turn{i}.aiff"; wav = f"audio/turn{i}.wav"
    synth(text, voice, aiff); to_pcm16k(aiff, wav)
    pcm = read_wav(wav)
    if i > 0:
        silence = b"\x00\x00" * int(0.25 * 16000)
        parts.append(silence); pos += len(silence)
    start = pos
    parts.append(pcm); pos += len(pcm)
    segments.append({"turn": i, "speaker": "A" if voice == A else "B", "start_ms": round(start / 32), "end_ms": round(pos / 32)})

with wave.open("audio/dialog16k.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"".join(parts))

for name, (voice, text) in zip(["enrollA", "enrollB"], enroll):
    aiff = f"audio/{name}.aiff"; wav = f"audio/{name}.wav"
    synth(text, voice, aiff); to_pcm16k(aiff, wav)

json.dump(segments, open("audio/ground_truth.json", "w"), ensure_ascii=False, indent=2)
print("dialog duration(s):", round(pos / 32000, 2))
print(json.dumps(segments, ensure_ascii=False))
