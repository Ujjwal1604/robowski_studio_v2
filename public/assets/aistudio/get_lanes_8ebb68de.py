"""Extract densitograms from rectangular lanes in multi-channel TLC images."""
from __future__ import annotations

import argparse
import csv
import shutil
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
from matplotlib import pyplot as plt
from scipy.interpolate import BSpline, LSQUnivariateSpline
from scipy.optimize import least_squares
from scipy.signal import savgol_filter
from skimage.measure import profile_line

LANE_BORDER_THICKNESS = 2


def parse_args():
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description="Extract lane densitograms")
    parser.add_argument("target_dir", type=Path, help="directory containing .npy image files")
    parser.add_argument("--config", type=Path, help="path to lane config CSV")
    parser.add_argument("--scale-white", type=float, default=2100)
    parser.add_argument("--scale-uv254", type=float, default=11000)
    parser.add_argument("--scale-uv366", type=float, default=60000)
    parser.add_argument("--agg-func", type=str, default="mean",
                        choices=["mean", "max", "savgol4_25max", "savgol4_25middle", "sides_2px",
                                 "savgol_automiddle"],
                        help="aggregation function across lane width")
    parser.add_argument("--microadjust", action="store_true",
                        help="perform microadjustment of lane positions and angles")
    parser.add_argument("--ma-channel", type=str, default="UV254",
                        choices=["White", "UV254", "UV366"],
                        help="channel for microadjustment (default: UV254)")
    parser.add_argument("--ma-color-idx", type=int, default=1,
                        choices=[0, 1, 2],
                        help="color index for microadjustment: 0=blue, 1=green, 2=red (default: 1)")
    parser.add_argument("--ma-search-center", type=int, default=150,
                        help="search zone center distance from lane start (default: 150)")
    parser.add_argument("--ma-search-length", type=int, default=80,
                        help="search zone length (default: 80)")
    parser.add_argument("--ma-radius-min", type=int, default=12,
                        help="minimum spot radius (default: 12)")
    parser.add_argument("--ma-radius-max", type=int, default=24,
                        help="maximum spot radius (default: 24)")
    parser.add_argument("--ma-opt-length", type=int, default=800,
                        help="probe line length for angle optimization (default: 800)")
    parser.add_argument("--ma-angle-range", type=float, nargs=2, default=[-4, 4],
                        help="angle search range in degrees (default: -4 4)")
    parser.add_argument("--ma-angle-step", type=float, default=0.2,
                        help="angle search step in degrees (default: 0.2)")
    parser.add_argument("--automiddle-fscale", type=float, default=15.0,
                        help="robust-fit inlier scale in pixels for savgol_automiddle (default: 15)")
    parser.add_argument("--automiddle-tail-ignore", type=int, default=50,
                        help="number of Rf points at the far end of the lane to exclude from spline fitting (default: 50)")
    return parser.parse_args()


def find_images(target_dir: Path) -> dict[str, Path]:
    """Return dict mapping channel name to .npy file path."""
    files = list(target_dir.glob("uni_linint_corrected_*_*.npy"))
    result = {}
    for f in files:
        channel = f.stem.split('_')[-1]
        assert channel in ('White', 'UV254', 'UV366'), f"unexpected channel: {channel}"
        result[channel] = f
    assert len(result) == 3, f"expected 3 channels, found {len(result)}"
    return result


def load_config(config_path: Path) -> list[dict]:
    """Load lane configuration from CSV."""
    with open(config_path) as f:
        reader = csv.DictReader(f)
        return [{
            'id': int(row['id']),
            'x0': int(row['x0']),
            'y0': int(row['y0']),
            'length': int(row['length']),
            'width': int(row['width']),
            'direction_angle': float(row['direction_angle']),
        } for row in reader]


