#!/usr/bin/env python3
"""Chroma keying for the Grok plugin's local tools, run by lib/chroma.mjs.

    chroma.py cutout INPUT --key RRGGBB --tolerance N [--output PATH]
    chroma.py split INPUT --bg auto|RRGGBB --tolerance N [--expect N] [--outputs PATH...]

Without an output a command only checks the image and reports what it would
do; with one, it writes the result. Either way it prints one JSON object.

Exit codes: 0 done, 1 refused (the reason is on stderr, fit to show the
user), 2 failed (a traceback on stderr), 3 a library is missing (JSON
{"missing": [...]} on stderr). Needs Pillow, numpy and scipy.
"""

import argparse
import importlib
import json
import sys
import traceback

REFUSED = 1
FAILED = 2
MISSING_LIBRARIES = 3

# Pixels this far (RGB distance) past the tolerance fade from clear to solid,
# so the cut edge is anti-aliased rather than jagged.
SOFT_EDGE = 40.0

# The key colour's spill is removed within this band of the cleared
# background: at least 3 px, 1% of the shorter side on larger images, where
# edges are softer. Deeper in, a subject keeps its own colour, even green.
SPILL_BAND_MIN = 3
SPILL_BAND_SHARE = 0.01

# From the sheet recipe: a piece closer than MERGE_GAP (of the sheet's width)
# to a much bigger one belongs to it (a plume, a sword tip); groups smaller
# than MIN_AREA (of the sheet's area) are noise. Items of similar size are
# never merged, however close: that is a tight grid, not a detached piece.
MERGE_GAP = 0.03
MERGE_SIZE_RATIO = 1 / 3
MIN_AREA = 0.0005


class Refused(Exception):
    """The request cannot be honoured; the message says why and what to do."""


def require_libraries():
    missing = []
    for module, package in (("PIL", "pillow"), ("numpy", "numpy"), ("scipy", "scipy")):
        try:
            importlib.import_module(module)
        except ImportError:
            missing.append(package)
    if missing:
        sys.stderr.write(json.dumps({"missing": missing}))
        sys.exit(MISSING_LIBRARIES)


def parse_key(text):
    return tuple(int(text[index : index + 2], 16) for index in (0, 2, 4))


def hex_colour(key):
    return "#" + "".join(f"{value:02X}" for value in key)


def load_image(path):
    """`(rgb, opacity)` as float arrays; `opacity` (0 to 1) is None unless the image has transparency."""
    import numpy as np
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(path) as image:
            image.load()
            rgba = np.asarray(image.convert("RGBA"), dtype=np.float32)
    except (UnidentifiedImageError, OSError) as error:
        raise Refused(f"{path} is not an image Pillow can read ({error}).") from error
    opacity = rgba[..., 3] / 255.0
    return rgba[..., :3], (opacity if opacity.min() < 1.0 else None)


def colour_distance(pixels, colour):
    """RGB distance of each pixel (or of each row of `pixels`) from `colour`."""
    import numpy as np

    return np.sqrt(((pixels - np.asarray(colour, dtype=np.float32)) ** 2).sum(axis=-1))


def key_opacity(rgb, key, tolerance):
    """Opacity per pixel from 0 to 1: clear within `tolerance` of the key, solid past the soft edge."""
    import numpy as np

    return np.clip((colour_distance(rgb, key) - tolerance) / SOFT_EDGE, 0.0, 1.0)


def despill(rgb, opacity, key):
    """Pull the key colour's cast out of the pixels along the cut edge.

    The key's dominant channels (green, for #00FF00) are capped at the
    strongest of the other channels, the classic despill, but only near the
    cleared background (see SPILL_BAND_*) and in half-clear pixels.
    """
    import numpy as np
    from scipy import ndimage

    dominant = [channel for channel in range(3) if key[channel] > 127]
    others = [channel for channel in range(3) if key[channel] <= 127]
    if not dominant or not others:
        return rgb  # a grey or white key has no cast to remove

    band = max(SPILL_BAND_MIN, round(SPILL_BAND_SHARE * min(opacity.shape)))
    cleared = opacity <= 0.0
    edge = (ndimage.binary_dilation(cleared, iterations=band) & ~cleared) | ((opacity > 0.0) & (opacity < 1.0))
    ceiling = rgb[..., others].max(axis=-1)
    result = rgb.copy()
    for channel in dominant:
        result[..., channel] = np.where(edge, np.minimum(rgb[..., channel], ceiling), rgb[..., channel])
    return result


