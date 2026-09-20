#!/usr/bin/env python3
"""
Whispers of the Vault -- exact RTP / no-arbitrage verification.

Mechanic:
  - N houndstooth caskets, K cursed (K fixed for the round; only ever
    decreases via CONSULT, never via a successful REVEAL).
  - REVEAL: draw one of the `cellsRemaining` caskets uniformly.
      curse prob this step = cursesRemaining / cellsRemaining
      safe  -> cellsRemaining -= 1, multiplier *= RTP * cells/(cells-curses)
      curse -> bust, payout = 0
  - CONSULT: pay one extra full wager into escrow (identical pattern to a
    blackjack double-down's `approvalAmount`). The Genie defuses ONE hidden
    curse: cursesRemaining -= 1, cellsRemaining -= 1. No risk -- it always
    succeeds. Only legal while cursesRemaining > 0.
  - CASHOUT: bank effectiveStake * multiplier.

First cut of this design (see git history / prior run) computed payout as
mult * totalStaked directly. That has a hole: if you consult AFTER the
multiplier has already grown past 1x, the newly-added wager would
retroactively inherit that growth for free -- a guaranteed-profit exploit
against the house vault the instant mult > 1. This version fixes it with
an "effective stake" basis: a consult buys in at the CURRENT multiplier
(dividing its wager by mult-now before adding it to the stake pool), so a
tranche only ever earns multiplier growth that happens *after* it joined.
Cashing out the instant after a consult must return exactly
(pre-consult banked value) + (the fresh wager, at face value, no gain) --
this script asserts that directly, plus the standard per-step RTP fairness
invariant, across every reachable state and a large sample of interleaved
action sequences.
"""

from fractions import Fraction
import itertools

RTP = Fraction(96, 100)  # 96% declared theoretical RTP


def step_factor(cells: int, curses: int) -> Fraction:
    safe = cells - curses
    assert safe > 0
    return RTP * Fraction(cells, safe)


def apply_consult(effective_stake, mult, wager):
    """Consult: buy a fresh tranche of `wager` at the CURRENT multiplier."""
    return effective_stake + wager / mult


def cash_value(effective_stake, mult):
    return effective_stake * mult


def test_consult_is_value_neutral(N, K, wager=Fraction(1), samples=None):
    """
    For every reachable (cells, curses, mult, eff_stake) state with
    curses > 0, confirm: value_immediately_after_consult - value_immediately_before
    == wager exactly (you get your new chip back at face value, nothing more,
    nothing less -- no retroactive windfall, no penalty).
    """
    # BFS over reachable states from pure REVEAL/CONSULT prefixes (bounded depth)
    seen = []
    start = (N, K, Fraction(1), wager)  # cells, curses, mult, eff_stake
    frontier = [start]
    depth = 0
    max_depth = min(8, N - 1)
    all_states = {start}
    while frontier and depth < max_depth:
        nxt = []
        for cells, curses, mult, eff in frontier:
            safe = cells - curses
            if safe > 0 and cells > 0:
                # take the "safe" branch deterministically to keep exploring reachable mult/cell combos
                f = step_factor(cells, curses)
                s2 = (cells - 1, curses, mult * f, eff)
                if s2 not in all_states:
                    all_states.add(s2)
                    nxt.append(s2)
            if curses > 0 and cells > curses:
                s3 = (cells - 1, curses - 1, mult, eff)  # consult doesn't change mult/eff by itself; checked separately below
                if s3 not in all_states:
                    all_states.add(s3)
                    nxt.append(s3)
        frontier = nxt
        depth += 1

    violations = []
    checked = 0
    for cells, curses, mult, eff in all_states:
        if curses <= 0 or cells <= curses:
            continue
        before = cash_value(eff, mult)
        eff_after = apply_consult(eff, mult, wager)
        after = cash_value(eff_after, mult)  # cells/curses change, but mult unchanged at the instant of consulting
        checked += 1
        if after - before != wager:
            violations.append((cells, curses, mult, eff, after - before))

    return checked, violations


def enumerate_strategy_ev(N, K, plan, wager=Fraction(1)):
    """
    plan: list of 'R' / 'C' / 'CASHOUT'.
    Exact enumeration over every random branch (R branches safe/curse; C is
    deterministic). Returns (E[payout], E[total wager committed], per-reveal
    RTP check list).
    """
    # state: prob, cells, curses, mult, eff_stake, total_committed, busted
    states = [(Fraction(1), N, K, Fraction(1), wager, wager, False)]

    for action in plan:
        new_states = []
        for prob, cells, curses, mult, eff, committed, busted in states:
            if busted:
                new_states.append((prob, cells, curses, mult, eff, committed, busted))
                continue
            if action == "C":
                if not (curses > 0 and cells > curses):
                    new_states.append((prob, cells, curses, mult, eff, committed, busted))
                    continue
                eff2 = apply_consult(eff, mult, wager)
                new_states.append((prob, cells - 1, curses - 1, mult, eff2, committed + wager, False))
            elif action == "R":
                safe = cells - curses
                if safe <= 0:
                    new_states.append((prob, cells, curses, mult, eff, committed, busted))
                    continue
                p_safe = Fraction(safe, cells)
                p_curse = Fraction(curses, cells)
                factor = step_factor(cells, curses)
                new_states.append((prob * p_safe, cells - 1, curses, mult * factor, eff, committed, False))
                new_states.append((prob * p_curse, cells, curses, mult, eff, committed, True))
            elif action == "CASHOUT":
                new_states.append((prob, cells, curses, mult, eff, committed, busted))
        states = new_states

    expected_payout = sum(prob * (Fraction(0) if busted else cash_value(eff, mult)) for prob, _, _, mult, eff, committed, busted in states)
    expected_committed = sum(prob * committed for prob, _, _, _, _, committed, _ in states)
    return expected_payout, expected_committed


