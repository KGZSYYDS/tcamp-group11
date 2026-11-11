"""
生成分享用的扫码卡片。

为什么做成卡片而不是裸二维码：
  裸二维码发到群里，别人不知道扫出来是什么，也不会扫码。
  带上名字 + 一行说明 + 网址，转发时信息是自解释的。

配色沿用应用本身的深绿灰调，和界面观感一致。
"""
import segno
from PIL import Image, ImageDraw, ImageFont
import pathlib

URL = "https://desktop-cbe32mg.tail3d2442.ts.net"
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "data" / "qrcode"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ---------- 1. 裸二维码（矢量 + 位图都给一份） ----------
qr = segno.make(URL, error="h")  # H 级容错：即使印花/贴纸磨损 30% 仍可扫
qr.save(OUT_DIR / "szu-calendar-qr.svg", scale=10, border=2)
qr.save(OUT_DIR / "szu-calendar-qr.png", scale=20, border=3, dark="#12352b", light="#ffffff")

# ---------- 2. 卡片 ----------
W, H = 1080, 1350
BG = "#ffffff"
DEEP = "#12352b"      # 主色：深墨绿
MUTED = "#6b7a75"
ACCENT = "#2f7d63"

card = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(card)


def font(size, bold=False):
    """按优先级找一个能显示中文的字体。"""
    names = [
        (r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc"),
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
    ]
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            continue
    return ImageFont.load_default()


f_title = font(66, bold=True)
f_sub = font(34)
f_url = font(30)
f_tip = font(26)

# 顶部装饰条
d.rectangle([0, 0, W, 14], fill=ACCENT)

# 标题
title = "深大日程助手"
tw = d.textlength(title, font=f_title)
d.text(((W - tw) / 2, 92), title, font=f_title, fill=DEEP)

sub = "课表 · 作业截止 · 校园通知"
sw = d.textlength(sub, font=f_sub)
d.text(((W - sw) / 2, 190), sub, font=f_sub, fill=MUTED)

# 二维码居中
QR_SIZE = 660
qimg = Image.open(OUT_DIR / "szu-calendar-qr.png").convert("RGB")
qimg = qimg.resize((QR_SIZE, QR_SIZE), Image.NEAREST)
qx, qy = (W - QR_SIZE) // 2, 288

# 二维码外面的细边框，让它在白底上有边界感
d.rounded_rectangle(
    [qx - 26, qy - 26, qx + QR_SIZE + 26, qy + QR_SIZE + 26],
    radius=28,
    outline="#dfe7e3",
    width=3,
)
card.paste(qimg, (qx, qy))

# 网址（等宽感更清晰）
url_y = qy + QR_SIZE + 70
# 太长就缩小一档
uf = f_url
while d.textlength(URL, font=uf) > W - 120 and uf.size > 20:
    uf = font(uf.size - 2)
uw = d.textlength(URL, font=uf)
d.text(((W - uw) / 2, url_y), URL, font=uf, fill=ACCENT)

# 底部提示
tip = "微信扫一扫，或长按识别"
tipw = d.textlength(tip, font=f_tip)
d.text(((W - tipw) / 2, url_y + 56), tip, font=f_tip, fill=MUTED)

# 底部细线 + 落款
d.line([(W / 2 - 60, H - 96), (W / 2 + 60, H - 96)], fill="#dfe7e3", width=2)
foot = "深圳大学 · 非官方"
fw = d.textlength(foot, font=f_tip)
d.text(((W - fw) / 2, H - 68), foot, font=f_tip, fill="#9aa8a3")

card.save(OUT_DIR / "szu-calendar-qr-card.png", "PNG", optimize=True)

print("generated:")
for p in sorted(OUT_DIR.iterdir()):
    print("  ", p.name, f"{p.stat().st_size / 1024:.0f} KB")
