import { useState, useEffect, useCallback, useRef } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001/api";
const REFRESH_INTERVAL = 30_000;

const LEAGUE_SLUGS = {
  NBA: "nba",
  NFL: "nfl",
  NHL: "nhl",
  MLS: "mls",
  "Champions League": "ucl",
};
const LEAGUES = Object.keys(LEAGUE_SLUGS);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function probTextClass(pct) {
  if (pct >= 70) return "text-green-500";
  if (pct >= 55) return "text-lime-500";
  if (pct >= 45) return "text-yellow-500";
  if (pct >= 30) return "text-orange-400";
  return "text-red-500";
}
function probBgClass(pct) {
  if (pct >= 70) return "bg-green-500";
  if (pct >= 55) return "bg-lime-500";
  if (pct >= 45) return "bg-yellow-400";
  if (pct >= 30) return "bg-orange-400";
  return "bg-red-500";
}
function edgeLabel(pct) {
  if (pct >= 75) return "Strong Lean";
  if (pct >= 62) return "Moderate Lean";
  if (pct >= 52) return "Slight Lean";
  return "Toss-Up";
}

// ─── FEATURE 1: Best Bet logic ────────────────────────────────────────────────
// Looks at ALL games across ALL leagues and finds the single most compelling
// upcoming game based on win probability skew.
//
// First tries win_probability data; falls back to spread size if none available.
function findBestBet(allGames) {
  let best = null;
  let bestSkew = 0;

  // First pass: prefer games with win_probability data
  for (const [league, games] of Object.entries(allGames)) {
    for (const game of games) {
      if (game.status !== "scheduled" || !game.win_probability) continue;

      const { home, away, win_probability } = game;
      const homePct = win_probability[home] ?? 50;
      const awayPct = win_probability[away] ?? 50;
      const skew = Math.abs(homePct - awayPct);

      if (skew > bestSkew) {
        bestSkew = skew;
        best = { game, league, favPct: Math.max(homePct, awayPct) };
      }
    }
  }

  // Second pass: if no win_probability data, fall back to spread size
  if (!best) {
    let bestSpreadVal = 0;
    for (const [league, games] of Object.entries(allGames)) {
      for (const game of games) {
        if (game.status !== "scheduled" || !game.spread?.favorite) continue;
        const match = game.spread.favorite.match(/-?\d+\.?\d*/);
        const spreadVal = match ? Math.abs(parseFloat(match[0])) : 0;
        if (spreadVal > bestSpreadVal) {
          bestSpreadVal = spreadVal;
          best = { game, league, favPct: null };
        }
      }
    }
  }

  return best;
}

// ─── FEATURE 2: Upset Alert logic ─────────────────────────────────────────────
// An upset alert means: the underdog is close enough to the favorite that
// betting on them could pay off. We flag any scheduled game where the
// probability gap is ≤ 15% (i.e. neither team is a heavy favorite).
function isUpsetAlert(win_probability, home, away) {
  if (!win_probability) return false;
  const homePct = win_probability[home] ?? 50;
  const awayPct = win_probability[away] ?? 50;
  return Math.abs(homePct - awayPct) <= 15;
}

// ─── FEATURE 5: Momentum logic ────────────────────────────────────────────────
// We track score history in a ref (persists across renders without causing
// re-renders). If one team scored in the last 2 consecutive score snapshots
// and the other didn't, we call that "on a run".
//
// scoreHistory shape: { [gameId]: [{ home: N, away: N }, ...] }
// We keep the last 3 snapshots per game.
function getMomentum(scoreHistory, gameId, homeAbbr, awayAbbr) {
  const history = scoreHistory[gameId];
  if (!history || history.length < 2) return null;

  const prev = history[history.length - 2];
  const curr = history[history.length - 1];

  const homeScored = curr[homeAbbr] > prev[homeAbbr];
  const awayScored = curr[awayAbbr] > prev[awayAbbr];

  if (homeScored && !awayScored) return homeAbbr;
  if (awayScored && !homeScored) return awayAbbr;
  return null; // both scored or neither scored
}

// ─── Advanced feature helpers ─────────────────────────────────────────────────

// Feature: Entertainment rating (1–10) for finished games.
// Based on margin of victory, lead changes (from score history), and OT.
function calcEntertainmentRating(game, scoreHistory) {
  if (game.status !== "final") return null;
  const homeScore = game.score?.[game.home] ?? 0;
  const awayScore = game.score?.[game.away] ?? 0;
  const margin = Math.abs(homeScore - awayScore);
  let rating = 5;
  if (margin === 0)       rating += 2;
  else if (margin <= 2)   rating += 2.5;
  else if (margin <= 5)   rating += 1.5;
  else if (margin <= 10)  rating += 0.5;
  else if (margin > 20)   rating -= 1.5;
  const history = scoreHistory?.[game.id] ?? [];
  if (history.length >= 2) {
    let changes = 0, prevLead = null;
    for (const snap of history) {
      const lead = snap[game.home] > snap[game.away] ? game.home
                 : snap[game.away] > snap[game.home] ? game.away : null;
      if (prevLead && lead && lead !== prevLead) changes++;
      if (lead) prevLead = lead;
    }
    rating += Math.min(changes * 0.8, 2);
  }
  if (game.clock && /OT|overtime|extra|pen/i.test(game.clock)) rating += 1.5;
  return Math.max(1, Math.min(10, +rating.toFixed(1)));
}