def save_rgba(path, rgb, opacity):
    import numpy as np
    from PIL import Image

    rgba = np.dstack([rgb, opacity * 255.0]).round().clip(0, 255).astype(np.uint8)
    # A fully clear pixel keeps no colour, so no key colour bleeds back in when the PNG is scaled.
    rgba[rgba[..., 3] == 0, :3] = 0
    Image.fromarray(rgba, "RGBA").save(path)


def cutout(args):
    rgb, existing = load_image(args.input)
    keyed = key_opacity(rgb, args.key, args.tolerance)
    height, width = keyed.shape
    cleared = float((keyed <= 0.0).mean())
    within = f"within {args.tolerance:g} of {hex_colour(args.key)}"
    if cleared == 0.0:
        raise Refused(
            f"no pixel is {within}: this image has no background of that colour. "
            "Pass the background's colour with --key, or raise --tolerance."
        )
    if cleared == 1.0:
        raise Refused(f"the whole image is {within}, so nothing would be left. Lower --tolerance, or check --key.")
    if args.output:
        # An image that already has transparency keeps it.
        opacity = keyed if existing is None else keyed * existing
        save_rgba(args.output, despill(rgb, keyed, args.key), opacity)
    return {"width": width, "height": height, "cleared": round(cleared, 4)}


def corner_key(rgb, tolerance):
    """The sheet's background, from its four corner pixels, which must agree within `tolerance`."""
    import numpy as np

    height, width = rgb.shape[:2]
    corners = np.array([rgb[0, 0], rgb[0, width - 1], rgb[height - 1, 0], rgb[height - 1, width - 1]])
    if max(colour_distance(corners, corner).max() for corner in corners) > tolerance:
        raise Refused(
            "the sheet's corners are not one colour, so its background cannot be told apart. "
            "Pass the background colour with --bg, e.g. --bg #00FF00."
        )
    return tuple(int(value) for value in np.median(corners, axis=0).round())


def near(first, second, gap):
    """Whether two boxes `(y0, x0, y1, x1)` overlap or sit closer than `gap` px on both axes."""
    y_gap = max(second[0] - first[2], first[0] - second[2])
    x_gap = max(second[1] - first[3], first[1] - second[3])
    return y_gap < gap and x_gap < gap


def belongs_together(first, second, gap):
    """A small piece near a much bigger one is part of it; similar sizes stay apart."""
    smaller, bigger = sorted((first["area"], second["area"]))
    return smaller < MERGE_SIZE_RATIO * bigger and near(first["box"], second["box"], gap)


def find_items(opacity):
    """`(labels, items)`: the separate items, each `{"box": [y0, x0, y1, x1], "labels": {...}, "area": px}`."""
    import numpy as np
    from scipy import ndimage

    height, width = opacity.shape
    labels, count = ndimage.label(opacity > 0.0, structure=np.ones((3, 3)))
    areas = ndimage.sum(np.ones_like(opacity), labels, index=np.arange(1, count + 1))
    items = [
        {"box": [box[0].start, box[1].start, box[0].stop, box[1].stop], "labels": {label}, "area": float(area)}
        for label, (box, area) in enumerate(zip(ndimage.find_objects(labels), areas), start=1)
    ]

    merged = True
    while merged:
        merged = False
        for first in range(len(items)):
            for second in range(first + 1, len(items)):
                if belongs_together(items[first], items[second], MERGE_GAP * width):
                    kept, joined = items[first], items.pop(second)
                    kept["box"] = [
                        min(kept["box"][0], joined["box"][0]),
                        min(kept["box"][1], joined["box"][1]),
                        max(kept["box"][2], joined["box"][2]),
                        max(kept["box"][3], joined["box"][3]),
                    ]
                    kept["labels"] |= joined["labels"]
                    kept["area"] += joined["area"]
                    merged = True
                    break
            if merged:
                break

    items = [item for item in items if item["area"] >= MIN_AREA * width * height]
    return labels, reading_order(items)


