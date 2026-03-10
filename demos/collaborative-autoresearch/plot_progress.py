"""
plot_progress.py — Generate a Karpathy-style progress chart for the
collaborative autoresearch experiment.

Usage:
    python3 plot_progress.py            # saves progress.png
    python3 plot_progress.py --show     # also opens the window
"""

import os
import sys
import glob
import argparse
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

# ── Locate all results.tsv files ─────────────────────────────────────────────

REPO_ROOT = Path(__file__).parent.parent.parent  # HyberText/
DEMO_DIR  = Path(__file__).parent

WORKTREE_ROOTS = [
    REPO_ROOT / '.claude' / 'worktrees',
    REPO_ROOT / '.claude' / 'worktrees' / 'agent-a2c7fedc' / '.claude' / 'worktrees',
    REPO_ROOT / '.claude' / 'worktrees' / 'agent-ad5fc278' / '.claude' / 'worktrees',
]

# Agent tag → short display name (populated from branch name if available)
TAG_MAP = {
    'mar9-a': 'A (architecture)',
    'mar9-b': 'B (optimizer)',
    'mar9-c': 'C (seq_len)',
    'mar9-d': 'D (betas)',
    'mar9-e': 'E (init)',
    'mar9-f': 'F (clipping)',
    'mar9-g': 'G (attention)',
    'mar9-h': 'H (MLP)',
    'mar9-i': 'I (embedding)',
    'mar9-j': 'J (optimizers)',
    'mar9-k': 'K (synthesis)',
    'mar9-l': 'L (data)',
}

# Color palette (one per agent)
COLORS = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
    '#aec7e8', '#ffbb78',
]

# ── Load data ────────────────────────────────────────────────────────────────

def load_results():
    """Return list of (tag, experiments) where experiments is list of dicts."""
    agents = {}

    for root in WORKTREE_ROOTS:
        if not root.exists():
            continue
        for tsv_path in sorted(root.glob('*/demos/collaborative-autoresearch/results.tsv')):
            # Detect branch/tag from git
            wt_dir = tsv_path.parent.parent.parent
            tag = None
            try:
                import subprocess
                branch = subprocess.check_output(
                    ['git', 'branch', '--show-current'], cwd=wt_dir, text=True,
                    stderr=subprocess.DEVNULL
                ).strip()
                if 'autoresearch/' in branch:
                    tag = branch.split('autoresearch/')[-1]
            except Exception:
                pass
            if tag is None:
                tag = wt_dir.name  # fallback to worktree dir name

            rows = []
            with open(tsv_path) as f:
                for i, line in enumerate(f):
                    line = line.strip()
                    if not line or line.startswith('commit'):
                        continue
                    parts = line.split('\t')
                    if len(parts) < 4:
                        continue
                    try:
                        commit      = parts[0]
                        val_bpb     = float(parts[1])
                        memory_mb   = float(parts[2]) if parts[2] else 0.0
                        raw_status  = parts[3].lower().strip()
                        if raw_status in ('keep', 'kept', 'improved', 'improvement', 'best'):
                            status = 'keep'
                        elif raw_status in ('discard', 'discarded', 'revert', 'reverted', 'rejected', 'worse'):
                            status = 'discard'
                        elif raw_status in ('crash', 'error', 'failed'):
                            status = 'crash'
                        else:
                            status = raw_status
                        description = parts[4] if len(parts) > 4 else ''
                        rows.append({
                            'commit': commit, 'val_bpb': val_bpb,
                            'memory_mb': memory_mb, 'status': status,
                            'description': description, 'exp_idx': i,
                        })
                    except ValueError:
                        continue
            if rows:
                agents[tag] = rows

    return agents


# ── Build global best timeline ───────────────────────────────────────────────

def global_best_timeline(agents):
    """
    Return (x_steps, y_bpb, annotations) for the global running best,
    treating kept experiments across all agents as a single pool.
    We assign each kept experiment a global step index in the order
    they would appear if agents ran sequentially (sorted by val_bpb improvement).
    For parallel runs we just concatenate in alphabetical agent order.
    """
    all_kept = []
    global_step = 0
    for tag in sorted(agents.keys()):
        for row in agents[tag]:
            global_step += 1
            row['global_step'] = global_step
            if row['status'] == 'keep':
                all_kept.append((global_step, row['val_bpb'], row['description'], tag))

    if not all_kept:
        return [], [], []

    xs, ys, annots = [], [], []
    best = float('inf')
    for step, bpb, desc, tag in all_kept:
        if bpb < best:
            best = bpb
            xs.append(step)
            ys.append(bpb)
            annots.append((step, bpb, f'[{tag}] {desc[:50]}'))

    return xs, ys, annots


# ── Plot ─────────────────────────────────────────────────────────────────────

