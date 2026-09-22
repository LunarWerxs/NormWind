"""Derive the images the landing page loads from their full-size PNG masters.

    python scripts/optimize_images.py

The masters in docs/assets/ stay as they are (the social card is what crawlers
fetch, so it is never touched). The page loads only the copies written here, each at
the size it is displayed (times three for high-density phones), as WebP, plus a small
favicon. Deterministic: the same masters and the same Pillow give the same bytes.
Needs Pillow with WebP support (pip install pillow).
"""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image

SITE = Path(__file__).resolve().parent.parent / "docs"

# (master, output, width, height). A missing side keeps the master's aspect ratio;
# both missing keeps the master's size and only changes the encoding.
JOBS: list[tuple[str, str, int | None, int | None]] = [
    # Header brand mark, shown in a 30x30 CSS px box (the master is 1200x816).
    ("assets/icon-256.png", "assets/icon-96.webp", 96, None),
    # Favicon: PNG, because every browser reads a PNG favicon.
    ("assets/icon-256.png", "assets/icon-64.png", 64, None),
    # Footer LunarWerx logo, shown 22 CSS px tall.
    ("assets/lw_logo_white.png", "assets/lw_logo_white.webp", None, 66),
    # Footer GitHub mark, shown at 17x17 CSS px.
    ("assets/github_mark.png", "assets/github_mark.webp", 51, 51),
]


def fit(img: Image.Image, width: int | None, height: int | None) -> Image.Image:
    if width is None and height is None:
        return img
    if width is None:
        assert height is not None
        width = round(img.width * height / img.height)
    if height is None:
        height = round(img.height * width / img.width)
    return img.resize((width, height), Image.Resampling.LANCZOS)


def webp_bytes(img: Image.Image) -> bytes:
    """The smaller of lossless and near-lossless (quality 90) WebP."""
    best = b""
    for opts in (
        {"lossless": True, "quality": 100},
        {"quality": 90, "alpha_quality": 100},
    ):
        buf = io.BytesIO()
        img.save(buf, "WEBP", method=6, **opts)
        if not best or buf.tell() < len(best):
            best = buf.getvalue()
    return best


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


ICO_SIZES = [(16, 16), (32, 32), (48, 48)]


def ico_bytes(path: Path) -> bytes:
    """A 16/32/48 px favicon.ico with PNG-compressed frames, for browsers that do not
    read the SVG icon. Reuses the master's own hand-drawn frame at each size when it
    has one, so re-running on its own output changes nothing."""
    with Image.open(path) as ico:
        have = set(ico.info.get("sizes", ()))
        frames = []
        for size in ICO_SIZES:
            if size in have:
                ico.size = size
                frames.append(ico.convert("RGBA"))
            else:
                big = ico.convert("RGBA")
                frames.append(big.resize(size, Image.Resampling.LANCZOS))
    buf = io.BytesIO()
    frames[-1].save(buf, "ICO", sizes=ICO_SIZES, append_images=frames[:-1])
    return buf.getvalue()


def main() -> None:
    for master, output, width, height in JOBS:
        if output.endswith(".ico"):
            data = ico_bytes(SITE / master)
            (SITE / output).write_bytes(data)
            print(f"{output}: {ICO_SIZES}, {len(data) / 1024:.1f} KB")
            continue
        with Image.open(SITE / master) as src:
            alpha = "A" in src.getbands() or "transparency" in src.info
            img = fit(src.convert("RGBA" if alpha else "RGB"), width, height)
        data = webp_bytes(img) if output.endswith(".webp") else png_bytes(img)
        (SITE / output).write_bytes(data)
        print(f"{output}: {img.width}x{img.height}, {len(data) / 1024:.1f} KB")


if __name__ == "__main__":
    main()
