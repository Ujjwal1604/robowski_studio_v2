import cv2
import numpy as np
from pathlib import Path
import re
import pandas as pd

_PAT      = re.compile(r"corrected_.+_EXP(\d+)_(\w+)\.png$")
CHANNELS  = ("UV254", "UV366", "White")

def parse_name(name: str):
    """Return (exposure_s, channel) or None if the name does not match."""
    m = _PAT.match(name)
    return (int(m[1]), m[2]) if m else None

def linear_hdr_image(img_paths, times, saveto, png_scalefactor,
                     crf_parameters_filepaths=("crf_robertson_mb4wonly.npy",
                                               "crf_robertson_mb4wonly.npy",
                                               "crf_robertson_mb4wonly.npy")):

    images_demo = [cv2.imread(p) for p in img_paths]
    times_demo = np.array(times, dtype=np.float32)

    linear_image = None
    for bgr_channel in range(3):
        merge_robertson = cv2.createMergeRobertson()
        crf = np.load(crf_parameters_filepaths[bgr_channel])
        if linear_image is None:
            linear_image = merge_robertson.process(images_demo, times=times_demo, response=crf.copy())
        else:
            linear_image[:,:,bgr_channel] = merge_robertson.process(images_demo, times=times_demo, response=crf.copy())[:,:,bgr_channel]

    # saveto is the filepath without extension. Save linear image to NP
    np.save(saveto + '.npy', linear_image)

    clipped_image = np.clip(linear_image * png_scalefactor, 0, 255).astype(np.uint8)
    cv2.imwrite(saveto + '.png', clipped_image)

    ### View: for debugging
    # lin_norm = cv2.normalize(linear_image, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)
    # cv2.imshow("Linear Image", lin_norm)
    # cv2.waitKey(0)
    # cv2.destroyAllWindows()

def retroactively_linearize_intensity(target_folder, datetime_string,
                         linearize_intensity=True,
                         exposures={'vis':tuple([10, 20]), 'uvc':tuple([69, 138]), 'uva':tuple([100, 200, 750])},
                         exposures_for_linearization={'vis':tuple([10, 20]), 'uvc':tuple([69, 138]), 'uva':tuple([100, 200, 750])},
                         png_scalefactors={'vis':2300, 'uvc':12000, 'uva':60000},
                         crf_parameters_filepaths_per_channel={'vis':("crf_robertson_tlcplate2w.npy",
                                                                      "crf_robertson_tlcplate2w.npy",
                                                                      "crf_robertson_tlcplate2w.npy"),
                                                               'uvc':("crf_robertson_tlcplate2w.npy",
                                                                      "crf_robertson_mb2uv254ed.npy",
                                                                      "crf_robertson_tlcplate2w.npy"),
                                                               'uva':("crf_robertson_tlcplate2w.npy",
                                                                      "crf_robertson_tlcplate2w.npy",
                                                                      "crf_robertson_tlcplate2w.npy"),
                                                               }):

    channel_suffixes = {'vis': 'White', 'uvc':'UV254', 'uva': 'UV366'}
    channels = ('vis', 'uva', 'uvc')

    if linearize_intensity:
        print('Linearizing intensity...')
        for channel in channels:
            if channel in exposures:
                img_paths = [f'{target_folder}/corrected_{datetime_string}_EXP{exposure}_{channel_suffixes[channel]}.png' for exposure in exposures[channel]]
                times = [exposure for exposure in exposures_for_linearization[channel]]
                linear_hdr_image(img_paths, times,
                                 saveto=f'{target_folder}/linint_corrected_{datetime_string}_{channel_suffixes[channel]}',
                                 png_scalefactor=png_scalefactors[channel],
                                 crf_parameters_filepaths=crf_parameters_filepaths_per_channel[channel])

