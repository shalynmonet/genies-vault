import { useEffect, useMemo, useRef, useState } from 'react';
import { parseUnits, formatUnits } from 'viem';
import { useCasinoHost } from './lib/useCasinoHost';
import { sfx } from './lib/sound';
import {
  DIFFICULTIES,
  WAD,
  ACTION_REVEAL,
  ACTION_CONSULT,
  ACTION_CASHOUT,
  BOARD_SIZE,
  initialState,
  currentPayout,
  applySafeReveal,
  applyConsult,
  isSealed,
  canConsult,
  canReveal,
  curseProbability,
  maxConsultsFor,
  encodeGameData,
  encodeAction,
  decodeGameState,
  demoUnbiasedDraw,
  formatMultiplier,
} from './lib/geniesVault';
import type { Difficulty, VaultState } from './lib/geniesVault';

type SlotStatus = 'hidden' | 'safe' | 'cursed' | 'genie';
type Mode = 'connecting' | 'demo' | 'live';
type Screen = 'setup' | 'playing' | 'ended';

const DEMO_STARTING_BALANCE = 1000n * WAD;
const HOST_HANDSHAKE_TIMEOUT_MS = 1400;

function freshSlots(): SlotStatus[] {
  return Array.from({ length: BOARD_SIZE }, () => 'hidden');
}

function BoardView({
  slots,
  onReveal,
  disabled,
}: {
  slots: SlotStatus[];
  onReveal: (index: number) => void;
  disabled: boolean;
}) {
  // Strict 3 rows x 5 columns (15 caskets total), matching the layout mockup
  // and the contract's hardcoded BOARD_SIZE. Real casket art is applied per
  // state via CSS background-image (see .casket / .casket.safe / etc.).
  return (
    <div className="board">
      {slots.map((status, index) => (
        <button
          key={index}
          className={`casket${status !== 'hidden' ? ' ' + status : ''}`}
          disabled={disabled || status !== 'hidden'}
          onClick={() => {
            sfx.click();
            onReveal(index);
          }}
          aria-label={`casket ${index + 1}`}
        />
      ))}
    </div>
  );
}

