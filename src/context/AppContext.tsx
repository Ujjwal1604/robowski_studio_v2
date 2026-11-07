import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  RunState,
  RunResult,
  LibraryReagent,
  SavedRun,
  VerifiedFix,
  TlcSet,
  TlcImageEntry,
} from '../types';
import * as Core from '../engine';
import { putTlcImage, getTlcImage, getImagesForSets } from './tlcStorage';
import {
  exampleState,
  normalize,
  validate,
  buildRows,
  buildDataPayload,
  dataFor,
} from './runPayload';
import {
  loadSavedRuns,
  saveSavedRuns,
  loadSavedLib,
  saveSavedLib,
  loadConfirmedPlates,
  saveConfirmedPlates,
  loadDraftState,
  saveDraftState,
  loadSavedTheme,
  saveTheme,
} from './storage';
import { parseLibrarySpreadsheet } from './importers';

export { exampleState, normalize, validate, buildRows, buildDataPayload, dataFor };

function defaultTlcSet(): TlcSet {
  return {
    uid: 'set_' + Math.random().toString(36).slice(2, 10),
    name: 'Set 1',
    cfg: null,
    cfgName: '',
    frameW: Core.LANE_FRAME_WIDTH,
    frontPx: null,
    frontAuto: {},
    originPx: null,
    originAuto: {},
    imgs: {},
  };
}

export interface AppContextType {
  state: RunState;
  setState: React.Dispatch<React.SetStateAction<RunState>>;
  run: RunResult | null;
  err: string | null;
  missing: string[];
  invalid: Set<string>;
  allEmpty: boolean;
  triPending: boolean;
  triMeta: any[];
  triBlank: Set<number>;
  rowsCache: number[][];
  setOf: number[];
  vialFocus: { label: string; rows: Set<number> } | null;
  setVialFocus: (focus: { label: string; rows: Set<number> } | null) => void;
  visited: Record<string, boolean>;
  setVisited: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  fixes: VerifiedFix[];
  fixesDone: boolean;
  fixesBusy: boolean;
  whyNot: string[];
  view: string;
  setView: (v: string) => void;
  page: number;
  setPage: (p: number | ((prev: number) => number)) => void;
  filterBad: boolean;
  setFilterBad: (b: boolean | ((prev: boolean) => boolean)) => void;
  status: 'draft' | 'exported';
  setStatus: (s: 'draft' | 'exported') => void;
  runsList: SavedRun[];
  lib: LibraryReagent[];
  runFilter: string;
  setRunFilter: (f: string) => void;
  runSearch: string;
  setRunSearch: (s: string) => void;
  compareIds: string[];
  setCompareIds: React.Dispatch<React.SetStateAction<string[]>>;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  toast: (msg: string, undo?: () => void) => void;
  spotProminence: number;
  setSpotProminence: (v: number) => void;
  toastState: { msg: string; undo?: () => void; id: number } | null;
  clearToast: () => void;
  previewModal: { kind: string; data?: any } | null;
  openPreview: (kind: string, data?: any) => void;
  closePreview: () => void;
  setPath: (path: string, val: any) => void;
  renameReagent: (i: number, newCode: string) => boolean;
  moveReagent: (i: number, dir: -1 | 1) => void;
  removeReagent: (i: number) => void;
  addReagent: () => void;
  addSet: () => void;
  dupSet: (i: number) => void;
  removeSet: (i: number) => void;
  unimport: () => void;
  applyFix: (fixIndex: number) => void;
  findFixes: () => void;
  saveRun: (asNew?: boolean) => Promise<void>;
  delRun: (id: string) => Promise<void>;
  putRun: (r: SavedRun) => Promise<void>;
  putLib: (item: Partial<LibraryReagent> & { id: string; name: string }) => Promise<void>;
  delLib: (id: string) => Promise<void>;
  startNewRun: () => void;
  openRun: (id: string) => void;
  dupRun: (id: string) => void;
  importLibraryFile: (f: File) => Promise<void>;
  restoreBackupFile: (f: File) => Promise<void>;
  importRobotFile: (f: File) => Promise<void>;
  importGeneratorFile: (f: File) => Promise<void>;
  downloadExport: (kind: string) => Promise<void>;
  draftSavedAt: number;
  platesOk: () => boolean;
  confirmPlates: () => void;
  unconfirmPlates: () => void;
  inlineRanges: boolean;
  tlcSets: TlcSet[];
  setTlcSets: React.Dispatch<React.SetStateAction<TlcSet[]>>;
  activeTlcStatus: 'ready' | 'pending';
  exportRobowskiArchive: () => Promise<boolean>;
  importRobowskiArchiveFile: (f: File) => Promise<boolean>;
  targetWell: { wellIndex: number; plateIndex?: number; source?: 'palette' | 'heatmap' | 'combinations' } | null;
  setTargetWell: (w: { wellIndex: number; plateIndex?: number; source?: 'palette' | 'heatmap' | 'combinations' } | null) => void;
}

