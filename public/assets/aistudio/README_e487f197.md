# Python API and various improvements for the Merck TLC Explorer device

## Features
- Python API for control of the Merck TLC Explorer device: 
programmatic capturing of images with any illumination mode and any exposure.
- Correction of imaging camera's geometrical distortions in the captured images
- Reverse transform of light intensity into linear space for accurate analysis
- Correction of spatial non-uniformity in illumination across the TLC plate
- Automatic extraction of lanes from images

## One-button autocapture

Download the repository and run `autocapture.bat`. Using the mouse/keyboard control apps,
you may bind execution of `autocapture.bat` to a button on your keyboard or mouse for one-button image capture.