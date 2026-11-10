/**
 * RDKit WebAssembly wrapper for publication-quality 2D chemical structure rendering.
 * Provides the same drawing engine as Python's rdkit.Chem.Draw (MolDraw2DSVG).
 */

let rdkitInstance: any = null;
let rdkitInitPromise: Promise<any> | null = null;

export async function getRDKitInstance(): Promise<any> {
  if (rdkitInstance) return rdkitInstance;
  if (rdkitInitPromise) return rdkitInitPromise;

  rdkitInitPromise = new Promise((resolve) => {
    // 1. Check if already initialized on window
    if (typeof window !== 'undefined' && (window as any).RDKit) {
      rdkitInstance = (window as any).RDKit;
      resolve(rdkitInstance);
      return;
    }

    // 2. Check for global initRDKitModule loaded via script tag
    const initFn =
      typeof window !== 'undefined'
        ? (window as any).initRDKitModule
        : undefined;

    const isNode = typeof window === 'undefined';
    const locateOptions = isNode
      ? {}
      : {
          locateFile: () => './rdkit/RDKit_minimal.wasm',
        };

    if (typeof initFn === 'function') {
      initFn(locateOptions)
        .then((inst: any) => {
          rdkitInstance = inst;
          if (typeof window !== 'undefined') (window as any).RDKit = inst;
          resolve(inst);
        })
        .catch((err: any) => {
          console.warn('[RDKit] Failed to load via window.initRDKitModule:', err);
          resolve(null);
        });
      return;
    }

    // 3. Fallback: dynamic import of npm package
    import('@rdkit/rdkit')
      .then((mod) => {
        const factory = mod.default || mod;
        if (typeof factory === 'function') {
          factory(locateOptions)
            .then((inst: any) => {
              rdkitInstance = inst;
              if (typeof window !== 'undefined') (window as any).RDKit = inst;
              resolve(inst);
            })
            .catch((err: any) => {
              console.warn('[RDKit] Failed to initialize via import:', err);
              resolve(null);
            });
        } else {
          resolve(null);
        }
      })
      .catch((err) => {
        console.warn('[RDKit] Module import failed:', err);
        resolve(null);
      });
  });

  return rdkitInitPromise;
}

export interface RdkitDrawOptions {
  width: number;
  height: number;
  isDark?: boolean;
  bondLineWidth?: number;
}

/**
 * Draws a molecule into an SVG string using RDKit's MolDraw2D.
 */
export function drawSmilesWithRDKit(
  rdkit: any,
  smiles: string,
  options: RdkitDrawOptions
): string | null {
  if (!rdkit || !smiles || !smiles.trim()) return null;

  let mol: any = null;
  try {
    mol = rdkit.get_mol(smiles.trim());
    if (!mol || !mol.is_valid()) {
      mol?.delete?.();
      return null;
    }

    const { width, height, isDark = false, bondLineWidth = 1.8 } = options;

    const details = {
      width: Math.max(40, Math.round(width)),
      height: Math.max(30, Math.round(height)),
      bondLineWidth,
      clearBackground: false,
      backgroundColour: [1, 1, 1, 0], // transparent background
      legend: '',
    };

    let svg: string = mol.get_svg_with_highlights(JSON.stringify(details));
    mol.delete();

    if (!svg) return null;

    // For dark mode: turn pure black bonds (#000000) into crisp accessible slate/white (#e2e8f0),
    // while leaving element colors (red Oxygen #FF0000, blue Nitrogen #0000FF, yellow Sulfur, etc.) intact.
    if (isDark) {
      svg = svg
        .replace(/stroke:#000000/g, 'stroke:#e2e8f0')
        .replace(/stroke: #000000/g, 'stroke: #e2e8f0')
        .replace(/fill='#000000'/g, "fill='#e2e8f0'");
    }

    return svg;
  } catch (err) {
    try {
      mol?.delete?.();
    } catch {}
    console.warn('[RDKit] drawSmiles error for', smiles, err);
    return null;
  }
}

/**
 * Computes exact average molecular weight (g/mol) directly from a SMILES string offline using RDKit.
 */
export function computeMolecularWeightFromSmiles(
  rdkit: any,
  smiles: string
): number | null {
  if (!rdkit || !smiles || !smiles.trim()) return null;
  let mol: any = null;
  try {
    mol = rdkit.get_mol(smiles.trim());
    if (!mol || !mol.is_valid()) {
      mol?.delete?.();
      return null;
    }
    const desc = JSON.parse(mol.get_descriptors());
    mol.delete();
    return desc.amw ? Math.round(desc.amw * 1000) / 1000 : null;
  } catch {
    try {
      mol?.delete?.();
    } catch {}
    return null;
  }
}