def make_chart(agents, output_path='progress.png', show=False):
    if not agents:
        print('No results.tsv data found.')
        return

    total_experiments = sum(len(rows) for rows in agents.values())
    total_kept        = sum(sum(1 for r in rows if r['status'] == 'keep') for rows in agents.values())
    baseline_bpb      = max(r['val_bpb'] for rows in agents.values() for r in rows)
    best_bpb          = min(r['val_bpb'] for rows in agents.values() for r in rows)

    fig, (ax_main, ax_agents) = plt.subplots(
        2, 1, figsize=(14, 10),
        gridspec_kw={'height_ratios': [3, 2]},
    )
    fig.patch.set_facecolor('white')

    # ── Top panel: global frontier ──────────────────────────────────────────

    ax_main.set_facecolor('#fafafa')
    ax_main.grid(True, linestyle='--', alpha=0.4, color='#cccccc')

    # All experiments as scatter (gray=discard, colored=keep per agent)
    color_map = {tag: COLORS[i % len(COLORS)] for i, tag in enumerate(sorted(agents.keys()))}
    global_step = 0
    for tag in sorted(agents.keys()):
        for row in agents[tag]:
            global_step += 1
            row['global_step'] = global_step
            if row['status'] in ('discard', 'crash'):
                ax_main.scatter(global_step, row['val_bpb'], color='#cccccc', s=18, zorder=2, alpha=0.7)
            elif row['status'] == 'keep':
                ax_main.scatter(global_step, row['val_bpb'], color=color_map[tag], s=40, zorder=3)

    # Global running best as step line
    gx, gy, gannots = global_best_timeline(agents)
    if gx:
        # Draw step line from start
        sx = [1] + [x for x in gx for _ in range(2)]
        sy = [gy[0]] + [y for y in gy for _ in range(2)]
        # Shift to make proper steps
        step_x = [1]
        step_y = [gy[0]]
        for i in range(len(gx)):
            step_x.extend([gx[i], gx[i]])
            step_y.extend([step_y[-1], gy[i]])
        ax_main.plot(step_x, step_y, color='#2ca02c', linewidth=2.5, zorder=4, label='Running best')
        ax_main.scatter(gx, gy, color='#2ca02c', s=80, zorder=5)

        # Annotate improvements (skip if too close)
        last_x = -999
        for x, y, desc in gannots:
            if x - last_x > total_experiments * 0.05:
                ax_main.annotate(
                    desc, xy=(x, y),
                    xytext=(x + total_experiments * 0.01, y + (baseline_bpb - best_bpb) * 0.03),
                    fontsize=6.5, color='#1a5276',
                    arrowprops=dict(arrowstyle='->', color='#aaaaaa', lw=0.8),
                    ha='left', va='bottom',
                )
                last_x = x

    ax_main.set_xlabel('Experiment # (all agents combined, sequential order)', fontsize=11)
    ax_main.set_ylabel('val_bpb  (lower is better)', fontsize=11)
    ax_main.set_title(
        f'HyberResearch Collaborative Autoresearch Progress\n'
        f'{total_experiments} experiments across {len(agents)} parallel agents · '
        f'{total_kept} improvements kept · '
        f'Baseline {baseline_bpb:.3f} → Best {best_bpb:.4f} '
        f'({(1 - best_bpb / baseline_bpb) * 100:.1f}% improvement)',
        fontsize=12, pad=12,
    )

    # Legend: discard + per-agent colors
    legend_handles = [
        mpatches.Patch(color='#cccccc', label='Discarded'),
        plt.Line2D([0], [0], color='#2ca02c', linewidth=2.5, label='Global best'),
    ]
    for tag in sorted(agents.keys()):
        display = TAG_MAP.get(tag, tag)
        legend_handles.append(mpatches.Patch(color=color_map[tag], label=display))
    ax_main.legend(handles=legend_handles, fontsize=8, loc='upper right', ncol=2,
                   framealpha=0.9, edgecolor='#cccccc')

    # ── Bottom panel: per-agent trajectories ────────────────────────────────

    ax_agents.set_facecolor('#fafafa')
    ax_agents.grid(True, linestyle='--', alpha=0.4, color='#cccccc')

    for tag in sorted(agents.keys()):
        rows   = agents[tag]
        color  = color_map[tag]
        xs_all = [r['exp_idx'] for r in rows]
        ys_all = [r['val_bpb'] for r in rows]

        # Discarded as small gray dots
        xd = [r['exp_idx'] for r in rows if r['status'] != 'keep']
        yd = [r['val_bpb'] for r in rows if r['status'] != 'keep']
        ax_agents.scatter(xd, yd, color='#dddddd', s=12, zorder=2)

        # Kept as colored dots
        xk = [r['exp_idx'] for r in rows if r['status'] == 'keep']
        yk = [r['val_bpb'] for r in rows if r['status'] == 'keep']
        ax_agents.scatter(xk, yk, color=color, s=30, zorder=3)

        # Running best per agent
        best_so_far = float('inf')
        bx, by = [], []
        for r in rows:
            if r['status'] == 'keep' and r['val_bpb'] < best_so_far:
                best_so_far = r['val_bpb']
            bx.append(r['exp_idx'])
            by.append(best_so_far if best_so_far < float('inf') else r['val_bpb'])

        ax_agents.step(bx, by, where='post', color=color, linewidth=1.5, alpha=0.85,
                       label=f'{TAG_MAP.get(tag, tag)}: {min(yk):.3f}' if yk else tag)

    ax_agents.set_xlabel('Experiment # (within each agent)', fontsize=10)
    ax_agents.set_ylabel('val_bpb', fontsize=10)
    ax_agents.set_title("Per-Agent Progress (each agent's own trajectory)", fontsize=10)
    ax_agents.legend(fontsize=7.5, loc='upper right', ncol=3, framealpha=0.9, edgecolor='#cccccc')

    plt.tight_layout(pad=2.0)
    out = Path(output_path)
    plt.savefig(out, dpi=150, bbox_inches='tight', facecolor='white')
    print(f'Saved: {out.resolve()}')
    if show:
        plt.show()


# ── Main ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--show',   action='store_true', help='Open chart window')
    parser.add_argument('--output', default=str(DEMO_DIR / 'progress.png'))
    args = parser.parse_args()

    agents = load_results()
    print(f'Found {len(agents)} agents: {sorted(agents.keys())}')
    for tag, rows in sorted(agents.items()):
        kept = sum(1 for r in rows if r['status'] == 'keep')
        best = min((r['val_bpb'] for r in rows), default=float('nan'))
        print(f'  {tag:12s}  {len(rows):3d} experiments  {kept:2d} kept  best={best:.4f}')

    make_chart(agents, output_path=args.output, show=args.show)
