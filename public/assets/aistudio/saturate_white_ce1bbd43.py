import cv2
import numpy as np
# from scipy import stats

def mode(a):
    # Count the occurrences of each value
    counts = np.bincount(np.array(a).flatten())

    # Find the index of the maximum count, which corresponds to the mode
    mode_value = np.argmax(counts)
    return mode_value

def saturate_white():
    # img_orig = cv2.imread(
    #     'C:/Users/UNIST/Documents/tlc_archive/2026-02-05_03-07-02/uni_linint_corrected_2026-02-05_03-07-02_White.png')
    img_orig = cv2.imread(
        'C:/Users/UNIST/Documents/tlc_archive/2026-02-20_23-15-19/uni_linint_corrected_2026-02-20_23-15-19_White.png')

    startX = 180
    startY = 550
    img = img_orig[startX:-startX, startY:-startY]

    img = 255 - img

    # Split into BGR channels
    b, g, r = cv2.split(img)

    # Subtract 50 from the Blue channel only (clamped at 0)
    b = cv2.subtract(b, int(round(mode(b))) - 3)
    g = cv2.subtract(g, int(round(mode(g))) - 3)
    r = cv2.subtract(r, int(round(mode(r))) - 3)

    # Merge back
    img = cv2.merge((b, g, r))

    if img is None:
        print("Error: Could not read image file.")
    else:
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        img = cv2.fastNlMeansDenoisingColored(img, None, 70, 70, 17, 41)
        alpha = 2.8  # Contrast control (1.0 means no change, >1 increases contrast)
        beta = 0  # Brightness control (0 means no change, positive value increases brightness)
        img = cv2.convertScaleAbs(img, alpha=alpha, beta=beta)
        # img = cv2.fastNlMeansDenoisingMulti(img, 2, 5, None, 4, 7, 35)
        alpha = 1.8  # Contrast control (1.0 means no change, >1 increases contrast)
        beta = 0  # Brightness control (0 means no change, positive value increases brightness)
        img = cv2.convertScaleAbs(img, alpha=alpha, beta=beta)
        img = 255 - img
    cv2.imshow('Adjusted Contrast and Brightness', img)
    cv2.waitKey(0)
    cv2.destroyAllWindows()


if __name__ == '__main__':
    saturate_white()