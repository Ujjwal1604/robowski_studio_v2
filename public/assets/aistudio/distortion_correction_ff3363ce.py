"""
Distortion correction module using Thin Plate Spline interpolation.

This module provides non-parametric distortion correction based on empirical
measurements from a chessboard calibration pattern. It uses Thin Plate Splines
with polynomial extension and regularization for smooth extrapolation.
"""

import numpy as np
import cv2
from scipy.spatial.distance import cdist
import matplotlib.pyplot as plt
from typing import Tuple, Dict, Any, Optional

# ============================================================================
# Global Configuration
# ============================================================================

OUTPUT_PIXEL_SPACING = (2760-500)/28  # pixels per chessboard square in output
CHESSBOARD_ORIGIN = (500, 122)  # (x, y) position of top-left corner in output
# OUTPUT_PIXEL_SPACING = 22.142857  # pixels per chessboard square in output
# CHESSBOARD_ORIGIN = (137, 33)  # (x, y) position of top-left corner in output
TPS_REGULARIZATION = 1e-5  # regularization parameter for TPS fitting


# ============================================================================
# Corner Detection
# ============================================================================

def reindex_corners_to_topleft(observed_corners: np.ndarray,
                               pattern_size: Tuple[int, int]) -> np.ndarray:
    """
    Reindex corners so the top-left corner in the image is always first.

    OpenCV's findChessboardCorners may start detection from any of the 4 corners.
    This function reorders the detected corners so that index 0 always corresponds
    to the corner physically closest to the top-left (0, 0) of the image.

    Args:
        observed_corners: Array of shape (N, 2) where N = cols * rows
        pattern_size: (cols, rows) - number of internal corners

    Returns:
        reindexed_corners: Array of shape (N, 2) with corrected ordering
    """
    cols, rows = pattern_size

    # Reshape 1D array to 2D grid based on pattern dimensions
    # Shape: (rows, cols, 2) where last dimension is (x, y)
    corners_grid = observed_corners.reshape(rows, cols, 2)

    # Get the 4 corner positions and their required transformations
    # Format: (position, needs_vertical_flip, needs_horizontal_flip)
    four_corners = [
        (corners_grid[0, 0], False, False),  # top-left in current indexing
        (corners_grid[0, -1], False, True),  # top-right in current indexing
        (corners_grid[-1, 0], True, False),  # bottom-left in current indexing
        (corners_grid[-1, -1], True, True)  # bottom-right in current indexing
    ]

    # Find which corner is physically closest to image origin (0, 0)
    # Using sum of coordinates (x + y) as a metric
    min_sum = float('inf')
    flip_v, flip_h = False, False

    for pos, needs_flip_v, needs_flip_h in four_corners:
        pos_sum = pos[0] + pos[1]  # x + y
        if pos_sum < min_sum:
            min_sum = pos_sum
            flip_v = needs_flip_v
            flip_h = needs_flip_h

    # Apply transformations to reorient the grid
    if flip_v:
        corners_grid = np.flip(corners_grid, axis=0)  # Flip rows
    if flip_h:
        corners_grid = np.flip(corners_grid, axis=1)  # Flip columns

    # Important: np.flip returns a view, we need a contiguous copy
    corners_grid = corners_grid.copy()

    # Reshape back to 1D array
    reindexed_corners = corners_grid.reshape(-1, 2)

    return reindexed_corners


def find_chessboard_pattern(image):
    # img = image
    # lwr = np.array([0, 0, 143])
    # upr = np.array([179, 61, 252])
    # hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # msk = cv2.inRange(hsv, lwr, upr)
    #
    # krn = cv2.getStructuringElement(cv2.MORPH_RECT, (50, 30))
    # dlt = cv2.dilate(msk, krn, iterations=5)
    # res = 255 - cv2.bitwise_and(dlt, msk)
    # res = np.uint8(res)
    # gray = res

    # Convert to grayscale if needed
    if len(image.shape) == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image.copy()

    for n in range(26, 33):
        for m in range(26, 33):
            pattern_size = (m, n)
            ret, corners = cv2.findChessboardCorners(
                gray,
                pattern_size,
                # cv2.CALIB_CB_ADAPTIVE_THRESH + cv2.CALIB_CB_NORMALIZE_IMAGE
                cv2.CALIB_CB_PLAIN
            )
            if ret:
                print('Good:')
                print(pattern_size)
                # break
            else:
                print(f'Nope: {pattern_size}')