def find_dark_circle(image: np.ndarray, lane: dict, color_idx: int,
                     search_zone_center: int, search_zone_length: int,
                     radius_min: int, radius_max: int) -> tuple[int, int, int]:
    """Find dark circle on light background. Search is based on convolution. Returns (y, x, radius).
    Does not support input lane direction_angle other than 0 or 180 degrees.

    Args:
        image: BGR image (H×W×3)
        lane: lane configuration dict. Does not support input lane direction_angle other than 0 or 180 degrees.
        color_idx: 0=blue, 1=green, 2=red
        search_zone_center: pixels from lane start to search zone center (down the lane)
        search_zone_length: length of search zone along lane (pixels)
        radius_min: minimum circle radius (pixels)
        radius_max: maximum circle radius (pixels)
    """
    x0, y0 = lane['x0'], lane['y0']
    width, angle = lane['width'], lane['direction_angle']

    x_start = x0 - width // 2
    y_center = (y0 - search_zone_center) if angle == 0 else (y0 + search_zone_center)
    y_start = y_center - search_zone_length // 2

    search_zone = image[y_start: y_start + search_zone_length,
           x_start: x_start + width,
           color_idx].astype(np.float32)

    best_score, best_radius, best_location = float('-inf'), radius_min, (0, 0)

    for r in range(radius_min, radius_max + 1):     # test circles of different radii, see which gives highest response
        yy, xx = np.ogrid[-2*r:2*r + 1, -2*r:2*r + 1]       # coordinate grids
        distance = np.sqrt(xx ** 2 + yy ** 2)                 # field of squared distances from center
        # make the values -1 inside the circle of radius r, and +1 outside the circle of radius sqrt(2)*r,
        # with a smooth transition in between. This way, when we convolve with the image, a darker circle will give a
        # higher positive response, and a brighter circle will give a lower negative response. The transition region
        # helps to make the response more robust to slight misalignments.
        transition_width = 0.3
        kernel = (-1 + 2 / (1 + np.exp(-(distance - r) / (transition_width))) -
                  1 / (1 + np.exp(-(distance - np.sqrt(2) * r) / (transition_width))))
        kernel[kernel >= 0] /= kernel[kernel >= 0].sum()   # normalize positive weights to sum to 1
        kernel[kernel < 0] /= -kernel[kernel < 0].sum()    # normalize negative weights to sum to -1

        response = cv2.filter2D(search_zone, -1, kernel, borderType=cv2.BORDER_REPLICATE) # convolution
        max_response = response.max()

        if max_response > best_score: # higher response means a darker and better matching circle found
            best_score = max_response
            best_radius = r
            best_location = np.unravel_index(response.argmax(), response.shape)

    return y_start + best_location[0], x_start + best_location[1], best_radius


