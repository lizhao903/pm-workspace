# powered by dsh - https://github.com/deepseek-ai/deepseek-harness

# 方案 B：不跑 VAD，直接用 whisper 段落当声纹块（边界=转写时间戳），CAM++ 提取 + 层次聚类 + 注册声纹匹配。
import json, time
import numpy as np, librosa
from funasr import AutoModel
from sklearn.cluster import AgglomerativeClustering

t0 = time.time()
seg = json.load(open("whisper_dialog_turbo.json"))["transcription"]
audio, sr = librosa.load("audio/dialog16k.wav", sr=16000, mono=True)
GT = json.load(open("audio/ground_truth.json"))
spk = AutoModel(model="cam++", hub="ms", device="cpu", disable_update=True, disable_pbar=True, log_level="ERROR")
print("model loaded", round(time.time()-t0,1), flush=True)

def emb(x):
    r = spk.generate(input=x, disable_pbar=True, log_level="ERROR")
    return r[0]["spk_embedding"].reshape(-1).cpu().numpy()

X, ivs = [], []
for s in seg:
    st, ed = s["offsets"]["from"]/1000.0, s["offsets"]["to"]/1000.0
    X.append(emb(audio[int(st*sr):int(ed*sr)]))
    ivs.append((st, ed, s.get("text","")[:20]))
X = np.stack(X)
print("segments", len(X), "dim", round(time.time()-t0,1), flush=True)

labels = AgglomerativeClustering(n_clusters=None, distance_threshold=0.35, metric="cosine", linkage="average").fit_predict(X)
uniq = sorted(set(int(l) for l in labels))
print("clusters", uniq, flush=True)

def gt_of(st, ed):
    best, bo = "?", 0
    for g in GT:
        ov = max(0, min(ed*1000, g["end_ms"]) - max(st*1000, g["start_ms"]))
        if ov > bo: bo, best = ov, g["speaker"]
    return best
gt = [gt_of(st, ed) for st, ed, _ in ivs]

from collections import Counter
l2g = {lab: Counter(g for l,g in zip(labels, gt) if int(l)==lab).most_common(1)[0][0] for lab in uniq}
pred = [l2g[int(l)] for l in labels]
acc = sum(1 for p,g in zip(pred,gt) if p==g)/len(gt)
dur_c = sum((ed-st) for (st,ed,_),p,g in zip(ivs,pred,gt) if p==g)
dur_t = sum(ed-st for st,ed,_ in ivs)
print("label->gt", l2g, flush=True)
for (st,ed,txt),l,p,g in zip(ivs,labels,pred,gt):
    print("  %5.1f-%5.1f %s->%s %-12s %s" % (st,ed,int(l),p,g,txt), flush=True)
print("seg accuracy %.1f%% duration %.1f%%" % (100*acc, 100*dur_c/dur_t), flush=True)

# 注册声纹匹配
enroll = {"A": emb(librosa.load("audio/enrollA.wav", sr=16000, mono=True)[0]),
          "B": emb(librosa.load("audio/enrollB.wav", sr=16000, mono=True)[0])}
centers = {lab: X[labels==lab].mean(0) for lab in uniq}
def cos(a,b): return float(np.dot(a,b)/(np.linalg.norm(a)*np.linalg.norm(b)+1e-9))
sim = {n:{lab: round(cos(e,c),4) for lab,c in centers.items()} for n,e in enroll.items()}
print("enroll sim", json.dumps(sim, ensure_ascii=False), flush=True)
print("match", sum(1 for n,e in enroll.items() if l2g[max(sim[n], key=sim[n].get)]==n), "/2", flush=True)
json.dump({"label2gt": l2g, "acc": acc, "dur_acc": dur_c/dur_t, "sim": sim}, open("poc_whisper_result.json","w"), ensure_ascii=False, indent=2)
print("DONE", round(time.time()-t0,1), flush=True)
