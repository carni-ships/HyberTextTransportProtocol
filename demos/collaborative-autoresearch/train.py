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
    sequence_len: int = MAX_SEQ_LEN
    n_layer:      int = 4
    n_head:       int = 4
    n_embd:       int = 128
    dropout:      float = 0.0

# ─── Model ────────────────────────────────────────────────────────────────────

class CausalSelfAttention(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        assert config.n_embd % config.n_head == 0
        self.n_head  = config.n_head
        self.n_embd  = config.n_embd
        self.c_attn  = nn.Linear(config.n_embd, 3 * config.n_embd, bias=False)
        self.c_proj  = nn.Linear(config.n_embd, config.n_embd, bias=False)
        self.dropout = config.dropout

        # Causal mask
        T = config.sequence_len
        self.register_buffer("mask", torch.tril(torch.ones(T, T)).view(1, 1, T, T))

    def forward(self, x):
        B, T, C = x.size()
        q, k, v = self.c_attn(x).split(self.n_embd, dim=2)
        q = q.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        k = k.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        v = v.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)

        att = (q @ k.transpose(-2, -1)) * (1.0 / math.sqrt(k.size(-1)))
        att = att.masked_fill(self.mask[:, :, :T, :T] == 0, float('-inf'))
        att = F.softmax(att, dim=-1)
        att = F.dropout(att, p=self.dropout, training=self.training)
        y   = att @ v
        y   = y.transpose(1, 2).contiguous().view(B, T, C)
        return self.c_proj(y)


class MLP(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.fc1  = nn.Linear(config.n_embd, 4 * config.n_embd, bias=False)
        self.fc2  = nn.Linear(4 * config.n_embd, config.n_embd, bias=False)
        self.drop = nn.Dropout(config.dropout)

    def forward(self, x):
        return self.fc2(self.drop(F.gelu(self.fc1(x))))


class Block(nn.Module):
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.ln1  = nn.LayerNorm(config.n_embd)
        self.attn = CausalSelfAttention(config)
        self.ln2  = nn.LayerNorm(config.n_embd)
        self.mlp  = MLP(config)

    def forward(self, x):
        x = x + self.attn(self.ln1(x))
        x = x + self.mlp(self.ln2(x))
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
            'ln_f': nn.LayerNorm(config.n_embd),
        })
        self.lm_head = nn.Linear(config.n_embd, config.vocab_size, bias=False)
        # Weight tying
        self.transformer['wte'].weight = self.lm_head.weight

    def forward(self, idx):
        B, T = idx.size()
        pos  = torch.arange(T, device=idx.device).unsqueeze(0)
        x    = self.transformer['wte'](idx) + self.transformer['wpe'](pos)
        x    = self.transformer['drop'](x)
        for block in self.transformer['h']:
            x = block(x)
        x    = self.transformer['ln_f'](x)
        return self.lm_head(x)

    def num_params(self) -> int:
        return sum(p.numel() for p in self.parameters())

# ─── Training ────────────────────────────────────────────────────────────────

def train():
    device      = "cuda" if torch.cuda.is_available() else "cpu"
    config      = GPTConfig()
    batch_size  = 8
    lr          = 3e-4

    # Data
    train_data, val_data = prepare_data()
    loader = make_dataloader(train_data, batch_size, config.sequence_len)

    # Model + optimizer
    model = GPT(config).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.1)

    # Optionally compile (PyTorch 2+, significant speedup even on CPU)
    try:
        model = torch.compile(model)
    except Exception:
        pass

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


if __name__ == "__main__":
    train()