def find_optimal_angle(image: np.ndarray, lane: dict, color_idx: int,
                       vantage_point: tuple[int, int], length=None,
                       angle_range_deg: tuple[float, float] = (-7, 7),
                       angle_step: float = 0.1, pad: int = 20,
                       linewidth_of_integration: int = 3) -> tuple[float, int, int]:
    """Find angle minimizing integral intensity along probe line. Returns (best_angle, new_x0, new_y0).
    Does not support input lane direction_angle other than 0 or 180 degrees.

    Args:
        image: BGR image (H×W×3)
        lane: lane configuration dict. Does not support input lane direction_angle other than 0 or 180 degrees.
        color_idx: 0=blue, 1=green, 2=red
        vantage_point: (y, x) starting point for probe lines in image coordinates
        angle_range_deg: angle range to sweep around lane's direction_angle
        angle_step: angular resolution in degrees
        pad: pixels of padding when cropping image for speedup
        linewidth_of_integration: width of probe line (in pixels)

    Returns:
        (best_angle, new_x0, new_y0) where best_angle is in degrees (absolute angle,
        not offset), and (new_x0, new_y0) is the start point of the optimally oriented lane
    """
    vy, vx = vantage_point
    if length is None:      # default: probe line extends to lane, but starts at vantage point instead of lane start
        distance_from_vantage_point_to_lane_start = np.hypot(lane['y0'] - vy, lane['x0'] - vx)
        length = lane['length'] - distance_from_vantage_point_to_lane_start
    base_angle = lane['direction_angle']
    min_angle = base_angle + angle_range_deg[0]
    max_angle = base_angle + angle_range_deg[1]

    # To speed up the profile_line() operation, we crop the image size from 8 megapixels to just the fan-shaped region
    # containing all probe lines, plus a small padding.
    end_points = []
    for theta in [min_angle, max_angle]:
        theta_rad = np.deg2rad(theta)
        end_y = vy - length * np.cos(theta_rad)
        end_x = vx + length * np.sin(theta_rad)
        end_points.append((end_y, end_x))

    all_y = [vy] + [p[0] for p in end_points]
    all_x = [vx] + [p[1] for p in end_points]

    y_min, y_max = int(np.floor(min(all_y))), int(np.ceil(max(all_y)))
    x_min, x_max = int(np.floor(min(all_x))), int(np.ceil(max(all_x)))

    y_min, y_max = max(0, y_min - pad), min(image.shape[0], y_max + pad)
    x_min, x_max = max(0, x_min - pad), min(image.shape[1], x_max + pad)

    cropped = image[y_min:y_max, x_min:x_max, color_idx]
    vy_crop, vx_crop = vy - y_min, vx - x_min

    # Preparation of the cropped image done. Now sweep angles and find best one.
    best_score, best_angle = float('inf'), base_angle
    angles = np.arange(min_angle, max_angle + angle_step, angle_step)

    for theta in angles:
        theta_rad = np.deg2rad(theta)
        end_y_crop = vy_crop - length * np.cos(theta_rad)
        end_x_crop = vx_crop + length * np.sin(theta_rad)

        profile = profile_line(cropped, (vy_crop, vx_crop), (end_y_crop, end_x_crop),
                               order=2, mode='constant', linewidth=linewidth_of_integration)

        # Using profile.mean() rather than profile.sum(). This is critical because profile_line
        # samples max(|Δy|, |Δx|) + 1 points, which varies with angle (e.g., 45 degree lines get 30% fewer samples than
        # zero degree. The mean normalizes for different sample counts, and since all probe lines have identical
        # length, minimizing mean intensity is equivalent to minimizing the integral \int I(s)ds.
        score = profile.mean()

        if score < best_score:
            best_score = score
            best_angle = theta

    # find new x0 and new y0
    old_distance_from_vantage_point_to_lane_start = np.hypot(lane['y0'] - vy, lane['x0'] - vx)
    new_x0 = vx - old_distance_from_vantage_point_to_lane_start * np.sin(np.deg2rad(best_angle))
    new_y0 = vy + old_distance_from_vantage_point_to_lane_start * np.cos(np.deg2rad(best_angle))
    # assert the new distance is the same as old distance
    new_distance = np.hypot(new_y0 - vy, new_x0 - vx)

    return best_angle, int(round(new_x0)), int(round(new_y0))


