import { localDate } from '../engine';

/**
 * Sanitizes a run name or filename segment for cross-platform filesystem safety.
 */
export function sanitizeFilenameSegment(
  value: string | null | undefined,
  fallback = 'run',
  maxLen = 48
): string {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen)
    .replace(/_+$/g, '');
  return cleaned || fallback;
}

/**
 * Returns an ISO-style local export date stamp (YYYY-MM-DD).
 */
export function exportDateStamp(dateStr?: string): string {
  const raw = (dateStr || localDate()).trim();
  const safe = raw.replace(/[^0-9-]+/g, '').slice(0, 10);
  return safe || localDate();
}

/**
 * Builds a consistent export filename containing the run name and export date:
 *   `<runName>_<docSlug>_<YYYY-MM-DD>.<ext>` (or `<runName>_<YYYY-MM-DD>.<ext>` if docSlug is empty).
 */
export function buildExportFilename(
  runName: string | null | undefined,
  docSlug: string,
  ext: string,
  dateStr?: string
): string {
  const runPart = sanitizeFilenameSegment(runName, 'run');
  const slugPart = docSlug ? sanitizeFilenameSegment(docSlug, '', 64) : '';
  const datePart = exportDateStamp(dateStr);
  const cleanExt = ext.replace(/^\.+/, '');
  return slugPart
    ? `${runPart}_${slugPart}_${datePart}.${cleanExt}`
    : `${runPart}_${datePart}.${cleanExt}`;
}

/**
 * Builds a consistent export filename for multi-run / multi-well comparisons.
 */
export function buildMultiRunExportFilename(
  runNames: Array<string | null | undefined>,
  docSlug: string,
  ext: string,
  dateStr?: string
): string {
  const unique: string[] = [];
  for (const name of runNames) {
    const seg = sanitizeFilenameSegment(name, 'run', 24);
    if (!unique.includes(seg)) unique.push(seg);
  }
  const runPrefix =
    unique.length === 0
      ? 'run'
      : unique.length === 1
      ? unique[0]
      : unique.length === 2
      ? `${unique[0]}_vs_${unique[1]}`
      : `${unique[0]}_vs_${unique[1]}_plus${unique.length - 2}`;
  const slugPart = sanitizeFilenameSegment(docSlug, 'export', 64);
  const datePart = exportDateStamp(dateStr);
  const cleanExt = ext.replace(/^\.+/, '');
  return `${runPrefix}_${slugPart}_${datePart}.${cleanExt}`;
}

/**
 * Standard default export filename for each core Robowski export document kind.
 */
export function exportFilenameForKind(
  kind: string,
  runName?: string | null,
  dateStr?: string
): string {
  switch (kind) {
    case 'robowski':
      return buildExportFilename(runName, '', 'robowski', dateStr);
    case 'xlsx':
      return buildExportFilename(runName, 'robowski_run', 'xlsx', dateStr);
    case 'bench':
      return buildExportFilename(runName, 'bench_sheet', 'html', dateStr);
    case 'nb':
      return buildExportFilename(runName, 'notebook_card', 'png', dateStr);
    case 'stock':
      return buildExportFilename(runName, 'stock_preparation', 'csv', dateStr);
    case 'load':
      return buildExportFilename(runName, 'deck_load_checklist', 'csv', dateStr);
    case 'tlc':
      return buildExportFilename(runName, 'tlc_lane_map', 'csv', dateStr);
    case 'png':
      return buildExportFilename(runName, 'run_card', 'png', dateStr);
    case 'zip':
      return buildExportFilename(runName, 'robowski_package', 'zip', dateStr);
    default:
      return buildExportFilename(runName, kind || 'export', 'bin', dateStr);
  }
}
