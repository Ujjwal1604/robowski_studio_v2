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
  const res = await fetch('/api/ai/synthesis-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Server error: ${res.status}`);
  }
  return data.report;
}

export async function fetchAiDiagnostics(payload: DiagnosticsPayload): Promise<string> {
  const res = await fetch('/api/ai/diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Server error: ${res.status}`);
  }
  return data.advice;
}

export async function fetchAiTlcInterpretation(payload: TlcInterpretationPayload): Promise<string> {
  const res = await fetch('/api/ai/tlc-interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Server error: ${res.status}`);
  }
  return data.interpretation;
}