def extract_lane_profiles(image: np.ndarray, lane: dict) -> np.ndarray:
    """Extract raw width profiles along lane. Returns shape (length, width, 3)."""
    x0, y0 = lane['x0'], lane['y0']
    length, width = lane['length'], lane['width']
    angle = lane['direction_angle']

    profiles = np.zeros((length, width, 3), dtype=np.float32)

    # Fast path for vertical lanes
    if abs(angle) < 0.1 or abs(abs(angle) - 180) < 0.1:
        x_start, x_end = x0 - width // 2, x0 - width // 2 + width
        for i in range(length):
            y = y0 - i if abs(angle) < 90 else y0 + i
            row = image[y, x_start:x_end, :]
            # For angle≈180° the lane goes downward, so the perpendicular vector
            # points leftward (-x).  The general rotation code stores pixels from
            # right (offset 0, negative-perp end) to left (offset width-1), which
            # is the convention assumed by apply_aggregation and create_visualizations.
            # A naive left-to-right slice contradicts that, so we flip the row.
            profiles[i] = row[::-1] if abs(angle - 180) < 0.1 else row
        return profiles

    # General case: rotate image to make lane vertical
    angle_rad = np.deg2rad(angle)
    end_x = x0 + length * np.sin(angle_rad)
    end_y = y0 - length * np.cos(angle_rad)

    center_x, center_y = (x0 + end_x) / 2, (y0 + end_y) / 2

    pad = int(max(length * 0.6, width * 3, 200))
    all_x, all_y = [x0, end_x, center_x], [y0, end_y, center_y]
    x_min = int(max(0, min(all_x) - pad))
    x_max = int(min(image.shape[1], max(all_x) + pad))
    y_min = int(max(0, min(all_y) - pad))
    y_max = int(min(image.shape[0], max(all_y) + pad))

    cropped = image[y_min:y_max, x_min:x_max, :]
    x0_crop, y0_crop = x0 - x_min, y0 - y_min
    center_crop = (center_x - x_min, center_y - y_min)

    # # resize down, so that it fits on screen. But keep aspect ratio
    # max_vis_size = 800
    # vis = cv2.normalize(cropped, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)
    #
    # # plot the center point and the x0,y0 point on the cropped image, to verify that cropping is correct
    # cv2.circle(vis, (int(center_crop[0]), int(center_crop[1])), 5, (0, 255, 0), -1)  # center point in green
    # cv2.circle(vis, (int(x0_crop), int(y0_crop)), 5, (255, 0, 0), -1)  # x0,y0 point in blue
    #
    # if max(vis.shape) > max_vis_size:
    #     scale = max_vis_size / max(vis.shape)
    #     vis = cv2.resize(vis, (int(vis.shape[1] * scale), int(vis.shape[0] * scale)))
    # cv2.imshow("Rotated Crop", vis)
    # cv2.waitKey(0)


    rotation_matrix = cv2.getRotationMatrix2D(center_crop, angle, 1.0)
    rotated = cv2.warpAffine(cropped, rotation_matrix, (cropped.shape[1], cropped.shape[0]),
                             flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    cos_a, sin_a = np.cos(angle_rad), np.sin(angle_rad)
    dx, dy = x0_crop - center_crop[0], y0_crop - center_crop[1]
    x0_rot = center_crop[0] + dx * cos_a + dy * sin_a
    y0_rot = center_crop[1] - dx * sin_a + dy * cos_a

    x_start = int(x0_rot - width // 2)
    x_end = x_start + width


    ##  DEBUGGING
    ##  Show the cropped and rotated image with the original and new lane start points marked, to verify correctness of rotation
    # # print x start and x end
    # print(f'x_start: {x_start}, x_end: {x_end}')
    # # Normalize for visualization
    # vis = cv2.normalize(rotated, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)
    # maxv = 200
    # # visuzlization for debugging: draw the lane borders on the rotated image
    # cv2.line(vis, (x_start, 0), (x_start, vis.shape[0]), (maxv, 0, maxv), 1)
    # cv2.line(vis, (x_end, 0), (x_end, vis.shape[0]), (maxv, 0, maxv), 1)
    #
    # cv2.circle(vis, (int(center_crop[0]), int(center_crop[1])), 5, (0, maxv, 0), -1)  # center point in green
    # cv2.circle(vis, (int(x0_rot), int(y0_rot)), 5, (maxv, 0, 0), -1)  # x0,y0 point in blue
    #
    #
    # # resize down, so that it fits on screen. But keep aspect ratio
    # max_vis_size = 800
    # if max(vis.shape) > max_vis_size:
    #     scale = max_vis_size / max(vis.shape)
    #     vis = cv2.resize(vis, (int(vis.shape[1] * scale), int(vis.shape[0] * scale)))
    # cv2.imshow("Rotated Crop", vis)
    # cv2.waitKey(0)

    for i in range(length):
        y = int(y0_rot - i)
        assert 0 <= y < rotated.shape[0] and 0 <= x_start and x_end <= rotated.shape[1], \
            f"out of bounds: y={y}, x=[{x_start}, {x_end}], shape={rotated.shape}, angle={angle}, pad={pad}"
        profiles[i] = rotated[y, x_start:x_end, :]

    return profiles


def _savgol_or_raw(signal: np.ndarray) -> np.ndarray:
    """Apply savgol4_25 if signal is long enough, otherwise return as-is."""
    return savgol_filter(signal, 25, 4, mode='mirror') if len(signal) >= 25 else signal


def apply_aggregation(profile: np.ndarray, agg_func: str, offset: int | None = None) -> np.ndarray:
    """Apply aggregation function across lane width.

    Args:
        profile: shape (width, 3)
        agg_func: aggregation mode
        offset: width-coordinate of point P; required for savgol_automiddle
    """
    if agg_func == 'mean':
        return profile.mean(axis=0)
    elif agg_func == 'max':
        return profile.max(axis=0)
    elif agg_func == 'savgol4_25max':
        return np.array([_savgol_or_raw(profile[:, i]).max() for i in range(3)], dtype=np.float32)
    elif agg_func == 'savgol4_25middle':
        return np.array([_savgol_or_raw(profile[:, i])[len(profile) // 2]
                         for i in range(3)], dtype=np.float32)
    elif agg_func == 'sides_2px':
        return (profile[:2, :].mean(axis=0) + profile[-2:, :].mean(axis=0)) / 2
    elif agg_func == 'savgol_automiddle':
        p = offset if offset is not None else len(profile) // 2
        return np.array([_savgol_or_raw(profile[:, i])[p] for i in range(3)], dtype=np.float32)
    else:
        raise ValueError(f"unknown aggregation function: {agg_func}")


def extract_lane(image: np.ndarray, lane: dict, agg_func: str = 'mean',
                 offsets: np.ndarray | None = None) -> np.ndarray:
    """Extract pixel values along lane, aggregated over width. Returns shape (length, 3).

    Args:
        offsets: per-Rf width-coordinate of point P; required when agg_func='savgol_automiddle'
    """
    profiles = extract_lane_profiles(image, lane)
    return np.array([
        apply_aggregation(profiles[i], agg_func, offsets[i] if offsets is not None else None)
        for i in range(lane['length'])
    ], dtype=np.float32)


def compute_lane_offsets(images: dict[str, np.ndarray], lane: dict,
                         scale_factors: dict[str, float],
                         f_scale: float = 15.0,
                         tail_ignore: int = 50,
                         ) -> tuple[np.ndarray, np.ndarray]:
    """Compute per-Rf automiddle offsets P for the synthetic channel S.

    S = scale_uv254 * UV254_green - scale_uv366 * (UV366_red + UV366_green + UV366_blue)

    Processing steps:
      1. Argmin of savgol-smoothed S per row -> raw_offsets.
      2. If microadjust info is present, replace rows 0 ... px_location_of_zero_rf +
         spot_radius_px with the lane centerline (weights unchanged).
      3. Ordinary cubic spline (LSQUnivariateSpline, 2 interior knots) for initial guess.
      4. Robust refinement via least_squares with soft_l1 loss and the given f_scale.
         Both fits use only rows 0 ... length-1-tail_ignore; the spline is then
         evaluated (extrapolated if necessary) over the full lane length.
      5. Evaluate, round, clamp to [0, width-1], re-force masked region to centerline.

    Args:
        f_scale: inlier/outlier threshold in pixels for the robust fit (default 15).
        tail_ignore: rows at the far end of the lane excluded from fitting (default 50).

    Returns:
        (raw_offsets, final_offsets) -- both shape (length,), dtype int32.
        raw_offsets  : argmin values before any replacement (for the red debug polyline).
        final_offsets: robustly-smoothed offsets with masked region forced to centerline
                       (used for extraction and the yellow polyline).
    """
    uv254 = extract_lane_profiles(images['UV254'], lane)   # (length, width, 3)
    uv366 = extract_lane_profiles(images['UV366'], lane)   # (length, width, 3)
    su, sv = scale_factors['UV254'], scale_factors['UV366']
    S = su * uv254[:, :, 1] - sv * uv366.sum(axis=2)      # (length, width)

    length, width = lane['length'], lane['width']
    rows = np.arange(length, dtype=np.float64)
    centerline = width // 2

    S_smooth = np.array([_savgol_or_raw(S[i]) for i in range(length)])   # (length, width)
    raw_offsets = np.argmin(S_smooth, axis=1).astype(np.int32)

    # Step 2: mask rows before/within the application spot (microadjust only)
    mask_end = -1
    if 'px_location_of_zero_rf' in lane and 'spot_radius_px' in lane:
        mask_end = int(np.ceil(lane['px_location_of_zero_rf'] + lane['spot_radius_px']))
        mask_end = min(mask_end, length - 1)

    fit_offsets = raw_offsets.astype(np.float64).copy()
    if mask_end >= 0:
        fit_offsets[:mask_end + 1] = centerline

    # Step 3: initial spline fit via ordinary least squares
    # -------------------------------------------------------
    # We need a starting point for the robust optimiser.  Two interior knots
    # placed uniformly over the unmasked Rf range give us a degree-3 B-spline
    # with 6 free coefficients -- flexible enough to track a gently wandering
    # lane centre without chasing every noisy argmin blip.
    #
    # The far end of the lane (the last tail_ignore rows) is excluded from
    # fitting: that region often contains only solvent front and background,
    # so its argmins are noisy and we prefer to let the spline extrapolate
    # gracefully rather than be yanked sideways by spurious detections.
    fit_end = max(length - tail_ignore, mask_end + 2)   # at least 2 rows to fit
    rows_fit = rows[:fit_end]
    offsets_fit = fit_offsets[:fit_end]

    unmasked_start = float(max(mask_end + 1, 0))
    unmasked_end = float(fit_end - 1)
    interior_knots = np.linspace(unmasked_start, unmasked_end, 4)[1:-1]   # 2 knots

    spline_ols = LSQUnivariateSpline(rows_fit, offsets_fit, t=interior_knots, k=3)

    # The coefficients from the ordinary fit are our initial guess.  We also
    # need the *full* knot vector (with the requisite k+1=4 repetitions at each
    # endpoint) so that scipy.interpolate.BSpline can evaluate the spline for
    # any coefficient vector we hand it during the optimisation.
    c_init = spline_ols.get_coeffs()                                 # shape (6,)
    t_full = np.concatenate([[0.0] * 4, interior_knots, [unmasked_end] * 4])

    # Step 4: robust refinement with soft_l1 loss
    # --------------------------------------------
    # Plain least squares treats every row as equally trustworthy.  But some
    # rows have a noisy or featureless S profile whose argmin is essentially
    # random -- a rogue pixel that drags the spline off-course.  The soft_l1
    # loss function penalises large residuals only *linearly* (rather than
    # quadratically), so those wayward argmins are gently demoted to the status
    # of "interesting suggestions" rather than "binding constraints".
    #
    # The transition between inlier (quadratic) and outlier (linear) behaviour
    # is governed by f_scale: a residual of size f_scale costs roughly as much
    # as a residual of size 1 would under ordinary least squares.  In pixels,
    # f_scale=15 means "I'm prepared to believe the true lane centre is within
    # 15 px of the raw argmin; beyond that, start discounting."

    def residuals(c: np.ndarray) -> np.ndarray:
        # The model is linear in c, so the Jacobian is constant and the
        # optimiser converges in a single Gauss-Newton step -- this is really
        # just a fancy way of solving a robust weighted linear system.
        return BSpline(t_full, c, 3)(rows_fit) - offsets_fit

    result = least_squares(residuals, c_init, loss='soft_l1', f_scale=f_scale)

    # Evaluate the winning spline over all rows, round to the nearest pixel,
    # and clamp so we never accidentally wander off the edge of the lane.
    final_offsets = np.clip(np.round(BSpline(t_full, result.x, 3)(rows)),
                            0, width - 1).astype(np.int32)

    # Step 5: re-force masked region to centerline regardless of spline opinion
    if mask_end >= 0:
        final_offsets[:mask_end + 1] = centerline

    return raw_offsets, final_offsets


def microadjust_lanes(image: np.ndarray, lanes: list[dict], color_idx: int,
                      search_zone_center: int, search_zone_length: int,
                      radius_min: int, radius_max: int,
                      opt_length: int, angle_range_deg: tuple[float, float],
                      angle_step: float) -> list[dict]:
    """Microadjust lane positions and angles using dark circle detection and angle optimization."""
    adjusted_lanes = []

    for lane in lanes:
        y, x, r = find_dark_circle(image, lane, color_idx,
                                   search_zone_center, search_zone_length,
                                   radius_min, radius_max)

        dist_from_circle_center_to_lane_start = np.hypot(lane['y0'] - y, lane['x0'] - x)

        theta, newx, newy = find_optimal_angle(image, lane, color_idx,
                                               vantage_point=(y, x),
                                               length=opt_length,
                                               angle_range_deg=angle_range_deg,
                                               angle_step=angle_step)

        adjusted_lane = lane.copy()
        adjusted_lane['x0'] = newx
        adjusted_lane['y0'] = newy
        adjusted_lane['direction_angle'] = theta
        adjusted_lane['spot_radius_px'] = r
        adjusted_lane['px_location_of_zero_rf'] = dist_from_circle_center_to_lane_start
        adjusted_lanes.append(adjusted_lane)

    return adjusted_lanes


def save_config(lanes: list[dict], config_path: Path) -> None:
    """Save lane configuration to CSV."""
    fieldnames = ['id', 'x0', 'y0', 'length', 'width', 'direction_angle']
    if lanes and 'spot_radius_px' in lanes[0]:
        fieldnames.append('spot_radius_px')
    if lanes and 'px_location_of_zero_rf' in lanes[0]:
        fieldnames.append('px_location_of_zero_rf')

    with open(config_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for lane in lanes:
            writer.writerow({k: lane[k] for k in fieldnames})


def process_lanes(images: dict[str, np.ndarray], lanes: list[dict],
                  scale_factors: dict[str, float], output_dir: Path,
                  agg_func: str = 'mean',
                  automiddle_fscale: float = 15.0,
                  automiddle_tail_ignore: int = 50,
                  ) -> dict[int, tuple[np.ndarray, np.ndarray]] | None:
    """Process all lanes and write CSV files.

    Returns {lane_id: (raw_offsets, final_offsets)} when agg_func='savgol_automiddle',
    for use by create_visualizations; otherwise None.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    lane_offsets: dict[int, tuple[np.ndarray, np.ndarray]] = {}

    for lane in lanes:
        final_offsets = None
        if agg_func == 'savgol_automiddle':
            raw_offsets, final_offsets = compute_lane_offsets(images, lane, scale_factors,
                                                               automiddle_fscale, automiddle_tail_ignore)
            lane_offsets[lane['id']] = (raw_offsets, final_offsets)

            # Write final offsets as a sibling agg-func directory — value broadcast to all channel columns
            offset_dir = output_dir.parent / 'automiddle_px_offset'
            offset_dir.mkdir(parents=True, exist_ok=True)
            offset_data = {'': np.arange(lane['length'])}
            for channel in ('UV254', 'UV366', 'White'):
                for color in ('blue', 'green', 'red'):
                    offset_data[f"{channel}_{color}"] = final_offsets
            pd.DataFrame(offset_data).to_csv(
                offset_dir / f"lane_{lane['id']}_densitogram.csv", index=False)

        data = {'': np.arange(lane['length'])}
        for channel in ('UV254', 'UV366', 'White'):
            values = extract_lane(images[channel], lane, agg_func, final_offsets) * scale_factors[channel]
            for i, color in enumerate(('blue', 'green', 'red')):
                data[f"{channel}_{color}"] = values[:, i]
        pd.DataFrame(data).to_csv(output_dir / f"lane_{lane['id']}_densitogram.csv", index=False)

    return lane_offsets if lane_offsets else None


def create_visualizations(images: dict[str, np.ndarray], image_paths: dict[str, Path],
                          lanes: list[dict], scale_factors: dict[str, float],
                          output_dir: Path,
                          lane_offsets: dict[int, tuple[np.ndarray, np.ndarray]] | None = None) -> None:
    """Create PNG images with lanes superimposed.

    Args:
        lane_offsets: if provided, draws automiddle traces along each lane —
                      red polyline = raw argmin offsets,
                      yellow polyline = spline-smoothed final offsets.
    """
    vis_dir = output_dir / "location_images"
    vis_dir.mkdir(parents=True, exist_ok=True)

    for channel in ('White', 'UV254', 'UV366'):
        clipped = np.clip(images[channel] * scale_factors[channel], 0, 255).astype(np.uint8)

        for lane in lanes:
            x0, y0 = lane['x0'], lane['y0']
            length, width = lane['length'], lane['width']
            angle_rad = np.deg2rad(lane['direction_angle'])

            # Direction and perpendicular vectors
            dx, dy = np.sin(angle_rad), -np.cos(angle_rad)
            perp_x, perp_y = -dy, dx

            # Four corners of lane rectangle
            corners = np.array([
                [x0 - width/2 * perp_x, y0 - width/2 * perp_y],
                [x0 + width/2 * perp_x, y0 + width/2 * perp_y],
                [x0 + width/2 * perp_x + length * dx, y0 + width/2 * perp_y + length * dy],
                [x0 - width/2 * perp_x + length * dx, y0 - width/2 * perp_y + length * dy],
            ], dtype=np.int32)

            cv2.polylines(clipped, [corners], True, (0, 0, 0), LANE_BORDER_THICKNESS)

            center_x = int(x0 + length/2 * dx)
            center_y = int(y0 + length/2 * dy)
            cv2.putText(clipped, str(lane['id']), (center_x, center_y),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)

            # if there is a spot_radius_px, draw a red circle at the detected spot location at the px_location_of_zero_rf distance from the lane start along the lane direction
            if 'spot_radius_px' in lane and 'px_location_of_zero_rf' in lane:
                spot_x = int(x0 + lane['px_location_of_zero_rf'] * dx)
                spot_y = int(y0 + lane['px_location_of_zero_rf'] * dy)
                cv2.circle(clipped, (spot_x, spot_y), lane['spot_radius_px'], (0, 0, 255), 1)

            # Draw automiddle polylines:
            #   red   = raw argmin offsets (noisy, per-row signal)
            #   yellow = spline-smoothed final offsets (used for extraction)
            # For each Rf step i: lane-centre image coords are (x0+i*dx, y0+i*dy);
            # lateral shift of (o - width//2) pixels along the perp vector reaches point P.
            if lane_offsets and lane['id'] in lane_offsets:
                raw_o, final_o = lane_offsets[lane['id']]

                def offset_polyline(o: np.ndarray) -> np.ndarray:
                    return np.array([
                        [int(x0 + i * dx + (o[i] - width // 2) * perp_x),
                         int(y0 + i * dy + (o[i] - width // 2) * perp_y)]
                        for i in range(length)
                    ], dtype=np.int32).reshape(-1, 1, 2)

                cv2.polylines(clipped, [offset_polyline(raw_o)],   False, (0, 0, 255),   1)  # red
                cv2.polylines(clipped, [offset_polyline(final_o)], False, (0, 255, 255), 1)  # yellow

        orig_name = image_paths[channel].stem
        cv2.imwrite(str(vis_dir / f"{orig_name}_lanes.png"), clipped)


if __name__ == "__main__":
    args = parse_args()

    assert args.target_dir.is_dir(), f"not a directory: {args.target_dir}"

    image_paths = find_images(args.target_dir)

    if args.config:
        shutil.copy(args.config, args.target_dir / "lane_config.csv")
        config_path = args.config
    else:
        config_path = args.target_dir / "lane_config.csv"
        assert config_path.exists(), f"no lane_config.csv found in {args.target_dir}"

    lanes = load_config(config_path)
    save_config(lanes, args.target_dir / "lane_config.csv")
    images = {ch: np.load(path) for ch, path in image_paths.items()}
    scale_factors = {
        'White': args.scale_white,
        'UV254': args.scale_uv254,
        'UV366': args.scale_uv366,
    }

    if args.microadjust:
        adjusted_lanes = microadjust_lanes(
            images[args.ma_channel], lanes, args.ma_color_idx,
            args.ma_search_center, args.ma_search_length,
            args.ma_radius_min, args.ma_radius_max,
            args.ma_opt_length, tuple(args.ma_angle_range), args.ma_angle_step
        )

        lanes_dir = args.target_dir / "microadjusted_lanes" / args.agg_func
        lanes_dir.mkdir(parents=True, exist_ok=True)

        adjusted_config_path = args.target_dir / "microadjusted_lane_config.csv"
        save_config(adjusted_lanes, adjusted_config_path)

        lane_offsets = process_lanes(images, adjusted_lanes, scale_factors, lanes_dir, args.agg_func,
                                     args.automiddle_fscale, args.automiddle_tail_ignore)
        create_visualizations(images, image_paths, adjusted_lanes, scale_factors, lanes_dir, lane_offsets)
    else:
        lanes_dir = args.target_dir / "lanes" / args.agg_func
        lane_offsets = process_lanes(images, lanes, scale_factors, lanes_dir, args.agg_func,
                                     args.automiddle_fscale, args.automiddle_tail_ignore)
        create_visualizations(images, image_paths, lanes, scale_factors, lanes_dir, lane_offsets)