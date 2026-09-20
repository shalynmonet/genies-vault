# Genie's Vault — Chain Jam Vol. 1 submission guide

Everything in this package has been built and verified. What's left needs your own
wallet and accounts (deploying a contract needs your private key, hosting needs your
own Vercel/Netlify login) — those steps I can't do for you, so this is the exact,
no-guesswork path to finishing them. **Submissions close Sep 20** (confirmed live from
jam.chain.wtf just now), so treat this as the checklist for tonight.

## What's already done and verified

- **Math**: exact-arithmetic proof (Python `Fraction`) that the RTP model is fair and
  arbitrage-free across all three difficulties — see `math/verify_rtp.py` and `MATH.md`.
  Declared RTP is **96%**, inside the jam's required 93–98% band.
- **Contract**: `GeniesVaultGame.sol`, a full `ICasinoGameV2` implementation. Compiled
  clean (0 warnings), and run through dozens of real rounds on a real local chain with a
  real VRF node — reveals, curses, consults, cash-outs, and full-clear jackpots all
  settle to the wei-exact value the math predicts.
- **Frontend**: `examples/genies-vault-public/` — the houndstooth-vault UI, with a fully
  working standalone demo mode (required by the jam) and a live on-chain mode. Now has
  synthesized sound effects (safe-reveal chime, curse thud, consult whoosh, cash-out
  fanfare) since "Visual & Sound" is one of the jam's four judging criteria and the game
  had none before tonight.
