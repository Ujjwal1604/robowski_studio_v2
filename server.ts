import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const app = express();
const port = 3000;

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

    const prompt = `You are an expert synthetic organic and analytical process chemist specializing in reaction monitoring, thin-layer chromatography (TLC), and flash column purification.

REACTION DATA:
- Transformation / Reaction Class: ${reactionClass || 'Organic Synthesis Screen'}
- Substrates / Starting Materials: ${JSON.stringify(substrates)}
- Target / Expected Product: ${expectedProduct || 'Target reaction product'}
- Stationary Phase: ${stationaryPhase}

TASK:
Suggest exactly 2 or 3 distinct TLC solvent systems (mobile phases) to monitor this reaction and cleanly separate the target product from the starting materials and expected byproducts.
Designate the single BEST system (with isBest: true) that provides an optimal product retention factor in the ideal analytical window (0.25 <= Rf <= 0.45, with Delta Rf >= 0.20 from substrates), plus 1 or 2 high-quality alternative systems (e.g., one with an additive like AcOH or Et3N if polar/tailing, and one orthogonal or greener solvent system like Heptane/Acetone or MTBE/Hexane).

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

    let parsed: any;
    try {
      let cleaned = rawResponse.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      parsed = JSON.parse(cleaned);
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