def detect_chessboard_corners(image: np.ndarray,
                               pattern_size: Tuple[int, int]) -> np.ndarray:
    """
    Detect chessboard corners with subpixel refinement.
    
    Args:
        image: Input image (color or grayscale)
        pattern_size: (cols, rows) of internal corners (not squares!)
    
    Returns:
        corners: Array of shape (N, 2) with (x, y) coordinates
                 where N = cols * rows
    
    Raises:
        ValueError: If corners cannot be detected
    """
    # Convert to grayscale if needed
    if len(image.shape) == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image.copy()

    # img = image
    # lwr = np.array([0, 0, 143])
    # upr = np.array([179, 61, 252])
    # hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # msk = cv2.inRange(hsv, lwr, upr)
    #
    # krn = cv2.getStructuringElement(cv2.MORPH_RECT, (50, 30))
    # dlt = cv2.dilate(msk, krn, iterations=5)
    # res = 255 - cv2.bitwise_and(dlt, msk)
    # res = np.uint8(res)
    # gray = res

    # Detect corners
    ret, corners = cv2.findChessboardCorners(
        gray, 
        pattern_size,
        cv2.CALIB_CB_ADAPTIVE_THRESH + cv2.CALIB_CB_NORMALIZE_IMAGE
    )
    
    if not ret:
        raise ValueError(f"Could not detect chessboard pattern {pattern_size}")
    
    # Refine to subpixel accuracy
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
    corners_refined = cv2.cornerSubPix(
        gray, 
        corners,
        winSize=(11, 11),
        zeroZone=(-1, -1),
        criteria=criteria
    )
    
    # Reshape from (N, 1, 2) to (N, 2)
    return corners_refined.reshape(-1, 2)


# ============================================================================
# Ideal Grid Generation
# ============================================================================

def compute_ideal_corners(pattern_size: Tuple[int, int],
                          spacing: float,
                          origin: Tuple[float, float]) -> np.ndarray:
    """
    Compute ideal corner positions in perfect orthographic view.
    
    The corners are arranged in a regular grid with specified spacing,
    starting from the given origin point.
    
    Args:
        pattern_size: (cols, rows) of internal corners
        spacing: Distance between adjacent corners in pixels
        origin: (x, y) position of top-left corner in output image
    
    Returns:
        ideal_corners: Array of shape (N, 2) with (x, y) coordinates
                       where N = cols * rows
    """
    cols, rows = pattern_size
    origin_x, origin_y = origin
    
    # Create grid of ideal positions
    ideal_corners = np.zeros((rows * cols, 2), dtype=np.float32)
    
    for i in range(rows):
        for j in range(cols):
            idx = j * cols + i
            ideal_corners[idx, 0] = origin_x + j * spacing  # x coordinate
            ideal_corners[idx, 1] = origin_y + i * spacing  # y coordinate

    # transpose
    
    return ideal_corners # flip


# ============================================================================
# Thin Plate Spline Implementation
# ============================================================================

def _tps_kernel(r: np.ndarray) -> np.ndarray:
    """
    Thin Plate Spline radial basis function for 2D.
    
    φ(r) = r² log(r²) for r > 0
    φ(0) = 0
    
    Args:
        r: Array of distances
    
    Returns:
        kernel_values: TPS kernel evaluated at each distance
    """
    # Avoid log(0) by adding small epsilon where r is zero
    result = np.zeros_like(r)
    mask = r > 1e-10
    r_safe = r[mask]
    result[mask] = r_safe ** 2 * np.log(r_safe ** 2)
    return result


