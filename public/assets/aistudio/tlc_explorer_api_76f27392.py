import datetime
import os

import requests
import time
from distortion_correction import load_and_apply_correction
from hdr_linearize_intensity import linear_hdr_image
from flatness_correction import correct_flatness_for_image

def collect_sample(sample_name, vis_exposure=43, uv254_exposure=300, uv366_exposure=200, instrument_ip='192.168.200.1'):
    headers = {
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Origin': 'http://192.168.200.1',
        'Referer': 'http://192.168.200.1/?lang=en&v=capture&user=IBS',
        'SessionKey': '1761647131273',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'local-time': '1761681841.028',
        'user': 'IBS',
        'userFullName': '',
        'utc-time': '1761649441.028',
    }

    current_date = datetime.datetime.now()
    datetime_string = current_date.strftime("%Y/%m/%d, %H:%M:%S")
    print(datetime_string)

    json_data = {
        'setname': sample_name,
        'abort': '',
        'author': 'IBS',
        'date': datetime_string,
        'vis': vis_exposure,
        'uva': uv366_exposure,
        'uvc': uv254_exposure,
        'uva_hdr': True,
        'userData': {
            'user': 'IBS',
            'userFullName': '',
            'SessionKey': '1761647131273',
        },
    }

    response = requests.post(f'http://{instrument_ip}/app/capture', headers=headers, json=json_data, verify=False)

    # print(response)

# Note: json_data will not be serialized by requests
# exactly as it was in the original request.
#data = '{"setname":"z2025-10-28","abort":"","author":"IBS","date":"28/10/2025, 20:04:01","vis":23,"uva":114,"uvc":135,"uva_hdr":false,"userData":{"user":"IBS","userFullName":"","SessionKey":"1761647131273"}}'
#response = requests.post('http://192.168.200.1/app/capture', headers=headers, data=data, verify=False)

def capture_image(channel_name, exposure, output_filepath):
    """
    Captures an image from the UV imaging device and saves it to disk.

    Args:
        channel_name: One of 'uvc' (254 nm), 'uva' (366 nm), or 'vis' (visible white light)
        exposure: Exposure time in milliseconds (positive integer)
        output_filepath: Path where the captured image will be saved

    Returns:
        str: The output filepath (enables function composition)
    """
    # Input validation
    assert channel_name in ('uvc', 'uva', 'vis'), \
        f"Invalid channel_name: {channel_name}. Must be 'uvc', 'uva', or 'vis'"
    assert isinstance(exposure, int) and exposure > 0, \
        f"Exposure must be a positive integer, got {exposure}"
    assert isinstance(output_filepath, str) and output_filepath, \
        "output_filepath must be a non-empty string"

    # if output filepath does not end with .jpg, warn the user and add it
    if not output_filepath.lower().endswith('.jpg'):
        print(f"Warning: output_filepath does not end with .jpg, adding it automatically.")
        output_filepath += '.jpg'

    # Calculate current Unix time in milliseconds
    unixtime_in_ms = int(time.time() * 1000)

    # Prepare request components
    url = f'http://192.168.200.1/app/snap_{channel_name}_{exposure}.jpg?{unixtime_in_ms}'
    headers = {
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Referer': 'http://192.168.200.1/?lang=en&v=capture&user=IBS&imageset=20251114_rif_vin_phe_aq_2h_stained_exp120',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    }

    # Execute request
    response = requests.get(url, headers=headers, verify=False)

    # Verify successful response
    assert response.status_code == 200, \
        f"Request failed with status code {response.status_code}"

    # Write image binary content to file
    open(output_filepath, 'wb').write(response.content)

    return output_filepath


def capture_all_channels(target_folder, datetime_string=None, undistort=True, without_autoillumination_correction=True,
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
                                                               },
                         correct_uniformity=True,
                         baseline_images={'vis':f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/White/averaged_image.npy',
                                          'uvc':f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/UV254/averaged_image.npy',
                                          'uva':f'C:/Users/UNIST/Documents/tlc_calibrations/uniformity/UV366/averaged_image.npy'},
                         baseline_channels={'vis':None, 'uvc':0, 'uva':0},
                         png_scalefactors_after_uni={'vis':2100, 'uvc':11000, 'uva':60000}):

    if without_autoillumination_correction:
        set_device_illumination_correction(enable=False)

    channel_suffixes = {'vis': 'White', 'uvc':'UV254', 'uva': 'UV366'}
    if datetime_string is None:
        datetime_string = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime())

    # Sequence is important. Expose to white light first, then to 366 nm, then to 254 nm.
    # In progressively longer exposures for each channel.
    # The reasoning is based on potentially photobleaching effect of UV, with shorter wavelength corresponding to
    # higher energy of photon and therefore to stronger photobleaching.
    channels = ('vis', 'uva', 'uvc')

    print('Capturing images. Exposure is in progress. Do not open the tray until the next message appears.')
    for channel in channels:
        if channel in exposures:
            for exposure in exposures[channel]:
                capture_image(channel, exposure, f'{target_folder}/{datetime_string}_{exposure}_{channel_suffixes[channel]}.jpg')

    set_device_illumination_correction(enable=True)

    print('Capturing has finished. You may open the tray and remove the plate if you wish.')
    if undistort:
        print('Correcting geometric distortion...')
        for channel in channels:
            if channel in exposures:
                for exposure in exposures[channel]:
                    source_image_path = f'{target_folder}/{datetime_string}_{exposure}_{channel_suffixes[channel]}.jpg'
                    target_image_path = f'{target_folder}/corrected_{datetime_string}_EXP{exposure}_{channel_suffixes[channel]}.png'
                    load_and_apply_correction(calibration_maps_filename='calibration/results/large_2025-10-30/calibration_maps.npz',
                                              source_image_file=source_image_path,
                                              target_image_file=target_image_path)

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

    if correct_uniformity:
        print('Compensating for nonuniform illumination...')
        for channel in channels:
            if channel in exposures:
                correct_flatness_for_image(baseline_image_path=baseline_images[channel],
                                           target_image_path=f'{target_folder}/linint_corrected_{datetime_string}_{channel_suffixes[channel]}.npy',
                                           png_scalefactor=png_scalefactors_after_uni[channel],
                                           saveto=f'{target_folder}/uni_linint_corrected_{datetime_string}_{channel_suffixes[channel]}',
                                           force_single_baseline_channel=baseline_channels[channel])



