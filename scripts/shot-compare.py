#!/usr/bin/env python3
"""原型和正式前端的截图对照：同一模块两边各截一张，三种宽度 x 亮暗两种主题，出一份并排的 HTML 报告。

用法（make shot-compare 调的就是这个）：
  /opt/miniconda3/bin/python scripts/shot-compare.py --module tasks
      [--front-port 7780] [--proto-url http://127.0.0.1:7778] [--front-url http://127.0.0.1:7780]
      [--widths 375,768,1440] [--themes light,dark] [--diff] [--full-page] [--out frontend/.shots]
  --module all 跑配置里的全部模块；--list 列出配置里有哪些模块。

- 两边怎么到达写在 frontend/e2e/shot-pairs.json：原型没有 URL 路由，按侧边栏菜单文字点进去；正式前端按路由直接打开。
- 只读：不启动、不重启原型和前端；任一边没在跑就提示启动命令后退出。
- 每个主题 x 宽度开全新的浏览器上下文，清掉 localStorage 后只写主题（原型 pmw-next-theme，前端 pmw-theme）。
- 报告在 <out>/<模块>/report.html，截图放在同目录，每次重跑先清掉该模块的旧结果。frontend/.shots/ 已被 git 忽略。
- --diff 用 Pillow 算像素差异百分比（任一通道差超过 --threshold 算不同），并输出差异图；尺寸不同时按大的补白。
- 退出码：0 全部截到；1 有截图失败（报告里会标出）；2 原型或前端没在跑、配置不对或环境不对。
"""
import argparse
import datetime
import html
import json
import os
import shutil
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAIRS_FILE = os.path.join(ROOT, 'frontend', 'e2e', 'shot-pairs.json')
DEFAULT_OUT = os.path.join(ROOT, 'frontend', '.shots')
PROTO_HINT = '原型没在跑（{url}）：先在另一个终端执行  cd web-next && npm run dev  （默认 http://127.0.0.1:7778）'
FRONT_HINT = '正式前端没在跑（{url}）：先在另一个终端执行  cd frontend && npm run dev  （默认 7780；换端口用 npx vite --port <端口> --strictPort，再给本脚本传 --front-port）'
SETTLE_MS = 600


