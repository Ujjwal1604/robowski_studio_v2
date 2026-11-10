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
});