// Feature: Is this live game currently tense? (close score, late in game)
function isTenseMoment(game) {
  if (game.status !== "in_progress" || !game.score) return false;
  const margin = Math.abs((game.score[game.home] ?? 0) - (game.score[game.away] ?? 0));
  const clock = (game.clock ?? "").toLowerCase();
  const isLate =
    clock.includes("4th") ||
    (clock.includes("3rd") && game.sport === "nhl") ||
    clock.includes("ot") || clock.includes("overtime") || clock.includes("extra") ||
    /\b[7-9]\d'|\b1[0-9]\d'/.test(clock); // soccer 70'+
  const threshold = { nba: 5, nfl: 8, nhl: 1, mls: 1, ucl: 1 }[game.sport] ?? 5;
  return isLate && margin <= threshold;
}

// Feature: Find the single most exciting live game across all leagues.
function findBestLiveGame(allGames, scoreHistory) {
  let best = null, bestScore = -1;
  for (const [league, games] of Object.entries(allGames)) {
    for (const game of games) {
      if (game.status !== "in_progress") continue;
      const margin = Math.abs((game.score?.[game.home] ?? 0) - (game.score?.[game.away] ?? 0));
      let excitement = Math.max(0, 15 - margin * 1.5);
      if (isTenseMoment(game)) excitement += 8;
      excitement += Math.min((scoreHistory?.[game.id] ?? []).length, 5);
      if (excitement > bestScore) { bestScore = excitement; best = { game, league }; }
    }
  }
  return best;
}

// Feature: Auto-generate a one-sentence recap for a finished game.
function generateRecap(game) {
  const { home, away, teams, score, events, clock, sport } = game;
  if (game.status !== "final") return null;
  const homeScore = score?.[home] ?? 0;
  const awayScore = score?.[away] ?? 0;
  if (homeScore === 0 && awayScore === 0) return null;
  const winner = homeScore >= awayScore ? home : away;
  const loser  = winner === home ? away : home;
  const winScore  = score[winner];
  const loseScore = score[loser];
  const margin = winScore - loseScore;
  const isOT   = clock && /OT|overtime|extra|pen/i.test(clock);
  const winName  = teams[winner]?.name ?? winner;
  const loseName = teams[loser]?.name  ?? loser;
  let line = `${winName} `;
  if (margin === 0) line += `drew ${winScore}–${loseScore} with ${loseName}`;
  else line += `${margin <= 2 ? "edged" : margin <= 6 ? "beat" : "defeated"} ${loseName} ${winScore}–${loseScore}`;
  if (isOT) line += " in extra time";
  if (events?.length && (sport === "mls" || sport === "ucl")) {
    const goals = events.filter(e => e.type?.toLowerCase().includes("goal") && !e.type?.toLowerCase().includes("own"));
    const winGoals = goals.filter(e => (e.isHome && winner === home) || (!e.isHome && winner === away));
    const last = winGoals[winGoals.length - 1];
    if (last?.player && margin <= 2) {
      line += ` — ${last.player} sealed it${last.clock ? ` (${last.clock}')` : ""}`;
    }
  }
  return line + ".";
}

// Feature: Score delta between last two snapshots — who's scoring right now.
function getScoreDelta(history, homeAbbr, awayAbbr) {
  if (!history || history.length < 2) return null;
  const prev = history[history.length - 2];
  const curr = history[history.length - 1];
  const hd = (curr[homeAbbr] ?? 0) - (prev[homeAbbr] ?? 0);
  const ad = (curr[awayAbbr] ?? 0) - (prev[awayAbbr] ?? 0);
  return (hd === 0 && ad === 0) ? null : { [homeAbbr]: hd, [awayAbbr]: ad };
}

// ─── FEATURE 4: Score Timeline ────────────────────────────────────────────────
// scoreHistory also powers a mini timeline. We show the last few score
// snapshots as a visual trail so you can see how the game has moved.
function ScoreTimeline({ history, homeAbbr, awayAbbr }) {
  if (!history || history.length < 2) return null;

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="text-xs text-gray-400 mb-1.5 font-medium">Score timeline</div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {history.map((snap, i) => (
          <div key={i} className="flex flex-col items-center min-w-[40px]">
            {/* Each snapshot shows away-home score at that moment */}
            <div className="text-xs font-mono font-bold text-gray-700">
              {snap[awayAbbr]}–{snap[homeAbbr]}
            </div>
            <div className="text-xs text-gray-300 mt-0.5">
              {snap.clock ?? (i === 0 ? "start" : `…`)}
            </div>
          </div>
        ))}
        {/* Arrow to show direction of time */}
        <div className="text-gray-200 self-center text-sm">→</div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 bg-red-100 text-red-600 text-xs font-bold tracking-wider px-2 py-0.5 rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
      LIVE
    </span>
  );
}

function ProbBar({ home, homeAbbr, away, awayAbbr, draw }) {
  const showDraw = draw != null;
  const total = (home ?? 50) + (away ?? 50) + (draw ?? 0);
  const homePct = (home / total) * 100;
  const awayPct = (away / total) * 100;
  const drawPct = showDraw ? (draw / total) * 100 : 0;
  const favPct = Math.max(home, away);
  const favTeam = home >= away ? homeAbbr : awayAbbr;

  return (
    <div className="mt-3">
      <div className="flex justify-between mb-1 text-xs text-gray-500">
        <span>{homeAbbr} <strong className={probTextClass(home)}>{home?.toFixed(0)}%</strong></span>
        {showDraw && <span>Draw <strong className={probTextClass(draw)}>{draw?.toFixed(0)}%</strong></span>}
        <span><strong className={probTextClass(away)}>{away?.toFixed(0)}%</strong> {awayAbbr}</span>
      </div>
      <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-100">
        <div className={`${probBgClass(home)} transition-all duration-500`} style={{ width: `${homePct}%` }} />
        {showDraw && <div className={`${probBgClass(draw)} transition-all duration-500`} style={{ width: `${drawPct}%` }} />}
        <div className={`${probBgClass(away)} transition-all duration-500`} style={{ width: `${awayPct}%` }} />
      </div>
      <div className="mt-1.5 text-xs text-gray-500">
        📊 <span className={`font-semibold ${probTextClass(favPct)}`}>{edgeLabel(favPct)}</span>
        {" "}→ <strong>{favTeam}</strong>
        {favPct >= 70 && " — data strongly favors this team"}
        {favPct < 55 && " — stats are too close to call"}
      </div>
    </div>
  );
}

