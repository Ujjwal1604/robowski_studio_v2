import { describe, it, expect, vi } from 'vitest';
import {
  fetchAiSynthesisReport,
  fetchAiDiagnostics,
  fetchAiTlcInterpretation,
  SynthesisReportPayload,
  DiagnosticsPayload,
} from '../src/services/aiService';

describe('AI Services Integration', () => {
  it('formats and fetches an AI synthesis report', async () => {
    const mockReport = '### 1. Executive Summary\nWinning hit identified in well P1_B3.';
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, report: mockReport }),
    });
    vi.stubGlobal('fetch', fakeFetch);

    const payload: SynthesisReportPayload = {
      campaignTitle: 'Buchwald-Hartwig Screen',
      reactionClass: 'C-N Coupling',
      objective: 'Maximize conversion of 2-chloropyridine',
      wellStats: {
        total: 54,
        hits: 12,
        moderate: 20,
        low: 15,
        failed: 7,
      },
      topHits: [
        { well: 'P1_B3', recipe: 'Pd(OAc)2 5 mol% · XPhos 10 mol% · NaOtBu 2 eq', conversion: 98 },
      ],
      problemWells: [
        { well: 'P1_F9', recipe: 'Pd(OAc)2 5 mol% · BINAP 10 mol% · K3PO4 2 eq', notes: 'Precipitated' },
      ],
    };

    const res = await fetchAiSynthesisReport(payload);
    expect(res).toBe(mockReport);
    expect(fakeFetch).toHaveBeenCalledWith(
      '/api/ai/synthesis-report',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  it('fetches liquid handling diagnostic advice', async () => {
    const mockAdvice = '1. Root Cause: stock concentration too low.';
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, advice: mockAdvice }),
    });
    vi.stubGlobal('fetch', fakeFetch);

    const payload: DiagnosticsPayload = {
      runName: 'Test Screen',
      totalVials: 54,
      vialVolume: 500,
      threshold: 50,
      reagents: [{ code: 'AA', name: 'Aniline', stock: 50 }],
      issues: [{ code: 'solvent', min: 0, max: 0, neg: 4 }],
    };

    const res = await fetchAiDiagnostics(payload);
    expect(res).toBe(mockAdvice);
    expect(fakeFetch).toHaveBeenCalledWith('/api/ai/diagnostics', expect.anything());
  });

  it('throws an informative error when the server returns an error code', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Gemini API key is not configured.' }),
    });
    vi.stubGlobal('fetch', fakeFetch);

    await expect(
      fetchAiSynthesisReport({ campaignTitle: 'Error test' })
    ).rejects.toThrow('Gemini API key is not configured.');
  });

  it('fetches AI TLC solvent system suggestions and parses best recommendation', async () => {
    const mockData = {
      reactionSummary: 'Amide coupling of acid and amine leads to less polar amide.',
      systems: [
        {
          name: '30% Ethyl Acetate / 70% Hexanes',
          ratio: '3:7 (v/v) EtOAc / Hexanes',
          isBest: true,
          tag: 'Top Choice',
          polarityRating: 'Medium Polarity',
          chamberPrep: 'For 20 mL chamber: 6.0 mL EtOAc + 14.0 mL Hexanes',
          predictedRf: { product: 0.38, substrateA: { name: 'Acid', rf: 0.1 }, substrateB: { name: 'Amine', rf: 0.05 } },
          resolutionDelta: 'ΔRf = 0.28 (Baseline separation)',
          rationale: 'Optimal Rf for target amide isolation.',
        },
        {
          name: '20% Acetone / 80% Heptane',
          ratio: '2:8 (v/v)',
          isBest: false,
          tag: 'Orthogonal / Green',
          polarityRating: 'Low Polarity',
          chamberPrep: 'For 20 mL chamber: 4.0 mL Acetone + 16.0 mL Heptane',
          predictedRf: { product: 0.28 },
          resolutionDelta: 'ΔRf = 0.20',
          rationale: 'Green replacement.',
        },
      ],
      visualization: {
        primaryStain: 'UV 254 nm',
        secondaryStain: 'KMnO4 dip / heat',
        stainNotes: 'Highlights aromatic and oxidizable groups.',
      },
      coSpottingProtocol: ['Lane 1: SM-A', 'Lane 2: Co-spot', 'Lane 3: Reaction Crude', 'Lane 4: SM-B'],
    };

    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: mockData }),
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { fetchAiSolventSystems } = await import('../src/services/aiService');
    const result = await fetchAiSolventSystems({
      substrates: [{ code: 'AA', name: 'p-toluic acid' }, { code: 'BB', name: 'benzylamine' }],
      expectedProduct: 'N-benzyl-4-methylbenzamide',
      reactionClass: 'Amide Coupling',
    });

    expect(result.systems).toHaveLength(2);
    expect(result.systems[0].isBest).toBe(true);
    expect(result.systems[0].name).toBe('30% Ethyl Acetate / 70% Hexanes');
    expect(fakeFetch).toHaveBeenCalledWith('/api/ai/solvent-systems', expect.anything());
  });
});
