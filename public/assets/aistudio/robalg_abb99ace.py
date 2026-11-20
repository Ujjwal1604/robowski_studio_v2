import cv2
import numpy as np
import re
from pathlib import Path

ROI_HALF  = 200                                              # half-side of the 20×20 ROI
_PAT      = re.compile(r"corrected_.+_EXP(\d+)_(\w+)\.png$")
CHANNELS  = ("UV254", "UV366", "White")
_RGB_META = (("red", "R"), ("green", "G"), ("blue", "B"))


def hdr_image(img_paths, times, saveto, png_scalefactor, crf_parameters_filepath="crf_robertson_mb4wonly.npy"):
    crf = np.load(crf_parameters_filepath)
    images_demo = [cv2.imread(p) for p in img_paths]
    times_demo = times
    merge_robertson = cv2.createMergeRobertson()
    linear_image = merge_robertson.process(images_demo, times=times_demo, response=crf.copy())
    # saveto is the filepath without extension. Save linear image to NP
    np.save(saveto + '.npy', linear_image)

    #
    clipped_image = np.clip(linear_image * png_scalefactor, 0, 255).astype(np.uint8)
    cv2.imwrite(saveto + '.png', clipped_image)


img_paths = []

def parse_name(name: str):
    """Return (exposure_s, channel) or None if the name does not match."""
    m = _PAT.match(name)
    return (int(m[1]), m[2]) if m else None


img_paths = []
times = []
channel = "White"

image_dir = Path("C:/Users/UNIST/Documents/tlc_calibrations/exposure_sweep_mb4wonly")

for p in image_dir.glob("corrected_*.png"):
    if (ec := parse_name(p.name)) is not None and ec[1] == channel:
        img_paths.append(p)
        times.append(ec[0])

# sort by times
sorted_indices = np.argsort(times)
img_paths = [img_paths[i] for i in sorted_indices]
times = np.array([times[i] for i in sorted_indices], dtype=np.float32)

# decimate for testing
# img_paths = img_paths[::10]
# times = times[::10]

print(f'Number of images: {len(img_paths)}')

# 1. Load images and exposure times
# Images should be sorted by exposure time (shortest to longest)
# images = [cv2.imread(p) for p in img_paths]

# # 2. Calibrate using Robertson Algorithm
# # This estimates the Camera Response Function (CRF)
# calibrate_robertson = cv2.createCalibrateRobertson()
# crf = calibrate_robertson.process(images, times=times)
# np.save("crf_robertson_mb4wonly.npy", crf)


crf = np.load("crf_robertson_mb4wonly.npy")
# load only n-th and n+1 image for demo
nth_image = 4
img_paths_demo = [img_paths[nth_image], img_paths[nth_image + 1]]
images_demo = [cv2.imread(p) for p in img_paths_demo]
times_demo = np.array([times[nth_image], times[nth_image + 1]], dtype=np.float32)

# 3. Recover the linear image (Inverse Gamma)
# Use one of the images (e.g., middle exposure) to recover linear scene radiance
merge_robertson = cv2.createMergeRobertson()
linear_image = merge_robertson.process(images_demo, times=times_demo, response=crf.copy())
print(np.max(linear_image))
# linear_image = merge_robertson.process(images_demo, times=times_demo)

# cap linear image at 0.3
linear_image = np.clip(linear_image, 0, 0.3)

# 4. (Optional) Convert to uint8 for visualization
# linear_image is float32. Normalize and convert to view.
lin_norm = cv2.normalize(linear_image, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)

cv2.imshow("Linear Image", lin_norm)
cv2.waitKey(0)
cv2.destroyAllWindows()