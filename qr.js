// ================= QR CODE =================
// A compact QR encoder (byte mode, error correction level M, versions 1–10).
// Written inline so the portal needs no extra dependency — one less file to
// deploy, and nothing to break if a CDN is unreachable.

const QR_EC_BLOCKS_M = {
  1: [[1, 26, 16]], 2: [[1, 44, 28]], 3: [[1, 70, 44]], 4: [[2, 50, 32]],
  5: [[2, 64, 43]], 6: [[4, 43, 27]], 7: [[4, 49, 31]], 8: [[2, 60, 38], [2, 61, 39]],
  9: [[3, 58, 36], [2, 59, 37]], 10: [[4, 69, 43], [1, 70, 44]],
};
const QR_ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// Galois field tables for Reed–Solomon
const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];

// Builds the generator polynomial, highest degree first (monic), which is the
// order the division in rsEncode expects.
function rsGenerator(n) {
  let poly = [1];                       // ascending: poly[j] is the x^j term
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], GF_EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse();                // descending, so gen[0] === 1
}
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(data.length + ecLen).fill(0);
  data.forEach((d, i) => { res[i] = d; });
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 1; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

// Format information for error level M with a given mask
function qrFormatBits(mask) {
  const data = (0b00 << 3) | mask;            // 00 = level M
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function qrVersionBits(version) {
  if (version < 7) return null;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const QR_MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// Builds the module matrix for a string. Returns null if the text is too long.
export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(text));

  // pick the smallest version that fits
  let version = 0, blocks = null, totalData = 0;
  for (let v = 1; v <= 10; v++) {
    const spec = QR_EC_BLOCKS_M[v];
    const cap = spec.reduce((a, [n, total, dataLen]) => a + n * dataLen, 0);
    const lenBits = v < 10 ? 8 : 16;
    if (bytes.length + 2 + Math.ceil(lenBits / 8) <= cap) {
      version = v; blocks = spec; totalData = cap; break;
    }
  }
  if (!version) return null;

  const size = version * 4 + 17;
  const lenBits = version < 10 ? 8 : 16;

  // ---- bit stream ----
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);                 // byte mode
  push(bytes.length, lenBits);
  bytes.forEach((b) => push(b, 8));
  const capBits = totalData * 8;
  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (bits.length < capBits) { push(padBytes[pi++ % 2], 8); }

  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataBytes.push(b);
  }

  // ---- split into blocks, add error correction ----
  const dataBlocks = [], ecBlocks = [];
  let offset = 0;
  const ecLen = blocks[0][1] - blocks[0][2];
  blocks.forEach(([count, total, dLen]) => {
    for (let i = 0; i < count; i++) {
      const blk = dataBytes.slice(offset, offset + dLen);
      offset += dLen;
      dataBlocks.push(blk);
      ecBlocks.push(rsEncode(blk, total - dLen));
    }
  });

  // interleave
  const finalBytes = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++)
    dataBlocks.forEach((b) => { if (i < b.length) finalBytes.push(b[i]); });
  for (let i = 0; i < ecLen; i++)
    ecBlocks.forEach((b) => { if (i < b.length) finalBytes.push(b[i]); });

  // ---- lay out the matrix ----
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFinder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
        (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      m[rr][cc] = inRing ? 1 : 0;
      reserved[rr][cc] = true;
    }
  };
  setFinder(0, 0); setFinder(0, size - 7); setFinder(size - 7, 0);

  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0; reserved[6][i] = true;
    m[i][6] = i % 2 === 0 ? 1 : 0; reserved[i][6] = true;
  }

  // alignment patterns
  const aligns = QR_ALIGN[version];
  aligns.forEach((r) => aligns.forEach((c) => {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) return;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      m[r + dr][c + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
      reserved[r + dr][c + dc] = true;
    }
  }));

  // dark module + reserve format areas
  m[size - 8][8] = 1; reserved[size - 8][8] = true;
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) { reserved[8][i] = true; m[8][i] = 0; }
    if (!reserved[i][8]) { reserved[i][8] = true; m[i][8] = 0; }
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) { reserved[8][size - 1 - i] = true; m[8][size - 1 - i] = 0; }
    if (!reserved[size - 1 - i][8]) { reserved[size - 1 - i][8] = true; m[size - 1 - i][8] = 0; }
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      reserved[size - 11 + j][i] = true; m[size - 11 + j][i] = 0;
      reserved[i][size - 11 + j] = true; m[i][size - 11 + j] = 0;
    }
  }

  // ---- place data, zig-zag from bottom right ----
  let bitIdx = 0;
  const allBits = [];
  finalBytes.forEach((b) => { for (let i = 7; i >= 0; i--) allBits.push((b >>> i) & 1); });

  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                       // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row][cc]) continue;
        m[row][cc] = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
      }
    }
    up = !up;
  }

  // ---- masking: pick the lowest-penalty mask ----
  const penalty = (grid) => {
    let p = 0;
    // rule 1: runs of five or more
    for (let i = 0; i < size; i++) {
      let runR = 1, runC = 1;
      for (let j = 1; j < size; j++) {
        runR = grid[i][j] === grid[i][j - 1] ? runR + 1 : 1;
        if (runR === 5) p += 3; else if (runR > 5) p += 1;
        runC = grid[j][i] === grid[j - 1][i] ? runC + 1 : 1;
        if (runC === 5) p += 3; else if (runC > 5) p += 1;
      }
    }
    // rule 2: 2x2 blocks
    for (let i = 0; i < size - 1; i++) for (let j = 0; j < size - 1; j++) {
      const v = grid[i][j];
      if (v === grid[i][j + 1] && v === grid[i + 1][j] && v === grid[i + 1][j + 1]) p += 3;
    }
    // rule 4: balance of dark modules
    let dark = 0;
    grid.forEach((row) => row.forEach((v) => { if (v) dark++; }));
    p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return p;
  };

  let best = null, bestPenalty = Infinity, bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const g = m.map((row) => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      if (!reserved[r][c] && QR_MASKS[mask](r, c)) g[r][c] ^= 1;

    // write format bits for this mask
    const fmt = qrFormatBits(mask);
    for (let i = 0; i <= 5; i++) g[8][i] = (fmt >>> (14 - i)) & 1;
    g[8][7] = (fmt >>> 8) & 1; g[8][8] = (fmt >>> 7) & 1; g[7][8] = (fmt >>> 6) & 1;
    for (let i = 9; i <= 14; i++) g[14 - i][8] = (fmt >>> (14 - i)) & 1;
    for (let i = 0; i <= 7; i++) g[size - 1 - i][8] = (fmt >>> i) & 1;
    for (let i = 8; i <= 14; i++) g[8][size - 15 + i] = (fmt >>> i) & 1;
    g[size - 8][8] = 1;

    if (version >= 7) {
      const vb = qrVersionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (vb >>> i) & 1;
        g[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
        g[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }

    const pen = penalty(g);
    if (pen < bestPenalty) { bestPenalty = pen; best = g; bestMask = mask; }
  }

  return best;
}

// Renders a QR matrix as a scalable SVG path — crisp at any print size.
export function qrSvgPath(matrix) {
  let d = "";
  matrix.forEach((row, r) => row.forEach((v, c) => {
    if (v) d += `M${c} ${r}h1v1h-1z`;
  }));
  return d;
}
