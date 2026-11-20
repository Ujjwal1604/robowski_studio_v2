"""Re-plot extracted TLC lanes onto a human-readable 6x9 (A-F, 1-9) plate layout.

Two hardcoded lane_id -> plate-position dictionaries (LANE_LOCATIONS_SERIAL and
LANE_LOCATIONS_PARALLEL) describe how lanes were loaded onto the physical plate;
edit them by hand to match the real loading order. Running this script produces
two overview images:

    <target_dir>/plate_overview_serial.png
    <target_dir>/plate_overview_parallel.png

Each of the 54 grid cells shows three channel strips, tightly side by side:
    UV254 (Viridis colormap of the green channel), UV366 (color), White (color).
A cropped header (the pencil-written plate annotation) sits above the grid, and
row letters / column numbers / a 0-53 raster index are overlaid for orientation.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np

from get_lanes import extract_lane_profiles, find_images, load_config

_VIRIDIS = plt.get_cmap('viridis')

ROWS = "ABCDEF"
COLS = range(1, 10)
N_ROWS, N_COLS = len(ROWS), len(COLS)

EMPTY_CELL_COLOR = (200, 200, 200)   # BGR fill for plate positions with no assigned lane

# ── lane_id -> plate position ("A1" .. "F9") ─────────────────────────────────
# The defaults below are just a plausible starting point (row-major "serial" /
# column-major "parallel" loading order). EDIT THESE BY HAND to match how the
# lanes were actually loaded onto the plate.
LANE_LOCATIONS_SERIAL = {
    lane_id-1: f"{row}{col}"
    for lane_id, (row, col) in enumerate(
        ((r, c) for r in ROWS for c in COLS), start=1)
}
# LANE_LOCATIONS_PARALLEL = {
#     lane_id-1: f"{row}{col}"
#     for lane_id, (row, col) in enumerate(
#         ((r, c) for c in COLS for r in ROWS), start=1)
# }

# This correspondence reflects the parallel spotting sequence performed by Hamilton Vantage
LANE_LOCATIONS_PARALLEL = {
    0: 'A1',
    1: 'D5',
    2: 'B1',
    3: 'E5',
    4: 'C1',
    5: 'F5',
    6: 'D1',
    7: 'A6',
    8: 'E1',
    9: 'B6',
    10: 'F1',
    11: 'C6',
    12: 'A2',
    13: 'D6',
    14: 'B2',
    15: 'E6',
    16: 'C2',
    17: 'F6',
    18: 'D2',
    19: 'A7',
    20: 'E2',
    21: 'B7',
    22: 'F2',
    23: 'C7',
    24: 'A3',
    25: 'D7',
    26: 'B3',
    27: 'E7',
    28: 'C3',
    29: 'F7',
    30: 'D3',
    31: 'A8',
    32: 'E3',
    33: 'B8',
    34: 'F3',
    35: 'C8',
    36: 'A4',
    37: 'D8',
    38: 'B4',
    39: 'E8',
    40: 'C4',
    41: 'F8',
    42: 'D4',
    43: 'A9',
    44: 'E4',
    45: 'B9',
    46: 'F4',
    47: 'C9',
    48: 'A5',
    49: 'D9',
    50: 'B5',
    51: 'E9',
    52: 'C5',
    53: 'F9'
}


# ── crop of the White-channel image containing the pencil-written header ────
# (x, y) is the top-left corner, in source image pixel coordinates. EDIT ME to
# match where the plate sits in the camera frame.
HEADER_REGION = {"x": 482, "y": 1220, "width": 2290, "height": 130}


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Re-plot TLC lanes onto a 6x9 (A-F, 1-9) plate overview")
    parser.add_argument("target_dir", type=Path, help="directory containing .npy image files")
    parser.add_argument("--config", type=Path, default=None,
                        help="path to lane config CSV (default: <target_dir>/lane_config.csv)")
    parser.add_argument("--scale-white", type=float, default=2100)
    parser.add_argument("--scale-uv254", type=float, default=11000)
    parser.add_argument("--scale-uv366", type=float, default=60000)
    parser.add_argument("--target-width", type=int, default=3000,
                        help="approximate total pixel width of the 9-column grid (default: 3000)")
    parser.add_argument("--cell-gap", type=int, default=30,
                        help="pixel gap between adjacent grid cells (default: 10)")
    parser.add_argument("--out-suffix", type=str, default=None,
                        help="suffix to be appended to the filename of the output image (default: None)")
    return parser.parse_args()


def validate_mapping(lanes: list[dict], mapping: dict[int, str], name: str) -> None:
    """Every lane id must have exactly one plate position and vice versa; every
    position must be a real A1..F9 cell, used at most once."""
    lane_ids = {lane['id'] for lane in lanes}
    mapped_ids = set(mapping)
    if lane_ids != mapped_ids:
        raise ValueError(
            f"{name}: lane ids in config and mapping disagree. "
            f"In config but unmapped: {sorted(lane_ids - mapped_ids)}. "
            f"Mapped but absent from config: {sorted(mapped_ids - lane_ids)}.")

    valid_positions = {f"{r}{c}" for r in ROWS for c in COLS}
    positions = list(mapping.values())
    if invalid := set(positions) - valid_positions:
        raise ValueError(f"{name}: invalid plate positions: {sorted(invalid)}")
    if len(set(positions)) != len(positions):
        dupes = {p for p in positions if positions.count(p) > 1}
        raise ValueError(f"{name}: plate positions assigned more than once: {sorted(dupes)}")


def render_uv254(profile: np.ndarray, scale: float) -> np.ndarray:
    """UV254 green channel -> Viridis, BGR uint8. The mapping uses a fixed [0,255]
    range (via the 256-level Viridis LUT), so color-to-signal correspondence stays
    identical across lanes and across separate runs of this script."""
    green = np.clip(profile[:, :, 1] * scale, 0, 255).astype(np.uint8)
    rgba = _VIRIDIS(green)                     # integer input -> exact LUT index, 0..255
    rgb = (rgba[:, :, :3] * 255).astype(np.uint8)
    return rgb[:, :, ::-1]                     # RGB -> BGR, to match the rest of the pipeline


def render_raw(profile: np.ndarray, scale: float) -> np.ndarray:
    """Scale-and-clip a raw BGR profile to uint8 -- the same transform
    get_lanes.create_visualizations uses for "as is" channel display."""
    return np.clip(profile * scale, 0, 255).astype(np.uint8)


def pad_to(img: np.ndarray, target_h: int, target_w: int) -> np.ndarray:
    """Zero-pad an (h, w, 3) array at the bottom/right up to (target_h, target_w, 3)."""
    h, w = img.shape[:2]
    if (h, w) == (target_h, target_w):
        return img
    padded = np.zeros((target_h, target_w, 3), dtype=img.dtype)
    padded[:h, :w] = img
    return padded


def canonical_geometry(lanes: list[dict]) -> tuple[int, int]:
    """Largest length/width across all lanes; used as the uniform per-cell size so every
    grid cell lines up (shorter/narrower lanes are zero-padded up to this size)."""
    return max(lane['length'] for lane in lanes), max(lane['width'] for lane in lanes)


def compute_channel_width(target_width_px: int, cell_gap: int) -> int:
    """Per-channel pixel width so that 9 columns of 3 channels, separated by cell_gap,
    sum to approximately target_width_px. The resulting shrink factor (relative to the
    source lane width) is whatever falls out of this -- no particular value is required."""
    available = target_width_px - (N_COLS - 1) * cell_gap
    channel_width = available // (N_COLS * 3)
    assert channel_width >= 2, (
        f"--target-width={target_width_px} too small for {N_COLS} columns "
        f"with --cell-gap={cell_gap}; increase target width or reduce the gap")
    return channel_width


def build_lane_triplet(images: dict[str, np.ndarray], lane: dict,
                       scale_factors: dict[str, float],
                       canonical_length: int, canonical_width: int,
                       channel_width: int) -> np.ndarray:
    """Extract, render and horizontally shrink one lane's three channel strips,
    placed tightly side by side. Returns (canonical_length, 3*channel_width, 3) uint8 BGR."""
    strips = []
    for channel in ('UV254', 'White', 'UV366'):
        profile = extract_lane_profiles(images[channel], lane)
        profile = pad_to(profile, canonical_length, canonical_width)

        rendered = (render_uv254(profile, scale_factors['UV254']) if channel == 'UV254'
                   else render_raw(profile, scale_factors[channel]))

        # Aspect ratio is deliberately not preserved here: only the width (the axis
        # orthogonal to Rf) is resized, so the Rf axis (length) keeps full pixel detail.
        strips.append(cv2.resize(rendered, (channel_width, canonical_length),
                                 interpolation=cv2.INTER_AREA))

    return np.concatenate(strips, axis=1)


def extract_header(white_image: np.ndarray, scale: float, target_width_px: int) -> np.ndarray:
    """Crop the pencil-written header out of the raw White-channel image, scale it for
    brightness like the rest of White, and resize to the grid's width, aspect preserved."""
    x, y, w, h = (HEADER_REGION[k] for k in ('x', 'y', 'width', 'height'))
    rendered = render_raw(white_image[y:y + h, x:x + w, :], scale)

    new_h = round(h * target_width_px / w)
    return cv2.resize(rendered, (target_width_px, new_h), interpolation=cv2.INTER_AREA)


