# Reaction prediction engine for HTE wells: design proposal

Nov 14, 2026 · @Ujjwal

## 1. Summary

The engine takes one triplet of substrates and one set of conditions, and returns a ranked list of the products and intermediates that can plausibly form in that well. Each result carries the chain of elementary steps that makes it, a score between 0 and 1, and the exact masses to look for by LC-MS.

The design rests on five choices:

1. **Reactions are chains of elementary steps.** Each step is one small SMARTS rule (for example nucleophilic addition, dehydration, Michael addition). Named reactions such as Knoevenagel or Biginelli are not coded; they appear when the steps chain together.
2. **The conditions are modelled before any rule fires.** A condition model assigns the protonation state of every site, works out how much TsOH is left after the basic substrates have taken their share, and gates each rule by acid, base and temperature.
3. **Products are found by breadth-limited network expansion.** Starting from the substrates, the engine applies every applicable rule, canonicalizes and deduplicates the products, scores each path, and prunes weak branches, to a depth of 4 steps by default.
4. **Scores come from priors that data can correct.** Each rule has an expert prior. Competing channels share a species, reversible steps are tagged, and LC-MS results update the priors.
5. **Whole-reaction templates are the exception.** They are kept only for pericyclic steps (Povarov, Fischer \[3,3\]) that cannot be written as single-bond events.

The outputs feed four uses in the screening workflow: LC-MS target lists per well, annotation of hit wells with candidate structures, the coordinate space used to plan later rounds, and the reaction-compatibility chart, which the engine can generate instead of scoring by hand.

## 2. Goals, scope and requirements

The engine must answer one question for every well: given these three substrates under this condition, which products can form, and which of them should LC-MS show?

**Inputs**

- Three substrates as SMILES, each with its category label from the reactant category list (for example Primary alkylamines, Michael acceptors).
- A condition: acid (TsOH 50 mol%) or base (DBU), temperature (80 or 120 °C), DMSO as solvent.
- The mixing ratio (1:2:1, 2:1:1 or 1:1:2), which limits how many copies of one substrate a product may contain.

**Outputs**

- A table of species: structure, formula, exact masses for \[M+H\]⁺, \[M+Na\]⁺ and \[M−H\]⁻, score, confidence tier, step chain, and whether the species is a stable product or a reversible intermediate.
- A reaction graph (nodes are species, edges are steps) that can be exported as JSON.

**Requirements**

| Requirement | Target |
| --- | --- |
| Runtime per triplet and condition | under 10 s on one core, under 60 s for depth 6 |
| One sextet (9 triplets × 4 temperature and condition pairs) | under 10 min on one core |
| Recall of observed major LC-MS products | at least 70% of products within the top 20 predictions, to be re-set after the first benchmark |
| Every prediction explainable | each species lists its steps and the rule that produced each one |
| Rules maintainable by a chemist | a rule is one SMARTS line plus a prior and a test, without code changes |
| Reproducible | same input and rule-base version give the same output, byte for byte |

**Not in scope**

- Yield, kinetics or rate prediction. The score ranks plausibility; it is not a yield.
- Transition-metal catalysis and photochemistry.
- Stereochemistry in version 1. Stereoisomers collapse to one entry.
- Cross-well effects and plate-level artifacts such as evaporation.
- Discovering new mechanisms. The engine applies rules chemists have written; it does not invent reactions.

## 3. Chemical model

A **species** is a molecule together with its protonation state and a bookkeeping vector that counts how many copies of each original substrate it contains. A **condition** is a triple of medium (acid or base), temperature, and DMSO as the solvent. A **step** is a transformation that makes or breaks one or two bonds around a reactive centre. Everything the engine predicts is a chain of steps.

The step vocabulary comes from the elementary-step workbook. Each label has a defined meaning, a favoured medium and a reversibility class. The suffix **-i** marks the intramolecular, ring-closing form of a step (for example NA(N)-i).

