"""
train.py — The only file you modify.
Contains the GPT model, optimizer, and training loop.
Runs for TIME_BUDGET seconds (30s on CPU), then prints metrics and exits.

Usage: python train.py
"""

import os
import time
import math
from dataclasses import dataclass, asdict

import torch
import torch.nn as nn
import torch.nn.functional as F

from prepare import (
    TIME_BUDGET, MAX_SEQ_LEN, VOCAB_SIZE,
    prepare_data, make_dataloader, evaluate_bpb,
)

# ─── Config ───────────────────────────────────────────────────────────────────

@dataclass
class GPTConfig:
    vocab_size:   int = VOCAB_SIZE
    sequence_len: int = 64        # per 0x703cc308 finding: batch=64+SDPA+seq=64
    n_layer:      int = 1
    n_head:       int = 4
    n_embd:       int = 128
    dropout:      float = 0.0

# ─── Model ────────────────────────────────────────────────────────────────────

class CausalSelfAttention(nn.Module):
    """SDPA (scaled_dot_product_attention) — per 0x703cc308 finding with batch=64."""
    def __init__(self, config: GPTConfig):
        super().__init__()
        assert config.n_embd % config.n_head == 0
        self.n_head  = config.n_head
        self.n_embd  = config.n_embd
        self.c_attn  = nn.Linear(config.n_embd, 3 * config.n_embd, bias=False)
        self.c_proj  = nn.Linear(config.n_embd, config.n_embd, bias=False)
        self.dropout = config.dropout

    def forward(self, x):
        B, T, C = x.size()
        q, k, v = self.c_attn(x).split(self.n_embd, dim=2)
        q = q.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        k = k.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        v = v.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)

        y = F.scaled_dot_product_attention(q, k, v, is_causal=True,
                                           dropout_p=self.dropout if self.training else 0.0)
        y = y.transpose(1, 2).contiguous().view(B, T, C)
        return self.c_proj(y)


class SwiGLU(nn.Module):
    """SwiGLU MLP — known to beat GELU for this task"""
    def __init__(self, config: GPTConfig):
        super().__init__()
        hidden = 4 * config.n_embd
        self.gate = nn.Linear(config.n_embd, hidden, bias=False)
        self.up   = nn.Linear(config.n_embd, hidden, bias=False)
        self.down = nn.Linear(hidden, config.n_embd, bias=False)

    def forward(self, x):
        return self.down(F.silu(self.gate(x)) * self.up(x))


class Block(nn.Module):
    """No LayerNorm — prior agents found it improves throughput & bpb at 1L"""
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.attn = CausalSelfAttention(config)
        self.mlp  = SwiGLU(config)

    def forward(self, x):
        x = x + self.attn(x)
        x = x + self.mlp(x)
        return x


class GPT(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.config = config
        self.transformer = nn.ModuleDict({
            'wte': nn.Embedding(config.vocab_size, config.n_embd),
            'wpe': nn.Embedding(config.sequence_len, config.n_embd),
            'drop': nn.Dropout(config.dropout),
            'h': nn.ModuleList([Block(config) for _ in range(config.n_layer)]),
        })
        self.lm_head = nn.Linear(config.n_embd, config.vocab_size, bias=False)
        # Weight tying
        self.transformer['wte'].weight = self.lm_head.weight

        # GPT-2 style init: big gain per prior agents
        self._init_weights()

    def _init_weights(self):
        for name, p in self.named_parameters():
            if 'wte' in name or ('weight' in name and 'proj' not in name and 'down' not in name):
                nn.init.normal_(p, mean=0.0, std=0.20)  # sweet spot: avg 2.305 over 16 runs
            elif 'proj' in name or 'down' in name:
                nn.init.normal_(p, mean=0.0, std=0.05)  # 1/4 of main std

    def forward(self, idx):
        B, T = idx.size()
        pos  = torch.arange(T, device=idx.device).unsqueeze(0)
        x    = self.transformer['wte'](idx) + self.transformer['wpe'](pos)
        x    = self.transformer['drop'](x)
        for block in self.transformer['h']:
            x = block(x)
        return self.lm_head(x)

    def num_params(self) -> int:
        return sum(p.numel() for p in self.parameters())

# ─── Training ────────────────────────────────────────────────────────────────

def train():
    # Use MPS (Apple Silicon GPU) if available for significant speedup
    if torch.cuda.is_available():
        device = "cuda"
    elif torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"
    config      = GPTConfig()
    batch_size  = 64      # MPS sweet spot per 0x703cc308: batch=64+SDPA
    lr          = 1.5e-2  # confirmed best lr

    # Data
    train_data, val_data = prepare_data()
    loader = make_dataloader(train_data, batch_size, config.sequence_len)

    # Model + optimizer
    model = GPT(config).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=lr,
        betas=(0.75, 0.95),
        weight_decay=0.2,
    )

    # Cosine LR schedule — calibrated to actual steps at batch=64/seq=64 (~1400 steps)
    # warmup=140 per 0xda61eb39 finding: improved 8-seed mean from 2.340 to 2.293
    def get_lr(step, warmup=140, total=1400):
        if step < warmup:
            return step / warmup
        progress = min((step - warmup) / (total - warmup), 1.0)
        return max(0.5 * (1 + math.cos(math.pi * progress)), 0.1)

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, get_lr)

    # Training loop (time-budgeted)
    model.train()
    total_loss     = 0.0
    num_steps      = 0
    total_tokens   = 0
    t_start        = time.perf_counter()
    train_start    = None

    for x, y in loader:
        # Start the budget clock on the first iteration (after compilation warmup)
        if train_start is None:
            train_start = time.perf_counter()

        x, y = x.to(device), y.to(device)
        logits = model(x)
        loss   = F.cross_entropy(logits.view(-1, config.vocab_size), y.view(-1))

        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        scheduler.step()

        total_loss   += loss.item()
        num_steps    += 1
        total_tokens += batch_size * config.sequence_len

        elapsed_train = time.perf_counter() - train_start
        if elapsed_train >= TIME_BUDGET:
            break

    training_seconds = time.perf_counter() - train_start if train_start else 0
    total_seconds    = time.perf_counter() - t_start

    # Evaluate
    val_bpb = evaluate_bpb(model, val_data, config.sequence_len, device)

    # Memory
    if device == "cuda":
        peak_vram_mb = torch.cuda.max_memory_allocated() / 1e6
    elif device == "mps":
        peak_vram_mb = torch.mps.current_allocated_memory() / 1e6
    else:
        import resource, sys
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # macOS returns bytes; Linux returns KB
        peak_vram_mb = rss / 1e6 if sys.platform == "darwin" else rss / 1e3

    # Print summary (same format as autoresearch, grep-friendly)
    print("---")
    print(f"val_bpb:          {val_bpb:.6f}")
    print(f"training_seconds: {training_seconds:.1f}")
    print(f"total_seconds:    {total_seconds:.1f}")
    print(f"peak_vram_mb:     {peak_vram_mb:.1f}")
    print(f"total_tokens_M:   {total_tokens / 1e6:.1f}")
    print(f"num_steps:        {num_steps}")
    print(f"num_params_M:     {model.num_params() / 1e6:.1f}")
    print(f"device:           {device}")
    print(f"n_layer:          {config.n_layer}")
    print(f"n_head:           {config.n_head}")
    print(f"n_embd:           {config.n_embd}")
    print(f"seq_len:          {config.sequence_len}")


if __name__ == "__main__":
    train()
