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
channel = "UV254"

image_dir = Path("C:/Users/UNIST/Documents/tlc_calibrations/exposure_sweep_tlcplate2")
# image_dir = Path("C:/Users/UNIST/Documents/tlc_calibrations/exposure_sweep_UV366_obj1")


for p in image_dir.glob("corrected_*.png"):
    if (ec := parse_name(p.name)) is not None and ec[1] == channel:
        img_paths.append(p)
        times.append(ec[0])

# sort by times
sorted_indices = np.argsort(times)
img_paths = [img_paths[i] for i in sorted_indices]
times = np.array([times[i] for i in sorted_indices], dtype=np.float32)


# img_paths = img_paths[::10]
# times = times[::10]


# remove times above maxtime
maxtime = 1500
img_paths = [img_paths[i] for i, t in enumerate(times) if t < maxtime]
times = times[times < maxtime]

# mintime = 40
# img_paths = [img_paths[i] for i, t in enumerate(times) if t > mintime]
# times = times[times > mintime]

# decimate for testing

print(f'Number of images: {len(img_paths)}')

# images = [cv2.imread(p) for p in img_paths]
#
# for i, image in enumerate(images):
#     images[i][:,:,0] = images[i][:,:,1]
#     images[i][:, :, 2] = images[i][:, :, 1]
#     images[i] = images[i][1200:-1200,900:-900,:]
#
# # 2. Calibrate using Robertson Algorithm
# # This estimates the Camera Response Function (CRF)
# calibrate_robertson = cv2.createCalibrateRobertson()
# calibrate_robertson.setMaxIter(100)
# crf = calibrate_robertson.process(images, times=times)
# np.save("crf_robertson_tlcplate2uv254xx.npy", crf)

# crf = np.load("crf_robertson_tlcplate2uv254xx.npy")
crf = np.load("crf_robertson_mb2uv254ed.npy")
# load only n-th and n+1 image for demo
# crf[:25, 0,1] = crf[:25, 0,0]
# np.save("crf_robertson_mb2uv254ed.npy", crf)

import matplotlib.pyplot as plt
plt.plot(crf[:,0,0], color='blue')
plt.plot(crf[:,0,1], color='green')
plt.plot(crf[:,0,2], color='red')
plt.show()

# nth_image = 10
# img_paths_demo = [img_paths[nth_image], img_paths[nth_image]]
# images_demo = [cv2.imread(p) for p in img_paths_demo]
# times_demo = np.array([times[nth_image], times[nth_image]], dtype=np.float32)
#
# # 3. Recover the linear image (Inverse Gamma)
# # Use one of the images (e.g., middle exposure) to recover linear scene radiance
# merge_robertson = cv2.createMergeRobertson()
# linear_image = merge_robertson.process(images_demo, times=times_demo, response=crf.copy())
#
#
# print(np.mean(linear_image))
# print(np.max(linear_image))
# # cap linear image at 0.3
# linear_image = np.clip(linear_image, 0, 0.06)
#
# # 4. (Optional) Convert to uint8 for visualization
# # linear_image is float32. Normalize and convert to view.
# lin_norm = cv2.normalize(linear_image, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)
#
# # cv2.imshow("Linear Image", lin_norm)
# # cv2.waitKey(0)
# # cv2.destroyAllWindows()

def correct_image_and_get_avg_in_roi(image_path, crf, initlocx=1600, initlocy=1200):
    print(f'Processing {image_path}')
    img_paths_demo = [image_path, image_path]
    images_demo = [cv2.imread(p) for p in img_paths_demo]
    times_demo = np.array([100, 100], dtype=np.float32)
    merge_robertson = cv2.createMergeRobertson()
    linear_image = merge_robertson.process(images_demo, times=times_demo, response=crf.copy())
    roi = linear_image[initlocx:initlocx+5, initlocy:initlocy+5,:]
    avg = np.mean(roi, axis=(0, 1))
    return avg

averages = [correct_image_and_get_avg_in_roi(image_path, crf) for image_path in img_paths]
averages = np.array(averages)
import matplotlib.pyplot as plt
plt.plot(times, averages[:,0], 'o-', color='blue')
plt.plot(times, averages[:,1], 'o-', color='green')
plt.plot(times, averages[:,2], 'o-', color='red')
plt.xlabel('Exposure, ms')
plt.ylabel('Pixel value after correction')
plt.show()