function SpreadBadge({ spread }) {
  if (!spread) return null;
  return (
    <div className="mt-2 text-xs text-gray-400">
      📈 Spread: <span className="font-medium text-gray-600">{spread.favorite}</span>
      {spread.overUnder && <> · O/U: <span className="font-medium text-gray-600">{spread.overUnder}</span></>}
    </div>
  );
}

// ─── Expanded card helpers ────────────────────────────────────────────────────

// Which stats to surface per sport (ESPN stat name → shown in StatsComparison)
const STAT_DISPLAY = {
  nba: ["fieldGoalPct", "threePointPct", "freeThrowPct", "rebounds", "assists", "turnovers"],
  nfl: ["totalYards", "passingYards", "rushingYards", "firstDowns", "turnovers", "sacks"],
  nhl: ["shots", "hits", "blocks", "faceoffWinPct", "powerPlayGoals", "pims"],
  mls: ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
  ucl: ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
};

function eventIcon(type) {
  if (!type) return "·";
  const t = type.toLowerCase();
  if (t.includes("yellow card")) return "🟨";
  if (t.includes("red card")) return "🟥";
  if (t.includes("goal")) return "⚽";
  if (t.includes("substitut")) return "🔄";
  return "·";
}

function EventsGrid({ events, home, away, teams }) {
  const homeEvents = events.filter(e => e.isHome);
  const awayEvents = events.filter(e => !e.isHome);
  return (
    <div className="grid grid-cols-2 gap-x-3">
      {/* Column headers */}
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5 text-right">
        {teams[home]?.name ?? home}
      </div>
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
        {teams[away]?.name ?? away}
      </div>

      {/* Left column: name → time → icon (icon sits at center seam) */}
      <div className="space-y-1.5">
        {homeEvents.length > 0 ? homeEvents.map((e, i) => (
          <div key={i} className="flex items-center justify-end gap-1.5 text-xs text-gray-600">
            <span className="truncate">{e.player ?? e.type}</span>
            <span className="text-gray-400 tabular-nums shrink-0">{e.clock}</span>
            <span className="text-base leading-none shrink-0">{eventIcon(e.type)}</span>
          </div>
        )) : <div className="text-xs text-gray-300 italic text-right">—</div>}
      </div>

      {/* Right column: icon → time → name (icon sits at center seam) */}
      <div className="space-y-1.5">
        {awayEvents.length > 0 ? awayEvents.map((e, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs text-gray-600">
            <span className="text-base leading-none shrink-0">{eventIcon(e.type)}</span>
            <span className="text-gray-400 tabular-nums shrink-0">{e.clock}</span>
            <span className="truncate">{e.player ?? e.type}</span>
          </div>
        )) : <span className="text-xs text-gray-300 italic">—</span>}
      </div>
    </div>
  );
}

function StatsComparison({ homeStats, awayStats, homeAbbr, awayAbbr, sport }) {
  const configuredKeys = STAT_DISPLAY[sport] ?? [];
  const availableKeys = Object.keys(homeStats ?? awayStats ?? {});
  // Use configured keys if at least one matches; otherwise fall back to whatever ESPN returned
  const keys = configuredKeys.some(k => availableKeys.includes(k))
    ? configuredKeys
    : availableKeys.slice(0, 6);
  const rows = keys
    .map(key => {
      const h = homeStats?.[key];
      const a = awayStats?.[key];
      if (!h && !a) return null;
      return { key, label: h?.label ?? a?.label ?? key, homeVal: h?.value ?? "—", awayVal: a?.value ?? "—" };
    })
    .filter(Boolean);
  if (rows.length === 0) return null;
  // Single flat grid — header + all rows share the same column widths, so they stay aligned
  // Visual order matches the card: AWAY on left, HOME on right
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-x-2 gap-y-1.5 text-xs">
      {/* Header row */}
      <div className="text-right font-semibold text-gray-400 pb-1">{awayAbbr}</div>
      <div className="min-w-[60px]" />
      <div className="font-semibold text-gray-400 pb-1">{homeAbbr}</div>
      {/* Stat rows */}
      {rows.flatMap(({ key, label, homeVal, awayVal }) => [
        <div key={`${key}-away`} className="text-right font-semibold text-gray-800">{awayVal}</div>,
        <div key={`${key}-label`} className="text-gray-400 text-center min-w-[60px]">{label}</div>,
        <div key={`${key}-home`} className="font-semibold text-gray-800">{homeVal}</div>,
      ])}
    </div>
  );
}