| Label | Step | Typical rule | Favoured by | Reversible |
| --- | --- | --- | --- | --- |
| NA(X) | Nucleophilic addition of X (N, C, O, S, P) to C=O, C=N or C≡N | amine + aldehyde → hemiaminal | either | yes |
| DH | Dehydration of a hydroxy intermediate | hemiaminal → imine; aldol → enone | acid | rarely, in wet DMSO |
| EN | Enolization or carbanion formation at an acidic C–H | malonate → enolate | base | yes |
| MI(X) | Michael (conjugate) addition of X | amine + enone | base | yes (retro-Michael) |
| SN(X) | SN2 substitution at sp3 carbon | amine + alkyl halide | base | no |
| AR | SNAr at an activated aryl halide | amine + 2-chloropyridine | base | no |
| AS | Acyl substitution (ester, acid, amide exchange) | amine + ester → amide | either | partly |
| IS | Isocyanide insertion at the isocyanide carbon | nitrilium formation | mild acid | no |
| EA | Electrophilic aromatic substitution or cyclization | indole C3 + iminium | acid | no |
| RE | Rearrangement or shift | Mumm, \[3,3\] sigmatropic | acid, heat | no |
| AO | Aromatization by loss of H₂ or a leaving group | dihydropyridine → pyridine | heat, air | no |
| DC | Decarboxylation | malonic acid → acetic acid + CO₂ | heat | no |
| EL | Elimination or cleavage | tert-butyl ester → acid + isobutylene | acid | no |
| OX | Oxidation by DMSO or air | thiol → disulfide | heat | no |
| FR | Fragmentation | Meldrum's acid → acylketene | heat | no |
| ES | Sulfur transfer from S₈ | Gewald ring closure | base | no |

Proton transfer is not a rule. It is handled once, up front, by the condition model (section 5), because it decides which species exist, not which bonds form.

The vocabulary has one gap. Cycloadditions and concerted sigmatropic shifts (Povarov \[4+2\], Fischer \[3,3\]) do not break into single-bond events without inventing unphysical intermediates. They get a seventeenth label, **PC** (pericyclic), written as a whole-reaction template with its own prior.

## 4. Rule representation

Each rule is a record in a versioned rule file, written so that a chemist can add or edit one without touching code. A rule fixes the chemistry (the SMARTS), the context in which it may fire (preconditions and condition factors), and how much to trust it (prior and confidence class).

| Field | Meaning |
| --- | --- |
| id, step | unique name and the vocabulary label, for example `NA(C)` |
| smarts | RDKit reaction SMARTS with atom maps; one or two reactant templates |
| require, forbid | extra SMARTS that the reactive atom must or must not match, for example no amide N, no N–N |
| acid, base, neutral | condition factors between 0 and 1 for each medium |
| t50, width | temperature window: the factor rises from 0 to 1 around t50 (°C) |
| prior | probability that the step goes when its conditions are met, between 0 and 1 |
| reversible, k\_class | whether the step reverses, and whether the forward direction is favourable, neutral or unfavourable |
| steric | name of a steric penalty function, or none |
| class | confidence class: A (textbook), B (literature precedent), C (speculative) |
| tests | at least two positive and two negative SMILES examples |
| source | reference or note on where the rule came from |

**Example: a carbon acid adds to an aldehyde (Knoevenagel step 2)**

```json
{
  "id": "NA_C_ald_activated",
  "step": "NA(C)",
  "smarts": "[CX3;$([CH1](=O)[#6]):1]=[O:2].[CX4;H2,H1;$(C(C=O)C=O),$(C(C#N)C#N),$(C(C=O)C#N):3]>>[C:1]([OX2H:2])[C:3]",
  "require": [],
  "forbid": ["[C:3]-C-[OX2H]"],
  "acid": 0.6, "base": 1.0, "neutral": 0.8,
  "t50": 40, "width": 15,
  "prior": 0.8,
  "reversible": true, "k_class": "neutral",
  "steric": "alpha_branching",
  "class": "A",
  "tests": {"pos": [["O=Cc1ccccc1", "N#CCC#N"]], "neg": [["CC(C)=O", "CCCC"]]},
  "source": "Knoevenagel, Ber. 1898"
}
```

**Precondition filters** do most of the chemistry. The prototype showed this: the amine rule excludes amides, hydrazines, sulfonamides and N–C–OH, which stops thousands of false products. Each excluded group gets a one-line reason in the rule file, so the logic can be reviewed.

**Steric penalties** are named functions that return a factor between 0 and 1 from the local environment of the reactive atoms. The first one, `alpha_branching`, counts heavy neighbours with three or more heavy-atom substituents within two bonds of the reaction centre. Each such neighbour multiplies the score by 0.6. For di-tert-butyl malonate attacking a carbonyl this gives 0.36 or lower, which is why its ring closures rank low.

