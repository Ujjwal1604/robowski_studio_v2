import numpy as np
import cv2

from tlc_explorer_api import capture_all_channels
import time
import os

from pathlib import Path
import glob

if __name__ == '__main__':
    datetime_strings = ['2026-02-05_03-07-02',
                        '2026-02-05_03-02-44',
                        '2026-02-05_02-00-26',
                        '2026-02-05_01-57-42',
                        '2026-02-04_22-21-07',
                        '2026-02-04_22-17-38', # calibration
                        '2026-02-04_21-35-08',
                        '2026-02-04_21-21-37', # calibration
                        '2026-02-04_19-55-09']
    datetime_strings2 = ['2026-02-11_22-35-36', # calibration
                        '2026-02-12_01-51-57',
                         '2026-02-12_05-18-21',
                         '2026-03-21_01-46-58',
                         '2026-03-21_01-49-04',
                         '2026-03-21_02-26-02',
                         '2026-03-21_02-28-55',
                             ]
    datetime_strings3=[
        '2026-03-25_13-21-39-Clean_Gryko-2',
        '2026-03-25_17-52-15',
    ]


    for datetime_string in datetime_strings + datetime_strings2 + datetime_strings3:
        for aggfunc in ['mean', 'savgol4_25middle', 'sides_2px', 'savgol_automiddle']:
            print(fr'python get_lanes.py C:\Users\UNIST\Documents\tlc_archive\{datetime_string} --microadjust --agg-func {aggfunc}')

    for datetime_string in datetime_strings + datetime_strings2 + datetime_strings3:
        for aggfunc in ['mean', 'savgol4_25middle', 'sides_2px', 'savgol_automiddle']:
            print(fr'python get_lanes.py C:\Users\UNIST\Documents\tlc_archive\{datetime_string} --agg-func {aggfunc}')

    datetime_string = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime())
    # project_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/exposure_sweep_tlcplate'
    # make a folder if it does not exist
    # os.mkdir(project_folder)
    # exposures_list = []
    # exposures_list.extend(list(range(1,20, 2)))
    # exposures_list.extend(list(range(20,300, 10)))
    # exposures_list.extend(list(range(300,2100, 100)))
    # for exposure in exposures_list:
    #     capture_all_channels(project_folder, datetime_string=datetime_string,
    #                          exposures={'vis': tuple([exposure]), 'uvc': tuple([exposure]), 'uva': tuple([exposure])})


    # project_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/exposure_sweep_mb2'
    # exposures_list = []
    # exposures_list.extend(list(range(1,100, 2)))
    # exposures_list.extend(list(range(100, 300, 10)))
    # exposures_list.extend(list(range(300, 2100, 30)))
    # for exposure in exposures_list:
    #     capture_all_channels(project_folder, datetime_string=datetime_string,
    #                          exposures={'vis': tuple([exposure]), 'uvc': tuple([exposure]), 'uva': tuple([exposure])})

    # ### White channel only. To avoid photobleaching.
    # project_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/exposure_sweep_mb4wonly'
    # exposures_list = []
    # exposures_list.extend(list(range(1, 100, 1)))
    # exposures_list.extend(list(range(100, 200, 2)))
    # exposures_list.extend(list(range(200, 300, 4)))
    # exposures_list.extend(list(range(300, 1200, 10)))
    # for exposure in exposures_list:
    #     capture_all_channels(project_folder, datetime_string=datetime_string,
    #                          exposures={'vis': tuple([exposure])})

    # ### UV366 channel only. To avoid photobleaching.
    # project_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/exposure_sweep_UV366_obj1'
    # exposures_list = []
    # # exposures_list.extend(list(range(1, 100, 1)))
    # exposures_list.extend(list(range(1, 200, 2)))
    # exposures_list.extend(list(range(200, 300, 4)))
    # exposures_list.extend(list(range(300, 1200, 10)))
    # for exposure in exposures_list:
    #     capture_all_channels(project_folder, datetime_string=datetime_string,
    #                          exposures={'uva': tuple([exposure])},
    #                          linearize_intensity=False,
    #                          correct_uniformity=False)

    # project_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/exposure_sweep_tlcplate2'
    # exposures_list = []
    # exposures_list.extend(list(range(1,200, 1)))
    # # exposures_list.extend(list(range(100, 300, 10)))
    # # exposures_list.extend(list(range(300, 2100, 30)))
    # for exposure in exposures_list:
    #     capture_all_channels(project_folder, datetime_string=datetime_string,
    #                          exposures={'vis': tuple([exposure]), 'uvc': tuple([exposure])},
    #                          linearize_intensity=False,
    #                          correct_uniformity=False
    #                          )

    # photobleaching test



    # Uniformity data

    # # UV254
    # default_exposure = 40
    # datetime_string = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime())
    # id = 1
    # project_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/UV254/{id}'
    # # make a folder if it does not exist
    # os.mkdir(project_folder)
    # capture_all_channels(project_folder, datetime_string=datetime_string, undistort=True, without_autoillumination_correction=True,
    #                      linearize_intensity=True,
    #                      exposures={'uvc': tuple([int(round(default_exposure/2)), default_exposure])},
    #                      exposures_for_linearization={'uvc': tuple([int(round(default_exposure/2)), default_exposure])},
    #                      png_scalefactors={'vis': 2300, 'uvc': 12000, 'uva': 60000},
    #                      crf_parameters_filepath="crf_robertson_mb4wonly.npy")

    # # UV366
    # default_exposure = 2
    # datetime_string = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime())
    # id = 8
    # project_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/UV366/{id}'
    # # make a folder if it does not exist
    # os.mkdir(project_folder)
    # capture_all_channels(project_folder, datetime_string=datetime_string, undistort=True, without_autoillumination_correction=True,
    #                      linearize_intensity=True,
    #                      exposures={'uva': tuple([int(round(default_exposure/2)), default_exposure])},
    #                      exposures_for_linearization={'uva': tuple([int(round(default_exposure/2)), default_exposure])},
    #                      png_scalefactors={'vis': 2300, 'uvc': 12000, 'uva': 100},
    #                      crf_parameters_filepath="crf_robertson_mb4wonly.npy")

    # ### Average calibration images
    # channel = 'White'
    # nimages = 6
    #
    # # channel = 'UV254'
    # # nimages = 8
    #
    # # channel = 'UV366'
    # # nimages = 8
    #
    # base_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/{channel}'
    # image = None
    # for i in range(nimages):
    #     k = i + 1
    #     subfolder = f'{base_folder}/{k}'
    #     # use glob to find all files that look like 'linint_corrected_2026-02-04_20-11-46_White.npy
    #     foundfiles = glob.glob(subfolder + f'/linint_corrected_*_{channel}.npy')
    #     print(foundfiles)
    #     filename = foundfiles[0]
    #     if image is None:
    #         image = np.load(filename)
    #     else:
    #         # add new image to the old one, channel-wise
    #         image = image + np.load(filename)
    #     print('Max signal in image: ', np.max(image))
    #
    # # gaussian blue, then save
    # image = cv2.GaussianBlur(image, (21, 21), 0)
    # np.save(f"{base_folder}/averaged_image.npy", image)
    #
    # ## View: for debugging
    # lin_norm = cv2.normalize(image, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)
    # cv2.imshow("Linear Image", lin_norm)
    # cv2.waitKey(0)
    # cv2.destroyAllWindows()

    # image[:,:,1] = image[:,:,0]
    # image[:, :, 2] = image[:, :, 0]
    # ## View: for debugging
    # lin_norm = cv2.normalize(image, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)
    # cv2.imshow("Linear Image", lin_norm)
    # cv2.waitKey(0)
    # cv2.destroyAllWindows()
    #
    #### Normalize one image by another

    # channel = 'White'
    # baseline_image = np.load(f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/{channel}/averaged_image.npy')
    # baseline_image = baseline_image / np.max(baseline_image) + 1e-14
    #
    # # target_image = np.load(f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/White/1/linint_corrected_2026-02-04_20-11-46_White.npy')
    # target_image = np.load(
    #     f'C:/Users/UNIST/Documents/tlc_archive/2026-02-04_19-55-09/linint_corrected_2026-02-04_19-55-09_White.npy')
    #
    # corrected_image = target_image / baseline_image * 0.9
    # print(np.max(corrected_image))
    # print(np.mean(corrected_image))
    #
    # corrected_image = np.clip(corrected_image, 0, 0.12)
    #
    # png_scalefactor = 2300
    # saveto = 'unitest'
    # clipped_image = np.clip(corrected_image * png_scalefactor, 0, 255).astype(np.uint8)
    # cv2.imwrite(saveto + '.png', clipped_image)
    #
    # ## View: for debugging
    # lin_norm = cv2.normalize(corrected_image, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)
    # cv2.imshow("Linear Image", lin_norm)
    # cv2.waitKey(0)
    # cv2.destroyAllWindows()

    # # data = np.load('C:/Users/UNIST/Documents/tlc_archive/2026-02-04_22-17-38/uni_linint_corrected_2026-02-04_22-17-38_UV254.npy')
    # data = np.load('C:/Users/UNIST/Documents/tlc_archive/2026-02-04_22-17-38/linint_corrected_2026-02-04_22-17-38_UV254.npy')
    # data = data[:,:,1]
    # data[data > 0.02] = 0.02
    #
    # import matplotlib.pyplot as plt
    # # use plt imshow with viridis
    # plt.imshow(data, cmap='viridis')
    # plt.colorbar()
    # plt.show()

    # ## TESTING LINEARITY WITH ND FILTERS IN FRONT OF THE CAMERA
    # datetime_string = 'datetime_'
    # project_folder = f'C:/Users/UNIST/Documents/tlc_calibrations/nd_filters/nd1p0'
    # # make a folder if it does not exist
    # os.mkdir(project_folder)
    # capture_all_channels(project_folder, datetime_string=datetime_string)
    