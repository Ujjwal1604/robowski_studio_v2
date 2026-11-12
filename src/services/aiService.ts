export interface SynthesisReportPayload {
  campaignTitle?: string;
  reactionClass?: string;
  objective?: string;
  postReactionNotes?: string;
  reagents?: Array<{
    code: string;
    name?: string;
    smiles?: string;
    stock?: number | string;
    molarMass?: number | string;
    solvent?: string;
  }>;
  wellStats?: {
    total: number;
    hits: number;
    moderate: number;
    low: number;
    failed: number;
  };
  topHits?: Array<{
    well: string;
    recipe: string;
    conversion?: number;
    yield?: number;
    notes?: string;
  }>;
  problemWells?: Array<{
    well: string;
    recipe: string;
    notes?: string;
  }>;
}

export interface DiagnosticsPayload {
  runName?: string;
  totalVials: number;
  vialVolume: number | string;
  threshold: number | string;
  solvent?: string;
  reagents: any[];
  issues: any[];
  deckWarnings?: any[];
}

export interface TlcInterpretationPayload {
  laneLabel: string;
  spots: Array<{ rf: number; intensity?: number; note?: string }>;
  wellRecipe?: any;
  mobilePhase?: string;
  stain?: string;
}

export async function fetchAiSynthesisReport(payload: SynthesisReportPayload): Promise<string> {
  try {
    const res = await fetch('/api/ai/synthesis-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `Server error: ${res.status}`);
    }
    return data.report;
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.message?.includes('aborted')) {
      throw new Error('AI analysis timed out after 45 seconds. Please try again.');
    }
    throw err;
  }
}

export async function fetchAiDiagnostics(payload: DiagnosticsPayload): Promise<string> {
  try {
    const res = await fetch('/api/ai/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `Server error: ${res.status}`);
    }
    return data.advice;
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.message?.includes('aborted')) {
      throw new Error('AI diagnostics timed out after 45 seconds. Please try again.');
    }
    throw err;
  }
}

export async function fetchAiTlcInterpretation(payload: TlcInterpretationPayload): Promise<string> {
  try {
    const res = await fetch('/api/ai/tlc-interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `Server error: ${res.status}`);
    }
    return data.interpretation;
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.message?.includes('aborted')) {
      throw new Error('TLC interpretation timed out after 45 seconds. Please try again.');
    }
    throw err;
  }
}

export interface SolventSystemRecommendation {
  name: string; // e.g. "30% Ethyl Acetate / 70% Hexanes"
  ratio: string; // e.g. "3:7 (v/v) EtOAc / Hexanes"
  isBest: boolean;
  tag: string; // "Top Choice (Standard)" | "Alternative / Additive" | "Orthogonal / Green"
  polarityRating: string; // "Low-Medium Polarity"
  chamberPrep: string; // "For 20 mL chamber: 6.0 mL EtOAc + 14.0 mL Hexanes"
  predictedRf: {
    product: number;
    substrateA?: { name: string; rf: number };
    substrateB?: { name: string; rf: number };
  };
  resolutionDelta: string;
  modifiers?: string;
  rationale: string;
}

export interface SolventSuggestionResponse {
  reactionSummary: string;
  systems: SolventSystemRecommendation[];
  visualization: {
    primaryStain: string;
    secondaryStain: string;
    stainNotes: string;
  };
  coSpottingProtocol: string[];
}

export interface SolventAdvisorPayload {
  substrates: Array<{
    code?: string;
    name: string;
    smiles?: string;
    role?: string;
  }>;
  expectedProduct?: string;
  reactionClass?: string;
  stationaryPhase?: string;
}

export async function fetchAiSolventSystems(payload: SolventAdvisorPayload): Promise<SolventSuggestionResponse> {
  try {
    const res = await fetch('/api/ai/solvent-systems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `Server error: ${res.status}`);
    }
    return data.data;
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.message?.includes('aborted')) {
      throw new Error('Solvent system recommendation timed out after 45 seconds. Please try again.');
    }
    throw err;
  }
}

export interface MeetingBulletsPayload {
  runName: string;
  reactionClass?: string;
  designSummary?: string;
  reagents?: any[];
  hitStats?: any;
  topHits?: any[];
}

export async function fetchAiMeetingBullets(payload: MeetingBulletsPayload): Promise<string[]> {
  try {
    const res = await fetch('/api/ai/meeting-bullets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `Server error: ${res.status}`);
    }
    return data.bullets;
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.message?.includes('aborted')) {
      throw new Error('Meeting bullets generation timed out after 45 seconds. Please try again.');
    }
    throw err;
  }
}