def fit_thin_plate_spline(source_points: np.ndarray,
                          target_values: np.ndarray,
                          regularization: float) -> Dict[str, Any]:
    """
    Fit Thin Plate Spline with affine polynomial extension.
    
    Solves the TPS interpolation problem with regularization:
        min ||f(x_i) - y_i||² + λ * smoothness_term
    
    The TPS interpolant has the form:
        f(x) = Σ w_i * φ(||x - x_i||) + a₀ + a₁*x + a₂*y
    
    Args:
        source_points: Array of shape (N, 2) - control point positions
        target_values: Array of shape (N,) - values at control points
        regularization: Regularization parameter λ (larger = smoother)
    
    Returns:
        tps_params: Dictionary with keys:
            - 'weights': Array of shape (N,) - RBF weights w_i
            - 'affine': Array of shape (3,) - polynomial coefficients [a₀, a₁, a₂]
            - 'source_points': Copy of source_points for later evaluation
    """
    n_points = source_points.shape[0]
    
    # Compute pairwise distances and kernel matrix
    distances = cdist(source_points, source_points, metric='euclidean')
    K = _tps_kernel(distances)
    
    # Add regularization to diagonal
    K_reg = K + regularization * np.eye(n_points)
    
    # Build polynomial matrix P = [1, x, y]
    P = np.column_stack([
        np.ones(n_points),
        source_points[:, 0],  # x coordinates
        source_points[:, 1]   # y coordinates
    ])
    
    # Build the full system matrix
    # [K_reg  P ] [w]   [y]
    # [P^T   0 ] [a] = [0]
    top_row = np.hstack([K_reg, P])
    bottom_row = np.hstack([P.T, np.zeros((3, 3))])
    system_matrix = np.vstack([top_row, bottom_row])
    
    # Build right-hand side
    rhs = np.concatenate([target_values, np.zeros(3)])
    
    # Solve linear system
    solution = np.linalg.solve(system_matrix, rhs)
    
    # Extract weights and polynomial coefficients
    weights = solution[:n_points]
    affine = solution[n_points:]
    
    return {
        'weights': weights,
        'affine': affine,
        'source_points': source_points.copy()
    }


def evaluate_thin_plate_spline(eval_points: np.ndarray,
                               tps_params: Dict[str, Any],
                               batch_size: int = 50000) -> np.ndarray:
    """
    Evaluate fitted TPS at given points (memory-efficient batched version).

    Args:
        eval_points: Array of shape (M, 2) - points where to evaluate
        tps_params: TPS parameters from fit_thin_plate_spline
        batch_size: Number of points to process at once (adjust for memory)

    Returns:
        values: Array of shape (M,) - interpolated values
    """
    source_points = tps_params['source_points']
    weights = tps_params['weights']
    affine = tps_params['affine']

    n_eval = len(eval_points)
    values = np.zeros(n_eval, dtype=np.float32)

    # Process in batches to avoid memory issues
    for start_idx in range(0, n_eval, batch_size):
        print(f'Start idx {start_idx} out of {n_eval}, {start_idx/n_eval:.2%} percent')
        end_idx = min(start_idx + batch_size, n_eval)
        batch = eval_points[start_idx:end_idx]

        # Compute distances for this batch
        distances = cdist(batch, source_points, metric='euclidean')

        # Evaluate kernel
        K_eval = _tps_kernel(distances)

        # Compute RBF contribution
        rbf_contribution = K_eval @ weights

        # Compute polynomial contribution
        poly_contribution = (
                affine[0] +
                affine[1] * batch[:, 0] +
                affine[2] * batch[:, 1]
        )

        values[start_idx:end_idx] = rbf_contribution + poly_contribution

    return values


def create_remap_matrices(image_shape: Tuple[int, int],
                          ideal_corners: np.ndarray,
                          observed_corners: np.ndarray,
                          regularization: float,
                          batch_size: int = 50000) -> Tuple[np.ndarray, np.ndarray]:
    """
    Create dense mapping matrices for cv2.remap (memory-efficient version).

    Args:
        image_shape: (height, width) of image
        ideal_corners: Array of shape (N, 2) - ideal corner positions
        observed_corners: Array of shape (N, 2) - observed corner positions
        regularization: TPS regularization parameter
        batch_size: Number of pixels to process at once

    Returns:
        map_x: Array of shape (height, width) - x coordinates to sample from
        map_y: Array of shape (height, width) - y coordinates to sample from
    """
    height, width = image_shape

    print(f"  Processing {height}×{width} = {height * width:,} pixels in batches of {batch_size:,}...")

    # Fit separate TPS for x and y coordinates
    tps_x = fit_thin_plate_spline(
        source_points=ideal_corners,
        target_values=observed_corners[:, 0],
        regularization=regularization
    )

    tps_y = fit_thin_plate_spline(
        source_points=ideal_corners,
        target_values=observed_corners[:, 1],
        regularization=regularization
    )

    # Create grid of all pixel positions
    y_coords, x_coords = np.mgrid[0:height, 0:width]
    pixel_positions = np.column_stack([
        x_coords.ravel(),
        y_coords.ravel()
    ])

    # Evaluate TPS at all pixel positions (in batches)
    map_x_flat = evaluate_thin_plate_spline(pixel_positions, tps_x, batch_size=batch_size)
    map_y_flat = evaluate_thin_plate_spline(pixel_positions, tps_y, batch_size=batch_size)

    # Reshape to image dimensions
    map_x = map_x_flat.reshape(height, width).astype(np.float32)
    map_y = map_y_flat.reshape(height, width).astype(np.float32)

    return map_x, map_y


