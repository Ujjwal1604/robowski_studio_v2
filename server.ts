import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';

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
${JSON.stringify(reagents || [], null, 2)}

SCREENING STATISTICS & DATA SUMMARY:
- Total Wells Screened: ${wellStats?.total || 0}
- High Conversion / Hits (>75%): ${wellStats?.hits || 0}
- Moderate Conversion (30-75%): ${wellStats?.moderate || 0}
- Low / Inactive (<30%): ${wellStats?.low || 0}
- Failed / Decomposed / Polymerized: ${wellStats?.failed || 0}

TOP PERFORMING REACTION HITS:
${JSON.stringify(topHits || [], null, 2)}

ANOMALOUS / FAILED WELLS:
${JSON.stringify(problemWells || [], null, 2)}

TASK:
Write a rigorous, professional, publication-grade HTE Synthesis & Campaign Summary Report.
Structure your report with the following clear markdown sections:
### 1. Executive Summary & Hit Highlights
Highlight the winning conditions, best reagent/catalyst combinations, and highest conversion wells.

### 2. Structure-Activity Relationships (SAR) & Reaction Trends
Analyze mechanistic patterns: which ligands/bases/additives favored product formation, solvent compatibility, stoichiometry sensitivities, and why certain reagent pairs outperformed others.

### 3. Failure Mode & Anomaly Analysis
Diagnose what went wrong in inactive or decomposed wells (e.g. catalyst precipitation, steric hindrance, solubility bottlenecks, insolubility of inorganic base, or volume loss).

### 4. Actionable Next Steps & Scale-up Recommendations
Provide concrete, prioritized recommendations for a follow-up 24/54-well focus screen or 10x bench scale-up (e.g., tight equivalence window, temperature re-optimization, or alternate counter-ions).

Keep the tone concise, authoritative, and scientifically precise. Use chemistry nomenclature accurately.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
    });

    res.json({
      success: true,
      report: response.text || 'Unable to generate synthesis report.',
    });
  } catch (err: any) {
    console.error('Error generating AI synthesis report:', err);
    res.status(500).json({
      error: err?.message || 'Failed to generate AI synthesis report.',
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

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
    });

    res.json({
      success: true,
      advice: response.text || 'No diagnostic advice could be generated.',
    });
  } catch (err: any) {
    console.error('Error generating AI diagnostics:', err);
    res.status(500).json({
      error: err?.message || 'Failed to generate diagnostic advice.',
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
- Mobile Phase: ${mobilePhase || 'e.g. 30% EtOAc / 70% Hexanes'}
- Visualization Stain / UV: ${stain || 'UV 254 nm + Vanillin'}
- Reaction Recipe Components: ${JSON.stringify(wellRecipe || {})}
- Detected Spots (Rf & Relative Intensities):
${JSON.stringify(spots || [], null, 2)}

TASK:
Provide a rapid chromatographic assessment:
1. **Spot Assignment**: Identify probable starting material(s), desired product, and baseline or polar impurities based on Rf values and polarity.
2. **Estimated Conversion & Cleanliness**: Evaluate whether reaction reached completion, stalled, or produced significant side-products.
3. **Chromatographic Optimization**: Suggest ideal Rf adjustments (e.g. increase or decrease polarity, additive such as 1% AcOH or 1% TEA to reduce tailing).

Keep it concise, actionable, and formatted in clean markdown.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
    });

    res.json({
      success: true,
      interpretation: response.text || 'No interpretation generated.',
    });
  } catch (err: any) {
    console.error('Error interpreting TLC lane:', err);
    res.status(500).json({
      error: err?.message || 'Failed to interpret TLC data.',
    });
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