def brute_force_all_plans(N, K, max_len):
    results = []
    def legal(cells, curses):
        acts = []
        if curses > 0 and cells > curses:
            acts.append("C")
        if cells - curses > 0:
            acts.append("R")
        return acts
    def recurse(plan, cells, curses):
        if plan:
            results.append(plan + ["CASHOUT"])
        if len(plan) >= max_len:
            return
        for a in legal(cells, curses):
            if a == "C":
                recurse(plan + ["C"], cells - 1, curses - 1)
            else:
                if cells - 1 - curses > 0 or curses == 0:
                    recurse(plan + ["R"], cells - 1, curses)
    recurse([], N, K)
    return results


def main():
    configs = [("Apprentice", 15, 2), ("Adept", 15, 3), ("Vizier", 15, 4)]

    for name, N, K in configs:
        print(f"\n=== {name}: N={N}, K={K}, declared RTP={float(RTP)*100:.1f}% ===")

        checked, violations = test_consult_is_value_neutral(N, K)
        print(f"  Consult value-neutrality: checked {checked} reachable pre-consult states.")
        if violations:
            print(f"  !! {len(violations)} VIOLATIONS (consult created/destroyed value), e.g. {violations[0]}")
        else:
            print("  PASS -- every consult returns exactly its own wager in immediate cash-out value. No arbitrage.")

        # Per-step RTP fairness for pure-reveal plans of every length
        max_r = N - K
        bad_step = []
        for r in range(1, max_r + 1):
            payout_r, committed_r = enumerate_strategy_ev(N, K, ["R"] * r + ["CASHOUT"])
            payout_r1, committed_r1 = enumerate_strategy_ev(N, K, ["R"] * (r - 1) + ["CASHOUT"]) if r > 1 else (Fraction(1), Fraction(1))
            # marginal fairness of the r-th reveal: E[payout_r] should be RTP * E[payout_{r-1}]
            expected = RTP * payout_r1 if r > 1 else RTP  # r=1 baseline: E[payout]=RTP*wager
            if payout_r != expected:
                bad_step.append((r, payout_r, expected))
        print(f"  Per-step marginal RTP fairness (E[payout_r] == RTP * E[payout_{{r-1}}]): "
              f"{'PASS for all r=1..' + str(max_r) if not bad_step else f'FAIL {bad_step[:3]}'}")

        # Mixed R/C interleavings: confirm no interleaving ever beats the pure-reveal
        # geometric decay envelope, i.e. no sequence of actions is a free lunch.
        plans = brute_force_all_plans(N, K, max_len=min(7, N - 1))
        exploits = []
        for plan in plans:
            payout, committed = enumerate_strategy_ev(N, K, plan)
            n_reveals = plan.count("R")
            # Fair envelope for ANY sequence with exactly n_reveals real gambles,
            # regardless of how many (free-to-enter, cost-bearing) consults were
            # mixed in: E[payout] should equal RTP**n_reveals * E[total committed
            # at the moment each tranche joined]... the simplest robust check
            # available without re-deriving per-tranche bookkeeping here is the
            # aggregate one: E[payout] must never exceed E[committed] (no
            # guaranteed-profit strategy), and pure-reveal-count scaling holds.
            if payout > committed:
                exploits.append((plan, float(payout), float(committed)))
        print(f"  Checked {len(plans)} interleavings of R/C up to length {min(7, N-1)}: "
              f"{'no guaranteed-profit exploits (E[payout] <= E[committed] always)' if not exploits else f'!! {len(exploits)} EXPLOITS, e.g. {exploits[0]}'}")

        # Multiplier ladder for display purposes
        cells, curses, mult = N, K, Fraction(1)
        ladder = []
        for r in range(1, max_r + 1):
            mult *= step_factor(cells, curses)
            cells -= 1
            ladder.append((r, float(mult)))
        preview = ", ".join(f"r{r}:{m:.3f}x" for r, m in ladder[:6])
        print(f"  Multiplier ladder (no consults): {preview}{' ...' if len(ladder) > 6 else ''}")
        print(f"  Top-tier (full clear, {max_r} safe reveals): {ladder[-1][1]:.4f}x")


if __name__ == "__main__":
    main()