# ============================================================================
# Image Correction
# ============================================================================

def apply_correction(image: np.ndarray,
                     map_x: np.ndarray,
                     map_y: np.ndarray,
                     interpolation: int = cv2.INTER_LINEAR) -> np.ndarray:
    """
    Apply distortion correction to image using precomputed maps.
    
    Args:
        image: Input distorted image
        map_x: X-coordinate remap matrix
        map_y: Y-coordinate remap matrix
        interpolation: OpenCV interpolation method (default: bilinear)
    
    Returns:
        corrected: Undistorted image
    """
    corrected = cv2.remap(
        image,
        map_x,
        map_y,
        interpolation=interpolation,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0
    )
    return corrected


# ============================================================================
# Visualization
# ============================================================================

def visualize_calibration(image: np.ndarray,
                          observed_corners: np.ndarray,
                          ideal_corners: np.ndarray,
                          output_path: Optional[str] = None) -> plt.Figure:
    """
    Visualize detected and ideal corner positions overlaid on image.
    
    Creates a figure showing:
    - Original image
    - Observed corner positions (red circles)
    - Ideal corner positions (blue crosses)
    - Displacement vectors from ideal to observed
    
    Args:
        image: Input calibration image
        observed_corners: Detected corner positions (N, 2)
        ideal_corners: Ideal corner positions (N, 2)
        output_path: Optional path to save figure
    
    Returns:
        fig: Matplotlib figure object
    """
    fig, ax = plt.subplots(figsize=(12, 10))
    
    # Display image
    if len(image.shape) == 3:
        ax.imshow(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    else:
        ax.imshow(image, cmap='gray')
    
    # Plot observed corners
    ax.plot(observed_corners[:, 0], observed_corners[:, 1], 
            'ro', markersize=8, label='Observed (distorted)', alpha=0.7)
    
    # Plot ideal corners
    ax.plot(ideal_corners[:, 0], ideal_corners[:, 1], 
            'bx', markersize=10, label='Ideal (target)', markeredgewidth=2)
    
    # Draw displacement vectors
    for i in range(len(observed_corners)):
        ax.arrow(
            ideal_corners[i, 0], ideal_corners[i, 1],
            observed_corners[i, 0] - ideal_corners[i, 0],
            observed_corners[i, 1] - ideal_corners[i, 1],
            head_width=3, head_length=5, fc='yellow', ec='orange',
            alpha=0.6, linewidth=1
        )
    
    ax.set_xlabel('X (pixels)', fontsize=12)
    ax.set_ylabel('Y (pixels)', fontsize=12)
    ax.set_title('Chessboard calibration: observed vs. ideal corners', fontsize=14)
    ax.legend(fontsize=11)
    ax.grid(True, alpha=0.3)
    
    plt.tight_layout()
    
    if output_path:
        fig.savefig(output_path, dpi=150, bbox_inches='tight')
    
    return fig


def compute_residual_statistics(observed_corners: np.ndarray,
                                 ideal_corners: np.ndarray) -> Dict[str, float]:
    """
    Compute statistical measures of distortion residuals.
    
    Args:
        observed_corners: Detected corner positions (N, 2)
        ideal_corners: Ideal corner positions (N, 2)
    
    Returns:
        stats: Dictionary containing:
            - 'rms_error': RMS distance between observed and ideal
            - 'max_error': Maximum distance
            - 'mean_error': Mean distance
    """
    displacements = observed_corners - ideal_corners
    distances = np.sqrt(np.sum(displacements ** 2, axis=1))
    
    return {
        'rms_error': np.sqrt(np.mean(distances ** 2)),
        'max_error': np.max(distances),
        'mean_error': np.mean(distances)
    }


# ============================================================================
# Main Calibration Pipeline
# ============================================================================

def calibrate_from_chessboard(
        image: np.ndarray,
        pattern_size: Tuple[int, int],
        spacing: Optional[float] = None,
        origin: Optional[Tuple[float, float]] = None,
        regularization: Optional[float] = None,
        visualize: bool = True,
        viz_output_path: Optional[str] = None
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """
    Complete calibration pipeline from chessboard image.
    
    This function:
    1. Detects chessboard corners with subpixel accuracy
    2. Computes ideal corner positions
    3. Fits TPS interpolators
    4. Creates dense remap matrices
    5. Optionally visualizes the calibration
    
    Args:
        image: Calibration image containing chessboard
        pattern_size: (cols, rows) of internal corners
        spacing: Pixel spacing in output (default: use global config)
        origin: Origin position in output (default: use global config)
        regularization: TPS regularization (default: use global config)
        visualize: Whether to create visualization
        viz_output_path: Path to save visualization
    
    Returns:
        map_x: X-coordinate remap matrix (height, width)
        map_y: Y-coordinate remap matrix (height, width)
        metadata: Dictionary containing:
            - 'observed_corners': Detected corner positions
            - 'ideal_corners': Ideal corner positions
            - 'residual_stats': Error statistics
            - 'figure': Matplotlib figure (if visualize=True)
    
    Raises:
        ValueError: If chessboard detection fails
    """
    # Use global config if not specified
    if spacing is None:
        spacing = OUTPUT_PIXEL_SPACING
    if origin is None:
        origin = CHESSBOARD_ORIGIN
    if regularization is None:
        regularization = TPS_REGULARIZATION
    
    print("Detecting chessboard corners...")
    observed_corners = detect_chessboard_corners(image, pattern_size)
    print(f"  Found {len(observed_corners)} corners")

    observed_corners = reindex_corners_to_topleft(observed_corners, pattern_size)
    print("  Corners reindexed to top-left origin")
    
    print("Computing ideal corner positions...")
    ideal_corners = compute_ideal_corners(pattern_size, spacing, origin)
    
    print("Computing residual statistics...")
    residual_stats = compute_residual_statistics(observed_corners, ideal_corners)
    print(f"  RMS error: {residual_stats['rms_error']:.3f} pixels")
    print(f"  Max error: {residual_stats['max_error']:.3f} pixels")
    print(f"  Mean error: {residual_stats['mean_error']:.3f} pixels")
    
    print("Fitting Thin Plate Spline interpolators...")
    map_x, map_y = create_remap_matrices(
        image_shape=image.shape[:2],
        ideal_corners=ideal_corners,
        observed_corners=observed_corners,
        regularization=regularization
    )
    print("  Remap matrices created")
    
    # Prepare metadata
    metadata = {
        'observed_corners': observed_corners,
        'ideal_corners': ideal_corners,
        'residual_stats': residual_stats,
        'pattern_size': pattern_size,
        'spacing': spacing,
        'origin': origin,
        'regularization': regularization
    }
    
    # Create visualization if requested
    if visualize:
        print("Creating visualization...")
        fig = visualize_calibration(
            image, 
            observed_corners, 
            ideal_corners,
            output_path=viz_output_path
        )
        metadata['figure'] = fig
    
    print("Calibration complete!")
    
    return map_x, map_y, metadata


# ============================================================================
# Convenience Functions
# ============================================================================

def save_calibration(map_x: np.ndarray, 
                     map_y: np.ndarray,
                     filepath: str) -> None:
    """
    Save remap matrices to file for later use.
    
    Args:
        map_x: X-coordinate remap matrix
        map_y: Y-coordinate remap matrix
        filepath: Path to save (will create .npz file)
    """
    np.savez_compressed(filepath, map_x=map_x, map_y=map_y)
    print(f"Calibration saved to {filepath}")


def load_calibration(filepath: str) -> Tuple[np.ndarray, np.ndarray]:
    """
    Load remap matrices from file.
    
    Args:
        filepath: Path to .npz file
    
    Returns:
        map_x: X-coordinate remap matrix
        map_y: Y-coordinate remap matrix
    """
    data = np.load(filepath)
    return data['map_x'], data['map_y']


def load_and_apply_correction(calibration_maps_filename, source_image_file, target_image_file=None, verbose=False):
    """
    Load previously saved calibration and apply to new images.
    """
    # Load saved calibration
    map_x, map_y = load_calibration(calibration_maps_filename)
    if verbose:
        print("Calibration loaded successfully")
        print(f"Map shape: {map_x.shape}")

    # Apply to new image
    test_image = cv2.imread(source_image_file)

    # if the size is wrong, exit with error
    if len(test_image.shape) == 3:
        height, width, channels = test_image.shape
    # For grayscale images (height, width)
    else:
        height, width = test_image.shape

    if verbose:
        print(f'Image shape H={height}, W={width}')

    assert height == map_x.shape[0], 'Height of source image does not match the height of calibrated distortion map'
    assert width == map_x.shape[1], 'Width of source image does not match the width of calibrated distortion map'

    if test_image is not None:
        corrected = apply_correction(test_image, map_x, map_y)
        if target_image_file is not None:
            cv2.imwrite(target_image_file, corrected)
            if verbose:
                print('Corrected image saved')

    return corrected
