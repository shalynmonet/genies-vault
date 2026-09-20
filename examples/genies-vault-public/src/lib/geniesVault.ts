// Shared game math -- mirrors contracts/GeniesVaultGame.sol instruction for
// instruction (same WAD, same truncating integer division via BigInt) so the
// UI's displayed multiplier ladder and "what happens next" previews are
// always exactly what the contract (or the standalone demo simulator below)
// will actually compute. See ../../../../MATH.md for the fairness proof and
// ../../../../math/verify_rtp.py for the exact-arithmetic verification.
import { encodeAbiParameters, decodeAbiParameters } from 'viem';

export const WAD = 10n ** 18n;
export const RTP_WAD = (96n * WAD) / 100n; // 96.00%
export const BOARD_SIZE = 15;
export const MAX_CONSULTS = 3;

export const ACTION_REVEAL = 0;
export const ACTION_CONSULT = 1;
export const ACTION_CASHOUT = 2;

export type Difficulty = 0 | 1 | 2;

export type DifficultyParams = {
  id: Difficulty;
  name: string;
  tagline: string;
  curses: number;
  revealCap: number;
  topMultiplierWad: bigint;
};

// Exact values computed + verified in math/verify_rtp.py (`ladder_wad`) --
// the true maximum multiplier reachable at each difficulty's reveal cap,
// regardless of how many consults are interleaved (proven there).
export const DIFFICULTIES: DifficultyParams[] = [
  {
    id: 0,
    name: 'Apprentice',
    tagline: '2 curses · seals at 13 caskets (full vault)',
    curses: 2,
    revealCap: 13,
    topMultiplierWad: 61761143538840550063n,
  },
  {
    id: 1,
    name: 'Adept',
    tagline: '3 curses · seals at 11 caskets',
    curses: 3,
    revealCap: 11,
    topMultiplierWad: 72599723850271914038n,
  },
  {
    id: 2,
    name: 'Vizier',
    tagline: '4 curses · seals at 9 caskets',
    curses: 4,
    revealCap: 9,
    topMultiplierWad: 63020593620027703143n,
  },
];

export function difficultyById(id: Difficulty): DifficultyParams {
  const d = DIFFICULTIES.find(x => x.id === id);
  if (!d) throw new Error(`unknown difficulty ${id}`);
  return d;
}

export function maxConsultsFor(curses: number): number {
  return Math.min(curses, MAX_CONSULTS);
}

/** Fair per-step multiplier factor applied on a safe reveal (WAD). */
export function stepFactorWad(cellsRemaining: number, cursesRemaining: number): bigint {
  const safe = BigInt(cellsRemaining - cursesRemaining);
  return (RTP_WAD * BigInt(cellsRemaining)) / safe;
}

export type VaultState = {
  difficulty: Difficulty;
  cellsRemaining: number;
  cursesRemaining: number;
  revealsMade: number;
  consultsUsed: number;
  revealCap: number;
  multiplierWad: bigint;
  effectiveStake: bigint; // token units (or demo-mode "GOLD" units)
};

export function initialState(difficulty: Difficulty, wager: bigint): VaultState {
  const d = difficultyById(difficulty);
  return {
    difficulty,
    cellsRemaining: BOARD_SIZE,
    cursesRemaining: d.curses,
    revealsMade: 0,
    consultsUsed: 0,
    revealCap: d.revealCap,
    multiplierWad: WAD,
    effectiveStake: wager,
  };
}

export function currentPayout(state: VaultState): bigint {
  return (state.effectiveStake * state.multiplierWad) / WAD;
}

export function previewRevealFactorWad(state: VaultState): bigint {
  return stepFactorWad(state.cellsRemaining, state.cursesRemaining);
}

export function curseProbability(state: VaultState): number {
  return state.cursesRemaining / state.cellsRemaining;
}

export function applySafeReveal(state: VaultState): VaultState {
  const factor = stepFactorWad(state.cellsRemaining, state.cursesRemaining);
  return {
    ...state,
    multiplierWad: (state.multiplierWad * factor) / WAD,
    cellsRemaining: state.cellsRemaining - 1,
    revealsMade: state.revealsMade + 1,
  };
}

export function isSealed(state: VaultState): boolean {
  return state.revealsMade >= state.revealCap;
}

export function applyConsult(state: VaultState, wager: bigint): VaultState {
  const addedEffective = (wager * WAD) / state.multiplierWad;
  return {
    ...state,
    effectiveStake: state.effectiveStake + addedEffective,
    cursesRemaining: state.cursesRemaining - 1,
    cellsRemaining: state.cellsRemaining - 1,
    consultsUsed: state.consultsUsed + 1,
  };
}

export function canConsult(state: VaultState): boolean {
  return state.cursesRemaining > 0 && state.consultsUsed < MAX_CONSULTS;
}

export function canReveal(state: VaultState): boolean {
  return state.revealsMade < state.revealCap && state.cellsRemaining > state.cursesRemaining;
}

// ---------------------------------------------------------------------
// ABI encode/decode for gameData / actionData, matching the contract.
// ---------------------------------------------------------------------

export function encodeGameData(difficulty: Difficulty): `0x${string}` {
  return encodeAbiParameters([{ type: 'uint8' }], [difficulty]);
}

export function encodeAction(action: number): `0x${string}` {
  return encodeAbiParameters([{ type: 'uint8' }], [action]);
}

export function decodeGameState(gameState: `0x${string}`): VaultState {
  const [difficulty, cellsRemaining, cursesRemaining, revealsMade, consultsUsed, revealCap, multiplierWad, effectiveStake] =
    decodeAbiParameters(
      [
        { type: 'uint8' },
        { type: 'uint8' },
        { type: 'uint8' },
        { type: 'uint8' },
        { type: 'uint8' },
        { type: 'uint8' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      gameState,
    ) as [number, number, number, number, number, number, bigint, bigint];

  return {
    difficulty: difficulty as Difficulty,
    cellsRemaining,
    cursesRemaining,
    revealsMade,
    consultsUsed,
    revealCap,
    multiplierWad,
    effectiveStake,
  };
}

/** Unbiased draw in [0, n) via rejection sampling, mirroring the contract's
 * `_drawUnbiased` -- used only by the standalone demo-mode simulator below,
 * never for a real on-chain round (the chain's own VRF settles those). */
export function demoUnbiasedDraw(n: number): number {
  const limit = Math.floor(256 / n) * n;
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  for (const b of bytes) {
    if (b < limit) return b % n;
  }
  // astronomically unlikely with 64 bytes for n <= 15; fall back safely
  return Math.floor(Math.random() * n);
}

export function formatMultiplier(multiplierWad: bigint): string {
  const scaled = Number(multiplierWad) / 1e18;
  return `${scaled.toFixed(2)}x`;
}

export function formatTokenAmount(amountWad: bigint, decimals = 2): string {
  const scaled = Number(amountWad) / 1e18;
  return scaled.toFixed(decimals);
}
