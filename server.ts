import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import fs from 'node:fs';
import { predictWellReactions } from './src/engine/predictor/engine';
import type {
  PredictionOptions,
  PredictorSubstrateInput,
  WellConditionConfig,
  WellPredictionResult,
} from './src/engine/predictor/types';

const app = express();
const port = 3000;

// Lazily initialized server-side RDKit instance + LRU well prediction cache
let serverRdkitPromise: Promise<any> | null = null;
function getServerRdkit(): Promise<any> {
  if (!serverRdkitPromise) {
    serverRdkitPromise = import('@rdkit/rdkit').then((mod: any) => (mod.default || mod)());
  }
  return serverRdkitPromise;
}

const serverPredCache = new Map<string, WellPredictionResult>();
const MAX_SERVER_PRED_CACHE = 600;

function makeWellCacheKey(
  substrates: PredictorSubstrateInput[],
  condition: WellConditionConfig,
  options?: PredictionOptions
): string {
  const normSubs = [...substrates]
    .map((s) => `${s.code}|${s.smiles.trim()}|${Number(s.equivalents).toFixed(3)}|${Number(s.concentrationMm ?? 0).toFixed(1)}`)
    .sort()
    .join(';');
  const normCond = `${condition.medium}|${condition.additiveName}|${Number(condition.additiveEquiv).toFixed(3)}|${Number(condition.additivePka).toFixed(2)}|${Number(condition.temperatureC).toFixed(1)}|${Number(condition.waterPct).toFixed(2)}|${condition.solvent}|${condition.equivBasis}`;
  const normOpt = `${Boolean(options?.includeSpeculative)}|${options?.maxExpansions ?? 160}|${options?.maxSpecies ?? 260}`;
  return `${normSubs}::${normCond}::${normOpt}`;
}

interface TlcFeedbackEntry {
  timestamp: string;
  wellKey: string;
  ruleIds: string[];
  observedNewSpot: boolean;
  solventSystem?: string;
  measuredRf?: number;
}

const TLC_FEEDBACK_FILE = '/tmp/robowski-tlc-feedback.json';
let tlcFeedbackStore: TlcFeedbackEntry[] = [];
try {
  if (fs.existsSync(TLC_FEEDBACK_FILE)) {
    const raw = JSON.parse(fs.readFileSync(TLC_FEEDBACK_FILE, 'utf8'));
    if (Array.isArray(raw)) tlcFeedbackStore = raw;
  }
} catch {}

function saveTlcFeedback(): void {
  try {
    fs.writeFileSync(TLC_FEEDBACK_FILE, JSON.stringify(tlcFeedbackStore.slice(-1000)), 'utf8');
  } catch {}
}

function summarizeRuleFeedback(): Record<string, { hits: number; total: number; hitRate: number }> {
  const stats: Record<string, { hits: number; total: number; hitRate: number }> = {};
  for (const item of tlcFeedbackStore) {
    for (const rid of item.ruleIds) {
      if (!stats[rid]) stats[rid] = { hits: 0, total: 0, hitRate: 0 };
      stats[rid].total += 1;
      if (item.observedNewSpot) stats[rid].hits += 1;
    }
  }
  for (const k of Object.keys(stats)) {
    stats[k].hitRate = Math.round((stats[k].hits / Math.max(1, stats[k].total)) * 1000) / 1000;
  }
  return stats;
}

app.use(express.json({ limit: '15mb' }));

// Server-side Google GenAI initialization with telemetry header
const getGenAIClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

/**
 * Robust, high-speed AI content generation:
 * 1. gemini-3.1-flash-lite (high free quota, fast response)
 * 2. gemini-3.5-flash-lite (seamless fallback if 3.1 experiences demand spikes)
 * 3. gemini-3.8-flash (thinking LOW)
 * Handles transient 503 spikes with exponential backoff before falling over.
 */
