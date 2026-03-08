/**
 * Pure TypeScript Reed-Solomon codec over GF(2^8).
 * Primitive polynomial: x^8 + x^4 + x^3 + x^2 + 1  (0x11d).
 *
 * Systematic encoding — output is [data_0 … data_{k-1}, parity_0 … parity_{p-1}].
 * Any k of the k+p chunks are sufficient to reconstruct the original data.
 *
 * Uses a Cauchy matrix for the parity section:
 *   cauchy(i, j) = 1 / (x[i] XOR y[j])
 *   where x[i] = i  (parity rows 0 … p-1)
 *         y[j] = p + j  (data columns 0 … k-1)
 *
 * All x[i] and y[j] are distinct non-zero field elements as long as k+p ≤ 128
 * (which covers every realistic chunking scenario).
 */

// ── GF(2^8) tables ────────────────────────────────────────────────────────────

const _exp = new Uint8Array(512);
const _log = new Uint8Array(256);

(function buildTables(): void {
  _exp[0] = 1;
  for (let i = 1; i < 255; i++) {
    let v = _exp[i - 1] << 1;
    if (v & 0x100) v ^= 0x11d;
    _exp[i] = v;
  }
  for (let i = 255; i < 512; i++) _exp[i] = _exp[i - 255];
  for (let i = 0; i < 255; i++) _log[_exp[i]] = i;
})();

function gfMul(a: number, b: number): number {
  return a !== 0 && b !== 0 ? _exp[_log[a] + _log[b]] : 0;
}

function gfInv(a: number): number {
  if (a === 0) throw new Error('GF inv(0)');
  return _exp[255 - _log[a]];
}

/** Cauchy matrix element for parity row i, data column j, p total parity rows. */
function cauchyElem(i: number, j: number, p: number): number {
  const denom = i ^ (p + j);
  if (denom === 0) throw new Error(`Cauchy denom=0 (i=${i}, j=${j}, p=${p})`);
  return gfInv(denom);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute p parity buffers from k data buffers.
 * All buffers must be the same byte length (pad the last data chunk to match).
 */
export function rsEncode(data: Buffer[], p: number): Buffer[] {
  if (p === 0) return [];
  const k = data.length;
  const len = data[0].length;

  const parity = Array.from({ length: p }, () => Buffer.alloc(len));

  for (let pi = 0; pi < p; pi++) {
    const dst = parity[pi];
    for (let j = 0; j < k; j++) {
      const c = cauchyElem(pi, j, p);
      const src = data[j];
      for (let b = 0; b < len; b++) {
        dst[b] ^= gfMul(c, src[b]);
      }
    }
  }

  return parity;
}

/**
 * Recover k original data buffers from a partial chunk set.
 *
 * @param chunks  Array of length k+p: data chunks first, then parity chunks.
 *                Set an entry to null if the corresponding chunk is unavailable.
 * @param k       Number of original data chunks.
 * @returns       Reconstructed data buffers [data_0 … data_{k-1}].
 */
export function rsDecode(chunks: Array<Buffer | null>, k: number): Buffer[] {
  const n = chunks.length;
  const p = n - k;

  // Collect the first k available chunks
  const available: { idx: number; buf: Buffer }[] = [];
  for (let i = 0; i < n && available.length < k; i++) {
    if (chunks[i] !== null) available.push({ idx: i, buf: chunks[i]! });
  }
  if (available.length < k) {
    throw new Error(`RS decode needs ${k} chunks, only ${available.length} available`);
  }

  const len = available[0].buf.length;

  // Build the k×k encoding sub-matrix for the selected chunk indices
  const mat: number[][] = available.map(({ idx }) => {
    const row: number[] = new Array(k);
    if (idx < k) {
      // Systematic data chunk → identity row
      for (let j = 0; j < k; j++) row[j] = idx === j ? 1 : 0;
    } else {
      // Parity chunk → Cauchy matrix row
      const pi = idx - k;
      for (let j = 0; j < k; j++) row[j] = cauchyElem(pi, j, p);
    }
    return row;
  });

  const invMat = invertMatrix(mat, k);

  // result[j] = XOR of invMat[j][i] * available[i]  for all i
  const result = Array.from({ length: k }, () => Buffer.alloc(len));
  for (let j = 0; j < k; j++) {
    const dst = result[j];
    for (let i = 0; i < k; i++) {
      const c = invMat[j][i];
      if (c === 0) continue;
      const src = available[i].buf;
      for (let b = 0; b < len; b++) {
        dst[b] ^= gfMul(c, src[b]);
      }
    }
  }

  return result;
}

// ── Matrix inversion over GF(256) ────────────────────────────────────────────

function invertMatrix(mat: number[][], k: number): number[][] {
  // Build augmented [mat | I_k]
  const aug: number[][] = mat.map((row, i) => {
    const id = new Array(k).fill(0);
    id[i] = 1;
    return [...row, ...id];
  });

  for (let col = 0; col < k; col++) {
    // Find pivot
    let pivot = -1;
    for (let row = col; row < k; row++) {
      if (aug[row][col] !== 0) { pivot = row; break; }
    }
    if (pivot < 0) throw new Error('RS matrix singular — insufficient independent chunks');
    if (pivot !== col) [aug[col], aug[pivot]] = [aug[pivot], aug[col]];

    // Scale pivot row so pivot element = 1
    const scale = gfInv(aug[col][col]);
    for (let j = 0; j < 2 * k; j++) aug[col][j] = gfMul(aug[col][j], scale);

    // Eliminate column in all other rows
    for (let row = 0; row < k; row++) {
      if (row === col || aug[row][col] === 0) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * k; j++) aug[row][j] ^= gfMul(factor, aug[col][j]);
    }
  }

  return aug.map(row => row.slice(k));
}
