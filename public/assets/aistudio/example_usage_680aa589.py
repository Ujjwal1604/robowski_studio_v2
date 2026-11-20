"""
Example usage of the distortion correction module.

This script demonstrates:
1. Calibrating from a chessboard image
2. Applying correction to new images
3. Saving and loading calibration data
"""

import cv2
import numpy as np
import matplotlib.pyplot as plt
import distortion_correction as dc

# ============================================================================
# Example 1: Complete calibration pipeline
# ============================================================================

def example_calibration():
    """
    Perform calibration from a chessboard image.
    """
    print("=" * 70)
    print("EXAMPLE 1: Calibration from Chessboard")
    print("=" * 70)
    
    # Load calibration image
    calibration_image = cv2.imread('calibration/download_v2_fine_edited7_inv.jpg')

    # dc.find_chessboard_pattern(calibration_image)
    
    if calibration_image is None:
        print("Please provide a calibration image with a chessboard pattern.")
        return None, None
    
    # Define chessboard pattern
    # For a standard 9x6 chessboard (10x7 squares), use (9, 6) internal corners
    pattern_size = (29, 29)  # (columns, rows) of internal corners
    
    # Optional: Override global configuration
    # dc.OUTPUT_PIXEL_SPACING = 60.0  # pixels per square
    # dc.CHESSBOARD_ORIGIN = (150, 150)  # top-left corner position
    # dc.TPS_REGULARIZATION = 1e-4  # smoothness parameter
    
    # Perform calibration
    map_x, map_y, metadata = dc.calibrate_from_chessboard(
        image=calibration_image,
        pattern_size=pattern_size,
        visualize=True,
        viz_output_path='calibration_visualization.png'
    )
    
    # Save calibration for future use
    dc.save_calibration(map_x, map_y, 'calibration_maps.npz')
    
    print("\nCalibration metadata:")
    print(f"  Pattern size: {metadata['pattern_size']}")
    print(f"  Output spacing: {metadata['spacing']:.2f} pixels")
    print(f"  Origin: {metadata['origin']}")
    print(f"  Regularization: {metadata['regularization']}")
    
    return map_x, map_y


# ============================================================================
# Example 2: Apply correction to a new image
# ============================================================================

def example_apply_correction(map_x, map_y):
    """
    Apply distortion correction to a new image using saved calibration.
    """
    print("\n" + "=" * 70)
    print("EXAMPLE 2: Apply Correction to New Image")
    print("=" * 70)
    
    # Load a new image to correct
    # This could be your actual measurement image
    test_image = cv2.imread('calibration/download_v2_fine_edited6.jpg')
    
    # if test_image is None:
    #     print("Info: No 'test_image.jpg' found, using calibration image as test")
    #     # test_image = cv2.imread('calibration/download_v1_rough_small.jpg')
    #
    #     if test_image is None:
    #         print("Error: No test image available")
    #         return
    
    print(f"Correcting image of shape {test_image.shape}...")
    
    # Apply correction
    corrected_image = dc.apply_correction(test_image, map_x, map_y)
    
    # Save results
    cv2.imwrite('corrected_image.jpg', corrected_image)
    print("Corrected image saved to 'corrected_image.jpg'")
    
    # Display side-by-side comparison
    fig, axes = plt.subplots(1, 2, figsize=(16, 8))
    
    axes[0].imshow(cv2.cvtColor(test_image, cv2.COLOR_BGR2RGB))
    axes[0].set_title('Original (Distorted)', fontsize=14)
    axes[0].axis('off')
    
    axes[1].imshow(cv2.cvtColor(corrected_image, cv2.COLOR_BGR2RGB))
    axes[1].set_title('Corrected (Undistorted)', fontsize=14)
    axes[1].axis('off')
    
    plt.tight_layout()
    plt.savefig('before_after_comparison.png', dpi=150, bbox_inches='tight')
    print("Comparison saved to 'before_after_comparison.png'")
    plt.show()


# ============================================================================
# Example 4: Batch processing multiple images
# ============================================================================

def example_batch_processing(map_x, map_y, image_paths):
    """
    Process multiple images using the same calibration.
    
    Args:
        map_x, map_y: Calibration maps
        image_paths: List of image file paths
    """
    print("\n" + "=" * 70)
    print("EXAMPLE 4: Batch Processing")
    print("=" * 70)
    
    for i, path in enumerate(image_paths):
        print(f"Processing {path}...")
        image = cv2.imread(path)
        
        if image is None:
            print(f"  Warning: Could not load {path}")
            continue
        
        corrected = dc.apply_correction(image, map_x, map_y)
        
        # Save with modified filename
        output_path = path.replace('.jpg', '_corrected.jpg')
        cv2.imwrite(output_path, corrected)
        print(f"  Saved to {output_path}")
    
    print(f"Processed {len(image_paths)} images")


# ============================================================================
# Example 5: Custom configuration
# ============================================================================

def example_custom_config():
    """
    Demonstrate using custom configuration parameters.
    """
    print("\n" + "=" * 70)
    print("EXAMPLE 5: Custom Configuration")
    print("=" * 70)
    
    calibration_image = cv2.imread('chessboard_calibration.jpg')
    
    if calibration_image is None:
        print("Error: Could not load calibration image")
        return
    
    # Use custom parameters (not global variables)
    map_x, map_y, metadata = dc.calibrate_from_chessboard(
        image=calibration_image,
        pattern_size=(9, 6),
        spacing=75.0,  # Larger spacing for higher magnification
        origin=(200, 200),  # Different origin position
        regularization=1e-4,  # More regularization for smoother extrapolation
        visualize=True,
        viz_output_path='custom_calibration_viz.png'
    )
    
    print("Custom calibration complete with parameters:")
    print(f"  Spacing: {metadata['spacing']} pixels")
    print(f"  Origin: {metadata['origin']}")
    print(f"  Regularization: {metadata['regularization']}")


# ============================================================================
# Main execution
# ============================================================================

if __name__ == "__main__":
    print("\n" + "=" * 70)
    print("DISTORTION CORRECTION - USAGE EXAMPLES")
    print("=" * 70)
    
    # Example 1: Perform calibration
    map_x, map_y = example_calibration()
    
    if map_x is not None:
        # Example 2: Apply to new image
        example_apply_correction(map_x, map_y)
        
        # # Example 3: Load and use saved calibration
        # example_load_and_use()
        
        # Example 4: Batch processing (if you have multiple images)
        # image_list = ['image1.jpg', 'image2.jpg', 'image3.jpg']
        # example_batch_processing(map_x, map_y, image_list)
        
        # Example 5: Custom configuration
        # example_custom_config()
    
    print("\n" + "=" * 70)
    print("Examples complete!")
    print("=" * 70)