function ExpandedSection({ game, scoreHistory }) {
  const { home, away, teams, events, homeStats, awayStats, broadcasts, sport } = game;
  const hasEvents    = events?.length > 0;
  const hasStats     = !!(homeStats || awayStats);
  const hasBroadcasts = broadcasts?.length > 0;
  const recap  = generateRecap(game);
  const rating = calcEntertainmentRating(game, scoreHistory);

  if (!hasEvents && !hasStats && !hasBroadcasts && !recap) {
    return (
      <div className="pt-3 border-t border-gray-100 text-xs text-gray-400 text-center italic py-2">
        No additional data available
      </div>
    );
  }

  return (
    <div className="pt-3 border-t border-gray-100 space-y-4">
      {/* Auto-generated recap sentence */}
      {recap && (
        <p className="text-xs text-gray-500 italic leading-relaxed">{recap}</p>
      )}
      {/* Entertainment rating */}
      {rating !== null && <EntertainmentRating rating={rating} />}
      {/* Broadcasts */}
      {hasBroadcasts && (
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <span>📺</span>
          <span className="font-medium">{broadcasts.join(" · ")}</span>
        </div>
      )}
      {/* Match events (soccer goals/cards) */}
      {hasEvents && (
        <div>
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Match Events
          </div>
          <EventsGrid events={events} home={home} away={away} teams={teams} />
        </div>
      )}
      {/* Team stats comparison */}
      {hasStats && (
        <StatsComparison
          homeStats={homeStats}
          awayStats={awayStats}
          homeAbbr={home}
          awayAbbr={away}
          sport={sport}
        />
      )}
    </div>
  );
}

// ─── Entertainment rating badge ───────────────────────────────────────────────
function EntertainmentRating({ rating }) {
  if (!rating) return null;
  const stars = rating >= 8.5 ? "★★★" : rating >= 6.5 ? "★★" : "★";
  const label = rating >= 8.5 ? "Must watch" : rating >= 7 ? "Great game" : rating >= 5 ? "Decent" : "Skip it";
  const color = rating >= 8 ? "text-green-600" : rating >= 6 ? "text-amber-500" : "text-gray-400";
  return (
    <div className={`flex items-center gap-1.5 text-xs ${color}`}>
      <span className="font-bold">{stars}</span>
      <span className="font-semibold">{rating}/10</span>
      <span className="text-gray-400">· {label}</span>
    </div>
  );
}

// ─── Best live game hero card ──────────────────────────────────────────────────
// Shown at the top of every tab when at least one live game is happening.
// Surfaces the most exciting cross-league game so you know when to tune in.
function BestLiveCard({ bestLive }) {
  if (!bestLive) return null;
  const { game, league } = bestLive;
  const { home, away, teams, score, clock } = game;
  const tense = isTenseMoment(game);
  return (
    <div className="bg-gradient-to-br from-red-600 to-orange-500 rounded-2xl p-4 mb-4 text-white shadow-lg">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          <span className="text-xs font-extrabold tracking-wider opacity-95">BEST LIVE GAME</span>
        </div>
        <span className="text-xs font-semibold opacity-70 uppercase tracking-wide">{league}</span>
      </div>
      <div className="flex items-center">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {teams[away]?.logo
            ? <img src={teams[away].logo} alt="" className="w-8 h-8 object-contain brightness-0 invert opacity-80 shrink-0" />
            : <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold shrink-0">{away}</div>
          }
          <div className="min-w-0">
            <div className="font-bold text-sm truncate">{teams[away]?.name ?? away}</div>
            <div className="text-xs opacity-60">Away</div>
          </div>
        </div>
        <div className="text-center px-3 shrink-0">
          <div className="font-black text-2xl tabular-nums">{score?.[away]} – {score?.[home]}</div>
          {clock && <div className="text-xs opacity-70 mt-0.5">{clock}</div>}
        </div>
        <div className="flex items-center gap-2 flex-1 min-w-0 justify-end text-right">
          <div className="min-w-0">
            <div className="font-bold text-sm truncate">{teams[home]?.name ?? home}</div>
            <div className="text-xs opacity-60">Home</div>
          </div>
          {teams[home]?.logo
            ? <img src={teams[home].logo} alt="" className="w-8 h-8 object-contain brightness-0 invert opacity-80 shrink-0" />
            : <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold shrink-0">{home}</div>
          }
        </div>
      </div>
      {tense && (
        <div className="mt-2.5 text-center text-xs font-semibold bg-white/20 rounded-xl py-1.5">
          ⚡ Getting close — tune in now
        </div>
      )}
    </div>
  );
}

// ─── App icon ─────────────────────────────────────────────────────────────────
// A mini chalkboard: dark board, score-chart line, gray chalk tray at the bottom.
function ChalkboardIcon({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Board */}
      <rect x="2" y="2" width="24" height="20" rx="3" fill="#111827" />
      {/* Score-chart line — zigzag like a live game's momentum */}
      <path
        d="M5.5 17 L9 9.5 L13 14 L17.5 7.5 L22.5 12.5"
        stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      />
      {/* Chalk tray */}
      <rect x="2" y="21.5" width="24" height="3.5" rx="1.5" fill="#4b5563" />
      {/* Chalk piece */}
      <rect x="11.5" y="21" width="5" height="2.5" rx="1" fill="#e5e7eb" />
    </svg>
  );
}