**Whole-reaction templates** (label PC) are used only where a step is concerted. They are written as a multi-reactant SMARTS in the same schema, with the full product as the right-hand side.

## 5. Condition model

The condition model decides, before any rule is applied, which form of each substrate is present and how much acid or base is left. It exists because the screening conditions are not neutral: a free-base guanidine takes up the TsOH, and a tertiary amine in an acid well never becomes a nucleophile.

**Step 1: find the ionizable sites.** SMARTS patterns tag each basic site (aliphatic amines, guanidines, amidines, pyridines, anilines) and each acidic site (carboxylic acids, 1,3-dicarbonyl C–H, phenols, thiols, azole N–H). Each pattern maps to an approximate pKa on the DMSO scale.

| Site | pKa in DMSO (approximate) |
| --- | --- |
| TsOH | 0.9 |
| Pyridinium, anilinium | 3.4 and 3.6 |
| Carboxylic acid | 12 |
| Guanidinium, DBU-H⁺ | 13.6 and 13.9 |
| Primary alkylammonium | 10.5 |
| Malonate diester C–H | 16 |
| Indole N–H | 21 |

These values are rounded from the literature and must be verified against the Bordwell DMSO table before the rule base is frozen.

**Step 2: distribute the protons (acid wells).** Take the TsOH budget in equivalents. Sort the basic sites by pKa of the conjugate acid, strongest first. Give protons to each site in that order until the budget is spent. Whatever is left is the free acid. If the budget runs out, the weaker bases stay neutral.

**Step 3: distribute the deprotonation (base wells).** For each acidic site, the fraction present as the anion with a base of conjugate-acid pKa B is:

```latex
f_{\text{anion}} = \frac{1}{1 + 10^{\,pK_a - pK_B}}
```

For diethyl malonate (16) with DBU (13.9) this is about 0.8%, which is enough for catalysis. For a carboxylic acid (12) it is above 98%, so DBU turns acids into carboxylate salts.

**Step 4: label the well.** The result is a state vector and one of three medium labels: *free acid* (protons left over), *buffered* (all protons taken by basic substrates, some free base remains) and *base*. A rule's acid factor and base factor are blended by the share of free acid and free base in the well.

**Step 5: temperature gating.** Each rule has a logistic window around its t50, using the width set in the rule:

```latex
g_T = \frac{1}{1 + \exp\!\big(-(T - t_{50})/w\big)}
```

Examples of initial settings: decarboxylation of a malonic acid t50 = 120 °C, tert-butyl ester cleavage by TsOH t50 = 100 °C, amine addition to an aldehyde t50 = 20 °C.

**Step 6: DMSO and water.** DMSO levels strong acids, so TsOH is weaker than in toluene; this is already in the pKa table. DMSO also adds channels the rule base must carry as ordinary rules: Kornblum oxidation of α-halo carbonyls and benzyl halides under base and heat, oxidation of thiols to disulfides, and water uptake. Water is an explicit parameter (default 2% by volume, to be set from the protocol) that scales the reverse of every dehydration step.

**Example.** A triplet with 1.0 equivalent of the free-base guanidine and 0.5 equivalent of TsOH: the guanidine (13.6) takes all 0.5 equivalent, so free acid is zero, half the guanidine stays free, and the well is labelled *buffered*. Acid-only steps such as tert-butyl cleavage are then gated to zero.

One input is still missing: the basis of the 50 mol% TsOH and the DBU amount, per limiting substrate or per total. It changes which wells are buffered, so it is an explicit parameter.

## 6. Core algorithm

The engine grows a reaction network outward from the three substrates, one round per step, keeping only the branches that stay plausible. The loop below is the whole algorithm; sections 5 and 7 supply the condition model and the scoring.

