// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ICasinoGameV2, SessionContext, SessionPhase, StepResult } from './ICasinoGameV2.sol';

/// @title Genie's Vault -- "Whispers of the Vault"
/// @notice A houndstooth-tessellated vault of sealed caskets. REVEAL a casket to grow your
///         multiplier; CONSULT the Genie (stake one more full wager, mines-double-down style)
///         to have him permanently defuse one hidden curse, buying safety for every reveal
///         that follows; CASH OUT at any time to bank effectiveStake * multiplier.
///
///         No per-casket adjacency numbers exist anywhere in this game -- the reductive
///         reasoning is a resource-allocation decision (pay real stake for real safety), not
///         a proximity-counting puzzle, which is the specific mechanic that would make this a
///         Mines clone. See ../../../MATH.md for the full fairness proof and
///         ../../../math/verify_rtp.py for the exact-arithmetic verification this contract's
///         math mirrors instruction-for-instruction.
///
/// @dev Declared theoretical RTP: 96.00% (RTP_WAD). Every difficulty's maximum reachable
///      multiplier is capped below the platform's 100x heavy-tail threshold by sealing the
///      board (forcing settlement) at a fixed reveal count, proven in verify_rtp.py to be the
///      true maximum regardless of how many consults are interleaved -- so quoteRiskParams
///      never needs a nonzero bodyVarianceScaled or a registered sigma floor.
contract GeniesVaultGame is ICasinoGameV2 {
  uint256 private constant WAD = 1e18;
  uint256 private constant RTP_WAD = 96e16; // 96.00%
  uint8 private constant BOARD_SIZE = 15; // N: houndstooth caskets on the board
  uint8 private constant MAX_CONSULTS = 3; // hard ceiling on Genie consultations per round

  uint8 private constant ACTION_REVEAL = 0;
  uint8 private constant ACTION_CONSULT = 1;
  uint8 private constant ACTION_CASHOUT = 2;

  error GeniesVault__InvalidDifficulty();
  error GeniesVault__InvalidWager();
  error GeniesVault__UnknownAction(uint8 action);
  error GeniesVault__NoCursesLeftToConsult();
  error GeniesVault__ConsultLimitReached();
  error GeniesVault__BoardSealed();
  error GeniesVault__RandomnessNotExpected();

  struct VaultState {
    uint8 difficulty;
    uint8 cellsRemaining;
    uint8 cursesRemaining;
    uint8 revealsMade;
    uint8 consultsUsed;
    uint8 revealCap;
    uint256 multiplierWad;
    uint256 effectiveStake; // token units, same decimals as wagerBase
  }

  // ---------------------------------------------------------------------
  // Difficulty table. topMultiplierWad is the EXACT value this contract's
  // own iterative WAD math reaches after revealCap safe reveals with zero
  // consults (see math/verify_rtp.py `ladder_wad`, which mirrors Solidity's
  // truncating integer division instruction-for-instruction) -- proven
  // there to be the maximum reachable regardless of consults interleaved.
  // ---------------------------------------------------------------------
  function _difficultyParams(
    uint8 difficulty
  ) private pure returns (uint8 curses, uint8 revealCap, uint256 topMultiplierWad) {
    if (difficulty == 0) return (2, 13, 61761143538840550063); // Apprentice
    if (difficulty == 1) return (3, 11, 72599723850271914038); // Adept
    if (difficulty == 2) return (4, 9, 63020593620027703143); // Vizier
    revert GeniesVault__InvalidDifficulty();
  }

  function _maxConsultsFor(uint8 curses) private pure returns (uint8) {
    return curses < MAX_CONSULTS ? curses : MAX_CONSULTS;
  }

  function _decodeDifficulty(bytes calldata gameData) private pure returns (uint8 difficulty) {
    difficulty = abi.decode(gameData, (uint8));
  }

  // ---------------------------------------------------------------------
  // ICasinoGameV2
  // ---------------------------------------------------------------------

  function quoteCaps(
    uint256 wager,
    bytes calldata gameData
  ) external pure override returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
    if (wager == 0) revert GeniesVault__InvalidWager();
    uint8 difficulty = _decodeDifficulty(gameData);
    (uint8 curses, , uint256 topMultiplierWad) = _difficultyParams(difficulty);
    uint8 maxConsults = _maxConsultsFor(curses);

    uint256 maxTotalStake = wager * (1 + uint256(maxConsults));
    maxEscrowStake = maxTotalStake;
    uint256 maxPayout = (maxTotalStake * topMultiplierWad) / WAD;
    maxReservedProfit = maxPayout > maxTotalStake ? maxPayout - maxTotalStake : 0;
  }

  function quoteRiskParams(
    uint256 wager,
    bytes calldata gameData
  )
    external
    pure
    override
    returns (uint256 maxPayout, uint256 probabilityWad, uint256 expectedPayout, uint256 bodyVarianceScaled)
  {
    if (wager == 0) revert GeniesVault__InvalidWager();
    uint8 difficulty = _decodeDifficulty(gameData);
    (uint8 curses, uint8 revealCap, uint256 topMultiplierWad) = _difficultyParams(difficulty);
    uint8 maxConsults = _maxConsultsFor(curses);

    uint256 maxTotalStake = wager * (1 + uint256(maxConsults));
    maxPayout = (maxTotalStake * topMultiplierWad) / WAD;

    // Top-tier win probability: reaching revealCap safe reveals with zero consults --
    // the same "probability of the full/cap cashout path" pattern the platform's own
    // Mines uses (1 / C(BOARD_SIZE, mineCount)), generalized to a capped board.
    probabilityWad = _topTierProbabilityWad(curses, revealCap);

    // RTP-fair expected value of the base wager (holds regardless of path -- see MATH.md).
    expectedPayout = (wager * RTP_WAD) / WAD;

    // Single top-tier path for risk-quoting purposes; every difficulty's maximum multiplier
    // is kept under the heavy-tail threshold by construction (see MATH.md difficulty table),
    // so no separate body-variance source is required.
    bodyVarianceScaled = 0;
  }

  function onSessionStart(SessionContext calldata ctx) external pure override returns (StepResult memory stepResult) {
    uint8 difficulty = _decodeDifficulty(ctx.gameData);
    (uint8 curses, uint8 revealCap, uint256 topMultiplierWad) = _difficultyParams(difficulty);

    VaultState memory state = VaultState({
      difficulty: difficulty,
      cellsRemaining: BOARD_SIZE,
      cursesRemaining: curses,
      revealsMade: 0,
      consultsUsed: 0,
      revealCap: revealCap,
      multiplierWad: WAD,
      effectiveStake: ctx.wagerBase
    });

    uint256 maxReservedProfit = ((ctx.wagerBase * topMultiplierWad) / WAD) > ctx.wagerBase
      ? ((ctx.wagerBase * topMultiplierWad) / WAD) - ctx.wagerBase
      : 0;

    stepResult.newGameState = _encode(state);
    stepResult.escrowDelta = 0; // the facet already pulled wagerBase before calling us
    stepResult.reservedProfitDelta = int256(maxReservedProfit);
    stepResult.nextPhase = SessionPhase.WAITING_PLAYER_ACTION;
    stepResult.requestRandomnessNow = false;
    stepResult.payout = 0;
  }

  function onPlayerAction(
    SessionContext calldata ctx,
    bytes calldata actionData
  ) external pure override returns (StepResult memory stepResult) {
    VaultState memory state = _decode(ctx.gameState);
    uint8 action = abi.decode(actionData, (uint8));

    if (action == ACTION_REVEAL) {
      if (state.revealsMade >= state.revealCap) revert GeniesVault__BoardSealed();
      // Randomness resolves the actual safe/curse draw in onRandomness.
      stepResult.newGameState = _encode(state);
      stepResult.escrowDelta = 0;
      stepResult.reservedProfitDelta = 0;
      stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
      stepResult.requestRandomnessNow = true;
      stepResult.payout = 0;
      return stepResult;
    }

    if (action == ACTION_CONSULT) {
      if (state.cursesRemaining == 0) revert GeniesVault__NoCursesLeftToConsult();
      if (state.consultsUsed >= MAX_CONSULTS) revert GeniesVault__ConsultLimitReached();

      // Fair "effective stake" buy-in at the CURRENT multiplier -- see MATH.md: this is what
      // makes consulting exactly value-neutral instead of a retroactive-growth exploit.
      state.effectiveStake += (ctx.wagerBase * WAD) / state.multiplierWad;
      state.cursesRemaining -= 1;
      state.cellsRemaining -= 1;
      state.consultsUsed += 1;

      (, , uint256 topMultiplierWad) = _difficultyParams(state.difficulty);
      uint256 addedReserve = (ctx.wagerBase * topMultiplierWad) / WAD > ctx.wagerBase
        ? (ctx.wagerBase * topMultiplierWad) / WAD - ctx.wagerBase
        : 0;

      stepResult.newGameState = _encode(state);
      stepResult.escrowDelta = int256(ctx.wagerBase); // pull one more full wager, blackjack-double style
      stepResult.reservedProfitDelta = int256(addedReserve); // scale the reserve to match the new total stake
      stepResult.nextPhase = SessionPhase.WAITING_PLAYER_ACTION;
      stepResult.requestRandomnessNow = false;
      stepResult.payout = 0;
      return stepResult;
    }

    if (action == ACTION_CASHOUT) {
      uint256 payout = (state.effectiveStake * state.multiplierWad) / WAD;
      stepResult.newGameState = _encode(state);
      stepResult.escrowDelta = 0;
      stepResult.reservedProfitDelta = 0; // facet releases the reserve itself at settlement
      stepResult.nextPhase = SessionPhase.SETTLED;
      stepResult.requestRandomnessNow = false;
      stepResult.payout = payout;
      return stepResult;
    }

    revert GeniesVault__UnknownAction(action);
  }

  function onRandomness(
    SessionContext calldata ctx,
    bytes32 randomness
  ) external pure override returns (StepResult memory stepResult) {
    VaultState memory state = _decode(ctx.gameState);
    if (state.cellsRemaining <= state.cursesRemaining) revert GeniesVault__RandomnessNotExpected();

    // Unbiased draw of an integer in [0, cellsRemaining) via rejection sampling
    // (see docs/RANDOMNESS_DICE.md, generalized from d6 to d(cellsRemaining)).
    uint256 draw = _drawUnbiased(randomness, state.cellsRemaining);
    bool cursed = draw < state.cursesRemaining;

    if (cursed) {
      stepResult.newGameState = _encode(state);
      stepResult.escrowDelta = 0;
      stepResult.reservedProfitDelta = 0; // facet releases the reserve itself at settlement
      stepResult.nextPhase = SessionPhase.SETTLED;
      stepResult.requestRandomnessNow = false;
      stepResult.payout = 0;
      return stepResult;
    }

    // Safe reveal: grow the multiplier by the RTP-fair per-step factor.
    uint256 safeRemaining = state.cellsRemaining - state.cursesRemaining;
    uint256 factorWad = (RTP_WAD * state.cellsRemaining) / safeRemaining;
    state.multiplierWad = (state.multiplierWad * factorWad) / WAD;
    state.cellsRemaining -= 1;
    state.revealsMade += 1;

    bool sealed_ = state.revealsMade >= state.revealCap;
    stepResult.newGameState = _encode(state);
    stepResult.escrowDelta = 0;
    stepResult.reservedProfitDelta = 0;
    stepResult.requestRandomnessNow = false;

    if (sealed_) {
      // The vault seals itself once the difficulty's reveal cap is hit -- this is what
      // keeps every difficulty's max payout under the heavy-tail threshold (see MATH.md).
      stepResult.nextPhase = SessionPhase.SETTLED;
      stepResult.payout = (state.effectiveStake * state.multiplierWad) / WAD;
    } else {
      stepResult.nextPhase = SessionPhase.WAITING_PLAYER_ACTION;
      stepResult.payout = 0;
    }
  }

  /// @notice Mines-style true anytime cash-out: whenever the facet can call this (session
  ///         expired out of WAITING_PLAYER_ACTION), gameState already reflects a fully
  ///         resolved state -- no unresolved randomness is ever pending in that phase, so
  ///         quoting the real value here cannot be an adverse-selection exploit against the
  ///         vault (see docs/CHAIN_WTF_CASINO_GAMES.md §2.1 on quoteForfeitPayout).
  function quoteForfeitPayout(SessionContext calldata ctx) external pure override returns (uint256 cashoutValue) {
    VaultState memory state = _decode(ctx.gameState);
    cashoutValue = (state.effectiveStake * state.multiplierWad) / WAD;
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  function _encode(VaultState memory state) private pure returns (bytes memory) {
    return
      abi.encode(
        state.difficulty,
        state.cellsRemaining,
        state.cursesRemaining,
        state.revealsMade,
        state.consultsUsed,
        state.revealCap,
        state.multiplierWad,
        state.effectiveStake
      );
  }

  function _decode(bytes calldata gameState) private pure returns (VaultState memory state) {
    (
      state.difficulty,
      state.cellsRemaining,
      state.cursesRemaining,
      state.revealsMade,
      state.consultsUsed,
      state.revealCap,
      state.multiplierWad,
      state.effectiveStake
    ) = abi.decode(gameState, (uint8, uint8, uint8, uint8, uint8, uint8, uint256, uint256));
  }

  /// @dev Unbiased draw of an integer in [0, n) from VRF bytes via rejection sampling,
  ///      generalizing docs/RANDOMNESS_DICE.md's d6 algorithm to arbitrary small n
  ///      (n <= BOARD_SIZE = 15 here, always << 256).
  function _drawUnbiased(bytes32 seed, uint256 n) private pure returns (uint256 result) {
    uint256 limit = (256 / n) * n; // reject bytes >= limit to remove modulo bias
    uint256 idx = 0;
    // Bounded: at most 256 rehashes of 32 bytes each gives 8192 draws, astronomically more
    // than needed in practice (expected < 2 draws for n <= 15); the cap only exists so the
    // compiler can see every path terminates.
    for (uint256 rehash = 0; rehash < 256; rehash++) {
      if (idx < 32) {
        uint8 b = uint8(seed[idx]);
        idx++;
        if (b < limit) {
          return b % n;
        }
      } else {
        seed = keccak256(abi.encodePacked(seed));
        idx = 0;
      }
    }
    revert GeniesVault__RandomnessNotExpected(); // unreachable in practice
  }

  /// @dev Probability (WAD) of reaching `revealCap` safe reveals in a row with zero
  ///      consults, from a board of BOARD_SIZE cells with `curses` cursed:
  ///      C(BOARD_SIZE - curses, revealCap) / C(BOARD_SIZE, revealCap), computed as a
  ///      running product to avoid factorials of BOARD_SIZE (small anyway, but this
  ///      keeps it exact and gas-cheap).
  function _topTierProbabilityWad(uint8 curses, uint8 revealCap) private pure returns (uint256) {
    uint256 pWad = WAD;
    uint256 cells = BOARD_SIZE;
    uint256 safe = BOARD_SIZE - curses;
    for (uint256 i = 0; i < revealCap; i++) {
      pWad = (pWad * safe) / cells;
      cells -= 1;
      safe -= 1;
    }
    return pWad;
  }
}
