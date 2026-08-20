"""Generates icons/icon-192.png, icons/icon-512.png, and
icons/icon-maskable-512.png: two overlapping dog-eared pages (a "documents
to triage" glyph) in the app's navy/paper palette. Uses Pillow, supersampled
4x per target size and downscaled with Lanczos for clean anti-aliased edges.

Re-run after any change: python3 scripts/gen_icons.py
"""

from PIL import Image, ImageDraw

NAVY = (0x1A, 0x2B, 0x4A)
PAPER = (0xF4, 0xF1, 0xEA)


def blend(c1, c2, t):
    return tuple(round(c1[i] * (1 - t) + c2[i] * t) for i in range(3))


BACK_PAPER = blend(PAPER, NAVY, 0.38)  # shadowed "second sheet" behind the front page
FLAP = blend(PAPER, NAVY, 0.20)  # folded corner, shaded a bit darker than the page


def page_mask(w, h, radius, fold):
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    if fold:
        # Cut the dog-ear notch out of the top-right corner.
        d.polygon([(w - 1 - fold, 0), (w - 1, 0), (w - 1, fold)], fill=0)
    return mask


def draw_page(canvas, x0, y0, w, h, radius, color, fold=0, flap_color=None):
    mask = page_mask(w, h, radius, fold)
    canvas.paste(Image.new("RGB", (w, h), color), (x0, y0), mask)
    if fold:
        ImageDraw.Draw(canvas).polygon(
            [
                (x0 + w - fold, y0),
                (x0 + w, y0 + fold),
                (x0 + w - fold, y0 + fold),
            ],
            fill=flap_color,
        )


def make_icon(path, canvas_size, content_scale):
    # content_scale shrinks everything toward the center — used for the
    # maskable variant so the glyph stays inside the safe-zone circle that
    # OS icon masks (a circle, squircle, etc.) are guaranteed not to clip.
    S = canvas_size * 4
    img = Image.new("RGB", (S, S), NAVY)

    page_w = round(S * 0.34 * content_scale)
    page_h = round(S * 0.44 * content_scale)
    radius = round(S * 0.045 * content_scale)
    fold = round(S * 0.09 * content_scale)
    offset = round(S * 0.075 * content_scale)

    overall_w = page_w + offset
    overall_h = page_h + offset
    ox = (S - overall_w) // 2
    oy = (S - overall_h) // 2

    draw_page(img, ox + offset, oy + offset, page_w, page_h, radius, BACK_PAPER)
    draw_page(img, ox, oy, page_w, page_h, radius, PAPER, fold=fold, flap_color=FLAP)

    img.resize((canvas_size, canvas_size), Image.LANCZOS).save(path)


make_icon("icons/icon-192.png", 192, content_scale=1.0)
make_icon("icons/icon-512.png", 512, content_scale=1.0)
make_icon("icons/icon-maskable-512.png", 512, content_scale=0.72)
print("done")