const AppContext: React.Context<AppContextType | null> =
  (globalThis as any).__ROBOWSKI_APP_CONTEXT__ ||
  ((globalThis as any).__ROBOWSKI_APP_CONTEXT__ = createContext<AppContextType | null>(null));

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setTheme] = useState<'light' | 'dark'>(loadSavedTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const [toastState, setToastState] = useState<{ msg: string; undo?: () => void; id: number } | null>(
    null
  );
  const toastTimeoutRef = useRef<any>(null);

  const toast = useCallback((msg: string, undo?: () => void) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    const id = Date.now();
    setToastState({ msg, undo, id });
    const dur = undo ? 9000 : Math.max(3200, msg.length * 55);
    toastTimeoutRef.current = setTimeout(() => {
      setToastState(null);
    }, dur);
  }, []);

  const clearToast = useCallback(() => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToastState(null);
  }, []);

  const [state, setState] = useState<RunState>(loadDraftState);
  const [status, setStatus] = useState<'draft' | 'exported'>('draft');
  const [view, setView] = useState<string>('setup');
  const [visited, setVisited] = useState<Record<string, boolean>>({ setup: true });
  const [page, setPage] = useState<number>(0);
  const [filterBad, setFilterBad] = useState<boolean>(false);
  // Spot-detection sensitivity shared by the TLC view, CSV export and the plate heatmap.
  const [spotProminence, setSpotProminence] = useState<number>(0.28);
  const [vialFocus, setVialFocus] = useState<{ label: string; rows: Set<number> } | null>(null);
  const [targetWell, setTargetWell] = useState<{ wellIndex: number; plateIndex?: number; source?: 'palette' | 'heatmap' | 'combinations' } | null>(null);
  const [runFilter, setRunFilter] = useState<string>('all');
  const [runSearch, setRunSearch] = useState<string>('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [previewModal, setPreviewModal] = useState<{ kind: string; data?: any } | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<number>(Date.now());

  // Storage
  const [runsList, setRunsList] = useState<SavedRun[]>(loadSavedRuns);
  const [lib, setLib] = useState<LibraryReagent[]>(loadSavedLib);
  const [tlcSets, setTlcSets] = useState<TlcSet[]>([defaultTlcSet()]);

  const activeTlcStatus: 'ready' | 'pending' = useMemo(() => {
    const hasImgs = tlcSets.some((s) => Object.keys(s.imgs || {}).length > 0);
    return hasImgs ? 'ready' : 'pending';
  }, [tlcSets]);

  // Computation results
  const [run, setRun] = useState<RunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [allEmpty, setAllEmpty] = useState<boolean>(false);
  const [triPending, setTriPending] = useState<boolean>(false);
  const [triMeta, setTriMeta] = useState<any[]>([]);
  const [triBlank, setTriBlank] = useState<Set<number>>(new Set());
  const [rowsCache, setRowsCache] = useState<number[][]>([]);
  const [setOf, setSetOf] = useState<number[]>([]);
  const [fixes, setFixes] = useState<VerifiedFix[]>([]);
  const [fixesDone, setFixesDone] = useState<boolean>(false);
  const [fixesBusy, setFixesBusy] = useState<boolean>(false);
  const [whyNot, setWhyNot] = useState<string[]>([]);

  const fixTimerRef = useRef<any>(null);

  // Compute on state change
  useEffect(() => {
    const v = validate(state);
    const m = v.m;
    const inv = v.inv;
    const emptyCheck =
      state.mode === 'triplet'
        ? state.reagents.every((r) => r.stock === '' || r.stock == null) && !state.tri?.groups.length
        : !state.imported &&
          state.reagents.every((r) => r.stock === '' || r.stock == null) &&
          (state.sets || []).every((s) => s.items.every((it) => it.min === '' || it.min == null));

    setMissing(m);
    setInvalid(emptyCheck ? new Set() : inv);
    setAllEmpty(emptyCheck);

    const blankCheck = m.length > 0;

    // Save draft
    saveDraftState(state);
    setDraftSavedAt(Date.now());

    if (blankCheck) {
      setRun(null);
      setRowsCache([]);
      setSetOf([]);
      if (fixTimerRef.current) clearTimeout(fixTimerRef.current);
      setFixes([]);
      setWhyNot([]);
      setFixesDone(false);
      setFixesBusy(false);
      setTriPending(false);
      setErr(
        emptyCheck
          ? state.mode === 'triplet'
            ? 'Fill in the stock concentrations of the reagents you use and add some groups to see the plate.'
            : 'Fill in the reagents and the vial-set ranges to see the checks, combinations and deck.'
          : 'Still to fill in: ' + m.slice(0, 5).join(', ') + (m.length > 5 ? ' …' : '') + '.'
      );
      return;
    }

    let tb: any = null;
    let localRowsCache: number[][] = [];
    let localSetOf: number[] = [];
    let localTriBlank = new Set<number>();
    let localTriMeta: any[] = [];

    if (state.mode === 'triplet') {
      try {
        tb = Core.triBuildRows(state);
      } catch (e: any) {
        setRun(null);
        setRowsCache([]);
        setSetOf([]);
        setTriMeta([]);
        setTriBlank(new Set());
        setFixes([]);
        setErr(e.message);
        return;
      }
      if (!tb) {
        setTriPending(true);
        setRun(null);
        setRowsCache([]);
        setSetOf([]);
        setTriMeta([]);
        setTriBlank(new Set());
        setFixes([]);
        setErr('Assign a group to at least one section to see the volumes.');
        return;
      }
      localRowsCache = tb.rows;
      localTriBlank = tb.blank;
      localTriMeta = tb.meta;
      localSetOf = tb.rows.map(() => 0);
      setTriPending(false);
    } else {
      try {
        const b = buildRows(state);
        localRowsCache = b.rows;
        localSetOf = b.setOf;
      } catch (e: any) {
        setRun(null);
        setRowsCache([]);
        setSetOf([]);
        setFixes([]);
        setErr(e.message);
        return;
      }
    }

    setRowsCache(localRowsCache);
    setSetOf(localSetOf);
    setTriBlank(localTriBlank);
    setTriMeta(localTriMeta);

    try {
      const payload = buildDataPayload(state, localRowsCache, localTriBlank, localTriMeta);
      const computedRun = Core.buildRun(payload);
      setRun(computedRun);
      setErr(null);

      // Verified fix search trigger
      setFixes([]);
      setWhyNot([]);
      setFixesDone(false);
      setFixesBusy(false);
      if (fixTimerRef.current) clearTimeout(fixTimerRef.current);

      if (computedRun && computedRun.blockingIssues > 0 && computedRun.reactions <= 300) {
        fixTimerRef.current = setTimeout(() => {
          try {
            setFixes(Core.suggestFixes(payload));
          } catch (e) {
            setFixes([]);
          }
          try {
            setWhyNot(Core.explainNoFix(payload));
          } catch (e) {
            setWhyNot([]);
          }
          setFixesDone(true);
          setFixesBusy(false);
        }, 250);
      }
    } catch (e: any) {
      setRun(null);
      setErr(e.message);
    }
  }, [state]);

  const snap = useCallback(() => {
    const s = JSON.stringify(state);
    return () => {
      setState(JSON.parse(s));
    };
  }, [state]);

  const setPath = useCallback((path: string, val: any) => {
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const p = path.split('.');
      let o: any = next;
      for (let i = 0; i < p.length - 1; i++) {
        if (o[p[i]] === undefined) o[p[i]] = {};
        o = o[p[i]];
      }
      o[p[p.length - 1]] = val;
      if (path === 'tri.reps') Core.triSync(next);
      return next;
    });
  }, []);

  const renameReagent = useCallback(
    (i: number, raw: string): boolean => {
      const nc = String(raw).trim();
      const r = state.reagents[i];
      const old = r.code;
      if (nc === old) return true;
      let msg = '';
      if (!/^[A-Za-z0-9_-]{1,24}$/.test(nc)) msg = 'A code can only use letters, numbers, _ and -.';
      else if (/_N2?$/i.test(nc)) msg = 'Codes ending in _N or _N2 are reserved for diluted stocks.';
      else if (nc.toLowerCase() === 'solvent') msg = "'solvent' is reserved for the reaction solvent.";
      else if (state.reagents.some((x, j) => j !== i && x.code.toLowerCase() === nc.toLowerCase())) {
        msg = 'Another reagent already uses that code.';
      }
      if (msg) {
        toast(msg);
        return false;
      }
      const u = snap();
      setState((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        const auto = (g: any) =>
          g.members.filter(Boolean).join('+') + (g.scale > 1 ? ' (' + g.scale + ' eq)' : '');
        next.tri?.groups.forEach((g: any) => {
          const wasAuto =
            g.derived && (g.name === auto(g) || g.name.startsWith(auto(g) + ' #'));
          const suffix = g.name.slice(auto(g).length);
          g.members = g.members.map((m: string) => (m === old ? nc : m));
          if (wasAuto) g.name = auto(g) + suffix;
        });
        next.tri?.adds.forEach((a: any) => {
          if (a.code === old) a.code = nc;
        });
        next.reagents[i].code = nc;
        return next;
      });
      toast(`Renamed ${old} to ${nc}.`, u);
      return true;
    },
    [state.reagents, toast, snap]
  );

  const moveReagent = useCallback((i: number, dir: -1 | 1) => {
    setState((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.reagents.length) return prev;
      const next = JSON.parse(JSON.stringify(prev));
      const tmp = next.reagents[i];
      next.reagents[i] = next.reagents[j];
      next.reagents[j] = tmp;
      next.sets?.forEach((set: any) => {
        const itTmp = set.items[i];
        set.items[i] = set.items[j];
        set.items[j] = itTmp;
      });
      return next;
    });
  }, []);

  const removeReagent = useCallback(
    (i: number) => {
      const u = snap();
      const nm = state.reagents[i]?.code || '';
      setState((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        next.reagents.splice(i, 1);
        next.sets?.forEach((set: any) => set.items.splice(i, 1));
        Core.triSync(next);
        return next;
      });
      toast(`Removed reagent ${nm}.`, u);
    },
    [state.reagents, toast, snap]
  );

  const addReagent = useCallback(() => {
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const n = next.reagents.length;
      const have = new Set(next.reagents.map((r: any) => r.code));
      const single = Array.from({ length: 26 }, (_, k) => String.fromCharCode(65 + k)).find(
        (c) => !have.has(c)
      );
      const code =
        next.mode === 'triplet'
          ? single || 'R' + (n + 1)
          : n < 26
          ? String.fromCharCode(65 + n) + String.fromCharCode(65 + n)
          : 'R' + (n + 1);

      next.reagents.push({
        code,
        name: '',
        molarMass: 100,
        density: 0,
        stock: 100,
        solvent: next.reactionSolvent || 'ethanol',
        pipettingMode: 'empty',
      });
      next.sets?.forEach((set: any, si: number) =>
        set.items.push({
          on: si === 0,
          min: next.mode === 'equivalence' ? 0.1 : 1,
          step: next.mode === 'equivalence' ? 0.1 : 1,
          max: next.mode === 'equivalence' ? 0.2 : 2,
        })
      );
      return next;
    });
  }, []);

  const addSet = useCallback(() => {
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const sets = next.sets || [];
      const last = sets[sets.length - 1] || {
        name: 'Set 1',
        items: next.reagents.map(() => ({ on: true, min: 1, step: 1, max: 2 })),
      };
      sets.push({
        name: 'Set ' + (sets.length + 1),
        items: JSON.parse(JSON.stringify(last.items)),
      });
      next.sets = sets;
      return next;
    });
  }, []);

  const dupSet = useCallback((i: number) => {
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const src = next.sets[i];
      next.sets.splice(i + 1, 0, {
        name: src.name + ' copy',
        items: JSON.parse(JSON.stringify(src.items)),
      });
      return next;
    });
  }, []);

  const removeSet = useCallback(
    (i: number) => {
      const u = snap();
      setState((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        next.sets.splice(i, 1);
        return next;
      });
      toast('Set removed.', u);
    },
    [toast, snap]
  );

  const unimport = useCallback(() => {
    const u = snap();
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      delete next.imported;
      next.randomize = true;
      return next;
    });
    toast('Imported vials discarded.', u);
  }, [toast, snap]);

  const applyFix = useCallback(
    (fixIndex: number) => {
      const f = fixes[fixIndex];
      if (!f) return;
      const u = snap();
      const { stocks, ...rest } = f.patch;
      setState((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        Object.assign(next, rest);
        if (stocks) {
          Object.entries(stocks).forEach(([k, v]) => {
            if (next.reagents[+k]) next.reagents[+k].stock = v;
          });
        }
        return next;
      });
      toast('Applied: ' + f.label, u);
    },
    [fixes, toast, snap]
  );

  const findFixes = useCallback(() => {
    if (!run) return;
    setFixesBusy(true);
    setTimeout(() => {
      try {
        const payload = buildDataPayload(state, rowsCache, triBlank, triMeta);
        setFixes(Core.suggestFixes(payload));
        setWhyNot(Core.explainNoFix(payload));
      } catch (e) {
        setFixes([]);
        setWhyNot([]);
      }
      setFixesDone(true);
      setFixesBusy(false);
    }, 40);
  }, [run, state, rowsCache, triBlank, triMeta]);

  // Run library & Reagent Library Storage Helpers
  const putRun = useCallback(
    async (r: SavedRun) => {
      setRunsList((prev) => {
        const next = [...prev];
        const idx = next.findIndex((x) => x.id === r.id);
        if (idx < 0) next.unshift(r);
        else next[idx] = r;
        next.sort((a, b) => (b.updated || 0) - (a.updated || 0));
        saveSavedRuns(next);
        return next;
      });
    },
    []
  );

  const delRun = useCallback(
    async (id: string) => {
      setRunsList((prev) => {
        const next = prev.filter((x) => x.id !== id);
        saveSavedRuns(next);
        return next;
      });
    },
    []
  );

  const putLib = useCallback(
    async (item: Partial<LibraryReagent> & { id: string; name: string }) => {
      setLib((prev) => {
        const next = [...prev];
        const idx = next.findIndex((x) => x.id === item.id);
        if (idx < 0) next.push(item as LibraryReagent);
        else next[idx] = { ...next[idx], ...item } as LibraryReagent;
        saveSavedLib(next);
        return next;
      });
    },
    []
  );

  const delLib = useCallback(async (id: string) => {
    setLib((prev) => {
      const next = prev.filter((x) => x.id !== id);
      saveSavedLib(next);
      return next;
    });
  }, []);

  const saveRun = useCallback(
    async (asNew = false) => {
      if (!run && !triPending) {
        toast('Fix the input error first.');
        return;
      }
      const newId = asNew || !state.id ? Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4) : state.id;
      if (asNew || !state.id) {
        setState((prev) => ({ ...prev, id: newId }));
      }
      const ts = run ? null : Core.triStats(state);
      const stockCount = run ? Object.keys(run.stocks).length : Core.triUsedCodes(state).size;
      const tipsText = run
        ? `${run.tipCounts[50]} / ${run.tipCounts[300]} / ${run.tipCounts[1000]}`
        : '-';

      const sm: SavedRun = {
        id: newId,
        name: state.name,
        mode: state.mode,
        hood: state.hood,
        reactions: run
          ? state.mode === 'triplet'
            ? triMeta.filter((m) => !m.blank).length
            : run.reactions
          : ts?.wells || 0,
        plates: run ? run.plates : ts?.plates || 0,
        tips: tipsText,
        stocks: stockCount,
        codes: state.reagents.map((r) => r.code),
        colors: state.reagents.map((_, i) => Core.PAL[i % Core.PAL.length]),
        status,
        updated: Date.now(),
        state: JSON.parse(JSON.stringify(state)),
        tlc_status: activeTlcStatus,
        tlc_sets: tlcSets.map((s) => ({
          uid: s.uid,
          name: s.name,
          cfg: s.cfg,
          cfgName: s.cfgName,
          cfgText: s.cfgText,
          frameW: s.frameW || Core.LANE_FRAME_WIDTH,
          frontPx: s.frontPx ?? null,
          frontAuto: s.frontAuto || {},
          imgMeta: Object.entries(s.imgs || {}).map(([k, im]) => ({
            key: k,
            name: im.name,
          })),
        })),
      };

      try {
        if (run) {
          sm.summary = Core.notebookSummary(run).reagents.map((x) => ({
            code: x.code,
            text: (x.name && x.name !== x.code ? x.name + ': ' : '') + x.use,
          }));
        }
      } catch (e) {}

      try {
        await putRun(sm);
        toast(`Saved "${state.name}".`);
      } catch (e: any) {
        toast('Could not save: ' + (e?.message || e));
      }
    },
    [run, triPending, state, triMeta, status, activeTlcStatus, tlcSets, putRun, toast]
  );

  const startNewRun = useCallback(() => {
    const u = snap();
    setStatus('draft');
    const newState = normalize(exampleState());
    newState.name = 'new-run';
    setState(newState);
    setTlcSets([defaultTlcSet()]);
    setVisited({ setup: true });
    setView('setup');
    toast('Started a new run.', u);
  }, [snap, toast]);

  const openRun = useCallback(
    (id: string) => {
      const r = runsList.find((x) => x.id === id);
      if (r) {
        setStatus(r.status || 'draft');
        const st = normalize(JSON.parse(JSON.stringify(r.state)));
        st.id = r.id;
        setState(st);
        if (r.tlc_sets && r.tlc_sets.length > 0) {
          setTlcSets(
            r.tlc_sets.map((s: any) => ({
              uid: s.uid,
              name: s.name,
              cfg: s.cfg,
              cfgName: s.cfgName,
              cfgText: s.cfgText,
              frameW: s.frameW || Core.LANE_FRAME_WIDTH,
              frontPx: s.frontPx ?? null,
              frontAuto: s.frontAuto || {},
              imgs: {},
              prof: {},
            }))
          );
        } else {
          setTlcSets([defaultTlcSet()]);
        }
        setVisited({ setup: true });
        setView('setup');
      }
    },
    [runsList]
  );

  const dupRun = useCallback(
    async (id: string) => {
      const r = runsList.find((x) => x.id === id);
      if (r) {
        setStatus('draft');
        const st = normalize(JSON.parse(JSON.stringify(r.state)));
        st.id = null;
        st.name = r.name + '-copy';
        setState(st);
        if (r.tlc_sets && r.tlc_sets.length > 0) {
          const duplicatedSets: TlcSet[] = [];
          for (const s of r.tlc_sets) {
            const newUid = 'set_' + Math.random().toString(36).slice(2, 10);
            duplicatedSets.push({
              uid: newUid,
              name: s.name,
              cfg: s.cfg,
              cfgName: s.cfgName,
              cfgText: s.cfgText,
              frameW: s.frameW || Core.LANE_FRAME_WIDTH,
              frontPx: s.frontPx ?? null,
              frontAuto: s.frontAuto || {},
              imgs: {},
              prof: {},
            });
            // Copy image blobs in IndexedDB to the new set namespace
            for (const k of ['UV254', 'White', 'UV366']) {
              const oldImg = await getTlcImage(s.uid, k);
              if (oldImg) {
                await putTlcImage(newUid, k, oldImg.name, oldImg.blob);
              }
            }
          }
          setTlcSets(duplicatedSets);
        } else {
          setTlcSets([defaultTlcSet()]);
        }
        setVisited({ setup: true });
        setView('setup');
        toast('Duplicated. Save it to keep the copy.');
      }
    },
    [runsList, toast]
  );

  // Deck plate confirmation check
  const plateSig = useCallback(() => {
    if (!run) return '';
    const d = run.deck;
    return JSON.stringify([state.hood, d.solvent_kind, d.solvent_plate, d.solvent_container, d.plates]);
  }, [run, state.hood]);

  const platesOk = useCallback(() => {
    if (!run) return false;
    const okList = loadConfirmedPlates();
    return okList.includes(plateSig());
  }, [run, plateSig]);

  const confirmPlates = useCallback(() => {
    const sig = plateSig();
    const okList = loadConfirmedPlates();
    if (!okList.includes(sig)) {
      okList.push(sig);
      saveConfirmedPlates(okList.slice(-50));
    }
    toast('Plate numbers confirmed for the ' + state.hood + ' hood.');
  }, [plateSig, state.hood, toast]);

  const unconfirmPlates = useCallback(() => {
    const sig = plateSig();
    const okList = loadConfirmedPlates();
    saveConfirmedPlates(okList.filter((x) => x !== sig));
  }, [plateSig]);

  // Preview & Download
  const openPreview = useCallback((kind: string, data?: any) => {
    setPreviewModal({ kind, data });
  }, []);

  const closePreview = useCallback(() => {
    setPreviewModal(null);
  }, []);

  const safeName = (s: string) =>
    String(s || 'run')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .slice(0, 40);

  const saveFileToDisk = async (name: string, data: any) => {
    try {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const el = document.createElement('a');
      el.href = url;
      el.download = name;
      document.body.appendChild(el);
      el.click();
      el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Downloaded ' + name);
      return true;
    } catch (e: any) {
      toast('Could not download ' + name + ': ' + (e?.message || e));
      return false;
    }
  };

  const downloadExport = useCallback(
    async (kind: string) => {
      if (!run || run.blockingIssues > 0) return;
      try {
        let ok = false;
        if (kind === 'xlsx') {
          ok = await saveFileToDisk(
            'robowski_run.xlsx',
            Core.workbookBytes(buildDataPayload(state, rowsCache, triBlank, triMeta), run)
          );
        } else if (kind === 'bench') {
          ok = await saveFileToDisk(
            'bench_sheet_' + safeName(state.name) + '.html',
            Core.benchSheetHtml(run, Core.localDate())
          );
        } else if (kind === 'nb') {
          const pngBytes = await Core.notebookCardPngBytes(run, Core.localDate());
          ok = await saveFileToDisk('notebook_card_' + safeName(state.name) + '.png', pngBytes);
        } else if (kind === 'stock') {
          ok = await saveFileToDisk('stock_preparation.csv', Core.stockCsv(run, Core.stockSteps(run)));
        } else if (kind === 'load') {
          ok = await saveFileToDisk('deck_load_checklist.csv', Core.loadCsv(Core.deckSteps(run)));
        } else if (kind === 'tlc') {
          ok = await saveFileToDisk('tlc_lane_map.csv', Core.tlcLaneCsv(run));
        } else if (kind === 'png') {
          const png = await Core.runCardPngBytes(run);
          ok = await saveFileToDisk('run_card.png', png);
        } else if (kind === 'zip') {
          let png: Uint8Array | null = null;
          try {
            png = await Core.runCardPngBytes(run);
          } catch (e) {}
          ok = await saveFileToDisk('robowski_package.zip', Core.packageBytes(run, png));
        } else if (kind === 'robowski') {
          const imageBlobs = await getImagesForSets(tlcSets);
          const archiveBytes = await Core.buildRobowskiArchive(state, run, tlcSets, imageBlobs);
          ok = await saveFileToDisk(safeName(state.name) + '_' + Core.localDate() + '.robowski', archiveBytes);
        }
        if (ok) {
          setStatus('exported');
          if (state.id) {
            const r = runsList.find((x) => x.id === state.id);
            if (r) {
              r.exports = r.exports || [];
              r.exports.push({ t: Date.now(), kind });
              if (r.exports.length > 50) r.exports = r.exports.slice(-50);
              r.status = 'exported';
              r.updated = Date.now();
              await putRun(r);
            }
          }
        }
      } catch (e: any) {
        toast('Export failed: ' + e.message);
      }
    },
    [run, state, tlcSets, rowsCache, triBlank, triMeta, runsList, putRun, toast]
  );

  const exportRobowskiArchive = useCallback(async (): Promise<boolean> => {
    if (!run || run.blockingIssues > 0) {
      toast('Fix blocking issues before exporting archive.');
      return false;
    }
    try {
      toast('Packaging .robowski experiment archive…');
      const imageBlobs = await getImagesForSets(tlcSets);
      const archiveBytes = await Core.buildRobowskiArchive(state, run, tlcSets, imageBlobs);
      const filename = `${safeName(state.name || 'run')}_${Core.localDate()}.robowski`;
      const ok = await saveFileToDisk(filename, archiveBytes);
      if (ok) {
        setStatus('exported');
        if (state.id) {
          const r = runsList.find((x) => x.id === state.id);
          if (r) {
            r.exports = r.exports || [];
            r.exports.push({ t: Date.now(), kind: 'robowski' });
            r.status = 'exported';
            r.updated = Date.now();
            await putRun(r);
          }
        }
      }
      return ok;
    } catch (e: any) {
      toast('Could not export archive: ' + (e?.message || e));
      return false;
    }
  }, [run, state, tlcSets, runsList, putRun, toast]);

  const importRobowskiArchiveFile = useCallback(
    async (file: File): Promise<boolean> => {
      try {
        toast('Opening .robowski archive…');
        const ab = await file.arrayBuffer();
        const parsed = await Core.parseRobowskiArchive(ab);

        // Put images into IndexedDB
        for (const img of parsed.tlcImages) {
          await putTlcImage(img.uid, img.key, img.name, img.blob);
        }

        // Reconstruct TLC sets
        const reconstructedSets: TlcSet[] = [];
        for (const s of parsed.tlcSets) {
          const imgs: Record<string, TlcImageEntry> = {};
          if (Array.isArray(s.imgMeta)) {
            for (const m of s.imgMeta) {
              const matched = parsed.tlcImages.find((im) => im.uid === s.uid && im.key === m.key);
              if (matched) {
                try {
                  const bmp = await createImageBitmap(matched.blob);
                  imgs[m.key] = { name: m.name, bmp };
                } catch {}
              }
            }
          }
          reconstructedSets.push({
            uid: s.uid,
            name: s.name,
            cfg: s.cfg,
            cfgName: s.cfgName,
            cfgText: s.cfgText,
            frameW: s.frameW || Core.LANE_FRAME_WIDTH,
            frontPx: s.frontPx ?? null,
            frontAuto: s.frontAuto || {},
            imgs,
            prof: {},
          });
        }

        if (reconstructedSets.length > 0) {
          setTlcSets(reconstructedSets);
        } else {
          setTlcSets([defaultTlcSet()]);
        }

        // Set state
        const st = normalize(parsed.state);
        if (!st.id) {
          st.id = Math.random().toString(36).slice(2, 10);
        }
        setState(st);
        setVisited({ setup: true, tlc: true });
        setView('tlc');

        // Add or update in saved runs
        const newRun: SavedRun = {
          id: st.id,
          name: st.name,
          mode: st.mode,
          hood: st.hood,
          reactions: parsed.manifest.summary?.reactions || 0,
          plates: parsed.manifest.summary?.plates || 1,
          tips: '-',
          stocks: 0,
          codes: st.reagents.map((r) => r.code),
          colors: st.reagents.map((_, i) => Core.PAL[i % Core.PAL.length]),
          status: 'exported',
          updated: Date.now(),
          state: st,
          tlc_status: parsed.tlcStatus,
          tlc_sets: parsed.tlcSets,
        };
        await putRun(newRun);

        if (parsed.tlcStatus === 'pending') {
          toast(
            `Restored "${st.name}". Note: ⚠️ TLC data is pending (drop plate photos here when ready).`
          );
        } else {
          toast(`Restored "${st.name}" with TLC plate images and analysis.`);
        }
        return true;
      } catch (e: any) {
        toast('Could not open .robowski file: ' + (e?.message || e));
        return false;
      }
    },
    [putRun, toast]
  );

  // File import routines
  const importLibraryFile = useCallback(
    async (f: File) => {
      try {
        const res = await parseLibrarySpreadsheet(f, lib);
        if (!res) {
          toast(
            "Couldn't find the columns. The file needs a name column and a molar mass column (g/mol). Use the Template button for an example."
          );
          return;
        }
        setLib(res.nextLib);
        saveSavedLib(res.nextLib);
        toast(`Library: ${res.added} added, ${res.updated} updated.`);
      } catch (e: any) {
        toast('Could not read that file: ' + e.message);
      }
    },
    [lib, toast]
  );

  const restoreBackupFile = useCallback(
    async (f: File) => {
      try {
        if (f.size > 50e6) throw new Error('that file is too large to be a backup');
        const pack = JSON.parse(await f.text());
        if (
          !pack ||
          pack.format !== 'robowski-studio-backup' ||
          !Array.isArray(pack.runs) ||
          !Array.isArray(pack.library)
        ) {
          throw new Error('this is not a Robowski Studio backup file');
        }
        let added = 0,
          updated = 0,
          kept = 0,
          libAdded = 0,
          skipped = 0;
        for (const r of pack.runs) {
          if (
            !r ||
            typeof r.id !== 'string' ||
            typeof r.name !== 'string' ||
            !r.state ||
            !Array.isArray(r.state.reagents)
          ) {
            skipped++;
            continue;
          }
          const ex = runsList.find((x) => x.id === r.id);
          if (!ex) {
            await putRun(r);
            added++;
          } else if ((+r.updated || 0) > (+ex.updated || 0)) {
            await putRun(r);
            updated++;
          } else {
            kept++;
          }
        }
        const names = new Set(lib.map((x) => String(x.name).trim().toLowerCase()));
        for (const x of pack.library) {
          if (!x || !String(x.name || '').trim()) {
            skipped++;
            continue;
          }
          const k = String(x.name).trim().toLowerCase();
          if (names.has(k)) continue;
          names.add(k);
          await putLib({
            ...x,
            id: lib.some((y) => y.id === x.id) ? Math.random().toString(36).slice(2, 10) : x.id,
          });
          libAdded++;
        }
        toast(
          `Restored: ${added} run${added === 1 ? '' : 's'} added, ${updated} updated, ${kept} already up to date; ${libAdded} reagent${
            libAdded === 1 ? '' : 's'
          } added${skipped ? '; ' + skipped + ' unreadable entries skipped' : ''}.`
        );
      } catch (e: any) {
        toast('Could not restore: ' + (e?.message || e));
      }
    },
    [runsList, lib, putRun, putLib, toast]
  );

  const importRobotFile = useCallback(
    async (f: File) => {
      try {
        const d = await Core.importRobotWorkbook(f);
        const st = exampleState();
        Object.assign(st, {
          name: d.name,
          mode: 'concentration',
          vialVolume: d.vialVolume,
          threshold: d.threshold,
          dilutionFactor: d.dilutionFactor,
          reactionSolvent: d.reactionSolvent,
          randomize: false,
          solventAfter: d.solventAfter,
          reagents: d.reagents,
          imported: { name: d.name, rows: d.rows, skipped: d.skipped },
        });
        delete st.sets;
        if (d.deckPlates) st.deckPlates = d.deckPlates;
        const normalizedState = normalize(st);
        normalizedState.id = null;
        setState(normalizedState);
        setView('setup');
        toast('Opened ' + f.name);
      } catch (e: any) {
        toast('Could not read that workbook: ' + e.message);
      }
    },
    [toast]
  );

  const importGeneratorFile = useCallback(
    async (f: File) => {
      let isRobot = false;
      try {
        await Core.importRobotWorkbook(f);
        isRobot = true;
      } catch (e) {}
      if (isRobot) return importRobotFile(f);

      try {
        const d = await Core.importGenerator(f);
        const st = exampleState();
        Object.assign(
          st,
          { name: f.name.replace(/\.xlsx$/i, '') },
          {
            mode: d.mode,
            vialVolume: d.vialVolume,
            threshold: d.threshold,
            dilutionFactor: d.dilutionFactor,
            reactionSolvent: d.reactionSolvent,
            reagents: d.reagents.map((r: any) => ({
              code: r.code,
              name: r.name,
              molarMass: r.molarMass,
              density: r.density,
              stock: r.stock,
              solvent: r.solvent,
              min: r.min,
              step: r.step,
              max: r.max,
              pipettingMode: 'empty',
            })),
          }
        );
        delete st.sets;
        const normalized = normalize(st);
        normalized.id = null;
        setState(normalized);
        setView('setup');
        toast('Imported ' + f.name);
      } catch (e: any) {
        toast('Could not read that workbook: ' + e.message);
      }
    },
    [importRobotFile, toast]
  );

  const inlineRanges = !state.imported && state.mode !== 'triplet' && (state.sets?.length || 0) === 1;

  return (
    <AppContext.Provider
      value={{
        state,
        setState,
        run,
        err,
        missing,
        invalid,
        allEmpty,
        triPending,
        triMeta,
        triBlank,
        rowsCache,
        setOf,
        vialFocus,
        setVialFocus,
        visited,
        setVisited,
        fixes,
        fixesDone,
        fixesBusy,
        whyNot,
        view,
        setView,
        page,
        setPage,
        filterBad,
        setFilterBad,
        status,
        setStatus,
        runsList,
        lib,
        runFilter,
        setRunFilter,
        runSearch,
        setRunSearch,
        compareIds,
        setCompareIds,
        theme,
        toggleTheme,
        toast,
        spotProminence,
        setSpotProminence,
        toastState,
        clearToast,
        previewModal,
        openPreview,
        closePreview,
        setPath,
        renameReagent,
        moveReagent,
        removeReagent,
        addReagent,
        addSet,
        dupSet,
        removeSet,
        unimport,
        applyFix,
        findFixes,
        saveRun,
        delRun,
        putRun,
        putLib,
        delLib,
        startNewRun,
        openRun,
        dupRun,
        importLibraryFile,
        restoreBackupFile,
        importRobotFile,
        importGeneratorFile,
        downloadExport,
        draftSavedAt,
        platesOk,
        confirmPlates,
        unconfirmPlates,
        inlineRanges,
        tlcSets,
        setTlcSets,
        activeTlcStatus,
        exportRobowskiArchive,
        importRobowskiArchiveFile,
        targetWell,
        setTargetWell,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
};