if __name__ == '__main__':
    # img_paths = ['C:/Users/UNIST/Documents/tlc_calibrations/exposure_sweep_mb2/corrected_2026-02-04_03-12-48_EXP11_White.png',
    #              'C:/Users/UNIST/Documents/tlc_calibrations/exposure_sweep_mb2/corrected_2026-02-04_03-12-48_EXP19_White.png']
    # times = [11, 19]
    # linear_hdr_image(img_paths, times, saveto='hdrtest', png_scalefactor=2300)

    # img_paths = ['C:/Users/UNIST/Documents/tlc_archive/2026-02-04_18-44-26/corrected_2026-02-04_18-44-26_EXP10_White.png',
    #              'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_18-44-26/corrected_2026-02-04_18-44-26_EXP20_White.png']
    # times = [10, 20]
    # linear_hdr_image(img_paths, times, saveto='hdrtest', png_scalefactor=2300)

    # img_paths = ['C:/Users/UNIST/Documents/tlc_archive/2026-02-04_18-44-26/corrected_2026-02-04_18-44-26_EXP69_UV254.png',
    #              'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_18-44-26/corrected_2026-02-04_18-44-26_EXP138_UV254.png']
    # img_paths = ['C:/Users/UNIST/Documents/tlc_archive/2026-02-04_22-17-38/corrected_2026-02-04_22-17-38_EXP69_UV254.png',
    #              'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_22-17-38/corrected_2026-02-04_22-17-38_EXP138_UV254.png']
    # times = [69, 138]
    # linear_hdr_image(img_paths, times, saveto='hdrtest', png_scalefactor=12000, crf_parameters_filepaths=["crf_robertson_tlcplate2w.npy",
    #                                                                                                       "crf_robertson_mb2uv254ed.npy",
    #                                                                                                       "crf_robertson_tlcplate2w.npy"])

    # img_paths = ['C:/Users/UNIST/Documents/tlc_archive/2026-02-04_18-44-26/corrected_2026-02-04_18-44-26_EXP100_UV366.png',
    #              'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_18-44-26/corrected_2026-02-04_18-44-26_EXP200_UV366.png',
    #              'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_18-44-26/corrected_2026-02-04_18-44-26_EXP750_UV366.png']
    # times = [100, 200, 750]
    # linear_hdr_image(img_paths, times, saveto='hdrtest', png_scalefactor=60000)

    # exposures_default = {'vis': tuple([10, 20]), 'uvc': tuple([20, 40]), 'uva': tuple([1, 2])}
    # channel_suffixes_reverse = {'White':'vis', 'UV254':'uvc', 'UV366':'uva'}

    # for channel in ['White', 'UV254']:
    #     if channel == 'White':
    #         kmax=6
    #     else:
    #         kmax=8
    #     exposures = {channel_suffixes_reverse[channel]:exposures_default[channel_suffixes_reverse[channel]]}
    #     print(exposures)
    #     for k in range(kmax):
    #         project_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/{channel}/{k+1}'
    #         print(project_folder)
    #         img_paths = []
    #         times = []
    #         image_dir = Path(project_folder)
    #         for p in image_dir.glob("corrected_*.png"):
    #             if (ec := parse_name(p.name)) is not None and ec[1] == channel:
    #                 img_paths.append(p)
    #                 times.append(ec[0])
    #         sorted_indices = np.argsort(times)
    #         img_paths = [img_paths[i] for i in sorted_indices]
    #         times = np.array([times[i] for i in sorted_indices], dtype=np.float32)
    #         # print(times)
    #         # print(img_paths)
    #         filename_here = str(img_paths[0].stem)
    #         filename_pieces = filename_here.split('_')
    #         datetime_string = filename_pieces[1] + '_' + filename_pieces[2]
    #         print(img_paths)
    #         print(times)
    #         print(datetime_string)
    #         # print(datetime_string)
    #         retroactively_linearize_intensity(target_folder=project_folder, datetime_string=datetime_string,
    #                                           exposures=exposures, exposures_for_linearization=exposures)

        # retroactively_linearize_intensity(project_folder, datetime_string=datetime_string)

    # exposures_default = {'vis': tuple([10, 20]), 'uvc': tuple([20, 40]), 'uva': tuple([1, 1])}
    # channel_suffixes_reverse = {'White':'vis', 'UV254':'uvc', 'UV366':'uva'}
    #
    # for channel in ['UV366']:
    #     if channel == 'White':
    #         kmax=6
    #     else:
    #         kmax=8
    #     exposures = {channel_suffixes_reverse[channel]:exposures_default[channel_suffixes_reverse[channel]]}
    #     print(exposures)
    #     for k in range(kmax):
    #         project_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/{channel}/{k+1}'
    #         print(project_folder)
    #         img_paths = []
    #         times = []
    #         image_dir = Path(project_folder)
    #         for p in image_dir.glob("corrected_*.png"):
    #             if (ec := parse_name(p.name)) is not None and ec[1] == channel:
    #                 img_paths.append(p)
    #                 times.append(ec[0])
    #         sorted_indices = np.argsort(times)
    #         img_paths = [img_paths[i] for i in sorted_indices]
    #         times = np.array([times[i] for i in sorted_indices], dtype=np.float32)
    #         # print(times)
    #         # print(img_paths)
    #         filename_here = str(img_paths[0].stem)
    #         filename_pieces = filename_here.split('_')
    #         datetime_string = filename_pieces[1] + '_' + filename_pieces[2]
    #         print(img_paths)
    #         print(times)
    #         print(datetime_string)
    #         # print(datetime_string)
    #         retroactively_linearize_intensity(target_folder=project_folder, datetime_string=datetime_string,
    #                                           exposures=exposures, exposures_for_linearization=exposures)
    #
    # datetime_strings = ['2026-02-05_03-07-02',
    #                     '2026-02-05_03-02-44',
    #                     '2026-02-05_02-00-26',
    #                     '2026-02-05_01-57-42',
    #                     '2026-02-04_22-21-07',
    #                     '2026-02-04_22-17-38',
    #                     '2026-02-04_21-35-08',
    #                     '2026-02-04_21-21-37',
    #                     '2026-02-04_19-55-09']
    # for datetime_string in datetime_strings:
    #     project_folder = f'C:/Users/UNIST/Documents/tlc_archive/{datetime_string}'
    #     retroactively_linearize_intensity(project_folder, datetime_string=datetime_string)


    channel = 'UV254'
    color_channel = 'G'
    color_channel_index = 1

    # color_channels = {'R':2, 'G':1, 'B':0}
    #
    # for channel in ['White', 'UV366']:
    #     for color_channel in ['R', 'G', 'B']:
    #         color_channel_index = color_channels[color_channel]

    # baseline intensity without filters
    image = np.load(f'F:/tlc/tlc_calibrations/nd_filters/nd0p0/uni_linint_corrected_datetime__{channel}.npy')
    # get mean intensity in the center 100x100 region
    center_region = image[image.shape[0] // 2 - 50:image.shape[0] // 2 + 50,
                    image.shape[1] // 2 - 50:image.shape[1] // 2 + 50, color_channel_index]
    mean_intensity_baseline = center_region.mean()

    # Check linearity from neutral density filter images
    filter_transmiitances = pd.read_csv('calibration/nd_flters/nd_filters_transmission.csv')
    # columns are filter_name,B,G,R
    filter_names = filter_transmiitances['filter_name'].tolist()
    measured_transmittances = []
    expected_transmittances = []
    for filter_name in filter_names:
        print(f'Processing filter {filter_name}...')
        # load numpy image
        image = np.load(f'F:/tlc/tlc_calibrations/nd_filters/nd{filter_name}/uni_linint_corrected_datetime__{channel}.npy')
        print(image.shape)
        # get mean intensity in the center 100x100 region
        center_region = image[image.shape[0]//2-50:image.shape[0]//2+50, image.shape[1]//2-50:image.shape[1]//2+50, color_channel_index]
        mean_intensity = center_region.mean()
        expected_transmittance = filter_transmiitances[filter_transmiitances['filter_name'] == filter_name][color_channel].values[0]
        measured_transmittance = mean_intensity / mean_intensity_baseline
        measured_transmittances.append(measured_transmittance)
        expected_transmittances.append(expected_transmittance)

    # make a plot
    import matplotlib.pyplot as plt
    plt.figure(figsize=(6, 6))
    plt.plot(expected_transmittances, measured_transmittances, 'o-')
    # fit a line and plot it
    xs = np.linspace(0, 1, 100)
    plt.plot(xs, xs, '--', label=f'x=y')
    plt.xlabel('Expected brightness')
    plt.ylabel('Measured brightness')
    plt.title(f'Linearity check for {channel} channel ({color_channel})')
    plt.legend()
    plt.grid()
    plt.savefig(f'calibration/nd_flters//linearity_check_{channel}_{color_channel}.png')
    plt.clf()