def set_device_illumination_correction(enable):
    '''
    This controls whether the device will apply the internal correction for spatial non-uniformity of illumination.
    Equivalent to "Apply illumination correction" checkbox in the "Settings" section of the web-interface.
    
    :param enable: boolean
         Can be True or False, depending on whether you want to switch illumination correction inside the device on or off.
    :return:
    '''

    headers = {
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Origin': 'http://192.168.200.1',
        'Referer': 'http://192.168.200.1/?lang=en&v=settings&user=IBS&imageset=test-LGA-2025-11-10-3-TLC-5000ms_for_uv254_nocorr&plate=0',
        'SessionKey': '1761807853274',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'local-time': '1762820454.547',
        'user': 'IBS',
        'userFullName': '',
        'utc-time': '1762788054.547',
    }

    json_data = {
        'device_settings': {
            'light_settings': {
                'correction': enable,
                'stray_light': False,
            },
        },
    }

    response = requests.post('http://192.168.200.1/app/settings.json', headers=headers, json=json_data, verify=False)
    # print(response)

if __name__ == '__main__':
    pass
    # collect_sample(sample_name='z2025-10-30_some_name', uv366_exposure=2000)
    # collect_sample(sample_name='test-LGA-2025-11-10-3-TLC-5000ms_for_uv254_nocorr', uv254_exposure=5000)
    # change_light_settings()
    # capture_image('vis', 43, 'test_captured_image.jpg')
    # capture_all_channels('C:/Users/UNIST/Documents/tlc_archive/temp1')
    exposures = {'vis': tuple([43]), 'uvc': tuple([40]), 'uva': tuple([1])}
    for i in range(100):
        print(f'{i}th exposure')
        project_folder = f'calibration/illumination_nonuniformity/a3_cut_sheet1_orientation1/{i}'
        # make a folder if it does not exist
        os.mkdir(project_folder)
        capture_all_channels(project_folder, exposures=exposures)
