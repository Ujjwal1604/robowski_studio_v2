import numpy as np
import cv2
from pathlib import Path
from get_lanes import *

def correct_flatness_for_image(baseline_image_path, target_image_path, png_scalefactor, saveto, force_single_baseline_channel=None):
    baseline_image = np.load(baseline_image_path)

    if force_single_baseline_channel is not None:
        # for i in range(3):
        #     print(f'Baseline channel {i} max: {np.max(baseline_image[:, :, i])}')
        # copy the contents of the selected channel to all channels of the image
        selected_baseline_channel = force_single_baseline_channel
        select_channel_data = np.copy(baseline_image[:,:,selected_baseline_channel])
        baseline_image[:,:,0] = select_channel_data
        baseline_image[:,:,1] = select_channel_data
        baseline_image[:,:,2] = select_channel_data
        # for i in range(3):
        #     print(f'After copying, baseline channel {i} max: {np.max(baseline_image[:, :, i])}')

    baseline_image = baseline_image / np.max(baseline_image) + 1e-14
    target_image = np.load(target_image_path)
    corrected_image = target_image / baseline_image
    np.save(saveto + '.npy', corrected_image)
    clipped_image = np.clip(corrected_image * png_scalefactor, 0, 255).astype(np.uint8)
    cv2.imwrite(saveto + '.png', clipped_image)


def retroactively_correct_uniformily(target_folder, datetime_string=None, undistort=True, without_autoillumination_correction=True,
                         linearize_intensity=True,
                         exposures={'vis':tuple([10, 20]), 'uvc':tuple([69, 138]), 'uva':tuple([100, 200, 750])},
                         exposures_for_linearization={'vis':tuple([10, 20]), 'uvc':tuple([69, 138]), 'uva':tuple([100, 200, 750])},
                         png_scalefactors={'vis':2300, 'uvc':12000, 'uva':60000},
                         crf_parameters_filepath="crf_robertson_mb4wonly.npy",
                         correct_uniformity=True,
                         baseline_images={'vis':f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/White/averaged_image.npy',
                                          'uvc':f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/UV254/averaged_image.npy',
                                          'uva':f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/UV366/averaged_image.npy'},
                         baseline_channels={'vis':None, 'uvc':0, 'uva':0},
                         png_scalefactors_after_uni={'vis':2100, 'uvc':11000, 'uva':60000}):

    channels = ('vis', 'uva', 'uvc')
    channel_suffixes = {'vis': 'White', 'uvc': 'UV254', 'uva': 'UV366'}

    if correct_uniformity:
        for channel in channels:
            if channel in exposures:
                correct_flatness_for_image(baseline_image_path=baseline_images[channel],
                                           target_image_path=f'{target_folder}/linint_corrected_{datetime_string}_{channel_suffixes[channel]}.npy',
                                           png_scalefactor=png_scalefactors_after_uni[channel],
                                           saveto=f'{target_folder}/uni_linint_corrected_{datetime_string}_{channel_suffixes[channel]}',
                                           force_single_baseline_channel=baseline_channels[channel])

if __name__ == '__main__':
    # channel = 'White'
    # baseline_image_path = f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/{channel}/averaged_image.npy'
    # target_image_path = f'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_19-55-09/linint_corrected_2026-02-04_19-55-09_White.npy'
    # png_scalefactor = 2100
    # saveto = 'unitest'
    # correct_flatness_for_image(baseline_image_path, target_image_path, png_scalefactor, saveto)

    # channel = 'UV254'
    # baseline_image_path = f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/{channel}/averaged_image.npy'
    # target_image_path = 'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_19-45-33/linint_corrected_2026-02-04_19-45-33_UV254.npy'
    # # target_image_path = f'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_19-55-09/linint_corrected_2026-02-04_19-55-09_UV254.npy'
    # png_scalefactor = 11000
    # saveto = 'unitest'
    # correct_flatness_for_image(baseline_image_path, target_image_path, png_scalefactor, saveto,
    #                            force_single_baseline_channel=0)

    # channel = 'UV366'
    # baseline_image_path = f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/{channel}/averaged_image.npy'
    # # target_image_path = 'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_19-45-33/linint_corrected_2026-02-04_19-45-33_UV366.npy'
    # target_image_path = f'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_19-55-09/linint_corrected_2026-02-04_19-55-09_UV366.npy'
    # png_scalefactor = 60000
    # saveto = 'unitest'
    # correct_flatness_for_image(baseline_image_path, target_image_path, png_scalefactor, saveto,
    #                            force_single_baseline_channel=0)

    datetime_strings = ['2026-02-05_03-07-02',
                        '2026-02-05_03-02-44',
                        '2026-02-05_02-00-26',
                        '2026-02-05_01-57-42',
                        '2026-02-04_22-21-07',
                        '2026-02-04_22-17-38',
                        '2026-02-04_21-35-08',
                        '2026-02-04_21-21-37',
                        '2026-02-04_19-55-09']
    for datetime_string in datetime_strings:
        project_folder = f'C:/Users/UNIST/Documents/tlc_archive/{datetime_string}'
        retroactively_correct_uniformily(project_folder, datetime_string=datetime_string)
        # Extract lanes
        target_dir = Path(project_folder)
        image_paths = find_images(target_dir)

        config = 'calibration/lanes.csv'
        shutil.copy(config, target_dir / "lane_config.csv")
        config_path = config

        lanes = load_config(config_path)
        images = {ch: np.load(path) for ch, path in image_paths.items()}
        scale_factors = {
            'White': 2100,
            'UV254': 11000,
            'UV366': 60000,
        }

        lanes_dir = target_dir / "lanes"
        process_lanes(images, lanes, scale_factors, lanes_dir)
        create_visualizations(images, image_paths, lanes, scale_factors, lanes_dir)