def render_plate(images: dict[str, np.ndarray], lanes: list[dict], mapping: dict[int, str],
                 scale_factors: dict[str, float], target_width_px: int, cell_gap: int,
                 out_path: Path) -> None:
    """Compose and save the full 6x9 plate overview for one lane_id -> position mapping."""
    canonical_length, canonical_width = canonical_geometry(lanes)
    channel_width = compute_channel_width(target_width_px, cell_gap)
    # print(f"  lane canvas {canonical_length}x{canonical_width}px -> {channel_width}px per channel "
    #      f"(~{canonical_width / channel_width:.1f}x horizontal shrink)")

    cell_w, cell_h = 3 * channel_width, canonical_length
    lane_by_id = {lane['id']: lane for lane in lanes}
    position_to_lane = {pos: lane_id for lane_id, pos in mapping.items()}

    grid_w = N_COLS * cell_w + (N_COLS - 1) * cell_gap
    grid_h = N_ROWS * cell_h + (N_ROWS - 1) * cell_gap
    canvas = np.full((grid_h, grid_w, 3), 255, dtype=np.uint8)

    for row_idx, row in enumerate(ROWS):
        y0 = row_idx * (cell_h + cell_gap)
        for col_idx, col in enumerate(COLS):
            x0 = col_idx * (cell_w + cell_gap)
            position = f"{row}{col}"
            cell = (build_lane_triplet(images, lane_by_id[position_to_lane[position]],
                                       scale_factors, canonical_length, canonical_width, channel_width)
                   if position in position_to_lane else
                   np.full((cell_h, cell_w, 3), EMPTY_CELL_COLOR, dtype=np.uint8))
            # canvas[y0:y0 + cell_h, x0:x0 + cell_w] = cell
            # show vertically flipped cell, instead of the original one
            canvas[y0:y0 + cell_h, x0:x0 + cell_w] = np.flipud(cell)

    header = extract_header(images['White'], scale_factors['White'], grid_w)

    # ── figure: header on top, grid below, row/column labels as axis ticks ──
    dpi = 100
    fig, (header_ax, grid_ax) = plt.subplots(
        2, 1, dpi=dpi,
        figsize=(grid_w / dpi, (header.shape[0] + grid_h) / dpi - 0.2),
        gridspec_kw={'height_ratios': [header.shape[0], grid_h], 'hspace': 0.02})

    header_ax.imshow(header[:, :, ::-1], interpolation='nearest')   # BGR -> RGB
    header_ax.axis('off')

    grid_ax.imshow(canvas[:, :, ::-1], interpolation='nearest')
    grid_ax.set_yticks([row_idx * (cell_h + cell_gap) + cell_h / 2 for row_idx in range(N_ROWS)])
    grid_ax.set_yticklabels(list(ROWS))
    grid_ax.set_xticks([col_idx * (cell_w + cell_gap) + cell_w / 2 for col_idx in range(N_COLS)])
    grid_ax.set_xticklabels([str(c) for c in COLS])
    grid_ax.xaxis.set_ticks_position('top')
    grid_ax.tick_params(length=0)
    # set tick font size to 20
    grid_ax.tick_params(axis='both', which='major', labelsize=20)
    for spine in grid_ax.spines.values():
        spine.set_visible(False)

    # Small 0-53 raster index near each cell (row-major: A1=0 .. F9=53), white-outlined
    # so it stays legible over whatever colour happens to be underneath.
    for row_idx in range(N_ROWS):
        for col_idx in range(N_COLS):
            x0 = col_idx * (cell_w + cell_gap)
            y0 = row_idx * (cell_h + cell_gap)
            grid_ax.text(x0 + 3, y0 + 3, str(row_idx * N_COLS + col_idx),
                        fontsize=16, color='black', ha='left', va='top',
                        path_effects=[pe.withStroke(linewidth=1.5, foreground='white')])

        # On every cell of the grid, superimpose a alpha=0.5 axhline on top of the image at 20%, 40%, 60%, 80% of the grid height, to help visually separate the rows
        array_of_rf_lines = np.linspace(0.06, 0.86, 6)

        for rf_line in array_of_rf_lines:
            y = y0 + rf_line * cell_h
            grid_ax.axhline(y=y, color='black', alpha=0.3, lw=3, linestyle='--')

    fig.savefig(out_path, dpi=dpi, bbox_inches='tight')
    plt.close(fig)


def main() -> None:
    args = parse_args()
    assert args.target_dir.is_dir(), f"not a directory: {args.target_dir}"

    image_paths = find_images(args.target_dir)
    images = {ch: np.load(p) for ch, p in image_paths.items()}

    config_path = args.config or (args.target_dir / "lane_config.csv")
    assert config_path.exists(), f"lane config not found: {config_path}"
    lanes = load_config(config_path)

    scale_factors = {'White': args.scale_white, 'UV254': args.scale_uv254, 'UV366': args.scale_uv366}

    for mapping, suffix in ((LANE_LOCATIONS_SERIAL, 'serial'), (LANE_LOCATIONS_PARALLEL, 'parallel')):
        validate_mapping(lanes, mapping, suffix)
        if args.out_suffix is not None:
            out_path = args.target_dir / f"summary_{args.out_suffix}_{suffix}.png"
        else:
            out_path = args.target_dir / f"summary_{suffix}.png"
        print(f"rendering {suffix} layout...")
        render_plate(images, lanes, mapping, scale_factors, args.target_width, args.cell_gap, out_path)
        print(f"wrote {out_path}")


if __name__ == "__main__":
    main()