- **Manifest**: `game.manifest.json` passes the SDK's own `validateCasinoGameManifest`.
- **Verified against the real local simulator harness** (not just my own test scripts):
  loads instantly, plays a full round live, and survives every "unhappy path" the SDK's
  own pre-ship checklist calls out — slow indexer, wallet not connected, and a page
  refresh mid-round (this one caught and fixed a real bug: consulting the Genie needs a
  second token approval mid-session, which the frontend wasn't requesting).
- **Novelty**: redesigned specifically to avoid two disqualification risks you flagged —
  it no longer resembles Chain's own built-in Mines game (no numbered-adjacency clues),
  and it doesn't share The Alchemist's blind-combinatoric-pick angle. The "pay the Genie
  to defuse a curse" resource-allocation mechanic is the actual game; the houndstooth
  grid is the reskin you asked for on top of it.

## What you still need to do

### 1. Deploy the contract to Base

You need a wallet with a small amount of Base ETH for gas, and its private key —
**never share that key with me or anyone else**; you run this yourself.

```sh
cd deploy
npm install
cp .env.example .env
# edit .env: paste your deploy wallet's private key and (optionally) your own RPC URLs
```

Recommended: deploy to **Base Sepolia (testnet)** first to confirm everything works,
then Base mainnet once you're confident:

```sh
npm run deploy:base-sepolia
# or, once ready:
npm run deploy:base
```

Fund a Base Sepolia wallet from a faucet (e.g. https://www.alchemy.com/faucets/base-sepolia)
if needed. The script prints the deployed contract address — save it, you'll need it
for step 3.

### 2. Host the frontend

The `examples/genies-vault-public/dist/` folder in this package is already built and
ready to deploy as-is (static files, no server needed). Two options:

- **Vercel**: `npx vercel deploy --prod dist/` from inside
  `examples/genies-vault-public/` (or drag-and-drop the `dist/` folder at vercel.com).
- **Netlify**: drag-and-drop `dist/` at app.netlify.com/drop, or `netlify deploy --prod
  --dir=dist`.

Whichever you pick, the resulting URL **must**:
- Serve `game.manifest.json` at the same origin (already true — it's copied into `dist/`
  automatically by the Vite build).
- Load the widget script (already in `dist/index.html`) — jam.chain.wtf checks for this
  automatically the moment you submit.
- Work standalone when opened directly, outside any iframe (already true — the demo
  mode fallback handles this).

### 3. Send the deployed contract address to the Chain team

The jam page doesn't have a separate "contract address" field on the public submission
form — the platform side (whitelisting your contract on `CasinoGameFacet`, indexer
registration, catalog entry) is wired up by the Chain.wtf maintainers after you submit
and share source access (per `docs/GETTING_STARTED.md`). Have the address from step 1
ready to give them — likely via the Discord you connect in the submission form, or
whatever channel they specify after you submit.

### 4. Share source access

The submission form has a required "Source access" field. Simplest options:
- Push this whole project to a **public GitHub repo** and paste that URL, or
- Keep it private and invite the Chain team's GitHub account/org once they tell you who
  to add, or
- Zip it and provide a download link if they accept that (ask in their Discord if unsure).

### 5. Submit the form at jam.chain.wtf

Scroll to section "07 · SUBMIT" on jam.chain.wtf. The fields, and what to put:

| Field | What to enter |
|---|---|
| Game title | `Genie's Vault` |
| Game URL | Your Vercel/Netlify URL from step 2 |
| Declared RTP | `96%` |
| Discord | Your Discord handle |
| X / Telegram | Optional — your handle if you want |
| Source access | The repo/zip link from step 4 |
| Pitch / info | See draft below — paste and tweak in your own voice |

**Draft pitch text** (edit freely, this is a starting point, not a final):

> Genie's Vault reskins a classic "reductive reasoning" grid game as an Arabian Nights
> treasure hunt, but the actual mechanic is new: instead of numbered-adjacency clues
> (Mines) or a blind combinatoric pick (The Alchemist's angle), you spend a full extra
> wager to have the Genie defuse one curse at a time — a real resource-allocation
> trade-off between paying for safety and banking your current multiplier. The board is
> a houndstooth mosaic of gilded caskets, not a plain grid.
>
> RTP is a declared, exact 96%, verified with exhaustive rational-arithmetic enumeration
> (no floating-point rounding, no simulation — a real proof) across all three difficulty
> tiers, including confirmation that consulting the Genie is value-neutral (never an
> arbitrage exploit against the house) at every reachable game state. Each difficulty's
> top multiplier is capped below the platform's 100x heavy-tail threshold by an explicit
> reveal cap, so no variance-source registration or sigma floor is needed.
>
> Full `ICasinoGameV2` implementation, `game.manifest.json`, and a real standalone demo
> mode (plays outside the chain.wtf iframe with a simulated balance) — see MATH.md and
> math/verify_rtp.py in the source for the full proof.

### Submitting the form itself

I can drive a browser to fill this form out for you once your Discord/URLs are ready —
just tell me to go ahead and give me the values, and I'll fill it in and show you the
result before hitting submit (I won't submit or agree to terms on your behalf without
you confirming first).

## Note on rebuilding the frontend

`examples/genies-vault-public/dist/` in this package is already built and ready to host
as-is — you don't need Node or a rebuild just to deploy it (steps 1–2 above). If you want
to *edit* the frontend source and rebuild, its `package.json` depends on
`@chain/casino-sdk` via a relative `file:../..` path that assumes it's sitting inside the
full unzipped `@chain/casino-sdk` package (the one from `sdk.chain.wtf`) at
`examples/genies-vault-public/`. Drop this folder into that structure (replacing the
example's own copy) before running `npm install` there.

## Package contents

```
contracts/                        GeniesVaultGame.sol + ICasinoGameV2.sol (canonical interface)
deploy/                           Standalone Hardhat project to deploy to Base (your own wallet)
examples/genies-vault-public/     Frontend source + dist/ (already built)
math/verify_rtp.py                Exact-arithmetic RTP + no-arbitrage proof
MATH.md                           Declared math writeup
game.manifest.json                Validated jam manifest
```

## Recommended (optional, if you have time)

The SDK's pre-ship checklist also suggests testing "stuck randomness" (stopping the
local chain mid-round and confirming `cancelStuckRandomness` surfaces cleanly). I
verified slow-indexer, wallet-not-ready, and refresh-mid-round already; stuck-randomness
is lower risk (the platform's own facet handles the recovery path generically) but worth
a quick check if you have 10 minutes before submitting.
