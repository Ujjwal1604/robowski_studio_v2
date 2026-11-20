from tlc_explorer_api import capture_all_channels
import time
import os
from get_lanes import *
import shutil
from pathlib import Path
import subprocess

if __name__ == '__main__':
    datetime_string = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime())
    project_folder = f'C:/Users/UNIST/Documents/tlc_archive/{datetime_string}'
    # make a folder if it does not exist
    os.mkdir(project_folder)
    capture_all_channels(project_folder, datetime_string=datetime_string)

    # # Extract lanes
    # target_dir = Path(project_folder)
    # image_paths = find_images(target_dir)
    #
    # config = 'calibration/lanes.csv'
    # shutil.copy(config, target_dir / "lane_config.csv")
    # config_path = config
    #
    # lanes = load_config(config_path)
    # images = {ch: np.load(path) for ch, path in image_paths.items()}
    # scale_factors = {
    #     'White': 2100,
    #     'UV254': 11000,
    #     'UV366': 60000,
    # }
    #
    # lanes_dir = target_dir / "lanes"
    # process_lanes(images, lanes, scale_factors, lanes_dir)
    # create_visualizations(images, image_paths, lanes, scale_factors, lanes_dir)


    #python get_lanes.py C:\Users\UNIST\Documents\tlc_archive\2026-02-05_03-07-02 --microadjust --agg-func mean
    #python get_lanes.py C:\Users\UNIST\Documents\tlc_archive\2026-02-05_03-07-02 --microadjust --agg-func savgol4_25middle
    #python get_lanes.py C:\Users\UNIST\Documents\tlc_archive\2026-02-05_03-07-02 --microadjust --agg-func sides_2px
    #python get_lanes.py C:\Users\UNIST\Documents\tlc_archive\2026-02-05_03-07-02 --microadjust --agg-func savgol_automiddle

    print('Replotting the summary image using the default locations of lanes...')
    subprocess.run(["python", "replot_lanes.py", project_folder.replace('/', '\\'), "--config", r"C:\Users\UNIST\Documents\tlc_python_api\calibration\lanes.csv"])  # For Linux/macOS

    print('Extracting lanes...')
    print('Version using lane coordinates from config file as-is...')
    print('...in mean mode...')
    subprocess.run(["python", "get_lanes.py", project_folder.replace('/', '\\'), "--config", r"C:\Users\UNIST\Documents\tlc_python_api\calibration\lanes.csv", "--agg-func", "mean"])  # For Linux/macOS
    print('...in savgol4_25middle mode...')
    subprocess.run(["python", "get_lanes.py", project_folder.replace('/', '\\'), "--config", r"C:\Users\UNIST\Documents\tlc_python_api\calibration\lanes.csv", "--agg-func", "savgol4_25middle"])  # For Linux/macOS
    print('...in sides_2px mode...')
    subprocess.run(["python", "get_lanes.py", project_folder.replace('/', '\\'), "--config", r"C:\Users\UNIST\Documents\tlc_python_api\calibration\lanes.csv", "--agg-func", "sides_2px"])  # For Linux/macOS
    print('...in automiddle mode...')
    subprocess.run(["python", "get_lanes.py", project_folder.replace('/', '\\'), "--config", r"C:\Users\UNIST\Documents\tlc_python_api\calibration\lanes.csv", "--agg-func", "savgol_automiddle"])  # For Linux/macOS
    print('Microadjusted version...')
    print('...in mean mode...')
    subprocess.run(["python", "get_lanes.py", project_folder.replace('/', '\\'), "--config", r"C:\Users\UNIST\Documents\tlc_python_api\calibration\lanes.csv", "--microadjust", "--agg-func", "mean"])  # For Linux/macOS
    print('...in savgol4_25middle mode...')
    subprocess.run(["python", "get_lanes.py", project_folder.replace('/', '\\'), "--config", r"C:\Users\UNIST\Documents\tlc_python_api\calibration\lanes.csv", "--microadjust", "--agg-func", "savgol4_25middle"])  # For Linux/macOS
    print('...in sides_2px mode...')
    subprocess.run(["python", "get_lanes.py", project_folder.replace('/', '\\'), "--config", r"C:\Users\UNIST\Documents\tlc_python_api\calibration\lanes.csv", "--microadjust", "--agg-func", "sides_2px"])  # For Linux/macOS
    print('...in automiddle mode...')
    subprocess.run(["python", "get_lanes.py", project_folder.replace('/', '\\'), "--config", r"C:\Users\UNIST\Documents\tlc_python_api\calibration\lanes.csv", "--microadjust", "--agg-func", "savgol_automiddle"])  # For Linux/macOS

    print('Replotting the summary image using microadjusted locations of lanes...')
    projfolderstring = project_folder.replace('/', '\\')
    subprocess.run(["python", "replot_lanes.py", project_folder.replace('/', '\\'), "--config", fr"{projfolderstring}\microadjusted_lane_config.csv", "--out-suffix", "microadjusted"])  # For Linux/macOS
    print('...Done.')