async function generateAiContent(ai: GoogleGenAI, prompt: string): Promise<string> {
  const modelsToTry = [
    { name: 'gemini-3.1-flash-lite', config: {} },
    { name: 'gemini-3.5-flash-lite', config: {} },
    { name: 'gemini-3.8-flash', config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } },
  ];

  let lastError: any = null;

  for (const { name, config } of modelsToTry) {
    // Up to 2 attempts per model for transient 503 errors
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await Promise.race([
          ai.models.generateContent({
            model: name,
            contents: prompt,
            config,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after 25s on ${name}`)), 25000)
          ),
        ]);

        if (response?.text) {
          return response.text;
        }
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        lastError = err;
        // If it's a 503 spike, wait 1 second and retry once on the same model
        if (errMsg.includes('503') && attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        // If quota 429 or other error, break to next model
        break;
      }
    }
  }

  throw lastError || new Error('All AI model attempts timed out or failed.');
}

function cleanErrorMessage(err: any): string {
  if (!err) return 'Unknown error occurred.';
  const msg = err?.message || String(err);
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
  } catch {}
  if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
    return 'Gemini Free Tier daily quota exceeded for this model. You can add or update your API key in Settings > Secrets.';
  }
  if (msg.includes('503') || msg.includes('high demand') || msg.includes('UNAVAILABLE')) {
    return 'The AI service is temporarily experiencing high traffic. Please retry in a few moments.';
  }
  if (msg.includes('Timeout')) {
    return 'The AI request timed out. Please try again.';
  }
  return msg;
}

// Health check & status endpoint
app.get('/api/ai/status', (_req, res) => {
  res.json({
    status: 'ok',
    hasKey: Boolean(process.env.GEMINI_API_KEY),
    model: 'gemini-3.1-flash-lite',
  });
});

// Server-side RDKit Reaction Prediction (runs off the browser main thread with LRU caching)
app.post('/api/predictor/well', async (req, res) => {
  try {
    const { substrates, condition, options } = req.body || {};
    if (!Array.isArray(substrates) || !condition) {
      res.status(400).json({ error: 'Missing substrates or condition.' });
      return;
    }
    const cacheKey = makeWellCacheKey(substrates, condition, options);
    const cached = serverPredCache.get(cacheKey);
    if (cached) {
      res.json({ success: true, cached: true, result: cached });
      return;
    }
    const rdkit = await getServerRdkit();
    const result = predictWellReactions(rdkit, substrates, condition, options || {});
    if (serverPredCache.size >= MAX_SERVER_PRED_CACHE) {
      const oldest = serverPredCache.keys().next().value;
      if (oldest !== undefined) serverPredCache.delete(oldest);
    }
    serverPredCache.set(cacheKey, result);
    res.json({ success: true, cached: false, result });
  } catch (err: any) {
    console.error('Server predictor /well error:', err);
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

app.post('/api/predictor/plate', async (req, res) => {
  try {
    const { wells, options } = req.body || {};
    if (!Array.isArray(wells) || wells.length === 0 || wells.length > 60) {
      res.status(400).json({ error: 'Provide between 1 and 60 wells.' });
      return;
    }
    const rdkit = await getServerRdkit();
    const results: Record<string, WellPredictionResult> = {};
    let cacheHits = 0;

    for (const w of wells) {
      if (!w || typeof w.key !== 'string' || !Array.isArray(w.substrates) || !w.condition) continue;
      const validSubs = w.substrates.filter((s: any) => typeof s?.smiles === 'string' && s.smiles.trim().length > 0);
      if (validSubs.length === 0) continue;
      const cacheKey = makeWellCacheKey(validSubs, w.condition, options);
      const hit = serverPredCache.get(cacheKey);
      if (hit) {
        results[w.key] = hit;
        cacheHits++;
      } else {
        const pred = predictWellReactions(rdkit, validSubs, w.condition, options || {});
        if (serverPredCache.size >= MAX_SERVER_PRED_CACHE) {
          const oldest = serverPredCache.keys().next().value;
          if (oldest !== undefined) serverPredCache.delete(oldest);
        }
        serverPredCache.set(cacheKey, pred);
        results[w.key] = pred;
      }
    }

    res.json({ success: true, count: Object.keys(results).length, cacheHits, results });
  } catch (err: any) {
    console.error('Server predictor /plate error:', err);
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

app.get('/api/predictor/tlc-feedback', (_req, res) => {
  res.json({
    success: true,
    totalObservations: tlcFeedbackStore.length,
    ruleStats: summarizeRuleFeedback(),
  });
});

app.post('/api/predictor/tlc-feedback', (req, res) => {
  try {
    const { wellKey, ruleIds, observedNewSpot, solventSystem, measuredRf } = req.body || {};
    if (typeof wellKey !== 'string' || !Array.isArray(ruleIds)) {
      res.status(400).json({ error: 'Missing wellKey or ruleIds.' });
      return;
    }
    const entry: TlcFeedbackEntry = {
      timestamp: new Date().toISOString(),
      wellKey,
      ruleIds: ruleIds.filter((r: any) => typeof r === 'string').slice(0, 12),
      observedNewSpot: Boolean(observedNewSpot),
      ...(typeof solventSystem === 'string' && solventSystem.trim() ? { solventSystem: solventSystem.trim() } : {}),
      ...(Number.isFinite(Number(measuredRf)) ? { measuredRf: Number(measuredRf) } : {}),
    };
    tlcFeedbackStore.push(entry);
    saveTlcFeedback();
    res.json({
      success: true,
      totalObservations: tlcFeedbackStore.length,
      ruleStats: summarizeRuleFeedback(),
    });
  } catch (err: any) {
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

// 1. AI HTE Campaign Synthesis Report Generator (Option 5)
app.post('/api/ai/synthesis-report', async (req, res) => {
  try {
    const ai = getGenAIClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured. Please check Settings > Secrets.',
      });
      return;
    }

    const {
      campaignTitle,
      reactionClass,
      objective,
      postReactionNotes,
      reagents,
      wellStats,
      topHits,
      problemWells,
    } = req.body;

    const prompt = `You are a world-class high-throughput experimentation (HTE) medicinal and synthetic process chemist analyzing an automated robotic liquid-handling reaction optimization screen.

CAMPAIGN METADATA:
- Campaign Title: ${campaignTitle || 'HTE Reaction Optimization Screen'}
- Reaction Class: ${reactionClass || 'General Catalytic Screening'}
- Campaign Objective & Hypothesis: ${objective || 'Screen multi-component reaction parameters to maximize conversion and identify optimal hits.'}
- Existing Chemist Observations: ${postReactionNotes || 'None recorded yet.'}

REAGENTS & LIBRARIES IN SCREEN:
${(reagents || []).map((r: any) => `- ${r.code}: ${r.name || 'reagent'}${r.smiles ? ' (SMILES: ' + r.smiles + ')' : ''} · Stock: ${r.stock || '-'} mM`).join('\n')}

SCREENING STATISTICS & DATA SUMMARY:
- Total Wells Screened: ${wellStats?.total || 0}
- High Conversion / Hits (>75%): ${wellStats?.hits || 0}
- Moderate Conversion (30-75%): ${wellStats?.moderate || 0}
- Low / Inactive (<30%): ${wellStats?.low || 0}
- Failed / Decomposed / Polymerized: ${wellStats?.failed || 0}

TOP PERFORMING REACTION HITS:
${JSON.stringify((topHits || []).slice(0, 6), null, 1)}

ANOMALOUS / FAILED WELLS:
${JSON.stringify((problemWells || []).slice(0, 6), null, 1)}

TASK:
Write a concise, authoritative, publication-grade HTE Synthesis & Campaign Summary Report (under 400 words).
Structure your report with the following clear markdown sections:
### 1. Executive Summary & Hit Highlights
### 2. Structure-Activity Relationships (SAR) & Reaction Trends
### 3. Failure Mode & Anomaly Analysis
### 4. Actionable Next Steps & Scale-up Recommendations

Keep the tone concise, authoritative, and scientifically precise. Use chemistry nomenclature accurately.`;

    const report = await generateAiContent(ai, prompt);

    res.json({
      success: true,
      report,
    });
  } catch (err: any) {
    console.error('Error generating AI synthesis report:', err);
    res.status(500).json({
      error: cleanErrorMessage(err),
    });
  }
});

// 2. AI Liquid Handling & Pipetting Diagnostics Advisor (Option 3)
app.post('/api/ai/diagnostics', async (req, res) => {
  try {
    const ai = getGenAIClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured. Please check Settings > Secrets.',
      });
      return;
    }

    const { runName, totalVials, vialVolume, threshold, solvent, reagents, issues, deckWarnings } =
      req.body;

    const prompt = `You are an expert robotic automation engineer and chemist specializing in automated liquid handlers (e.g., Tecan, Chemspeed, Hamilton, Robowski workstations).

A chemist designed a liquid handling run that triggered safety or pipetting constraint warnings.

RUN CONFIGURATION:
- Run Name: ${runName || 'Robowski Plate Screen'}
- Plate Size: ${totalVials} vials
- Total Vial Target Volume: ${vialVolume} µL
- Solvent Minimum Threshold: ${threshold} µL
- Bulk Solvent: ${solvent || 'ethanol'}

REAGENTS & STOCKS:
${JSON.stringify(reagents || [], null, 2)}

DETECTED ROBOT & MATH ISSUES:
${JSON.stringify(issues || [], null, 2)}

DECK WARNINGS:
${JSON.stringify(deckWarnings || [], null, 2)}

TASK:
Analyze these liquid handling errors and provide a clear, practical diagnostic briefing for the chemist.
Include:
1. **Root Cause Analysis**: Why did the math or deck violate robot physical constraints (e.g., why solvent volume went negative, why pipette transfers fell below ${threshold} µL, or why multi-tier _N/_N2 dilutions became necessary)?
2. **Step-by-Step Resolution**: Exact, quantitative adjustments to stock concentrations (e.g., "Prepare Stock Reagent A at 250 mM instead of 500 mM"), total vial volume, or screening ranges.
3. **Deck & Tip Optimization**: Practical bench tips to minimize pipette tip consumption, avoid cross-contamination, and prevent evaporation.

Format your response in clean markdown with bullet points and bold highlights.`;

    const advice = await generateAiContent(ai, prompt);

    res.json({
      success: true,
      advice,
    });
  } catch (err: any) {
    console.error('Error generating AI diagnostics:', err);
    res.status(500).json({
      error: cleanErrorMessage(err),
    });
  }
});

// 3. AI TLC Plate & Lane Reaction Interpreter (Option 4)
app.post('/api/ai/tlc-interpret', async (req, res) => {
  try {
    const ai = getGenAIClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured. Please check Settings > Secrets.',
      });
      return;
    }

    const { laneLabel, spots, wellRecipe, mobilePhase, stain } = req.body;

    const prompt = `You are an organic chemistry chromatography expert analyzing thin-layer chromatography (TLC) data from an automated screening reaction.

LANE DATA:
- Sample: ${laneLabel || 'Reaction Well'}
- Mobile Phase: ${mobilePhase || '30% EtOAc / 70% Hexanes'}
- Visualization Stain / UV: ${stain || 'UV 254 nm'}
- Reaction Recipe Components: ${JSON.stringify(wellRecipe || {})}
- Detected Spots (Rf & Relative Intensities):
${(spots || []).map((s: any) => `- Rf ${Number(s.rf).toFixed(2)} (${s.note || 'peak'}, strength: ${s.intensity || 'mid'})`).join('\n')}

TASK:
Provide a rapid chromatographic assessment (under 200 words):
1. **Spot Assignment**: Identify probable starting material(s), desired product, and baseline or polar impurities based on Rf values.
2. **Estimated Conversion & Cleanliness**: Evaluate whether reaction reached completion, stalled, or produced significant side-products.
3. **Chromatographic Optimization**: Suggest ideal Rf adjustments or mobile phase tweaks.

Keep it concise, actionable, and formatted in clean markdown.`;

    const interpretation = await generateAiContent(ai, prompt);

    res.json({
      success: true,
      interpretation,
    });
  } catch (err: any) {
    console.error('Error interpreting TLC lane:', err);
    res.status(500).json({
      error: cleanErrorMessage(err),
    });
  }
});

// 4. AI TLC Solvent System & Mobile Phase Advisor
app.post('/api/ai/solvent-systems', async (req, res) => {
  try {
    const ai = getGenAIClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured. Please check Settings > Secrets.',
      });
      return;
    }

    const {
      substrates = [],
      expectedProduct,
      reactionClass,
      stationaryPhase = 'Silica Gel (SiO2)',
    } = req.body;

    const organicSubs = Array.isArray(substrates)
      ? substrates.filter((s: any) => !/^additive/i.test(String(s?.role || '')))
      : [];
    const wellAdditives = Array.isArray(substrates)
      ? substrates.filter((s: any) => /^additive/i.test(String(s?.role || '')))
      : [];

    const prompt = `You are an expert synthetic organic and analytical process chemist specializing in reaction monitoring, thin-layer chromatography (TLC), and flash column purification.

REACTION DATA:
- Transformation / Reaction Class: ${reactionClass || 'Organic Synthesis Screen'}
- Substrates / Starting Materials: ${JSON.stringify(organicSubs)}
- Reaction Additives / Catalysts / Acid-Base Conditions: ${wellAdditives.length ? JSON.stringify(wellAdditives) : 'None specified'}
- Target / Expected Product: ${expectedProduct || 'Target reaction product'}
- Stationary Phase: ${stationaryPhase}

TASK:
Suggest exactly 2 or 3 distinct, COMPLETE TLC mobile-phase solvent systems to monitor this reaction and cleanly separate the target product from starting materials, residual reaction additives/salts, and expected byproducts.
CRITICAL RULES FOR STATIONARY PHASE & MODIFIERS:
1. NEVER suggest a standalone additive or modifier by itself (for example, NEVER output "1% Et3N", "AcOH", "NH4OH", "TFA", or "DBU" alone as a solvent system "name" or "ratio"). Every entry in "systems" MUST be a complete carrier mobile phase + ratio (e.g., "30% EtOAc / 70% Hexanes + 1% Et3N" or "5% MeOH / 95% DCM + 1% AcOH" or "DCM / MeOH / (2M NH3 in MeOH) (95:3:2)").
2. STATIONARY PHASE COMPATIBILITY (${stationaryPhase}):
   - If Stationary Phase is "All Stationary Phases Equal (Suggest Best)": evaluate Silica Gel (SiO2), Neutral Alumina (Al2O3), Basic Alumina (Al2O3), and Reverse Phase (C18) on completely equal footing with no bias toward SiO2, recommend whichever stationary phase + mobile phase combination achieves the cleanest separation, and explicitly include the stationary phase name in each system's "name" (e.g., "30% EtOAc / Hexanes (Basic Al2O3)" or "40% MeCN / H2O + 0.1% TFA (C18 RP)") while obeying each phase's modifier rules above.
   - If Stationary Phase is "Neutral Alumina (Al2O3)" or "Basic Alumina (Al2O3)": DO NOT add NH3 (e.g., 2M NH3 in MeOH, NH4OH), Et3N, or AcOH modifiers to the mobile phase. Alumina lacks acidic silanols (Basic Alumina is already basic; Neutral Alumina is chosen specifically to keep separation neutral without base/acid additives), and AcOH reacts with/strips alumina. Recommend neat normal-phase organic solvent blends (e.g., EtOAc/Hexanes, MeOH/DCM, Acetone/Hexanes, MeOH/EtOAc).
   - If Stationary Phase is "Silica Gel (SiO2 - Normal Phase)": if analytes contain basic amines/azoles/guanidines, carboxylic acids, or residual acid/base catalysts/salts (like TsOH, TFA, HCl, DBU), include an appropriate compensating modifier (1% Et3N, 2M NH3 in MeOH, or 1% AcOH) INSIDE a polarity-matched bulk solvent system (in "name", "ratio", "chamberPrep", and "modifiers").
   - If Stationary Phase is "Reverse Phase (C18)": recommend aqueous MeCN/H2O or MeOH/H2O eluents (optionally with 0.1% TFA/formic acid for ionizable amines/acids).
3. Designate the single BEST system (with isBest: true) providing optimal product retention (0.22 <= Rf <= 0.65, Delta Rf >= 0.18), plus 1 or 2 complementary or orthogonal complete solvent systems.

Return ONLY valid JSON (no markdown text, no backticks) with this structure:
{
  "reactionSummary": "Brief chemical rationale of the transformation and expected polarity change",
  "systems": [
    {
      "name": "30% Ethyl Acetate / 70% Hexanes",
      "ratio": "3:7 (v/v) EtOAc / Hexanes",
      "isBest": true,
      "tag": "Top Choice (Standard)",
      "polarityRating": "Medium-Low Polarity",
      "chamberPrep": "For 20 mL chamber: 6.0 mL EtOAc + 14.0 mL Hexanes",
      "predictedRf": {
        "product": 0.40,
        "substrateA": { "name": "Substrate A", "rf": 0.15 },
        "substrateB": { "name": "Substrate B", "rf": 0.70 }
      },
      "resolutionDelta": "ΔRf = 0.25 (Baseline separation)",
      "modifiers": "None required",
      "rationale": "Clear scientific explanation why this ratio separates product from substrates."
    }
  ],
  "visualization": {
    "primaryStain": "UV 254 nm",
    "secondaryStain": "KMnO4 dip / heat",
    "stainNotes": "Why these stains detect the specific functional groups"
  },
  "coSpottingProtocol": [
    "Lane 1: Pure Substrate A (1 mg/mL)",
    "Lane 2: Co-spot (Substrate A + Reaction Mixture)",
    "Lane 3: Crude Reaction Mixture",
    "Lane 4: Pure Substrate B (1 mg/mL)"
  ]
}`;

    const rawResponse = await generateAiContent(ai, prompt);

    const hasCarrierSolvent = (text: string) =>
      /\b(etoac|ethyl\s+acetate|hex|hexane|hexanes|heptane|dcm|ch2cl2|dichloromethane|meoh|methanol|etoh|mecn|acn|acetonitrile|acetone|toluene|et2o|ether|mtbe|pentane|chcl3|chloroform|h2o|water|ipa|thf)\b/i.test(
        text || ''
      );

    let parsed: any;
    try {
      let cleaned = rawResponse.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      parsed = JSON.parse(cleaned);

      if (parsed && Array.isArray(parsed.systems)) {
        const anchorCarrier =
          parsed.systems.find((s: any) => hasCarrierSolvent(s?.name))?.name ||
          '5% MeOH / 95% DCM';
        const anchorWithoutMod = anchorCarrier.replace(/\s*\+\s*.*$/, '').trim();
        const isReversePhase = /c18|reverse/i.test(stationaryPhase);

        parsed.systems = parsed.systems.map((sys: any) => {
          const rawName = String(sys?.name || '').trim();
          const rawMod = String(sys?.modifiers || '').trim();
          if (!hasCarrierSolvent(rawName)) {
            const combinedCue = `${rawName} ${rawMod}`;
            const isAcidMod = /\b(acoh|acetic|tfa|hcooh|formic)\b/i.test(combinedCue);
            const isNh3Mod = /\b(nh3|nh4oh|ammonia)\b/i.test(combinedCue);
            const modText =
              rawName && !/^(none|modifier|additive)$/i.test(rawName)
                ? rawName.replace(/^add\s+/i, '').trim()
                : isNh3Mod
                ? '2% (2M NH3 in MeOH)'
                : isAcidMod
                ? '1% AcOH'
                : '1% Et3N';
            if (isReversePhase) {
              return {
                ...sys,
                name: `50% MeCN / 50% H2O + ${modText}`,
                ratio: `50:50 v/v MeCN / H2O + ${modText}`,
                chamberPrep: `For 20 mL chamber: 10.0 mL MeCN + 10.0 mL H2O + ${modText}`,
                modifiers: modText,
              };
            }
            if (isNh3Mod) {
              return {
                ...sys,
                name: 'DCM / MeOH / (2M NH3 in MeOH) (95:3:2)',
                ratio: '95:3:2 v/v/v DCM / MeOH / (2M NH3 in MeOH)',
                chamberPrep: 'For 20 mL chamber: 19.0 mL DCM + 0.6 mL MeOH + 0.4 mL (2M NH3 in MeOH)',
                modifiers: '2% (2M NH3 in MeOH)',
              };
            }
            const base = hasCarrierSolvent(anchorWithoutMod)
              ? anchorWithoutMod
              : isAcidMod
              ? '30% EtOAc / 70% Hexanes'
              : '5% MeOH / 95% DCM';
            return {
              ...sys,
              name: `${base} + ${modText}`,
              ratio: sys?.ratio && hasCarrierSolvent(sys.ratio) ? sys.ratio : `${base} + ${modText}`,
              chamberPrep:
                sys?.chamberPrep && hasCarrierSolvent(sys.chamberPrep)
                  ? sys.chamberPrep
                  : `For 20 mL chamber: prepare ${base} containing ${modText} (0.2 mL additive in 19.8 mL solvent)`,
              modifiers: modText,
            };
          }
          return sys;
        });
      }
    } catch {
      parsed = {
        reactionSummary: `Chromatographic separation for ${reactionClass || 'reaction'} on ${stationaryPhase}.`,
        systems: [
          {
            name: '30% Ethyl Acetate / 70% Hexanes',
            ratio: '3:7 (v/v) EtOAc / Hexanes',
            isBest: true,
            tag: 'Top Choice',
            polarityRating: 'Medium Polarity',
            chamberPrep: 'For 20 mL chamber: 6.0 mL EtOAc + 14.0 mL Hexanes',
            predictedRf: { product: 0.38 },
            resolutionDelta: 'ΔRf > 0.20',
            modifiers: 'None required',
            rationale: 'Standard medium polarity system providing optimal Rf for product isolation.',
          },
          {
            name: '50% Ethyl Acetate / 50% Hexanes',
            ratio: '1:1 (v/v) EtOAc / Hexanes',
            isBest: false,
            tag: 'Higher Polarity System',
            polarityRating: 'Higher Polarity',
            chamberPrep: 'For 20 mL chamber: 10.0 mL EtOAc + 10.0 mL Hexanes',
            predictedRf: { product: 0.55 },
            resolutionDelta: 'ΔRf = 0.18',
            modifiers: 'None required',
            rationale: 'Useful if product is polar or eluting too close to baseline.',
          },
          {
            name: '5% MeOH / 95% DCM',
            ratio: '1:19 (v/v) MeOH / DCM',
            isBest: false,
            tag: 'Orthogonal Selectivity',
            polarityRating: 'Halogenated / Polar',
            chamberPrep: 'For 20 mL chamber: 1.0 mL MeOH + 19.0 mL DCM',
            predictedRf: { product: 0.42 },
            resolutionDelta: 'ΔRf = 0.22',
            modifiers: 'Optional 0.5% Et3N or AcOH if tailing occurs',
            rationale: 'Alternative solvent selectivity for difficult separations.',
          },
        ],
        visualization: {
          primaryStain: 'UV 254 nm',
          secondaryStain: 'KMnO4 stain with gentle heat gun',
          stainNotes: 'Universal stain for oxidizable functional groups.',
        },
        coSpottingProtocol: [
          'Lane 1: Pure Starting Material A',
          'Lane 2: Co-spot (SM-A + Reaction Mixture)',
          'Lane 3: Crude Reaction Mixture',
          'Lane 4: Pure Starting Material B',
        ],
      };
    }

    res.json({
      success: true,
      data: parsed,
    });
  } catch (err: any) {
    console.error('Error generating AI solvent systems:', err);
    res.status(500).json({
      error: cleanErrorMessage(err),
    });
  }
});

// 5. AI Group Meeting Slide Bullets Generator
app.post('/api/ai/meeting-bullets', async (req, res) => {
  try {
    const ai = getGenAIClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured. Please check Settings > Secrets.',
      });
      return;
    }

    const { runName, reactionClass, designSummary, reagents, hitStats, topHits } = req.body;

    const prompt = `You are a high-throughput experimentation (HTE) medicinal and process chemist writing 3 concise bullet points for a weekly group meeting presentation slide.

CAMPAIGN DATA:
- Campaign: ${runName || 'HTE Screen'} (${reactionClass || 'Reaction Screen'})
- Matrix & Design: ${designSummary || 'Factorial screen'}
- Reagents: ${JSON.stringify(reagents || [])}
- Hits Summary: ${JSON.stringify(hitStats || {})}
- Top Hits: ${JSON.stringify((topHits || []).slice(0, 3))}

TASK:
Write exactly 3 concise, punchy bullet points for a presentation slide (under 25 words each):
1. **Design & Scope**: What factorial matrix was tested and the scale.
2. **Key Finding**: Top hit condition and observed conversion/selectivity.
3. **Next Week's Plan**: Actionable follow-up or scale-up step.

Return ONLY a valid JSON array of 3 strings:
["Bullet 1", "Bullet 2", "Bullet 3"]`;

    const rawResponse = await generateAiContent(ai, prompt);
    let bullets: string[] = [];
    try {
      let cleaned = rawResponse.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      bullets = JSON.parse(cleaned);
      if (!Array.isArray(bullets) || bullets.length === 0) throw new Error('Not array');
    } catch {
      bullets = [
        `Screened ${hitStats?.total || 'factorial'} conditions exploring reagent stoichiometry and solvent effects.`,
        `Top hit condition achieved >${topHits?.[0]?.conversion || 85}% conversion with clean reaction profile.`,
        `Validate lead hits at 5 mL preparative scale and screen lower catalyst loading.`,
      ];
    }

    res.json({ success: true, bullets });
  } catch (err: any) {
    console.error('Error generating slide bullets:', err);
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

// 6. AI Vision Final TLC Plate QC Audit (Gemini Multimodal Vision)
app.post('/api/ai/tlc-vision-qc', async (req, res) => {
  try {
    const ai = getGenAIClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured. Please check Settings > Secrets.',
      });
      return;
    }

    const { imageBase64, mimeType, channelLabel, plateNumber, lanesSummary, warnings } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      res.status(400).json({ error: 'Missing annotated plate image for Vision QC.' });
      return;
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    const resolvedMime =
      typeof mimeType === 'string' && /^image\/(jpeg|png|webp)$/.test(mimeType)
        ? mimeType
        : 'image/jpeg';

    const qcSchema = {
      type: Type.OBJECT,
      properties: {
        overallVerdict: {
          type: Type.STRING,
          description: 'One of: good, minor_fixes, needs_attention',
        },
        summary: {
          type: Type.STRING,
          description:
            '1-2 concise sentences from a synthetic chemist summarizing origin, solvent front, lane alignment, and spot accuracy.',
        },
        laneAlignmentWarning: {
          type: Type.STRING,
          description:
            'Short warning ONLY if lane boxes visibly miss the silica plate or straddle glass edges; otherwise empty string.',
        },
        frontAudit: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              half: { type: Type.INTEGER, description: '0 for lower half (A1-C5), 1 for upper half (D5-F9)' },
              status: { type: Type.STRING, description: 'ok or shift' },
              suggestedShiftRf: {
                type: Type.NUMBER,
                description:
                  'Fractional shift along the lane length (-0.18 to +0.18; positive moves front UP, negative moves front DOWN; 0 if ok).',
              },
              note: { type: Type.STRING },
            },
            required: ['half', 'status', 'suggestedShiftRf', 'note'],
          },
        },
        originAudit: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              half: { type: Type.INTEGER, description: '0 for lower half (A1-C5), 1 for upper half (D5-F9)' },
              status: { type: Type.STRING, description: 'ok or shift' },
              suggestedShiftRf: {
                type: Type.NUMBER,
                description:
                  'Fractional shift along the lane length (-0.12 to +0.12; positive moves origin UP, negative moves origin DOWN; 0 if ok).',
              },
              note: { type: Type.STRING },
            },
            required: ['half', 'status', 'suggestedShiftRf', 'note'],
          },
        },
        spotCorrections: {
          type: Type.ARRAY,
          description: 'Up to 24 highest-impact missed spots to add or bogus markers to remove.',
          items: {
            type: Type.OBJECT,
            properties: {
              well: { type: Type.STRING, description: 'Exact well label printed below the lane, e.g. F7 or E3' },
              laneId: { type: Type.INTEGER, description: 'Exact laneId from the provided lanesSummary JSON' },
              action: { type: Type.STRING, description: 'add or remove' },
              rf: {
                type: Type.NUMBER,
                description: 'Estimated Rf between 0.03 and 0.97 read against the yellow origin (0.0) and cyan front (1.0).',
              },
              confidence: { type: Type.STRING, description: 'high or medium' },
              reason: { type: Type.STRING, description: 'Short 4-10 word chemist reason' },
            },
            required: ['well', 'laneId', 'action', 'rf', 'confidence', 'reason'],
          },
        },
      },
      required: ['overallVerdict', 'summary', 'laneAlignmentWarning', 'frontAudit', 'originAudit', 'spotCorrections'],
    };

    const promptText = `You are a senior synthetic / high-throughput experimentation (HTE) chemist performing a visual quality-control (QC) audit on an annotated 54-well TLC plate image.

PLATE METADATA:
- Plate #${plateNumber || 1}, Channel: ${channelLabel || 'UV 254 nm'}
- Overlay legend drawn on the image:
  * Teal vertical rectangles = lane boxes with white well labels printed below each box (Lower tier = half 0, Upper tier = half 1).
  * Yellow horizontal line near the bottom of each tier = detected ORIGIN (Rf = 0.00).
  * Cyan horizontal line near the top of each tier = detected SOLVENT FRONT (Rf = 1.00).
  * Bright magenta circles with horizontal ticks = currently detected SPOTS.
  * White ticks along left/right edges = Rf ruler (0.0 to 1.0).
- Current automated detections (JSON):
${JSON.stringify(lanesSummary || [])}
${warnings?.length ? `- System notes: ${JSON.stringify(warnings)}` : ''}

AUDIT RULES (THINK LIKE A CHEMIST):
1. Check whether the lane boxes actually sit on the physical silica plate or if outer lanes sit in the black surround / straddle the vertical glass cut edge. If misaligned, explain concisely in laneAlignmentWarning.
2. Check the yellow ORIGIN line for half 0 (lower) and half 1 (upper). Is it centered on the spotting baseline? Only suggest status="shift" if visibly off by > 0.025 Rf.
3. Check the cyan SOLVENT FRONT line for half 0 (lower) and half 1 (upper). Is it sitting on the true solvent front meniscus (NOT floating in black void above the glass and NOT sitting on handwriting/ink)? Only suggest status="shift" if visibly off by > 0.025 Rf.
4. Inspect every on-plate lane for:
   - MISSED SPOTS (action="add"): Clear dark UV-quenching or fluorescent/stained spots inside the lane between Rf 0.04 and 0.96 that have NO magenta circle (especially wide coalesced spots spanning adjacent lanes). Estimate Rf carefully using the yellow origin (0.0) and cyan front (1.0).
   - FALSE POSITIVES (action="remove"): Magenta circles sitting on clean empty silica, pitch-black off-plate surround, vertical glass edges, pencil/pen writing, or dust.
   - NEVER suggest adding a spot on off-plate black background, on the origin baseline (Rf < 0.03), or on handwriting/plate edges.
   - Use ONLY valid well labels and matching laneIds from the lanesSummary JSON. Return at most 24 highest-impact corrections.`;

    const visionModels = [
      {
        name: 'gemini-4-hydrogen',
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: qcSchema,
        },
      },
      {
        name: 'gemini-3.1-flash-lite',
        config: {
          responseMimeType: 'application/json',
          responseSchema: qcSchema,
        },
      },
    ];

    let rawText = '';
    let usedModel = '';
    let lastErr: any = null;

    for (const m of visionModels) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await Promise.race([
            ai.models.generateContent({
              model: m.name,
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: promptText },
                    { inlineData: { mimeType: resolvedMime, data: cleanBase64 } },
                  ],
                },
              ],
              config: m.config,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Timeout after 40s on ${m.name}`)), 40000)
            ),
          ]);
          if (response?.text) {
            rawText = response.text;
            usedModel = m.name;
            break;
          }
        } catch (err: any) {
          lastErr = err;
          const msg = err?.message || String(err);
          if (msg.includes('503') && attempt === 1) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          break;
        }
      }
      if (rawText) break;
    }

    if (!rawText) {
      throw lastErr || new Error('Vision AI QC failed to produce a response.');
    }

    let cleaned = rawText.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    const parsed = JSON.parse(cleaned);

    // Validate & clamp numeric bounds against known lanesSummary
    const validLaneMap = new Map<number, string>();
    const wellToLane = new Map<string, number>();
    if (Array.isArray(lanesSummary)) {
      for (const l of lanesSummary) {
        if (typeof l?.laneId === 'number' && typeof l?.well === 'string') {
          validLaneMap.set(l.laneId, l.well);
          wellToLane.set(l.well.toUpperCase(), l.laneId);
        }
      }
    }

    const clampNum = (v: any, lo: number, hi: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
    };

    const frontAudit = Array.isArray(parsed.frontAudit)
      ? parsed.frontAudit
          .filter((a: any) => a && (a.half === 0 || a.half === 1))
          .map((a: any) => ({
            half: Number(a.half),
            status: a.status === 'shift' ? 'shift' : 'ok',
            suggestedShiftRf: +clampNum(a.suggestedShiftRf, -0.18, 0.18).toFixed(3),
            note: String(a.note || ''),
          }))
      : [];

    const originAudit = Array.isArray(parsed.originAudit)
      ? parsed.originAudit
          .filter((a: any) => a && (a.half === 0 || a.half === 1))
          .map((a: any) => ({
            half: Number(a.half),
            status: a.status === 'shift' ? 'shift' : 'ok',
            suggestedShiftRf: +clampNum(a.suggestedShiftRf, -0.12, 0.12).toFixed(3),
            note: String(a.note || ''),
          }))
      : [];

    const spotCorrections = Array.isArray(parsed.spotCorrections)
      ? parsed.spotCorrections
          .map((c: any) => {
            const rawWell = String(c?.well || '').trim().toUpperCase();
            let laneId = Number(c?.laneId);
            if (!validLaneMap.has(laneId) && wellToLane.has(rawWell)) {
              laneId = wellToLane.get(rawWell)!;
            }
            if (!validLaneMap.has(laneId)) return null;
            const action = c?.action === 'add' ? 'add' : c?.action === 'remove' ? 'remove' : null;
            if (!action) return null;
            const rf = +clampNum(c?.rf, 0.03, 0.97).toFixed(3);
            return {
              well: validLaneMap.get(laneId)!,
              laneId,
              action,
              rf,
              confidence: c?.confidence === 'high' ? 'high' : 'medium',
              reason: String(c?.reason || ''),
            };
          })
          .filter(Boolean)
          .slice(0, 24)
      : [];

    const verdict =
      parsed.overallVerdict === 'good' ||
      parsed.overallVerdict === 'minor_fixes' ||
      parsed.overallVerdict === 'needs_attention'
        ? parsed.overallVerdict
        : spotCorrections.length > 0
        ? 'minor_fixes'
        : 'good';

    res.json({
      success: true,
      data: {
        overallVerdict: verdict,
        summary: String(parsed.summary || 'Vision QC audit complete.'),
        laneAlignmentWarning: String(parsed.laneAlignmentWarning || ''),
        frontAudit,
        originAudit,
        spotCorrections,
        model: usedModel,
      },
    });
  } catch (err: any) {
    console.error('Error running TLC Vision QC:', err);
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

// Start dev Vite server or serve static bundle in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (_req, res) => {
      res.sendFile('dist/index.html', { root: '.' });
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Robowski Studio server running on http://0.0.0.0:${port}`);
  });
}

startServer();