```python
def predict(substrates, condition, ratio, rules, depth=4, beam=60, tau=0.02):
    state    = assign_states(substrates, condition)        # section 5
    species  = {key(s): Species(s, score=1.0, inv=unit(s)) for s in state.species}
    index    = ApplicabilityIndex(rules)                    # which rule matches which species
    frontier = set(species)
    limits   = copy_limits(ratio)                           # max copies of each substrate

    for d in range(1, depth + 1):
        new = {}
        for r in rules:
            gate = condition_gate(r, state, condition.T)    # acid/base blend x temperature
            if gate < 0.05: continue
            for combo in index.candidates(r, frontier, species):   # at most one new species
                inv = sum_inventory(combo)
                if exceeds(inv, limits): continue            # stoichiometry check
                for p in run_reaction(r, combo):             # RDKit RunReactants
                    if not passes_filters(p): continue       # valence, MW, ring strain
                    k = key(p)                               # canonical SMILES / InChIKey
                    w = path_score(r, combo, gate, steric(r, combo))
                    if k not in species or w > new.get(k, species.get(k)).score:
                        new[k] = Species(p, w, inv, parent=combo, rule=r)
        new = compete(new, species)                          # section 7: shared reactants
        frontier = top_k(new, beam, min_score=tau)
        species.update(frontier_items(new, frontier))
        if not frontier: break

    return rank(classify(species), by='score')              # stable products vs intermediates
```

**1. State assignment.** The condition model returns the neutral or protonated form of each substrate, the free acid and free base, and the weights of the forms. Species with fractions of 0.2 or more are carried forward as separate starting species.

**2. Applicability index.** Before the loop, each reactant template of each rule is matched against every species with `HasSubstructMatch`, and the result is cached. Calling `RunReactants` on every pair is wasteful, because most pairs do not match. With the cache the cost is one matching pass per new species, and reaction runs happen only on pairs that match.

**3. Rule application.** A bimolecular rule fires on one species from the frontier and one from the full species set, never two old species, so each product is made exactly once. Atom maps give the product; sanitization catches impossible valences.

**4. Filters.** A product is dropped if it fails sanitization, exceeds a mass cap of 700 Da, contains a three- or four-membered ring that the rule did not intend, or has a net charge the condition cannot support.

**5. Canonicalization and deduplication.** Each product gets an InChIKey (stereochemistry stripped in version 1). Two paths to the same species are merged; the edge from the higher-scoring path is kept as the main chain, and the other is stored as an alternative.

**6. Stoichiometry.** Each species stores an inventory vector: how many copies of A, D and E it contains. The ratio sets limits, for example 1:1:2 allows two copies of E and one each of A and D. A path that needs more than the limit is cut. This is why a double Michael addition only appears in the 1:1:2 wells.

**7. Pruning.** After each round the top `beam` species by score are kept, and any species below `tau` is dropped. The defaults are depth 4, beam 60 and tau 0.02. Heterocycle syntheses that need six or seven steps (Hantzsch dihydropyridine) run at depth 6 with a larger beam.

**8. Reversibility.** A step flagged as reversible gets its retro-rule generated automatically. A species with no outgoing step above the cut-off is a *sink*, and the output classes it as a stable product. A species whose only exits are retro-steps is *transient*, and the output lists it as a reversible intermediate (for example a hemiaminal or an aza-Michael adduct).

**Cost.** With F frontier species, S total species and R rules, a round costs about R·S matching calls plus the pairs that match. For R = 150, S ≤ 300 and F ≤ 60 this is tens of thousands of cheap calls per round and a few hundred actual reaction runs. That fits the 10 s target.

## 7. Scoring and calibration

The score ranks how plausible a product is under the stated conditions. It is not a yield. It is built in three layers: a weight for each step, a share for each competing channel, and a calibration against measured data.

**Step weight.** For a step r applied to species in a given well:

```latex
w_r = \pi_r \cdot c_r \cdot g_T \cdot f_{\text{free}} \cdot \sigma_r
```

Here π is the rule prior, c the blend of the acid and base factors by the well's medium, g\_T the temperature gate, f\_free the free fraction of the attacking site from the condition model, and σ the steric factor. All five lie between 0 and 1, so a weight can only be as large as its weakest factor.

**Competition.** One species often has several possible next steps: an aldehyde can go to a Knoevenagel adduct or to an imine. If species s has candidate steps with weights w₁ to wₖ, the share going down channel j is:

```latex
\text{share}_j = \frac{w_j}{w_0 + \sum_{i=1}^{k} w_i}, \qquad S(p_j) = S(s)\cdot \text{share}_j
```

The idle weight w₀ (default 0.3) stands for the species doing nothing. It stops a single weak channel from taking a full share. For a bimolecular step the competition is counted on the reactant that is limiting under the chosen ratio.

