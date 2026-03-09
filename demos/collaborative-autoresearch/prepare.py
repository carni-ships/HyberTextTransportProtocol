"""
prepare.py — Fixed constants and data preparation.
Do NOT modify. Contains the evaluation harness and dataset.

CPU-friendly version: trains a tiny character-level GPT on Shakespeare.
Time budget: 30 seconds (vs 5 minutes in the H100 version).
"""

import os
import time
import math
import struct
import hashlib
import urllib.request
from pathlib import Path

# ─── Fixed constants (do not change) ─────────────────────────────────────────

TIME_BUDGET       = 30        # seconds of training (wall clock, excl. startup)
MAX_SEQ_LEN       = 256       # context length
VOCAB_SIZE        = 65        # character-level: printable ASCII
EVAL_TOKENS       = 65_536    # tokens used for val_bpb evaluation
CACHE_DIR         = Path(os.environ.get("CACHE_DIR", "~/.cache/collab-autoresearch")).expanduser()

# ─── Dataset ──────────────────────────────────────────────────────────────────

SHAKESPEARE_URL = "https://raw.githubusercontent.com/karpathy/char-rnn/master/data/tinyshakespeare/input.txt"

def prepare_data() -> tuple[bytes, bytes]:
    """Download and split Shakespeare into train/val byte sequences."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / "shakespeare.txt"
    if not path.exists():
        print("Downloading Shakespeare...", flush=True)
        urllib.request.urlretrieve(SHAKESPEARE_URL, path)
        print("Done.", flush=True)
    text  = path.read_text(encoding="utf-8")
    # Character-level encode to 0–64
    chars = sorted(set(text))
    stoi  = {c: i for i, c in enumerate(chars)}
    data  = bytes(stoi[c] for c in text)
    split = int(0.9 * len(data))
    return data[:split], data[split:]

# ─── Dataloader ───────────────────────────────────────────────────────────────

import torch

def make_dataloader(data: bytes, batch_size: int, seq_len: int):
    """Infinite dataloader yielding (x, y) tensor pairs."""
    import random
    buf = torch.tensor(list(data), dtype=torch.long)
    n   = len(buf)
    while True:
        starts = torch.randint(0, n - seq_len - 1, (batch_size,))
        x = torch.stack([buf[s : s + seq_len]     for s in starts])
        y = torch.stack([buf[s + 1 : s + seq_len + 1] for s in starts])
        yield x, y

# ─── Evaluation ───────────────────────────────────────────────────────────────

def evaluate_bpb(model, val_data: bytes, seq_len: int, device: str = "cpu") -> float:
    """
    Evaluate bits-per-byte on the validation set.
    This is the ground-truth metric. Do not modify.
    """
    import math
    model.eval()
    with torch.no_grad():
        buf      = torch.tensor(list(val_data), dtype=torch.long).to(device)
        total_loss = 0.0
        total_tok  = 0
        i = 0
        while i + seq_len + 1 < len(buf) and total_tok < EVAL_TOKENS:
            x = buf[i : i + seq_len].unsqueeze(0)
            y = buf[i + 1 : i + seq_len + 1].unsqueeze(0)
            logits = model(x)
            import torch.nn.functional as F
            loss    = F.cross_entropy(logits.view(-1, logits.size(-1)), y.view(-1))
            total_loss += loss.item() * seq_len
            total_tok  += seq_len
            i += seq_len
    model.train()
    # bits-per-byte = nats-per-token / log(2)  (char-level so token = byte)
    return (total_loss / total_tok) / math.log(2)
