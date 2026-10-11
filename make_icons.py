from PIL import Image, ImageDraw
import math, os

def sky(w, h):
    img = Image.new("RGB", (w, h))
    px = img.load()
    top, bot = (22, 70, 160), (96, 176, 240)
    for y in range(h):
        t = y / (h - 1)
        c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = c
    return img

def glyph(size, scale=1.0):
    """Transparent layer: sun + cloud + a row of 'source' dots with a consensus diamond."""
    S = 4
    N = size * S
    g = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    u = N / 100 * scale
    ox = N * (1 - scale) / 2
    X = lambda v: ox + v * u
    Y = lambda v: ox + v * u
    # sun
    cx, cy, r = X(63), Y(34), 15 * u
    for i in range(8):
        a = i * math.pi / 4
        d.line([(cx + math.cos(a) * (r + 5 * u), cy + math.sin(a) * (r + 5 * u)), (cx + math.cos(a) * (r + 11 * u), cy + math.sin(a) * (r + 11 * u))], fill=(255, 212, 59, 255), width=int(4 * u))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 212, 59, 255))
    # cloud
    cl = (244, 247, 251, 255)
    d.ellipse([X(14), Y(52), X(40), Y(78)], fill=cl)
    d.ellipse([X(28), Y(40), X(60), Y(74)], fill=cl)
    d.ellipse([X(48), Y(50), X(76), Y(78)], fill=cl)
    d.rounded_rectangle([X(26), Y(60), X(64), Y(78)], radius=int(9 * u), fill=cl)
    # sources strip
    colors = [(90, 200, 250), (48, 209, 88), (255, 159, 10), (191, 90, 242)]
    xs = [30, 40, 52, 62]
    for c, x in zip(colors, xs):
        d.ellipse([X(x) - 4.2 * u, Y(88) - 4.2 * u, X(x) + 4.2 * u, Y(88) + 4.2 * u], fill=c + (255,))
    bx, by = X(46), Y(88)
    d.polygon([(bx, by - 7 * u), (bx + 5 * u, by), (bx, by + 7 * u), (bx - 5 * u, by)], fill=(255, 255, 255, 255))
    return g.resize((size, size), Image.LANCZOS)

def icon(size, scale=1.0):
    img = sky(size, size).convert("RGBA")
    img.alpha_composite(glyph(size, scale))
    return img.convert("RGB")

os.makedirs("icons", exist_ok=True)
icon(512).save("icons/icon-512.png")
icon(192).save("icons/icon-192.png")
icon(180).save("icons/apple-touch-icon.png")
icon(32).save("icons/favicon-32.png")
icon(512, 0.72).save("icons/icon-maskable-512.png")

# iOS launch screens
sizes = [  # (w, h, css-w, css-h, ratio)
    (1290, 2796, 430, 932, 3), (1179, 2556, 393, 852, 3), (1284, 2778, 428, 926, 3), (1170, 2532, 390, 844, 3),
    (1125, 2436, 375, 812, 3), (828, 1792, 414, 896, 2), (750, 1334, 375, 667, 2),
    (1668, 2388, 834, 1194, 2), (2048, 2732, 1024, 1366, 2), (1640, 2360, 820, 1180, 2), (1620, 2160, 810, 1080, 2), (1488, 2266, 744, 1133, 2),
]
os.makedirs("splash", exist_ok=True)
tags = []
for w, h, cw, ch, r in sizes:
    bg = sky(w, h).convert("RGBA")
    s = int(min(w, h) * 0.26)
    g = glyph(s)
    bg.alpha_composite(g, ((w - s) // 2, (h - s) // 2))
    name = f"splash/launch-{w}x{h}.png"
    bg.convert("RGB").save(name, optimize=True)
    tags.append(f'<link rel="apple-touch-startup-image" href="{name}" media="(device-width: {cw}px) and (device-height: {ch}px) and (-webkit-device-pixel-ratio: {r}) and (orientation: portrait)">')
open("splash/tags.html", "w").write("\n".join(tags))
print(len(tags), "splash screens")