**Reversible steps.** A reversible step gets an equilibrium class: favourable (K = 10), neutral (K = 1) or unfavourable (K = 0.1). A species that exists only at equilibrium is a transient intermediate, and its score is scaled by K/(1+K). A sink reached through reversible steps keeps the unscaled path score, a Curtin–Hammett-style simplification: what matters is how fast the sink forms, not how much of the intermediate there is.

**Confidence tiers.**

| Tier | Score | Meaning |
| --- | --- | --- |
| High | 0.5 or more | expect it in LC-MS |
| Medium | 0.2 to 0.5 | likely, worth looking for |
| Low | 0.05 to 0.2 | possible, a minor peak at best |
| Speculative | below 0.05 | listed only on request |

A product whose chain contains a class C rule drops one tier.

**Calibration against LC-MS.** The first scores are expert guesses, so they must be tested. A prediction counts as *observed* when a peak at the predicted exact mass appears within 5 ppm (high resolution) or 0.3 Da (nominal mass), with an area of at least 1% of the total ion current in that well. Blank wells and substrate-alone controls provide the negatives. With these labels:

1. Fit a logistic model of observed against log S, number of steps, lowest rule class, steric product, transient or sink, and medium match. Use isotonic regression instead while there are fewer than 200 labelled predictions.
2. Report the Brier score and a reliability plot per tier. A well-calibrated High tier is observed at least half the time.
3. Update rule priors as Beta distributions. A class A rule starts as Beta(4π, 4(1−π)) and a class C rule as Beta(2π, 2(1−π)). An observation counts as a success for the weakest-prior rule in the chain, and as a failure for that rule if the precursor was seen but the product was not. The posterior mean replaces the prior once a rule has 10 or more observations.

The weakest-link attribution is a simplification. Where several uncertain rules sit in one chain it spreads the blame unevenly, so rules with wide credible intervals should be reviewed by hand, not trusted blindly.

**Choosing what to test next.** The triplets where predicted scores sit nearest 0.5 are the most informative, because a measurement there moves the model most. The engine can list these as candidates for the next plate.

## 8. Software architecture

The engine is a Python package built on RDKit, with one rule file, six modules, and no database. It runs as a library and as a command-line tool that reads a triplet table and writes one result file per well.

| Module | Job | Reads | Writes |
| --- | --- | --- | --- |
| rules | load and validate the rule file, compile every SMARTS once, run each rule's own tests | rules file | compiled rule set |
| conditions | find ionizable sites, distribute protons, compute medium label and temperature gates | substrates, condition | state vector |
| network | expand the reaction network: applicability index, rule application, filters, deduplication, inventory | state vector, rule set | species graph |
| scoring | step weights, competition, reversibility, tiers, calibration | species graph | scored species |
| io | read triplet tables, write JSON, CSV and Excel, build LC-MS mass lists | triplet table | result files |
| bench | benchmark runs, metrics, reliability plots, rule-prior updates | LC-MS results | updated priors |

**Data formats.** Rules live in one versioned YAML file. Triplets and conditions come in as CSV with an id, three SMILES, three category labels, the ratio and the condition. A result is one JSON file per well, plus a combined Excel sheet for chemists with one row per species.

**Performance.** Wells are independent, so a process pool runs one well per core. Compiled reactions and the applicability index are cached per run, and species are processed in sorted key order so that results do not depend on dictionary order. A sextet of 36 triplet-condition pairs should finish in minutes on one core; a full library of 20 sextets in under an hour on a laptop.

**Versioning and reproducibility.** The rule file carries a semantic version. Every result file records the rule version, the condition parameters, the engine commit and the date, so any prediction can be regenerated. A change to a prior is a patch version; a new rule is a minor version; a change to the scoring formula is a major version. A changelog table lists each change with its reason.

**Testing.** Each rule's own positive and negative examples become unit tests automatically. Golden-file tests compare the full output of 20 reference triplets against stored results, so an unintended change in any rule shows up as a diff. A continuous-integration run executes both on every change to the rule file.

## 9. Validation

The engine is validated at four levels, from single rules up to measured plates. Each level has a pass gate, so a failure points to where the error sits.

| Level | What is tested | Pass gate |
| --- | --- | --- |
| 1. Rule tests | every rule's own positive and negative examples | all pass, no exceptions |
| 2. Named-reaction tests | for each reaction in the v15 candidate file (33 from your list and 39 proposed), two literature examples; the engine must reproduce the textbook product at depth 6 or less | at least 90% reproduced, each failure explained |
| 3. Retrospective benchmark | the round-1 wells with LC-MS data, predictions made blind to the data | top-20 recall of observed major products at least 70% |
| 4. Prospective test | a new set of triplets predicted before they are run | precision of the High tier at least 50% |

