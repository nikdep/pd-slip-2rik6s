# Builds icons/icon-{180,192,512}.png (run by .github/workflows/icons.yml; needs Pillow)
import os
from PIL import Image, ImageDraw, ImageFont
os.makedirs("icons", exist_ok=True)
FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVuSans-Bold.ttf"]
def font(px):
    for f in FONTS:
        try:
            return ImageFont.truetype(f, px)
        except OSError:
            pass
    return None
def icon(size):
    S = size * 4
    img = Image.new("RGB", (S, S), (13, 17, 23))
    d = ImageDraw.Draw(img)
    x0 = int(S * 0.2); x1 = S - x0; w = x1 - x0
    bh = int(w * 0.13); gap = int(w * 0.09); top = int(S * 0.5 - (3 * bh + 2 * gap) / 2) + int(w * 0.1)
    for i, (f, c) in enumerate([(1.0, (46, 204, 113)), (0.62, (245, 166, 35)), (0.3, (88, 166, 255))]):
        y = top + i * (bh + gap)
        d.rounded_rectangle([x0, y, x1, y + bh], radius=bh // 2, fill=(38, 44, 52))
        d.rounded_rectangle([x0, y, x0 + int(w * f), y + bh], radius=bh // 2, fill=c)
    fnt = font(int(w * 0.32))
    if fnt:
        d.text((S / 2, top - int(w * 0.2)), "$", font=fnt, fill=(230, 237, 243), anchor="mm")
    return img.resize((size, size), Image.LANCZOS).quantize(colors=32)
for s in (180, 192, 512):
    icon(s).save(f"icons/icon-{s}.png", optimize=True)
print("icons ok")
