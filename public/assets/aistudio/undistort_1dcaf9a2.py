# This script is specialized for applying the correction to the TLC images, then saving the result in the same folder
# with the `_corrected` suffix added to the filename, and the filetype changed to PNG to avoid the
# compression artifacts

from distortion_correction import load_and_apply_correction
import tkinter as tk
from tkinter import filedialog

def undistort_all_files_in_zip():
    # NOT IMPLEMENTED HERE
    pass


if __name__ == '__main__':
    root = tk.Tk()
    root.withdraw()
    source_image_path = filedialog.askopenfilename()
    target_image_path = source_image_path[:-4] + '_corrected.png'
    load_and_apply_correction(calibration_maps_filename='calibration/results/large_2025-10-30/calibration_maps.npz',
                              source_image_file=source_image_path,
                              target_image_file=target_image_path)