def reading_order(items):
    """Row by row, top to bottom, and left to right within a row.

    An item joins the row above when its vertical centre falls inside that
    row's span, so a slightly uneven grid still reads as a grid.
    """
    rows = []
    for item in sorted(items, key=lambda item: item["box"][0]):
        y0, _, y1, _ = item["box"]
        centre = (y0 + y1) / 2
        if rows and rows[-1]["top"] <= centre <= rows[-1]["bottom"]:
            rows[-1]["items"].append(item)
            rows[-1]["bottom"] = max(rows[-1]["bottom"], y1)
        else:
            rows.append({"top": y0, "bottom": y1, "items": [item]})
    return [item for row in rows for item in sorted(row["items"], key=lambda item: item["box"][1])]


def split(args):
    import numpy as np

    rgb, existing = load_image(args.input)
    if existing is not None:
        # Already cut out (e.g. by `cutout`): split along its own transparency.
        key, opacity, colour = None, existing, rgb
    else:
        key = corner_key(rgb, args.tolerance) if args.bg == "auto" else parse_key(args.bg)
        opacity = key_opacity(rgb, key, args.tolerance)
        colour = despill(rgb, opacity, key)
    sheet_height, sheet_width = opacity.shape
    labels, items = find_items(opacity)

    if not items:
        raise Refused("no item found on the sheet: it is all background.")
    for number, item in enumerate(items, start=1):
        y0, x0, y1, x1 = item["box"]
        if y0 == 0 or x0 == 0 or y1 == sheet_height or x1 == sheet_width:
            raise Refused(
                f"item {number} touches the edge of the sheet, so it was probably cut off when the sheet was drawn. "
                "Generate the sheet again with a clear margin around every item."
            )
    if args.expect is not None and len(items) != args.expect:
        raise Refused(
            f"found {len(items)} items, expected {args.expect}. Items that touch come out as one; "
            "generate the sheet again with clear gaps between them."
        )

    item_widths = [item["box"][3] - item["box"][1] for item in items]
    item_heights = [item["box"][2] - item["box"][0] for item in items]
    # One canvas for the set: the widest and the tallest item, plus one margin
    # of ~6% of the largest item side all round.
    pad = max(1, round(0.06 * max(item_widths + item_heights)))
    canvas_width, canvas_height = max(item_widths) + 2 * pad, max(item_heights) + 2 * pad

    if args.outputs:
        for item, item_width, item_height, output in zip(items, item_widths, item_heights, args.outputs):
            y0, x0, y1, x1 = item["box"]
            own = np.isin(labels[y0:y1, x0:x1], list(item["labels"]))
            canvas_rgb = np.zeros((canvas_height, canvas_width, 3), dtype=np.float32)
            canvas_opacity = np.zeros((canvas_height, canvas_width), dtype=np.float32)
            # Centred across, standing on one baseline: feet line up in a turnaround.
            left = (canvas_width - item_width) // 2
            top = canvas_height - pad - item_height
            canvas_rgb[top : top + item_height, left : left + item_width] = colour[y0:y1, x0:x1]
            canvas_opacity[top : top + item_height, left : left + item_width] = opacity[y0:y1, x0:x1] * own
            save_rgba(output, canvas_rgb, canvas_opacity)

    return {"count": len(items), "canvas": [canvas_width, canvas_height], "key": hex_colour(key) if key else None}


def main():
    parser = argparse.ArgumentParser(prog="chroma.py")
    commands = parser.add_subparsers(dest="command", required=True)

    cut = commands.add_parser("cutout")
    cut.add_argument("input")
    cut.add_argument("--key", type=parse_key, required=True)
    cut.add_argument("--tolerance", type=float, required=True)
    cut.add_argument("--output")
    cut.set_defaults(handler=cutout)

    sheet = commands.add_parser("split")
    sheet.add_argument("input")
    sheet.add_argument("--bg", required=True)
    sheet.add_argument("--tolerance", type=float, required=True)
    sheet.add_argument("--expect", type=int)
    sheet.add_argument("--outputs", nargs="+")
    sheet.set_defaults(handler=split)

    args = parser.parse_args()
    require_libraries()
    try:
        result = args.handler(args)
    except Refused as refusal:
        sys.stderr.write(str(refusal))
        sys.exit(REFUSED)
    except Exception:  # anything else is a bug or a broken file: a failure, with its traceback
        traceback.print_exc()
        sys.exit(FAILED)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