def reachable(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return r.status < 500
    except (urllib.error.URLError, OSError, ValueError):
        return False


def load_pairs(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        print(f'读不了对照配置 {path}：{e}')
        return None


def open_fresh(page, url, key, theme):
    """打开页面，清掉存储只留主题，重新加载。"""
    page.goto(url, wait_until='domcontentloaded')
    page.evaluate("([k, t]) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(k, t) }", [key, theme])
    page.reload(wait_until='networkidle')


def settle(page, wait):
    """去掉点击留下的焦点框和悬停态，再等渲染稳定。"""
    page.mouse.move(0, 0)
    page.evaluate('() => document.activeElement && document.activeElement.blur && document.activeElement.blur()')
    page.wait_for_timeout(SETTLE_MS + wait)


def check_theme(page, theme):
    got = page.evaluate('() => document.documentElement.dataset.theme')
    return None if got == theme else f'主题不对：期望 {theme}，页面是 {got}'


def shot_proto(ctx, base, spec, theme, path, full_page, wait):
    page = ctx.new_page()
    try:
        open_fresh(page, base, 'pmw-next-theme', theme)
        page.wait_for_selector('.side-group .side-item', timeout=10000)
        scope = '.side-foot .side-item' if spec.get('foot') else '.side-group .side-item'
        item = page.locator(scope).filter(has_text=spec['menu']).first
        if not item.count():
            return f'原型侧边栏里没有「{spec["menu"]}」'
        item.scroll_into_view_if_needed(timeout=3000)
        item.click(timeout=5000)
        if spec.get('sub'):
            page.wait_for_timeout(SETTLE_MS)
            sub = page.locator('.subnav .subnav-item').filter(has_text=spec['sub']).first
            if not sub.count():
                return f'原型「{spec["menu"]}」下没有二级菜单「{spec["sub"]}」'
            sub.click(timeout=5000)
        # 窄屏点菜单后可能留着抽屉或遮罩，按 Esc 收起
        page.keyboard.press('Escape')
        settle(page, wait)
        bad = check_theme(page, theme)
        page.screenshot(path=path, full_page=full_page)
        return bad
    finally:
        page.close()


def shot_front(ctx, base, spec, theme, path, full_page, wait):
    page = ctx.new_page()
    try:
        url = base.rstrip('/') + spec['route']
        open_fresh(page, url, 'pmw-theme', theme)
        settle(page, wait)
        bad = check_theme(page, theme)
        page.screenshot(path=path, full_page=full_page)
        return bad
    finally:
        page.close()


def pixel_diff(a, b, out, threshold):
    """返回不同像素的百分比，并写一张差异图（不同处标红）。"""
    from PIL import Image, ImageChops
    ia, ib = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
    w, h = max(ia.width, ib.width), max(ia.height, ib.height)
    pa, pb = Image.new('RGB', (w, h), 'white'), Image.new('RGB', (w, h), 'white')
    pa.paste(ia)
    pb.paste(ib)
    diff = ImageChops.difference(pa, pb).convert('L').point(lambda v: 255 if v > threshold else 0)
    hist = diff.histogram()
    pct = 100.0 * hist[255] / (w * h)
    shade = Image.blend(pa, Image.new('RGB', (w, h), 'white'), 0.7)
    shade.paste(Image.new('RGB', (w, h), (220, 30, 30)), mask=diff)
    shade.save(out)
    return pct


REPORT_CSS = """
:root { --bg:#f6f7f9; --fg:#1d2129; --muted:#6b7280; --card:#fff; --line:#e3e6eb; --bad:#c0392b; }
@media (prefers-color-scheme: dark) { :root { --bg:#16181c; --fg:#e6e8eb; --muted:#9aa1ab; --card:#1f2228; --line:#30343b; --bad:#ef6b5b; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
.meta { color: var(--muted); margin-bottom: 20px; }
.group { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 20px; }
.group h2 { font-size: 15px; margin: 0 0 10px; display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; }
.group h2 .pct { color: var(--muted); font-weight: normal; font-size: 13px; }
.row { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 12px; align-items: start; }
figure { margin: 0; min-width: 0; }
figcaption { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; }
.err { color: var(--bad); font-size: 13px; margin: 4px 0; }
@media (max-width: 720px) { .row { grid-template-columns: minmax(0, 1fr); } }
"""


def write_report(path, module, spec, info, cells, with_diff):
    cols = 3 if with_diff else 2
    parts = [
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f'<title>截图对照 {html.escape(module)}</title><style>{REPORT_CSS}</style></head><body>',
        f'<h1>截图对照：{html.escape(module)}</h1>',
        f'<div class="meta">原型 {html.escape(info["proto"])}，菜单「{html.escape(spec["proto"]["menu"])}'
        + (f' / {html.escape(spec["proto"]["sub"])}' if spec['proto'].get('sub') else '')
        + f'」；正式前端 {html.escape(info["front"])}{html.escape(spec["front"]["route"])}；生成于 {html.escape(info["time"])}</div>',
    ]
    for c in cells:
        pct = f'<span class="pct">像素差异 {c["pct"]:.2f}%</span>' if c.get('pct') is not None else ''
        parts.append(f'<section class="group"><h2>{c["width"]}px · {"浅色" if c["theme"] == "light" else "深色"}{pct}</h2>')
        for e in c['errors']:
            parts.append(f'<p class="err">{html.escape(e)}</p>')
        parts.append(f'<div class="row" style="--cols:{cols}">')
        for label, key in (('原型', 'proto'), ('正式前端', 'front')) + ((('差异（红色为不同）', 'diff'),) if with_diff else ()):
            img = c.get(key)
            body = f'<img src="{html.escape(img)}" alt="{label}" loading="lazy">' if img else '<p class="err">没有截图</p>'
            parts.append(f'<figure><figcaption>{label}</figcaption>{body}</figure>')
        parts.append('</div></section>')
    parts.append('</body></html>')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(parts))


def run_module(browser, module, spec, a, widths, themes, height):
    out = os.path.join(a.out, module)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    cells, failed = [], 0
    for theme in themes:
        for width in widths:
            c = {'theme': theme, 'width': width, 'errors': []}
            for side, fn, base in (('proto', shot_proto, a.proto_url), ('front', shot_front, a.front_url)):
                name = f'{width}-{theme}-{side}.png'
                ctx = browser.new_context(viewport={'width': width, 'height': height}, color_scheme=theme)
                try:
                    warn = fn(ctx, base, spec[side], theme, os.path.join(out, name), a.full_page, spec.get('wait', 0))
                    if os.path.exists(os.path.join(out, name)):
                        c[side] = name
                    if warn:
                        c['errors'].append(('原型：' if side == 'proto' else '正式前端：') + warn)
                except Exception as e:
                    c['errors'].append(('原型' if side == 'proto' else '正式前端') + '截图失败：' + str(e).splitlines()[0][:200])
                finally:
                    ctx.close()
            if not (c.get('proto') and c.get('front')):
                failed += 1
            elif a.diff:
                dname = f'{width}-{theme}-diff.png'
                c['pct'] = pixel_diff(os.path.join(out, c['proto']), os.path.join(out, c['front']), os.path.join(out, dname), a.threshold)
                c['diff'] = dname
            cells.append(c)
            tail = f'，差异 {c["pct"]:.2f}%' if c.get('pct') is not None else ''
            note = f'，{"；".join(c["errors"])}' if c['errors'] else ''
            print(f'[{module} {theme:5} {width:>4}] 原型 {"有" if c.get("proto") else "无"}，前端 {"有" if c.get("front") else "无"}{tail}{note}', flush=True)
    info = {'proto': a.proto_url, 'front': a.front_url.rstrip('/'), 'time': datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}
    report = os.path.join(out, 'report.html')
    write_report(report, module, spec, info, cells, a.diff)
    print(f'报告：{report}（{len(cells)} 组）')
    return failed


def main():
    ap = argparse.ArgumentParser(description='原型和正式前端的截图对照')
    ap.add_argument('--module', help='配置里的模块名，all 表示全部')
    ap.add_argument('--list', action='store_true', help='列出配置里的模块')
    ap.add_argument('--config', default=PAIRS_FILE)
    ap.add_argument('--proto-url', default=os.environ.get('PROTO_URL', 'http://127.0.0.1:7778'))
    ap.add_argument('--front-port', type=int, default=int(os.environ.get('FRONT_PORT', '7780')), help='正式前端 dev server 端口')
    ap.add_argument('--front-url', help='正式前端地址，给了就忽略 --front-port')
    ap.add_argument('--widths', help='默认用配置里的 widths')
    ap.add_argument('--themes', help='默认用配置里的 themes')
    ap.add_argument('--full-page', action='store_true', help='截整页；默认只截视口，两边尺寸一致便于比对')
    ap.add_argument('--diff', action='store_true', help='算像素差异百分比并输出差异图（需要 Pillow）')
    ap.add_argument('--threshold', type=int, default=16, help='像素差异阈值，0-255')
    ap.add_argument('--out', default=DEFAULT_OUT)
    a = ap.parse_args()
    a.front_url = a.front_url or f'http://127.0.0.1:{a.front_port}'
    a.out = os.path.abspath(a.out)

    pairs = load_pairs(a.config)
    if pairs is None:
        return 2
    modules = pairs.get('modules', {})
    if a.list or not a.module:
        print('配置里的模块：' + '、'.join(modules))
        if not a.list:
            print('用 --module <模块> 指定要对照的模块，--module all 跑全部')
        return 0 if a.list else 2
    names = list(modules) if a.module == 'all' else [a.module]
    unknown = [n for n in names if n not in modules]
    if unknown:
        print(f'配置里没有模块 {"、".join(unknown)}；可选：{"、".join(modules)}')
        return 2
    widths = [int(x) for x in (a.widths.split(',') if a.widths else pairs.get('widths', [375, 768, 1440])) if str(x).strip()]
    themes = [x.strip() for x in (a.themes.split(',') if a.themes else pairs.get('themes', ['light', 'dark'])) if x.strip()]
    height = int(pairs.get('height', 900))

    down = []
    if not reachable(a.proto_url):
        down.append(PROTO_HINT.format(url=a.proto_url))
    if not reachable(a.front_url):
        down.append(FRONT_HINT.format(url=a.front_url))
    if down:
        print('\n'.join(down))
        return 2
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('没找到 playwright：用本机 base Python 跑，/opt/miniconda3/bin/python scripts/shot-compare.py')
        return 2
    if a.diff:
        try:
            import PIL  # noqa: F401
        except ImportError:
            print('--diff 需要 Pillow：用本机 base Python 跑，或去掉 --diff')
            return 2

    failed = 0
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel='chrome')
        except Exception as e:
            print('启动 Chrome 失败：' + str(e).splitlines()[0])
            return 2
        try:
            for n in names:
                failed += run_module(browser, n, modules[n], a, widths, themes, height)
        finally:
            browser.close()
    if failed:
        print(f'有 {failed} 组没截全，见报告里的红字')
        return 1
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
