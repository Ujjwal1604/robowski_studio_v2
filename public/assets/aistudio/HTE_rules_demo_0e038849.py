"""Rule-based product prediction for HTE wells (prototype).

Each elementary step is an RDKit reaction SMARTS with metadata:
  - bimolecular or unimolecular
  - which condition favours it ('acid', 'base' or 'either')
  - a prior (0-1): how likely the step is to go under the screening conditions
The driver applies the rules repeatedly (a small reaction network), so products
can chain: aldehyde + malononitrile -> Knoevenagel adduct -> aza-Michael adduct, etc.
Run:  python HTE_rules_demo.py
"""
from itertools import product
from rdkit import Chem
from rdkit.Chem import AllChem, Descriptors

EWG = '$(C=O),$(C#N)'
# name: (reaction SMARTS, favoured condition, prior)
RULES = {
 # NA(N): amine adds to aldehyde/ketone -> carbinolamine
 'NA(N)': ('[CX3;$([CH1](=O)[#6]),$(C(=O)([#6])[#6]):1]=[O:2].[NX3;H2,H1;!$(N-C=[O,S,N]);!$(N-N);!$(N-S);!$(N-C-[OX2H]):3]>>[C:1]([OX2H:2])[N:3]', 'either', 0.9),
 # DH: carbinolamine -> imine / enamine side (needs N-H)
 'DH(imine)': ('[CX4:1]([OX2H])[NX3;H1:2]>>[C:1]=[N:2]', 'acid', 0.9),
 # NA(C): carbon acid adds to aldehyde/ketone (EN is implicit in the acidic C-H precondition)
 'NA(C)': ('[CX3;$([CH1](=O)[#6]),$(C(=O)([#6])[#6]):1]=[O:2].[CX4;H2,H1;!$(C-C-[OX2H]);$(C(C=O)C=O),$(C(C#N)C#N),$(C(C=O)C#N):3]>>[C:1]([OX2H:2])[C:3]', 'either', 0.8),
 # DH: beta-hydroxy -> alkene, only toward an acidic C-H
 'DH(condensation)': ('[CX4:1]([OX2H])[CX4;H1;$(C(C=O)C=O),$(C(C#N)C#N),$(C(C=O)C#N):2]>>[C:1]=[C:2]', 'either', 0.8),
 # MI(N): amine adds to an activated alkene
 'MI(N)': ('[CX3:1]=[CX3;$(C(C#N)),$(C(C=O)):2].[NX3;H2,H1;!$(N-C=[O,S,N]);!$(N-N);!$(N-C-[OX2H]):3]>>[C:1]([N:3])[C:2]', 'base', 0.7),
 # MI(S): thiol adds to an activated alkene
 'MI(S)': ('[CX3:1]=[CX3;$(C(C#N)),$(C(C=O)):2].[SX2H1:3]>>[C:1]([S:3])[C:2]', 'base', 0.7),
 # SN(N): amine alkylated by an alkyl halide
 'SN(N)': ('[CX4;!$(C=O):1][Cl,Br,I].[NX3;H2,H1;!$(N-C=[O,S,N]);!$(N-N);!$(N-C-[OX2H]):3]>>[C:1][N:3]', 'base', 0.7),
 # AR: SNAr on a halo-azine
 'AR': ('[c;$(c:n):1][F,Cl,Br].[NX3;H2,H1;!$(N-C=[O,S,N]);!$(N-N);!$(N-C-[OX2H]):3]>>[c:1][N:3]', 'base', 0.6),
 # Whole-reaction template (Hantzsch thiazole): alpha-haloketone + thioamide
 'Hantzsch thiazole': ('[CX4;H2:1]([Cl,Br,I])[CX3:2](=O)[#6:7].[NX3;H2:4][CX3:5]=[S:6]>>[CH:1]1=[C:2]([#6:7])[N:4]=[C:5][S:6]1', 'either', 0.7),
}
MAX_MW = 700.0

def compile_rules():
    out = {}
    for name, (sma, cond, prior) in RULES.items():
        out[name] = (AllChem.ReactionFromSmarts(sma), cond, prior)
    return out

def run(rxn, mols):
    products = []
    try:
        for ps in rxn.RunReactants(tuple(mols)):
            for p in ps:
                try:
                    Chem.SanitizeMol(p)
                    products.append(Chem.MolToSmiles(p))
                except Exception:
                    pass
    except Exception:
        pass
    return set(products)

def predict(substrates, condition, depth=3, max_species=300):
    """substrates: list of SMILES. condition: 'acid' or 'base'.
    Returns {smiles: (score, chain)} for every new species."""
    rules = compile_rules()
    species = {Chem.MolToSmiles(Chem.MolFromSmiles(s)): (1.0, ()) for s in substrates}
    start = dict(species)
    for _ in range(depth):
        new = {}
        items = list(species.items())
        for name, (rxn, cond, prior) in rules.items():
            gate = 1.0 if cond in ('either', condition) else 0.1
            n = rxn.GetNumReactantTemplates()
            for combo in product(items, repeat=n):
                mols = [Chem.MolFromSmiles(s) for s, _ in combo]
                score = gate * prior
                for _, (sc, _) in combo: score *= sc
                chain = sum((c for _, (_, c) in combo), ()) + (name,)
                for p in run(rxn, mols):
                    m = Chem.MolFromSmiles(p)
                    if m is None or Descriptors.MolWt(m) > MAX_MW: continue
                    if p in species or (p in new and new[p][0] >= score): continue
                    new[p] = (score, chain)
        if not new: break
        species.update(new)
        if len(species) > max_species: break
    return {s: v for s, v in species.items() if s not in start}

if __name__ == '__main__':
    triplet = ['O=Cc1ccccc1', 'N#CCC#N', 'Nc1ccccc1']   # benzaldehyde, malononitrile, aniline
    for cond in ('acid', 'base'):
        res = predict(triplet, cond)
        print(f'\n{cond}: {len(res)} predicted species')
        for smi, (sc, chain) in sorted(res.items(), key=lambda kv: -kv[1][0])[:8]:
            print(f'  {sc:.2f}  {smi:45s} {" > ".join(chain)}')