**Metrics.**

- **Top-k recall:** the share of observed major products (at least 1% of total ion current) that appear in the top k predictions, for k = 5, 10, 20.
- **Precision per tier:** how often High, Medium and Low predictions are observed.
- **Blank false-positive rate:** how often a predicted product matches a peak that also appears in the acid or base blank, which signals a substrate-derived or reagent-derived signal.
- **Calibration:** the Brier score and a reliability plot per tier.
- **Unexplained mass share:** the fraction of the total ion current in peaks that match no prediction, per well. This is the most direct measure of what the rule base is missing.

**Coverage of the reaction list.** Most reactions are expressible as step chains. The exceptions are known in advance:

| Class | Reactions | Handling |
| --- | --- | --- |
| Concerted steps | Povarov, Fischer indole, other \[4+2\] and \[3,3\] steps | whole-reaction template, label PC |
| Debated mechanism | Passerini, Ugi, GBB, Petasis, Morita–Baylis–Hillman | step rules, class C, one tier lower |
| Single-substrate and solvent channels | tert-butyl cleavage, decarboxylation, pinacol, E1, Kornblum, thiol oxidation | ordinary rules with strict condition gates |
| Above the plate temperature | Gould–Jacobs ring closure (needs about 250 °C) | rule fires only at its t50; at 120 °C the open-chain intermediate is the product |

**Error analysis.** After every benchmark, each miss is sorted into one of five causes: the rule is missing, a precondition was too strict, a prior was too low, the condition model had the wrong medium, or the species was a side product outside the reaction list. The counts show where to spend effort next. A cause that repeats three times becomes a rule change.

## 10. Worked example: triplet A + D + E

The triplet is N-(pyridin-4-ylmethyl)guanidine (A, free base), quinoline-2-carbaldehyde (D) and di-tert-butyl malonate (E). Here is how the engine would handle it.

1. **Condition model.** In the acid wells, 0.5 equivalent of TsOH meets 1.0 equivalent of guanidine. The guanidine (13.6) takes all the protons, so free acid is zero and the well is labelled *buffered*, with half the guanidine free. In the base wells, DBU deprotonates malonate to about 0.8%, enough for catalysis.
2. **Round 1.** D meets two competing partners. With E it can go NA(C) → DH to the Knoevenagel adduct. With A it can go NA(N) → DH to the imine. The competition formula splits D between them. No rule touches E alone, because tert-butyl cleavage (EL) needs free acid and is gated to zero in the buffered acid wells.
3. **Round 2.** The Knoevenagel adduct is a Michael acceptor. A adds to it (MI(N)) to give the open-chain adduct. In the 1:1:2 wells a second E can add instead (MI(C)).
4. **Round 3.** The open-chain adduct can close the ring by attack on a tert-butyl ester (AS-i). The steric penalty makes this the weakest step in the network.

Illustrative scores, using the initial priors and the formulas of section 7. They are not calibrated against data.

| Species | Formula | \[M+H\]⁺ | Acid 80 °C | Acid 120 °C | Base 80 °C | Base 120 °C |
| --- | --- | --- | --- | --- | --- | --- |
| Knoevenagel adduct | C₂₁H₂₅NO₄ | 356.1856 | 0.24 | 0.37 | 0.26 | 0.37 |
| Imine of D and A (transient) | C₁₇H₁₅N₅ | 290.1400 | 0.17 | 0.17 | 0.18 | 0.19 |
| Aza-Michael adduct (transient) | C₂₈H₃₅N₅O₄ | 506.2762 | 0.07 | 0.10 | 0.08 | 0.12 |
| Cyclized dihydropyrimidinone | C₂₄H₂₅N₅O₃ | 432.2030 | 0.01 | 0.03 | 0.02 | 0.08 |
| Double Michael adduct (ratio 1:1:2 only) | C₃₂H₄₅NO₈ | 572.3218 | 0.03 | 0.06 | 0.09 | 0.13 |
| Malonic acid (needs free acid) | C₃H₄O₄ | 105.0182 | 0 | 0 | 0 | 0 |

