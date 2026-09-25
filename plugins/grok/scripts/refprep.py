#!/usr/bin/env python3
"""Fit an edit reference into what the Grok CLI sends to image_edit as it is.

    refprep.py INPUT --output PATH [--max-bytes N] [--max-side N] [--min-side N]

The Grok CLI passes a JPEG or PNG of up to 400 KB to image_edit untouched and
shrinks anything else to 768 px. This writes INPUT upright (EXIF orientation
applied) at the largest size, up to --max-side, that fits in --max-bytes: a
JPEG, or a PNG when the image has transparency. It never enlarges. Prints one
JSON object: the size and format written, and the source's size.

Exit codes: 0 done, 1 refused (it does not fit even at --min-side; the reason
is on stderr), 2 failed (a traceback on stderr), 3 Pillow is missing (JSON
{"missing": [...]} on stderr).
"""

import argparse
import io
import json
import sys
import traceback

REFUSED = 1
FAILED = 2
MISSING_LIBRARIES = 3

# Tried from the top down: the first side that fits in the byte budget wins.
SIDES = (1536, 1280, 1024, 768)
JPEG_QUALITIES = (90, 85, 80, 75, 70, 65, 60)


def has_alpha(image):
    return image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)


def fitted(image, side, Image):
    width, height = image.size
    scale = side / max(width, height)
    if scale >= 1:
        return image
    return image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS)


def encode(image, alpha):
    """Yield (bytes, format) from the best quality down."""
    if alpha:
        buffer = io.BytesIO()
        image.convert("RGBA").save(buffer, "PNG", optimize=True)
        yield buffer.getvalue(), "png"
        return
    rgb = image.convert("RGB")
    for quality in JPEG_QUALITIES:
        buffer = io.BytesIO()
        rgb.save(buffer, "JPEG", quality=quality, optimize=True)
        yield buffer.getvalue(), "jpeg"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input")
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-bytes", type=int, default=400 * 1024)
    parser.add_argument("--max-side", type=int, default=SIDES[0])
    parser.add_argument("--min-side", type=int, default=SIDES[-1])
    args = parser.parse_args()

    try:
        from PIL import Image, ImageOps
    except ImportError:
        sys.stderr.write(json.dumps({"missing": ["Pillow"]}))
        return MISSING_LIBRARIES

    with Image.open(args.input) as source:
        image = ImageOps.exif_transpose(source)
        image.load()
    alpha = has_alpha(image)
    longest = max(image.size)
    sides = sorted({min(side, longest) for side in (args.max_side, *SIDES) if args.min_side <= side <= args.max_side}, reverse=True)

    for side in sides:
        candidate = fitted(image, side, Image)
        for data, kind in encode(candidate, alpha):
            if len(data) <= args.max_bytes:
                with open(args.output, "wb") as out:
                    out.write(data)
                json.dump(
                    {
                        "width": candidate.size[0],
                        "height": candidate.size[1],
                        "bytes": len(data),
                        "format": kind,
                        "sourceWidth": image.size[0],
                        "sourceHeight": image.size[1],
                    },
                    sys.stdout,
                )
                return 0

    sys.stderr.write(f"{args.input} does not fit in {args.max_bytes} bytes even at {sides[-1] if sides else longest} px.\n")
    return REFUSED


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 — any failure is reported, not hidden
        traceback.print_exc()
        sys.exit(FAILED)
