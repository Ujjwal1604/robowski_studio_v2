import numpy as np
import matplotlib.pyplot as plt

from scipy.special.cython_special import expit
from scipy import special

special.expit()


# I0 = incident excitation radiation intensity (W/m²)
# absorbance_coefficients = [] # absorption fraction in an infinitely thin layer per unit concentration per length (L/(mol·cm))
# scattering_coefficients = [] # scattering fraction in an infinitely thin layer per unit concentration per length (L/(mol·cm))
# quantum_efficiencies = [] # quantum efficiency of fluorescence (dimensionless, positive). Flux absorbed by species is multiplied by this to get emitted flux.

def get_R(a_over_r):
    return 1 + a_over_r - np.sqrt(a_over_r**2 + 2*a_over_r)

def get_emission_intensities(concentrations, absorbance_coefficients, scattering_coefficients, quantum_efficiencies, I0=1):
    '''
    :return:
    '''

    # assert that all input lists have the same length, convert to numpy arrays
    concentrations = np.array(concentrations)
    absorbance_coefficients = np.array(absorbance_coefficients)
    scattering_coefficients = np.array(scattering_coefficients)
    quantum_efficiencies = np.array(quantum_efficiencies)
    assert len(concentrations) == len(absorbance_coefficients) == len(scattering_coefficients) == len(quantum_efficiencies), "Input lists must have the same length"

    total_absorption_fraction = np.sum(concentrations * absorbance_coefficients)
    total_scattering_fraction = np.sum(concentrations * scattering_coefficients)

    a_over_r = total_absorption_fraction / total_scattering_fraction
    R = get_R(a_over_r)
    total_absorbed_intensity = I0 * (1 - R)
    emission_intensities = []
    for c, a_coeff, q_eff in zip(concentrations, absorbance_coefficients, quantum_efficiencies):
        emitted_intensity =  q_eff * total_absorbed_intensity * c * a_coeff / total_absorption_fraction
        emission_intensities.append(emitted_intensity)

    return emission_intensities

if __name__ == "__main__":
    # make concentration of one species constant, and another as a gaussain profile w.r.t. position x
    x = np.linspace(-10, 10, 100)
    concentrations_species1 = 1.0 * np.ones_like(x)
    concentrations_species2 = 700 * np.exp(-0.5 * (x / 2)**2)

    factor_here = 12.74
    factor_2 = 1
    absorbance_coefficients = [0.01139, factor_2 * 0.0001 * factor_here]
    scattering_coefficients = [1, 0]
    quantum_efficiencies = [1, factor_2 * 0.9 *3/factor_here] # arbitrary units
    emission_intensities_species1 = []
    emission_intensities_species2 = []
    for c1, c2 in zip(concentrations_species1, concentrations_species2):
        emissions = get_emission_intensities([c1, c2], absorbance_coefficients, scattering_coefficients, quantum_efficiencies)
        emission_intensities_species1.append(emissions[0])
        emission_intensities_species2.append(emissions[1])

    plt.plot(x, emission_intensities_species1, label='TLC emission')
    plt.plot(x, emission_intensities_species2, label='Analyte emission')
    # plot sum
    total_emission = np.array(emission_intensities_species1) + np.array(emission_intensities_species2)
    plt.plot(x, total_emission, label='Total detected emission', linestyle='--')

    plt.xlabel('Position on the plate (i.e. relative Rf)')
    plt.ylabel('Emission Intensity (arbitrary units)')
    plt.legend()
    plt.show()

    # make concentration of one species constant, and another varying
    x = np.linspace(-10, 10, 300)
    concentrations_species1 = 1.0 * np.ones_like(x)
    concentrations_species2 = np.linspace(0, 500, len(x))

    # use the total emission as radial profile. Generate a picture in shades of green-to-black with the radial profile of greenness
    fig = plt.figure(figsize=(4.5, 4.5))

    # make a two dimensional array for the image
    image_size = 300
    image = np.zeros((image_size, image_size))
    center = image_size // 2
    r = np.sqrt((np.arange(image_size) - center)**2 + (np.arange(image_size)[:, np.newaxis] - center)**2) / 15
    concentrations_species1 = 1.0 * np.ones_like(r)
    concentrations_species2 = 700 * np.exp(-0.5 * (r / 2)**2)

    factor_here = 12.74
    factor_2 = 1
    absorbance_coefficients = [0.01139, factor_2 * 0.0001 * factor_here]
    scattering_coefficients = [1, 0]
    quantum_efficiencies = [1, factor_2 * 0.9 *3/factor_here] # arbitrary units

    # now compute total emission for every pixel
    for i in range(image_size):
        for j in range(image_size):
            c1 = concentrations_species1[i, j]
            c2 = concentrations_species2[i, j]
            emissions = get_emission_intensities([c1, c2], absorbance_coefficients, scattering_coefficients, quantum_efficiencies)
            total_emission = emissions[0] + emissions[1]
            image[i, j] = total_emission

    # show
    plt.imshow(image, cmap='Greens_r', vmax=np.max(image)*2)
    plt.show()





    # make figure 6x6 inch
    fig = plt.figure(figsize=(4.5, 4.5))

    N = 20
    colors = plt.cm.viridis(np.linspace(0, 1, N))
    for color_id, factor_here in enumerate(np.logspace(0, 3, N)):
        # absorbance_coefficients = [1.2340, 0.01 * factor_here]
        absorbance_coefficients = [0.01139, 0.0001 * factor_here]
        scattering_coefficients = [1, 0]
        quantum_efficiencies = [1, 3/factor_here] # arbitrary units
        emission_intensities_species1 = []
        emission_intensities_species2 = []
        total_emission = []
        for c1, c2 in zip(concentrations_species1, concentrations_species2):
            emissions = get_emission_intensities([c1, c2], absorbance_coefficients, scattering_coefficients, quantum_efficiencies)
            emission_intensities_species1.append(emissions[0])
            emission_intensities_species2.append(emissions[1])
            total_emission.append(emissions[0] + emissions[1])

        # plt.plot(x, emission_intensities_species1, label='Species 1 Emission')
        # plt.plot(x, emission_intensities_species2, label='Species 2 Emission')
        # total_emission = np.array(total_emission)/np.max(np.array(total_emission))
        if color_id == 7:
            plt.plot(concentrations_species2, total_emission, label=f'$\kappa$={factor_here:.4f})', alpha=1,
                     color='k')
        else:
            plt.plot(concentrations_species2, total_emission , label=f'$\kappa$={factor_here:.4f})', alpha=0.7, color=colors[color_id])

    # plt.xlabel('Position x')
    plt.ylabel('Total emission flux from the plate (arbitrary units)')
    plt.xlabel('Analyte concentration (arbitrary units)')
    plt.xlim(-1,501)
    # do simpleaxis()
    plt.gca().spines['top'].set_visible(False)
    plt.gca().spines['right'].set_visible(False)
    # plt.legend()
    plt.show()