// ─── FEATURE 1: Best Bet Card ─────────────────────────────────────────────────
// A highlighted hero card shown at the very top of the page.
// It's visually distinct to draw the eye immediately.
function BestBetCard({ bestBet }) {
  if (!bestBet) return null;
  const { game, league, favPct } = bestBet;
  const { home, away, teams, win_probability, spread, start_time } = game;

  // Determine the favorite from win_probability, spread string, or default to home
  let favAbbr;
  if (win_probability) {
    favAbbr = (win_probability[home] ?? 0) >= (win_probability[away] ?? 0) ? home : away;
  } else if (spread?.favorite) {
    const s = spread.favorite.toUpperCase();
    favAbbr = s.includes(home.toUpperCase()) ? home : s.includes(away.toUpperCase()) ? away : home;
  } else {
    favAbbr = home;
  }

  return (
    <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl p-5 mb-6 text-white shadow-lg">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="bg-yellow-400 text-gray-900 text-xs font-extrabold px-2 py-0.5 rounded-full tracking-wide">
            ⭐ BEST BET
          </span>
          <span className="text-gray-400 text-xs">{league}</span>
        </div>
        <span className="text-gray-400 text-xs">{formatTime(start_time)}</span>
      </div>

      {/* Matchup */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex-1">
          <div className="font-bold">{teams[away]?.name ?? away}</div>
          <div className="text-xs text-gray-400">Away</div>
        </div>
        <div className="text-gray-500 font-bold px-4">vs</div>
        <div className="flex-1 text-right">
          <div className="font-bold">{teams[home]?.name ?? home}</div>
          <div className="text-xs text-gray-400">Home</div>
        </div>
      </div>

      {/* Why it's the best bet */}
      <div className="bg-white/10 rounded-xl px-4 py-3 text-sm">
        {favPct !== null ? (
          <>
            <span className="text-yellow-300 font-bold">{teams[favAbbr]?.name ?? favAbbr}</span>
            {" "}is favored at{" "}
            <span className={`font-bold ${probTextClass(favPct)}`}>{favPct.toFixed(0)}%</span>
            {" "}win probability
            {spread && <> with a spread of <span className="font-bold text-white">{spread.favorite}</span></>}.
            {" "}
            <span className="text-gray-300">
              {favPct >= 75
                ? "This is one of today's clearest data edges."
                : "Stats lean this way — worth watching closely."}
            </span>
          </>
        ) : (
          <>
            <span className="text-yellow-300 font-bold">{teams[favAbbr]?.name ?? favAbbr}</span>
            {" "}is the listed favorite
            {spread?.favorite && <> at <span className="font-bold text-white">{spread.favorite}</span></>}
            {spread?.overUnder && <>, O/U <span className="font-bold text-white">{spread.overUnder}</span></>}.
            {" "}
            <span className="text-gray-300">Best available matchup today.</span>
          </>
        )}
      </div>
    </div>
  );
}

// ─── GameCard (updated with features 2, 3, 4, 5) ─────────────────────────────

function GameCard({ game, isFavorited, onToggleFavorite, scoreHistory, defaultExpanded, myTeams, onToggleMyTeam }) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  useEffect(() => { setExpanded(defaultExpanded ?? false); }, [defaultExpanded]);
  const { home, away, teams, score, status, clock, start_time, win_probability, spread } = game;
  const homeTeam = teams[home];
  const awayTeam = teams[away];
  const isScheduled = status === "scheduled";
  const isLive = status === "in_progress";
  const isFinal = status === "final" || status === "closed";
  const showUpsetAlert = isScheduled && isUpsetAlert(win_probability, home, away);
  const onARun = isLive ? getMomentum(scoreHistory, game.id, home, away) : null;
  const tense = isLive && isTenseMoment(game);
  const scoreDelta = isLive ? getScoreDelta(scoreHistory[game.id], home, away) : null;
  const scoreDeltaParts = scoreDelta
    ? [away, home].filter(a => (scoreDelta[a] ?? 0) > 0).map(a => `+${scoreDelta[a]} ${a}`)
    : [];

  const homeScore = score?.[home] ?? 0;
  const awayScore = score?.[away] ?? 0;
  const homeWon = isFinal && homeScore > awayScore;
  const awayWon = isFinal && awayScore > homeScore;

  return (
    <div className={`bg-white rounded-2xl mb-3 overflow-hidden transition-all
      ${isLive
        ? "shadow-md ring-2 ring-red-400/40"
        : isFavorited
        ? "shadow-sm ring-2 ring-indigo-300/60"
        : "shadow-sm hover:shadow-md border border-gray-100"}`}>

      {isLive && <div className="h-1 bg-gradient-to-r from-red-400 to-orange-400" />}
      {isFavorited && !isLive && <div className="h-1 bg-gradient-to-r from-indigo-400 to-violet-400" />}

      <div className="px-5 pt-4 pb-3">
        {/* Status row */}
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-2 min-w-0">
            {isLive ? <LiveBadge /> : (
              <span className={`text-xs font-semibold tracking-wide uppercase shrink-0
                ${isFinal ? "text-gray-400" : "text-indigo-500"}`}>
                {isFinal ? "Final" : "Upcoming"}
              </span>
            )}
            {isLive && clock && (
              <span className="text-xs font-medium text-gray-500 truncate">{clock}</span>
            )}
            {tense && (
              <span className="bg-orange-100 text-orange-600 text-xs font-bold px-2 py-0.5 rounded-full shrink-0 animate-pulse">
                ⚡ Tune in!
              </span>
            )}
            {showUpsetAlert && (
              <span className="bg-orange-100 text-orange-600 text-xs font-bold px-2 py-0.5 rounded-full shrink-0">
                ⚡ Upset Alert
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-gray-400">{formatTime(start_time)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleFavorite(game.id); }}
              className={`text-lg leading-none transition-all
                ${isFavorited ? "text-yellow-400 scale-110" : "text-gray-200 hover:text-yellow-300"}`}
            >★</button>
          </div>
        </div>

        {/* Teams */}
        <div className="flex items-center gap-3">
          {/* Away team */}
          <div className="flex-1 min-w-0 flex items-center gap-2 sm:gap-3">
            {awayTeam?.logo
              ? <img src={awayTeam.logo} alt="" className="w-9 h-9 sm:w-10 sm:h-10 object-contain flex-shrink-0" />
              : <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500 flex-shrink-0">{away}</div>
            }
            <div className="min-w-0">
              <div className={`font-bold text-sm leading-tight
                ${awayWon ? "text-green-600" : isFinal && !awayWon ? "text-gray-400" : "text-gray-900"}`}>
                <span className="hidden sm:block truncate">{awayTeam?.name ?? away}</span>
                <span className="sm:hidden">{away}</span>
              </div>
              <div className="flex items-center gap-1 text-xs text-gray-400">
                Away
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleMyTeam?.(away); }}
                  className={`leading-none transition-colors ${myTeams?.has(away) ? "text-indigo-400" : "text-gray-200 hover:text-indigo-300"}`}
                >♥</button>
              </div>
            </div>
          </div>

          {/* Score / VS */}
          <div className="text-center px-1 sm:px-2 shrink-0">
            {!isScheduled ? (
              <div className="font-black text-2xl tracking-tight font-mono tabular-nums text-gray-900">
                {score?.[away]} <span className="text-gray-300">–</span> {score?.[home]}
              </div>
            ) : (
              <div className="text-sm font-bold text-gray-300">vs</div>
            )}
            {onARun && (
              <div className="text-xs font-semibold text-orange-500 mt-1">
                🔥 {onARun} on a run
              </div>
            )}
            {scoreDeltaParts.length > 0 && (
              <div className="text-xs text-orange-400 font-semibold mt-0.5">
                {scoreDeltaParts.join(" · ")}
              </div>
            )}
          </div>

          {/* Home team */}
          <div className="flex-1 min-w-0 flex items-center justify-end gap-2 sm:gap-3 text-right">
            <div className="min-w-0">
              <div className={`font-bold text-sm leading-tight
                ${homeWon ? "text-green-600" : isFinal && !homeWon ? "text-gray-400" : "text-gray-900"}`}>
                <span className="hidden sm:block truncate">{homeTeam?.name ?? home}</span>
                <span className="sm:hidden">{home}</span>
              </div>
              <div className="flex items-center justify-end gap-1 text-xs text-gray-400">
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleMyTeam?.(home); }}
                  className={`leading-none transition-colors ${myTeams?.has(home) ? "text-indigo-400" : "text-gray-200 hover:text-indigo-300"}`}
                >♥</button>
                Home
              </div>
            </div>
            {homeTeam?.logo
              ? <img src={homeTeam.logo} alt="" className="w-9 h-9 sm:w-10 sm:h-10 object-contain flex-shrink-0" />
              : <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500 flex-shrink-0">{home}</div>
            }
          </div>
        </div>

        {/* Prob bar */}
        {win_probability && (isLive || isScheduled) && (
          <ProbBar
            home={win_probability[home]} homeAbbr={home}
            away={win_probability[away]} awayAbbr={away}
            draw={win_probability.draw}
          />
        )}

        {/* Spread */}
        {isScheduled && spread && (
          <div className="mt-3 pt-3 border-t border-gray-50 flex gap-4 text-xs text-gray-400">
            <span>📈 <span className="font-medium text-gray-600">{spread.favorite}</span></span>
            {spread.overUnder && <span>O/U <span className="font-medium text-gray-600">{spread.overUnder}</span></span>}
          </div>
        )}

        {/* Score timeline */}
        {isLive && scoreHistory[game.id]?.length > 1 && (
          <ScoreTimeline history={scoreHistory[game.id]} homeAbbr={home} awayAbbr={away} />
        )}

      </div>

      {/* Expanded stats/events — own padded section below the main content */}
      {expanded && (
        <div className="px-5 pb-4">
          <ExpandedSection game={game} scoreHistory={scoreHistory} />
        </div>
      )}

      {/* Toggle button — fixed card footer, never moves relative to the teams area */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-center gap-1 text-xs text-gray-300 hover:text-gray-500 transition-colors py-2.5 border-t border-gray-100"
      >
        <span className={`inline-block transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>▾</span>
        <span>{expanded ? "Less" : "Details"}</span>
      </button>
    </div>
  );
}

// ─── FEATURE 3: Favorites section ────────────────────────────────────────────
// Shows favorited games pinned at the top of the current tab, before other games.
function FavoritesSection({ games, favoriteIds, onToggleFavorite, scoreHistory, defaultExpanded, myTeams, onToggleMyTeam }) {
  const favGames = games.filter(g => favoriteIds.has(g.id));
  if (favGames.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 px-1">
        ★ Your Favorites
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        {favGames.map(g => (
          <GameCard
            key={g.id}
            game={g}
            isFavorited={true}
            onToggleFavorite={onToggleFavorite}
            scoreHistory={scoreHistory}
            defaultExpanded={defaultExpanded}
            myTeams={myTeams}
            onToggleMyTeam={onToggleMyTeam}
          />
        ))}
      </div>
      <div className="border-t border-gray-200 mb-4" />
    </div>
  );
}

function LeagueSection({ games, favoriteIds, onToggleFavorite, scoreHistory, expandDefault, onToggleExpand, myTeams, onToggleMyTeam }) {
  const [selectedDay, setSelectedDay] = useState(null);

  const live = games.filter(g => g.status === "in_progress");
  const upcoming = games.filter(g => g.status === "scheduled");
  const finished = games.filter(g => g.status === "final" || g.status === "closed");
  const sorted = [
    ...live,
    ...upcoming.sort((a, b) => new Date(a.start_time) - new Date(b.start_time)),
    ...finished.sort((a, b) => new Date(b.start_time) - new Date(a.start_time)),
  ];

  const today = new Date();
  const yesterday = new Date();
  const tomorrow = new Date();
  yesterday.setDate(today.getDate() - 1);
  tomorrow.setDate(today.getDate() + 1);

  const grouped = sorted.reduce((acc, game) => {
    const gameDate = new Date(game.start_time);
    let label;
    if (gameDate.toDateString() === today.toDateString()) label = "Today";
    else if (gameDate.toDateString() === yesterday.toDateString()) label = "Yesterday";
    else if (gameDate.toDateString() === tomorrow.toDateString()) label = "Tomorrow";
    else label = gameDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    if (!acc[label]) acc[label] = [];
    acc[label].push(game);
    return acc;
  }, {});

  const order = ["Today", "Tomorrow", "Yesterday"];
  const sortedLabels = [
    ...order.filter(l => grouped[l]),
    ...Object.keys(grouped).filter(l => !order.includes(l)),
  ];

  const activeDay = sortedLabels.includes(selectedDay)
    ? selectedDay
    : (sortedLabels.includes("Today") ? "Today" : sortedLabels[0]);

  const activeDayGames = activeDay ? (grouped[activeDay] ?? []) : [];

  return (
    <div>
      <FavoritesSection
        games={sorted}
        favoriteIds={favoriteIds}
        onToggleFavorite={onToggleFavorite}
        scoreHistory={scoreHistory}
        defaultExpanded={expandDefault}
        myTeams={myTeams}
        onToggleMyTeam={onToggleMyTeam}
      />

      {/* Day filter tabs + expand toggle */}
      {sortedLabels.length > 0 && (
        <div className="flex items-center gap-2 mb-5">
          <div className="flex gap-2 overflow-x-auto pb-1 flex-1 min-w-0">
            {sortedLabels.map(label => {
              const liveCount  = (grouped[label] ?? []).filter(g => g.status === "in_progress").length;
              const tenseCount = (grouped[label] ?? []).filter(g => isTenseMoment(g)).length;
              const isActive = activeDay === label;
              return (
                <button
                  key={label}
                  onClick={() => setSelectedDay(label)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors
                    ${isActive
                      ? "bg-gray-900 text-white"
                      : "bg-white border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-700"}`}
                >
                  {label}
                  {tenseCount > 0 && <span className="text-orange-500 animate-pulse">⚡</span>}
                  {liveCount > 0 ? (
                    <span className={`text-xs font-bold px-1.5 py-px rounded-full leading-none
                      ${isActive ? "bg-red-500 text-white" : "bg-red-100 text-red-600"}`}>
                      {liveCount}
                    </span>
                  ) : (
                    <span className="opacity-50">{grouped[label].length}</span>
                  )}
                </button>
              );
            })}
          </div>
          {/* Expand/collapse all toggle */}
          <button
            onClick={onToggleExpand}
            title={expandDefault ? "Collapse all cards" : "Expand all cards"}
            className="shrink-0 text-xs text-gray-400 hover:text-gray-700 border border-gray-200 bg-white rounded-lg px-2.5 py-1.5 transition-colors"
          >
            {expandDefault ? "⊟" : "⊞"}
          </button>
        </div>
      )}

      {/* Games for active day */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        {activeDayGames
          .filter(g => !favoriteIds.has(g.id))
          .map(g => (
            <GameCard
              key={g.id}
              game={g}
              isFavorited={false}
              onToggleFavorite={onToggleFavorite}
              scoreHistory={scoreHistory}
              defaultExpanded={expandDefault}
              myTeams={myTeams}
              onToggleMyTeam={onToggleMyTeam}
            />
          ))}
      </div>
    </div>
  );
}
// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState("NBA");
  const [allGames, setAllGames] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  // Feature 3: favoriteIds is a Set of game IDs the user has starred.
  // We store it in localStorage so it persists across page refreshes.
  // localStorage.getItem returns null if the key doesn't exist yet,
  // so we use JSON.parse with a fallback of "[]" (empty array).
  const [favoriteIds, setFavoriteIds] = useState(() => {
    const saved = localStorage.getItem("chalkboard_favorites");
    return new Set(saved ? JSON.parse(saved) : []);
  });

  const [expandDefault, setExpandDefault] = useState(
    () => localStorage.getItem("chalkboard_expand_default") === "true"
  );
  const toggleExpandDefault = () => {
    setExpandDefault(prev => {
      const next = !prev;
      localStorage.setItem("chalkboard_expand_default", String(next));
      return next;
    });
  };

  // My Teams: follow specific teams across all leagues
  const [myTeams, setMyTeams] = useState(() => {
    const saved = localStorage.getItem("chalkboard_my_teams");
    return new Set(saved ? JSON.parse(saved) : []);
  });
  const toggleMyTeam = useCallback((abbr) => {
    setMyTeams(prev => {
      const next = new Set(prev);
      if (next.has(abbr)) next.delete(abbr); else next.add(abbr);
      localStorage.setItem("chalkboard_my_teams", JSON.stringify(Array.from(next)));
      return next;
    });
  }, []);

  // Feature 4+5: scoreHistory tracks score snapshots for live games.
  // We use useRef instead of useState because we DON'T want React to
  // re-render every time we add a snapshot — it would cause an infinite loop
  // since we update it inside the fetch cycle.
  const scoreHistoryRef = useRef({});
  // But we DO need to trigger re-renders when we want to display it,
  // so we keep a separate "display" copy in state that we update less frequently.
  const [scoreHistory, setScoreHistory] = useState({});

  // Feature 3: toggle a game in/out of favorites and persist to localStorage
  const toggleFavorite = useCallback((gameId) => {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      if (next.has(gameId)) {
        next.delete(gameId);
      } else {
        next.add(gameId);
      }
      // Persist to localStorage — Array.from converts Set back to array for JSON
      localStorage.setItem("chalkboard_favorites", JSON.stringify(Array.from(next)));
      return next;
    });
  }, []);

  const fetchLeague = useCallback(async (league) => {
    const slug = LEAGUE_SLUGS[league];
    const response = await fetch(`${API_BASE}/scores/${slug}`);
    if (!response.ok) throw new Error(`Server error for ${league}: ${response.status}`);
    const data = await response.json();
    return data.games;
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const results = await Promise.all(
        LEAGUES.map(async (league) => {
          const games = await fetchLeague(league);
          return { league, games };
        })
      );

      const gameMap = {};
      for (const { league, games } of results) {
        gameMap[league] = games;

        // Feature 4+5: for every live game, append the current score to its history.
        // We cap history at 10 snapshots to avoid unbounded memory growth.
        for (const game of games) {
          if (game.status === "in_progress" && game.score) {
            const prev = scoreHistoryRef.current[game.id] ?? [];
            const lastSnap = prev[prev.length - 1];
            const currentSnap = { [game.home]: game.score[game.home], [game.away]: game.score[game.away], clock: game.clock ?? null };

            // Only add a new snapshot if the score actually changed
            const scoreChanged =
              !lastSnap ||
              lastSnap[game.home] !== currentSnap[game.home] ||
              lastSnap[game.away] !== currentSnap[game.away];

            if (scoreChanged) {
              scoreHistoryRef.current[game.id] = [...prev, currentSnap].slice(-10);
            }
          }
        }
      }

      setAllGames(gameMap);
      setLastRefresh(new Date());
      // Sync the ref into state so components re-render with new history
      setScoreHistory({ ...scoreHistoryRef.current });
    } catch (err) {
      console.error("Fetch failed:", err);
      setError("Could not reach the ChalkBoard server. Is it running? (node server.js)");
    } finally {
      setLoading(false);
    }
  }, [fetchLeague]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // Games for the "Following" tab — any game where a followed team is playing
  const followingGames = Object.values(allGames)
    .flat()
    .filter(g => myTeams.size > 0 && (myTeams.has(g.home) || myTeams.has(g.away)));

  const currentGames = activeTab === "★" ? followingGames : (allGames[activeTab] ?? []);
  const bestBet  = findBestBet(allGames);
  const bestLive = findBestLiveGame(allGames, scoreHistory);

  return (
    <div className="bg-gray-50 min-h-screen font-sans">

      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
      <div className="px-6 py-5 flex items-center justify-center relative">
        {/* Brand — centred */}
        <div className="flex items-center gap-2.5">
          <ChalkboardIcon size={30} />
          <span className="font-extrabold text-2xl tracking-tight">ChalkBoard</span>
        </div>
        {/* Refresh — small, pinned top-right */}
        <button
          onClick={fetchAll}
          disabled={loading}
          className="absolute right-5 top-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5 disabled:opacity-40"
        >
          <span className={`text-lg text-gray-400 hover:text-gray-700 transition-colors leading-none ${loading ? "animate-spin" : ""}`}>↻</span>
          {lastRefresh && (
            <span className="text-[10px] text-gray-300 leading-none tabular-nums">
              {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </button>
      </div>
      </div>

      {error && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-3 text-sm text-red-700">
          ⚠️ {error}
        </div>
      )}

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 flex overflow-x-auto px-3">
        {/* ★ Following tab — only visible when at least one team is followed */}
        {myTeams.size > 0 && (() => {
          const followingLive = followingGames.filter(g => g.status === "in_progress").length;
          const isActive = activeTab === "★";
          return (
            <button
              key="★"
              onClick={() => setActiveTab("★")}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors
                ${isActive
                  ? "font-bold text-gray-900 border-gray-900"
                  : "font-medium text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300"}`}
            >
              ★ Following
              {followingLive > 0 && (
                <span className="bg-red-600 text-white text-xs font-bold px-1.5 py-px rounded-full leading-none">
                  {followingLive}
                </span>
              )}
            </button>
          );
        })()}
        {LEAGUES.map(l => {
          const liveCount  = (allGames[l] ?? []).filter(g => g.status === "in_progress").length;
          const tenseCount = (allGames[l] ?? []).filter(g => isTenseMoment(g)).length;
          const isActive = activeTab === l;
          return (
            <button
              key={l}
              onClick={() => setActiveTab(l)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors
                ${isActive
                  ? "font-bold text-gray-900 border-gray-900"
                  : "font-medium text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300"}`}
            >
              {l}
              {tenseCount > 0 && <span className="text-orange-500 animate-pulse text-xs">⚡</span>}
              {liveCount > 0 && (
                <span className="bg-red-600 text-white text-xs font-bold px-1.5 py-px rounded-full leading-none">
                  {liveCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="bg-yellow-50 border-b border-yellow-200 px-6 py-2 text-xs text-yellow-800">
        📌 Win probabilities are statistical model outputs, not betting advice. Always gamble responsibly.
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-4 py-6">
        {!lastRefresh && loading ? (
          <div className="text-center py-16 text-gray-400">Connecting to ChalkBoard server...</div>
        ) : error && currentGames.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-8 text-center">
            <div className="text-2xl mb-2">🔌</div>
            <div className="font-semibold text-gray-700 mb-1">Server not connected</div>
            <div className="text-sm text-gray-500">
              Run <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">node server.js</code> then click Refresh.
            </div>
          </div>
        ) : (
          <>
            {/* Best live game — cross-league urgent alert */}
            <BestLiveCard bestLive={bestLive} />
            {/* Best upcoming bet — shown when no live games are active */}
            {!bestLive && <BestBetCard bestBet={bestBet} />}

            {currentGames.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                {activeTab === "★"
                  ? "Follow teams using the ♥ buttons on any game card."
                  : `No games found for ${activeTab}.`}
              </div>
            ) : (
              <LeagueSection
                games={currentGames}
                favoriteIds={favoriteIds}
                onToggleFavorite={toggleFavorite}
                scoreHistory={scoreHistory}
                expandDefault={expandDefault}
                onToggleExpand={toggleExpandDefault}
                myTeams={myTeams}
                onToggleMyTeam={toggleMyTeam}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
