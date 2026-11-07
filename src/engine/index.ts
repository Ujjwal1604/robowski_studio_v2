// Robowski Studio - Master Engine Export
export * from './constants';
export * from './combinations';
export * from './deckTiming';
export * from './dilution';
export * from './autoFix';
export * from './triplet';
export * from './tooltips';
export * from './exporters/zipStore';
export * from './exporters/unzipStore';
export * from './exporters/xlsx';
export * from './exporters/csv';
export * from './exporters/benchSheet';
export * from './exporters/runCard';
export * from './exporters/package';
export * from './exporters/robowskiArchive';
export * from './importers/tableReader';
export * from './importers/generatorParser';
export * from './importers/robotParser';
export * from './presets';
export * from './dilutionTier';
export * from './tlcLanes';
export * from './tlcEdge';
export * from './barcode';
export * from './demoTlc';

import * as constants from './constants';
import * as combinations from './combinations';
import * as deckTiming from './deckTiming';
import * as dilution from './dilution';
import * as autoFix from './autoFix';
import * as zipStore from './exporters/zipStore';
import * as xlsx from './exporters/xlsx';
import * as csv from './exporters/csv';
import * as benchSheet from './exporters/benchSheet';
import * as runCard from './exporters/runCard';
import * as pkg from './exporters/package';
import * as tableReader from './importers/tableReader';
import * as generatorParser from './importers/generatorParser';
import * as robotParser from './importers/robotParser';
import * as tlcLanes from './tlcLanes';

if (typeof globalThis !== 'undefined') {
  (globalThis as any).RobowskiCore = {
    ...constants,
    ...combinations,
    ...deckTiming,
    ...dilution,
    ...autoFix,
    ...zipStore,
    ...xlsx,
    ...csv,
    ...benchSheet,
    ...runCard,
    ...pkg,
    ...tableReader,
    ...generatorParser,
    ...robotParser,
    ...tlcLanes,
  };
}
