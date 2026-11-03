// Robowski Studio - Code 128 (Set B) Barcode Generator for Lab LIMS Tracking
// Pure TypeScript, dependency-free, generates crisp SVG barcode symbols.

// Code 128 patterns (widths of bars and spaces, 6 elements each, ending in 2-element stop pattern)
const PATTERNS: number[] = [
  0x6cc, 0x66c, 0x666, 0x498, 0x48c, 0x44c, 0x4c8, 0x4c4, 0x464, 0x648,
  0x644, 0x624, 0x59c, 0x4dc, 0x4ce, 0x5cc, 0x4ec, 0x4ee, 0x764, 0x744,
  0x724, 0x74c, 0x72c, 0x6ec, 0x6e4, 0x674, 0x76c, 0x69c, 0x6ce, 0x6e7,
  0x558, 0x546, 0x526, 0x456, 0x446, 0x426, 0x52c, 0x42e, 0x436, 0x56a,
  0x564, 0x524, 0x4ea, 0x4e4, 0x4a4, 0x758, 0x746, 0x716, 0x768, 0x762,
  0x712, 0x728, 0x722, 0x714, 0x6b8, 0x6b2, 0x692, 0x6ba, 0x6b4, 0x694,
  0x658, 0x646, 0x616, 0x668, 0x662, 0x612, 0x628, 0x622, 0x614, 0x5a8,
  0x5a2, 0x582, 0x5b0, 0x5b2, 0x58a, 0x548, 0x542, 0x502, 0x550, 0x552,
  0x50a, 0x4a8, 0x4a2, 0x482, 0x4b0, 0x4b2, 0x48a, 0x448, 0x442, 0x402,
  0x450, 0x452, 0x40a, 0x748, 0x742, 0x702, 0x750, 0x752, 0x70a, 0x6a8,
  0x6a2, 0x682, 0x6b1, 0x691, 0x685, 0x64b, // 100-105
  0x690 // Stop pattern extra
];

const START_B = 104;
const STOP = 106;

export function generateCode128Svg(text: string, height: number = 38): string {
  // Clean ASCII input (32-126)
  const safeText = text.replace(/[^\x20-\x7E]/g, '').slice(0, 48) || 'ROBOWSKI';
  
  // Encode characters in Code 128 Set B
  const codes: number[] = [START_B];
  let checksum = START_B;

  for (let i = 0; i < safeText.length; i++) {
    const code = safeText.charCodeAt(i) - 32;
    codes.push(code);
    checksum += code * (i + 1);
  }

  codes.push(checksum % 103);
  codes.push(STOP);

  // Convert codes to binary modules
  const modules: number[] = [];
  codes.forEach((c) => {
    const pattern = PATTERNS[c] ?? PATTERNS[0];
    for (let bit = 10; bit >= 0; bit--) {
      modules.push((pattern >> bit) & 1);
    }
  });
  // Add stop termination bar (2 bits: 11)
  modules.push(1, 1);

  // Build SVG rects
  const quietZone = 10;
  const barWidth = 1.6;
  const totalWidth = (modules.length + quietZone * 2) * barWidth;
  const barHeight = height;

  let rects = '';
  modules.forEach((m, idx) => {
    if (m === 1) {
      const x = (idx + quietZone) * barWidth;
      rects += `<rect x="${x.toFixed(1)}" y="0" width="${barWidth.toFixed(1)}" height="${barHeight}" fill="#111827"/>`;
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth.toFixed(1)} ${barHeight + 14}" style="display:inline-block; max-width:100%; height:auto;">
  <g>${rects}</g>
  <text x="${(totalWidth / 2).toFixed(1)}" y="${barHeight + 11}" text-anchor="middle" font-family="'IBM Plex Mono', Consolas, monospace" font-size="10" font-weight="600" fill="#374151" letter-spacing="0.1em">${safeText}</text>
</svg>`;
}
