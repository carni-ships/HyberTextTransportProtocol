/**
 * GF(256) Reed-Solomon decoder for the Node.js resolver.
 * See packages/cli/src/rs.ts for the full annotated implementation.
 */

const _exp = new Uint8Array(512);
const _log = new Uint8Array(256);
(function () {
  _exp[0] = 1;
  for (let i = 1; i < 255; i++) {
    let v = _exp[i - 1] << 1;
    if (v & 0x100) v ^= 0x11d;
    _exp[i] = v;
  }
  for (let i = 255; i < 512; i++) _exp[i] = _exp[i - 255];
  for (let i = 0; i < 255; i++) _log[_exp[i]] = i;
})();

const gfMul = (a: number, b: number) => (a && b ? _exp[_log[a] + _log[b]] : 0);
const gfInv = (a: number) => { if (!a) throw new Error('GF inv(0)'); return _exp[255 - _log[a]]; };
const cauchy = (i: number, j: number, p: number) => { const d = i ^ (p + j); if (!d) throw new Error('cauchy denom=0'); return gfInv(d); };

function invertMatrix(mat: number[][], k: number): number[][] {
  const aug = mat.map((row, i) => { const id = Array(k).fill(0); id[i] = 1; return [...row, ...id]; });
  for (let col = 0; col < k; col++) {
    let pivot = -1;
    for (let row = col; row < k; row++) { if (aug[row][col]) { pivot = row; break; } }
    if (pivot < 0) throw new Error('RS matrix singular');
    if (pivot !== col) [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
    const scale = gfInv(aug[col][col]);
    for (let j = 0; j < 2 * k; j++) aug[col][j] = gfMul(aug[col][j], scale);
    for (let row = 0; row < k; row++) {
      if (row === col || !aug[row][col]) continue;
      const f = aug[row][col];
      for (let j = 0; j < 2 * k; j++) aug[row][j] ^= gfMul(f, aug[col][j]);
    }
  }
  return aug.map(r => r.slice(k));
}

export function rsDecodeBuffers(chunks: Array<Buffer | null>, k: number): Buffer[] {
  const n = chunks.length;
  const p = n - k;
  const avail: { idx: number; buf: Buffer }[] = [];
  for (let i = 0; i < n && avail.length < k; i++) {
    if (chunks[i] !== null) avail.push({ idx: i, buf: chunks[i]! });
  }
  if (avail.length < k) throw new Error(`Need ${k} chunks, got ${avail.length}`);
  const len = avail[0].buf.length;
  const mat = avail.map(({ idx }) => {
    const row = new Array(k);
    if (idx < k) { for (let j = 0; j < k; j++) row[j] = idx === j ? 1 : 0; }
    else { const pi = idx - k; for (let j = 0; j < k; j++) row[j] = cauchy(pi, j, p); }
    return row;
  });
  const inv = invertMatrix(mat, k);
  const result = Array.from({ length: k }, () => Buffer.alloc(len));
  for (let j = 0; j < k; j++) {
    const dst = result[j];
    for (let i = 0; i < k; i++) {
      const c = inv[j][i]; if (!c) continue;
      const src = avail[i].buf;
      for (let b = 0; b < len; b++) dst[b] ^= gfMul(c, src[b]);
    }
  }
  return result;
}