export default function App() {
  const { hostApi, snapshot } = useCasinoHost();
  const [mode, setMode] = useState<Mode>('connecting');
  const [screen, setScreen] = useState<Screen>('setup');
  const [difficulty, setDifficulty] = useState<Difficulty>(0);
  const [wagerInput, setWagerInput] = useState('10');
  const [slots, setSlots] = useState<SlotStatus[]>(freshSlots());
  const [vault, setVault] = useState<VaultState | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<'busted' | 'sealed' | null>(null);

  // Fresh randomized particle sets for the two big "moment" overlays --
  // regenerated (via useMemo keyed on `outcome`) every time a round actually
  // busts or seals, so a replay never looks like a static repeat of the
  // same burst. Pure CSS-driven from here (see styles.css .ash-flake /
  // .coin-bit): cheap, instant, no image/video assets to load.
  const ashFlakes = useMemo(
    () =>
      outcome === 'busted'
        ? Array.from({ length: 34 }, (_, i) => ({
            id: i,
            left: Math.random() * 100,
            delay: Math.random() * 0.5,
            duration: 1.6 + Math.random() * 1.4,
            drift: (Math.random() - 0.5) * 140,
            size: 4 + Math.random() * 7,
          }))
        : [],
    [outcome],
  );
  const coinBits = useMemo(
    () =>
      outcome === 'sealed'
        ? Array.from({ length: 40 }, (_, i) => ({
            id: i,
            left: 50 + (Math.random() - 0.5) * 90,
            delay: Math.random() * 0.35,
            duration: 1.1 + Math.random() * 0.9,
            drift: (Math.random() - 0.5) * 320,
            rot: Math.random() * 720 - 360,
          }))
        : [],
    [outcome],
  );

  // demo-mode-only state
  const [demoBalance, setDemoBalance] = useState<bigint>(DEMO_STARTING_BALANCE);
  const [demoWager, setDemoWager] = useState<bigint>(0n);

  // live-mode-only state
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const pendingIndexRef = useRef<number | null>(null);
  // Synchronous guard for demo mode: `busy` (React state) only takes effect
  // on the next render, so two clicks fired within the same tick (a fast
  // real double-click, or two different caskets clicked back-to-back before
  // React re-renders) can both slip past the `busy` check and both schedule
  // a reveal. Each one's own `index` is safely closed over, so the payout
  // math was never wrong -- but both calls used to resolve their casket via
  // the single shared `pendingIndexRef`, so the second call's write clobbered
  // the first, leaving one clicked casket stuck visually "hidden" forever
  // even after the round (correctly) settled around it. A ref updates
  // synchronously, so checking it here closes the window outright.
  const demoBusyRef = useRef(false);

  const decimals = mode === 'live' ? snapshot?.token.decimals ?? 18 : 18;
  const fmt = (amount: bigint) => Number(formatUnits(amount, decimals)).toFixed(2);

  useEffect(() => {
    if (hostApi) {
      setMode('live');
      return;
    }
    const timer = setTimeout(() => {
      setMode(current => (current === 'connecting' ? 'demo' : current));
    }, HOST_HANDSHAKE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [hostApi]);

  const activeSession = useMemo(() => {
    if (mode !== 'live' || !snapshot || !sessionKey) return undefined;
    return snapshot.sessions.items.find(item => item.sessionKey === sessionKey);
  }, [mode, snapshot, sessionKey]);

  // Refresh mid-round: the harness's session feed is already scoped to this
  // game's contract address (see LOCAL_SIMULATOR/useIndexedSessions), so any
  // non-terminal row we don't yet know about is our own in-flight round.
  // Reconnect to it instead of stranding the player on a blank setup screen.
  useEffect(() => {
    if (mode !== 'live' || !snapshot || sessionKey || screen !== 'setup') return;
    const resumable = snapshot.sessions.items.find(
      item =>
        item.phaseName &&
        item.phaseName !== 'SETTLED' &&
        item.phaseName !== 'FORFEITED' &&
        item.phaseName !== 'CANCELLED' &&
        !!item.raw.gameState,
    );
    if (!resumable) return;
    try {
      const resumedVault = decodeGameState(resumable.raw.gameState!);
      // Sanity-bound the decode against our own schema before trusting it --
      // abi.encode pads every field to 32 bytes, so a same-length blob from
      // an unrelated game would decode without throwing but fail these checks.
      if (
        resumedVault.difficulty < 0 ||
        resumedVault.difficulty > 2 ||
        resumedVault.cellsRemaining > BOARD_SIZE ||
        resumedVault.revealCap > BOARD_SIZE ||
        resumedVault.consultsUsed > maxConsultsFor(resumedVault.difficulty)
      ) {
        return;
      }
      setSlots(prev => {
        const next = [...prev];
        for (let i = 0; i < resumedVault.revealsMade && i < next.length; i++) next[i] = 'safe';
        return next;
      });
      setDifficulty(resumedVault.difficulty);
      setSessionKey(resumable.sessionKey);
      setScreen('playing');
      appendLog('Reconnected to your open vault.');
    } catch {
      // Not a decodable Genie's Vault state -- leave the setup screen as is.
    }
  }, [mode, snapshot, sessionKey, screen]);

  // Derive vault state + board slots from the live session's raw.gameState
  // whenever the snapshot updates (never accumulate from prior renders --
  // always trust the current gameState, per CHAIN_WTF_CASINO_GAMES.md §4).
  useEffect(() => {
    if (mode !== 'live' || !activeSession?.raw.gameState) return;
    const next = decodeGameState(activeSession.raw.gameState);
    setVault(next);
    if (activeSession.phaseName === 'SETTLED' || activeSession.phaseName === 'FORFEITED' || activeSession.phaseName === 'CANCELLED') {
      const result = isSealed(next) && (activeSession.payout ?? '0') !== '0' ? 'sealed' : activeSession.payout && activeSession.payout !== '0' ? null : 'busted';
      if (screen !== 'ended') {
        // Only fire once per settlement, not on every repeat snapshot push
        // while the ended screen is already showing.
        if (result === 'sealed') setTimeout(() => sfx.sealed(), 150);
        else if (result === 'busted') sfx.cursed();
        else sfx.cashout();
      }
      setOutcome(result);
      setScreen('ended');
      void hostApi?.revealOutcome({ sessionId: activeSession.sessionId });
    }
  }, [mode, activeSession, hostApi]);

  function appendLog(line: string) {
    setLog(l => [line, ...l].slice(0, 6));
  }

  function resolveSlot(index: number | null, status: SlotStatus) {
    setSlots(prev => {
      const next = [...prev];
      let target = index;
      if (target === null || next[target] !== 'hidden') {
        // No specific tile to place this on (the contract only tracks counts
        // like cursesRemaining/consultsUsed, never which cell a Genie ward
        // landed on) — pick uniformly among the still-hidden tiles rather
        // than always the first one in reading order, so the ward doesn't
        // visually march top-left-to-right in the same spot every round.
        const hiddenIndexes = next.reduce<number[]>((acc, s, i) => {
          if (s === 'hidden') acc.push(i);
          return acc;
        }, []);
        target = hiddenIndexes.length > 0 ? hiddenIndexes[Math.floor(Math.random() * hiddenIndexes.length)] : -1;
      }
      if (target >= 0) next[target] = status;
      return next;
    });
  }

  // ---------------------------------------------------------------------
  // DEMO MODE
  // ---------------------------------------------------------------------

  function startDemoRound() {
    let wager: bigint;
    try {
      wager = parseUnits(wagerInput || '0', 18);
    } catch {
      return;
    }
    if (wager <= 0n || wager > demoBalance) return;

    setDemoBalance(b => b - wager);
    setDemoWager(wager);
    setVault(initialState(difficulty, wager));
    setSlots(freshSlots());
    setOutcome(null);
    setLog([]);
    setScreen('playing');
  }

  function demoReveal(index: number) {
    if (!vault || busy || demoBusyRef.current || !canReveal(vault)) return;
    demoBusyRef.current = true;
    setBusy(true);
    // Simulate the same VRF-fulfillment latency a real chain round would have.
    setTimeout(() => {
      const draw = demoUnbiasedDraw(vault.cellsRemaining);
      const cursed = draw < vault.cursesRemaining;
      if (cursed) {
        // Resolve the casket this specific call was for -- `index` is
        // closed over per-call, so it can't be clobbered by another click.
        resolveSlot(index, 'cursed');
        appendLog('A cursed casket! The vault seals shut. Payout: 0.');
        setOutcome('busted');
        setScreen('ended');
        sfx.cursed();
      } else {
        const next = applySafeReveal(vault);
        setVault(next);
        resolveSlot(index, 'safe');
        appendLog(`Safe! Multiplier now ${formatMultiplier(next.multiplierWad)}.`);
        sfx.safeReveal(next.revealsMade);
        if (isSealed(next)) {
          const payout = currentPayout(next);
          setDemoBalance(b => b + payout);
          appendLog(`The vault is fully cleared! Banked ${fmt(payout)} GOLD.`);
          setOutcome('sealed');
          setScreen('ended');
          setTimeout(() => sfx.sealed(), 150);
        }
      }
      demoBusyRef.current = false;
      setBusy(false);
    }, 550);
  }

  function demoConsult() {
    if (!vault || busy || demoBusyRef.current || !canConsult(vault)) return;
    if (demoBalance < demoWager) {
      appendLog("You don't have enough GOLD left to pay the Genie.");
      return;
    }
    demoBusyRef.current = true;
    setBusy(true);
    setTimeout(() => {
      setDemoBalance(b => b - demoWager);
      const next = applyConsult(vault, demoWager);
      setVault(next);
      resolveSlot(null, 'genie');
      appendLog('The Genie defuses one curse for you, at the cost of another wager staked.');
      sfx.consult();
      demoBusyRef.current = false;
      setBusy(false);
    }, 350);
  }

  function demoCashOut() {
    if (!vault || busy) return;
    const payout = currentPayout(vault);
    setDemoBalance(b => b + payout);
    appendLog(`Secured the treasure: ${fmt(payout)} GOLD.`);
    setOutcome(null);
    setScreen('ended');
    sfx.cashout();
  }

  // ---------------------------------------------------------------------
  // LIVE MODE
  // ---------------------------------------------------------------------

  async function startLiveRound() {
    if (!hostApi || !snapshot) return;
    const tokenDecimals = snapshot.token.decimals ?? 18;
    let wager: bigint;
    try {
      wager = parseUnits(wagerInput || '0', tokenDecimals);
    } catch {
      return;
    }
    if (wager <= 0n) return;

    setBusy(true);
    try {
      const { sessionKey: key } = await hostApi.openSession({
        wager: wager.toString(),
        gameData: encodeGameData(difficulty),
      });
      setSessionKey(key);
      setSlots(freshSlots());
      setOutcome(null);
      setLog([]);
      setScreen('playing');
    } catch (err) {
      appendLog(`Could not open session: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  // Set the instant an action is submitted, to the gameState bytes that were
  // current at that moment; cleared once the effect below sees that value
  // change (or the round end). A submitted reveal/consult only *requests*
  // randomness -- the submitAction promise resolves as soon as that request
  // transaction is mined, which is well before onRandomness actually lands
  // and moves gameState/phase forward. If we cleared `busy` right there,
  // there's a window where the board looks idle again but the session is
  // still WAITING_RANDOMNESS on-chain; a click in that window submits a new
  // action against a session that isn't in WAITING_PLAYER_ACTION yet and the
  // host reverts with LocalCasinoHost__InvalidSessionPhase. Gating on the
  // observed gameState actually changing (rather than the tx promise alone)
  // closes that window regardless of whether a given host even surfaces the
  // intermediate phase to the guest.
  const pendingGameStateRef = useRef<string | null>(null);
  // Belt-and-suspenders: randomness fulfillment is normally seconds away, but
  // should the VRF callback genuinely stall (the same "stuck randomness"
  // scenario the host has its own on-chain recovery path for), this stops
  // the action lock from becoming permanent and stranding the player with
  // every button dead. It only ever fires the UI back open for another try;
  // it never touches the chain.
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const PENDING_ACTION_TIMEOUT_MS = 25000;

  function clearPendingLock() {
    if (pendingTimeoutRef.current !== null) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
    pendingGameStateRef.current = null;
  }

  async function liveSubmit(action: number, index: number | null) {
    if (!hostApi || !activeSession || busy) return;
    setBusy(true);
    pendingIndexRef.current = index;
    pendingGameStateRef.current = activeSession.raw.gameState ?? null;
    pendingTimeoutRef.current = setTimeout(() => {
      pendingTimeoutRef.current = null;
      pendingGameStateRef.current = null;
      appendLog('Still waiting on the chain — you can try again.');
      setBusy(false);
    }, PENDING_ACTION_TIMEOUT_MS);
    try {
      // A consult ("Whisper to the Genie") stakes another full wager on top
      // of what's already escrowed — the host only approved the opening
      // wager at session-start, so this action needs its own approval bump
      // or the token's transferFrom reverts with InsufficientAllowance.
      const approvalAmount = action === ACTION_CONSULT ? activeSession.wager : undefined;
      await hostApi.submitAction({
        sessionId: activeSession.sessionId,
        actionData: encodeAction(action),
        ...(approvalAmount ? { approvalAmount } : {}),
      });
      // Don't clear `busy` here on success — see the effect below.
    } catch (err) {
      appendLog(`Action failed: ${(err as Error).message ?? err}`);
      clearPendingLock();
      setBusy(false);
    }
  }

  // Resolve the clicked/consulted slot visually once the vault state we
  // derive from the snapshot actually changes (safe reveal grew cellsRemaining
  // down, a curse leaves it hidden until the settle banner shows it as cursed).
  const prevVaultRef = useRef<VaultState | null>(null);
  useEffect(() => {
    if (mode !== 'live' || !vault) return;
    const prev = prevVaultRef.current;
    if (prev && prev.revealsMade < vault.revealsMade) {
      resolveSlot(pendingIndexRef.current, 'safe');
      sfx.safeReveal(vault.revealsMade);
    } else if (prev && prev.consultsUsed < vault.consultsUsed) {
      resolveSlot(null, 'genie');
      sfx.consult();
    }
    prevVaultRef.current = vault;
  }, [mode, vault]);

  // Releases the action lock once a pending action's effect is actually
  // visible — either the session's on-chain gameState moved past the
  // snapshot we submitted against, or the round ended outright (a curse
  // settles without ever changing gameState's revealsMade/multiplier).
  useEffect(() => {
    if (mode !== 'live' || pendingGameStateRef.current === null) return;
    if (screen !== 'playing') {
      clearPendingLock();
      setBusy(false);
      return;
    }
    if ((activeSession?.raw.gameState ?? null) !== pendingGameStateRef.current) {
      clearPendingLock();
      setBusy(false);
    }
  }, [mode, screen, activeSession?.raw.gameState]);

  useEffect(() => {
    if (mode === 'live' && screen === 'ended' && outcome === 'busted') {
      resolveSlot(pendingIndexRef.current, 'cursed');
    }
  }, [mode, screen, outcome]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  const diff = DIFFICULTIES[difficulty];
  const walletReady = mode !== 'live' || snapshot?.wallet.status === 'ready';
  const canStart = mode === 'demo' ? true : walletReady;
  const wagerAmount = mode === 'demo' ? demoWager : activeSession ? BigInt(activeSession.wager ?? '0') : 0n;

  return (
    <div className="app">
      <div
        className={`vault-shell${outcome === 'busted' ? ' vault-shell--ashen' : ''}${
          outcome === 'sealed' ? ' vault-shell--triumph' : ''
        }`}
      >
        {outcome === 'busted' && (
          <div className="ash-overlay" aria-hidden="true">
            {ashFlakes.map(f => (
              <span
                key={f.id}
                className="ash-flake"
                style={
                  {
                    left: `${f.left}%`,
                    width: `${f.size}px`,
                    height: `${f.size}px`,
                    animationDelay: `${f.delay}s`,
                    animationDuration: `${f.duration}s`,
                    '--drift': `${f.drift}px`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        )}
        {outcome === 'sealed' && (
          <div className="confetti-overlay" aria-hidden="true">
            {coinBits.map(c => (
              <span
                key={c.id}
                className="coin-bit"
                style={
                  {
                    left: `${c.left}%`,
                    animationDelay: `${c.delay}s`,
                    animationDuration: `${c.duration}s`,
                    '--drift': `${c.drift}px`,
                    '--rot': `${c.rot}deg`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        )}
        <div className="vault-header">
          <h1 className="vault-title">Genie&rsquo;s Vault</h1>
          <p className="vault-subtitle">Whispers of the Vault &mdash; open caskets, or pay the Genie to defuse a curse</p>
          <span className={`mode-badge ${mode === 'live' ? 'live' : 'demo'}`}>
            {mode === 'connecting' ? 'connecting…' : mode === 'live' ? 'Live · on-chain' : 'Standalone demo'}
          </span>
        </div>

        {screen === 'setup' && (
          <div className="panel setup-panel">
            <div className="difficulty-grid">
              {DIFFICULTIES.map(d => (
                <div
                  key={d.id}
                  className={`difficulty-card${difficulty === d.id ? ' selected' : ''}`}
                  onClick={() => setDifficulty(d.id)}
                >
                  <div className="difficulty-name">{d.name}</div>
                  <div className="difficulty-tagline">{d.tagline}</div>
                  <div className="difficulty-tagline">top {formatMultiplier(d.topMultiplierWad)}</div>
                </div>
              ))}
            </div>
            <div className="wager-row">
              <label htmlFor="wager">Wager</label>
              <input
                id="wager"
                inputMode="decimal"
                value={wagerInput}
                onChange={e => setWagerInput(e.target.value)}
              />
            </div>
            {mode === 'demo' && (
              <p className="helper-text">
                Demo balance: <span className="helper-text-value">{fmt(demoBalance)} GOLD</span>
              </p>
            )}
            {!canStart && <p className="helper-text">Connect your wallet in the host to play live.</p>}
            <button
              className="btn"
              disabled={busy || !canStart || mode === 'connecting'}
              onClick={() => (mode === 'demo' ? startDemoRound() : startLiveRound())}
            >
              Open the Vault
            </button>
          </div>
        )}

        {screen !== 'setup' && vault && (
          <div className="vault-body">
            <div className="board-column">
              <BoardView
                slots={slots}
                disabled={busy || screen === 'ended' || !canReveal(vault)}
                onReveal={index => (mode === 'demo' ? demoReveal(index) : liveSubmit(ACTION_REVEAL, index))}
              />

              {outcome === 'busted' && <div className="busted-banner">The Genie warned you. Payout: 0.</div>}
              {outcome === 'sealed' && <div className="sealed-banner">Vault fully cleared! Maximum treasure secured.</div>}

              <div className="log">
                {log.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            </div>

            <div className="hud-panel">
              <div className="hud-panel-label">Wager Control Panel</div>

              <div className="hud-stat">
                <div className="hud-stat-label">Wager</div>
                <div className="hud-stat-value">
                  {fmt(wagerAmount)} <span className="hud-unit">GOLD</span>
                </div>
              </div>

              <div className={`hud-stat${vault.consultsUsed > 0 ? ' hud-stat--risk' : ''}`}>
                <div className="hud-stat-label">Total Wagered</div>
                <div className="hud-stat-value">
                  {fmt(wagerAmount * (1n + BigInt(vault.consultsUsed)))} <span className="hud-unit">GOLD</span>
                </div>
                {vault.consultsUsed > 0 && (
                  <div className="hud-stat-note">
                    {fmt(wagerAmount)} base + {vault.consultsUsed} whisper{vault.consultsUsed === 1 ? '' : 's'} at {fmt(wagerAmount)} each
                  </div>
                )}
              </div>

              <div className="hud-stat hud-stat--glow">
                <div className="hud-stat-label">Multiplier</div>
                <div className="hud-stat-value">{formatMultiplier(vault.multiplierWad)}</div>
              </div>

              <div className="hud-stat">
                <div className="hud-stat-label">If You Cash Out</div>
                <div className="hud-stat-value">
                  {fmt(currentPayout(vault))} <span className="hud-unit">GOLD</span>
                </div>
              </div>

              <div className="hud-stat-row">
                <div className="hud-stat small">
                  <div className="hud-stat-label">Whispers</div>
                  <div className="hud-stat-value small">
                    {vault.consultsUsed}/{maxConsultsFor(diff.curses)}
                  </div>
                </div>
                <div className="hud-stat small">
                  <div className="hud-stat-label">Curse Odds</div>
                  <div className="hud-stat-value small">{(curseProbability(vault) * 100).toFixed(0)}%</div>
                </div>
              </div>

              {screen === 'playing' && (
                <div className="hud-actions">
                  <button
                    className="btn secondary"
                    disabled={busy || !canConsult(vault)}
                    onClick={() => (mode === 'demo' ? demoConsult() : liveSubmit(ACTION_CONSULT, null))}
                  >
                    <span className="btn-label">Whisper to the Genie</span>
                    <span className="btn-subcost">+{fmt(wagerAmount)} GOLD</span>
                  </button>
                  <button
                    className="btn danger ornate"
                    disabled={busy}
                    onClick={() => (mode === 'demo' ? demoCashOut() : liveSubmit(ACTION_CASHOUT, null))}
                  >
                    Secure the Treasure
                  </button>
                </div>
              )}

              {screen === 'ended' && (
                <div className="hud-actions">
                  <button
                    className="btn wide"
                    onClick={() => {
                      setScreen('setup');
                      setVault(null);
                      setSessionKey(null);
                      setOutcome(null);
                    }}
                  >
                    Play Again
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