Two results stand out. The most likely product reaches only the Medium tier (0.37 at best), so the engine does not call the Knoevenagel adduct a sure thing, which fits a TLC that shows nothing. And the species that stay on the baseline, the imine and the aza-Michael adduct, are the ones with the lowest scores because they are reversible. If the guanidine were a salt, the acid wells would have free acid, and the tert-butyl cleavage, malonic acid and Doebner channels would appear at 120 °C.

## 11. Integration with the HTE workflow

The engine sits between library design and screening. It reads what the design stage already produces and returns what the screening and analysis stages need.

1. **Library design (before the plates).** The category and slot tables tell the engine which substrate plays which role. For each candidate triplet the engine counts the predicted products with a score of at least 0.2 in each of the four conditions. A triplet with no such product is flagged as likely to give a blank well, and the hazard rules (energetic azides, polymerizing acrylates, sealed-plate gas from decarboxylation) are checked at the same time.
2. **Compatibility chart.** Today the chart is scored by hand: a condition score from 0 to 2 per reaction, and two reactions are compatible if they share a condition. The engine can compute the same chart from its rules: for each pair of reactions, the share of triplets in which both channels score at least 0.2 under one condition. The hand-scored chart stays as the reference to compare against.
3. **LC-MS target lists (after the plates).** For each well the engine writes a list of exact masses for \[M+H\]⁺, \[M+Na\]⁺ and \[M−H\]⁻, ordered by score, with the substrate masses and the acid and base blank signals marked. The analyst extracts these ion chromatograms first and looks at the unexplained peaks second.
4. **Hit annotation.** For a well that shows activity, the engine lists the candidate structures present or predicted, with transient species separated from stable ones, and flags known chelator motifs (an N,N-bidentate unit such as a 2-quinolyl imine) and reactive acceptors. This turns "this crude is active" into a short list of things to isolate.
5. **Coordinate space.** Each predicted product gets a descriptor vector: reaction class, step count, ring count, polarity, and the substrate categories involved. A hit well maps to the vectors of its likely actives, and the next round's triplets are chosen near those points. The engine's contribution is that the coordinates describe products, not only substrates.
6. **Feedback.** LC-MS results go back through the bench module (section 8), which updates priors, recalibrates scores and lists the triplets that are most informative to run next.

The engine never decides which compounds to isolate or which sextets to run. It ranks and explains, and the chemist decides.

## 12. Roadmap, risks, limitations and open decisions

### Roadmap

| Phase | Scope | Gate to move on |
| --- | --- | --- |
| 1. Rules and conditions | Port the demo rules to the full schema; build the condition model and pKa table; unit tests per rule | Every rule passes its positive and negative test molecules |
| 2. Network and scoring | Expansion loop, dedup, stoichiometry, competition shares, tiers | Triplet A + D + E reproduces the worked example in section 10 |
| 3. Benchmark | Run all 72 reactions' known substrate pairs and the 9 triplets already screened; compare tiers with LC-MS | High and Medium calls hold in most wells; misses are listed by rule |
| 4. Integration | LC-MS target lists, hit annotation, computed compatibility chart | Analyst uses a target list on one real plate |
| 5. Calibration | Fit priors from results; active-learning picks | Brier score improves over the uncalibrated run |

### Risks and limitations

- **Condition model is approximate.** DMSO pKa values and the free-acid test are estimates; a salt form or wet reagent can flip a call. Mitigation: every score reports which condition assumption drove it.
- **Combinatorial growth.** Depth 5 with many reactive sites can exceed the beam. Mitigation: beam 60, threshold 0.02, and a cap on products per step.
- **Rules reflect known chemistry.** Unusual reactivity (metal traces, radical paths, DMSO as oxidant at 120 °C) is covered only by the side channels, not predicted in general.
- **Scores are relative.** Before calibration a tier means ranking, not probability.
- **No kinetics or solubility.** Precipitation, phase separation and evaporation in sealed wells are outside the model.
- **Biology is not predicted.** The engine says what is present, not whether it is active.

### Open decisions

1. Equivalents of TsOH and DBU assumed in the base case (the buffering call depends on them).
2. Water level in wells (dry, trace, or deliberately wet) for the water-sensitive and water-making rules.
3. Default depth and beam, and whether to expose them per run.
4. Who checks the pKa table, and against which source.
5. Whether class C (speculative) rules are shown in target lists or hidden by default.
6. Whether the proposed 39 reactions (R38–R76) enter the rule set before or after the benchmark.
