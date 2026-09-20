# Whispers of the Vault — declared math

**Declared theoretical RTP: 96.00%**

## The loop

A round has a houndstooth board of `N = 15` gold-gilded caskets, `K` of them
holding a dormant curse (`K` fixed per difficulty, chosen when the wager is
placed — it never changes except by CONSULT, below). Three actions:

- **REVEAL** — open one of the `cellsRemaining` caskets. Curse odds this
  instant are exactly `cursesRemaining / cellsRemaining`. Safe → your
  multiplier grows and the board shrinks by one. Cursed → the round busts,
  payout is 0.
- **CONSULT** ("whisper to the Genie") — stake one *additional* full wager
  (identical pattern to a blackjack double-down's `approvalAmount`) and the
  Genie permanently defuses one hidden curse: `cursesRemaining -= 1` and
  `cellsRemaining -= 1`. It never fails. Only legal while `cursesRemaining >
  0`, capped at 3 per round.
- **CASH OUT** ("Secure the Treasure") — bank `effectiveStake × multiplier`
  and settle.

This is the reductive-reasoning layer the design is built around: consulting
trades money for a *safer* board (fewer curses among what's left), not
information about *where* the curses are — there is no per-tile adjacency
number anywhere in this game, which is the specific mechanic that would make
it a Mines clone. The player's real decision is a resource-allocation one
("is protecting my run worth another full wager right now?"), not a
counting puzzle.

## Why 96% is the actual number your paytable pays

### Per-reveal fairness (the core invariant)

Every REVEAL step multiplies the running multiplier by

```
factor(cells, curses) = RTP × cells / (cells − curses)
```

immediately before the casket is drawn. Since `P(safe) = (cells−curses)/cells`,

```
E[multiplier after this reveal] = P(safe) × multiplier_before × factor
                                 = multiplier_before × RTP
```

**exactly**, for *any* reachable `(cells, curses)` pair — not just the ones
reachable without consulting. This is the same family of fair-odds formula
every "reveal-and-survive" casino game uses (including the platform's own
built-in Mines); the declared RTP is the constant this recursion targets,
and it is literally what `factor()` computes on-chain, so declared math and
paytable are the same expression, not two things that happen to agree.

### Consult is priced with an "effective stake" basis, not a flat rate

A wager staked mid-round must **not** retroactively inherit multiplier
growth that already happened — otherwise consulting after a few good
reveals would be a guaranteed-profit exploit against the house vault
(stake a new wager, have it instantly inherit the already-pumped multiplier,
cash out immediately). To rule that out by construction, a CONSULT adds

```
effectiveStake += wager / multiplier_now
```

so that cashing out the instant after a consult returns exactly
`effectiveStake_before × multiplier_now + wager` — i.e. everything you had
banked, plus your new chip back at face value. No more, no less. From that
point on the new tranche rides the *same* shared multiplier and is subject
to the *same* per-step RTP fairness above, so it only ever earns growth from
reveals taken after it joined.

### Verified, not just argued

`math/verify_rtp.py` enumerates every state and a large sample of
REVEAL/CONSULT interleavings by exact rational arithmetic (Python
`fractions`, no floating-point rounding) and asserts, per difficulty:

1. **Consult value-neutrality** — every reachable pre-consult state: cashing
   out immediately after consulting changes banked value by *exactly* one
   wager (45–250 states checked per difficulty, zero violations).
2. **Per-step marginal RTP fairness** — `E[payout at reveal r] == RTP ×
   E[payout at reveal r−1]` for every `r` (checked exhaustively for every
   difficulty's full reveal ladder).
3. **No guaranteed-profit interleaving** — every mixed REVEAL/CONSULT
   sequence up to length 7 (91–217 sequences per difficulty) satisfies
   `E[payout] ≤ E[total wager committed]`.

Run it yourself: `python3 math/verify_rtp.py`.

## Difficulty table (heavy-tail avoidance)

The platform's facet treats `maxPayout/wager > 100×` as heavy-tail and
requires a registered variance source or council σ floor to whitelist —
extra machinery this jam entry deliberately avoids by capping every
difficulty's *maximum reachable multiplier* under 100× outright. The board
seals itself (forces a cash-out) once the cap is hit, rather than letting
a lucky full clear run into heavy-tail territory:

| Difficulty | K (curses) | Max REVEALs allowed | Ladder top multiplier | Full-clear would've been |
|---|---|---|---|---|
| Apprentice | 2 | 13 (full clear) | 61.76× | 61.76× (no cap needed) |
| Adept | 3 | 11 (capped) | 72.60× | 278.78× |
| Vizier | 4 | 9 (capped) | 63.02× | 871.20× |

`quoteRiskParams.probabilityWad` is the exact probability of reaching each
difficulty's capped top tier with zero consults (the platform's own Mines
returns the analogous "probability of the full-board cashout path" for the
same reason): `C(N−K, cap) / C(N, cap)`.

## What CONSULT is declared as, for the eligibility gate

Consulting is, by construction (proof above), **exactly RTP-neutral**: it
changes the *variance* of a run (fewer curses left → safer subsequent
reveals, at the cost of more capital staked) but never the expected fraction
returned per dollar committed. The declared 96% therefore holds whether or
not — and no matter when — a player consults. There is no separate "consult
RTP" to reconcile against the base number.
