import { useState, useEffect, useCallback, useRef } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001/api";
const REFRESH_INTERVAL = 30_000;

// Sport groups define the two-level navigation hierarchy.
// Each group has a sport label and an ordered list of league slugs with display names.
const SPORT_GROUPS = [
  { id: "basketball", label: "🏀 Basketball", leagues: [
    { slug: "nba",   label: "NBA" },
    { slug: "wnba",  label: "WNBA" },
  ]},
  { id: "football", label: "🏈 Football", leagues: [
    { slug: "nfl",   label: "NFL" },
    { slug: "ncaaf", label: "College" },
  ]},
  { id: "hockey", label: "🏒 Hockey", leagues: [
    { slug: "nhl",   label: "NHL" },
  ]},
  { id: "baseball", label: "⚾ Baseball", leagues: [
    { slug: "mlb",   label: "MLB" },
  ]},
  { id: "soccer", label: "⚽ Soccer", leagues: [
    { slug: "mls",        label: "MLS" },
    { slug: "nwsl",       label: "NWSL" },
    { slug: "ucl",        label: "Champions League" },
    { slug: "uel",        label: "Europa League" },
    { slug: "epl",        label: "Premier League" },
    { slug: "laliga",     label: "La Liga" },
    { slug: "bundesliga", label: "Bundesliga" },
    { slug: "seriea",     label: "Serie A" },
    { slug: "ligue1",     label: "Ligue 1" },
    { slug: "ligamx",     label: "Liga MX" },
  ]},
];

// Flat ordered list of all league slugs, used for fetching and iteration
const ALL_LEAGUE_IDS = SPORT_GROUPS.flatMap(g => g.leagues.map(l => l.slug));

// Set of soccer slugs for fast sport-type checks
const SOCCER_SLUGS = new Set(
  SPORT_GROUPS.find(g => g.id === "soccer")?.leagues.map(l => l.slug) ?? []
);

// Human-readable display name for a slug (e.g. "nba" → "NBA", "mls" → "MLS")
function leagueDisplayName(slug) {
  for (const group of SPORT_GROUPS) {
    const found = group.leagues.find(l => l.slug === slug);
    if (found) return found.label;
  }
  return slug.toUpperCase();
}

// Returns the SPORT_GROUPS entry that contains the given league slug, or null
function getSportGroup(slug) {
  return SPORT_GROUPS.find(g => g.leagues.some(l => l.slug === slug)) ?? null;
}

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

  // Third pass: no odds at all — just surface any upcoming game so the card isn't empty
  if (!best) {
    for (const slug of ALL_LEAGUE_IDS) {
      const next = (allGames[slug] ?? []).find(g => g.status === "scheduled");
      if (next) { best = { game: next, league: slug, favPct: null }; break; }
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
  const threshold = SOCCER_SLUGS.has(game.sport) ? 1 : ({ nba: 5, nfl: 8, nhl: 1, ncaaf: 10, mlb: 2, wnba: 5 }[game.sport] ?? 5);
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
  if (events?.length && SOCCER_SLUGS.has(sport)) {
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
  nba:        ["fieldGoalPct", "threePointPct", "freeThrowPct", "rebounds", "assists", "turnovers"],
  wnba:       ["fieldGoalPct", "threePointPct", "freeThrowPct", "rebounds", "assists", "turnovers"],
  nfl:        ["totalYards", "passingYards", "rushingYards", "firstDowns", "turnovers", "sacks"],
  ncaaf:      ["totalYards", "passingYards", "rushingYards", "firstDowns", "turnovers", "sacks"],
  nhl:        ["shots", "hits", "blocks", "faceoffWinPct", "powerPlayGoals", "pims"],
  mlb:        ["hits", "runs", "errors", "strikeouts", "walks", "homeRuns"],
  // Soccer — same keys for all leagues
  mls:        ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
  nwsl:       ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
  ucl:        ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
  uel:        ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
  epl:        ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
  laliga:     ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
  bundesliga: ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
  seriea:     ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
  ligue1:     ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
  ligamx:     ["possessionPct", "shots", "shotsOnTarget", "corners", "fouls"],
};

// Season-level stats to highlight in the team drawer (keyed by ESPN stat name)
const SEASON_STAT_DISPLAY = {
  nba:        ["points", "assists", "rebounds", "steals", "blocks", "fieldGoalPct", "threePointPct", "turnovers"],
  wnba:       ["points", "assists", "rebounds", "steals", "blocks", "fieldGoalPct", "threePointPct", "turnovers"],
  nfl:        ["pointsPerGame", "totalYards", "passingYards", "rushingYards", "sacks", "interceptions", "turnovers"],
  ncaaf:      ["pointsPerGame", "totalYards", "passingYards", "rushingYards", "sacks", "interceptions", "turnovers"],
  nhl:        ["goals", "assists", "points", "plusMinus", "savePct", "goalsAgainstAverage", "powerPlayPct"],
  mlb:        ["battingAvg", "homeRuns", "rbi", "ops", "era", "strikeouts", "wins"],
  // Soccer — same keys for all leagues
  mls:        ["goals", "assists", "shots", "shotsOnTarget", "possessionPct", "cleanSheets", "goalsAgainst"],
  nwsl:       ["goals", "assists", "shots", "shotsOnTarget", "possessionPct", "cleanSheets", "goalsAgainst"],
  ucl:        ["goals", "assists", "shots", "shotsOnTarget", "possessionPct", "cleanSheets", "goalsAgainst"],
  uel:        ["goals", "assists", "shots", "shotsOnTarget", "possessionPct", "cleanSheets", "goalsAgainst"],
  epl:        ["goals", "assists", "shots", "shotsOnTarget", "possessionPct", "cleanSheets", "goalsAgainst"],
  laliga:     ["goals", "assists", "shots", "shotsOnTarget", "possessionPct", "cleanSheets", "goalsAgainst"],
  bundesliga: ["goals", "assists", "shots", "shotsOnTarget", "possessionPct", "cleanSheets", "goalsAgainst"],
  seriea:     ["goals", "assists", "shots", "shotsOnTarget", "possessionPct", "cleanSheets", "goalsAgainst"],
  ligue1:     ["goals", "assists", "shots", "shotsOnTarget", "possessionPct", "cleanSheets", "goalsAgainst"],
  ligamx:     ["goals", "assists", "shots", "shotsOnTarget", "possessionPct", "cleanSheets", "goalsAgainst"],
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
function BestLiveCard({ bestLive, onTuneIn }) {
  if (!bestLive) return null;
  const { game, league } = bestLive;
  const { home, away, teams, score, clock } = game;
  const tense = isTenseMoment(game);

  function TeamLogo({ abbr, logo }) {
    return logo
      ? <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center shrink-0 shadow-sm">
          <img src={logo} alt={abbr} className="w-7 h-7 object-contain" />
        </div>
      : <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-xs font-bold text-gray-800 shrink-0 shadow-sm">{abbr}</div>;
  }

  return (
    <div className="bg-gradient-to-br from-red-600 to-orange-500 rounded-2xl p-4 mb-4 text-white shadow-lg">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          <span className="text-xs font-extrabold tracking-wider opacity-95">BEST LIVE GAME</span>
        </div>
        <span className="text-xs font-semibold opacity-70 uppercase tracking-wide">{leagueDisplayName(league)}</span>
      </div>
      <div className="flex items-center">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <TeamLogo abbr={away} logo={teams[away]?.logo} />
          <div className="min-w-0">
            <div className="font-bold text-sm truncate">{teams[away]?.name ?? away}</div>
            <div className="text-xs opacity-60">Away</div>
          </div>
        </div>
        <div className="text-center px-3 shrink-0">
          <div className="font-black text-2xl tabular-nums">{score?.[away]} – {score?.[home]}</div>
          {clock && <div className="text-xs opacity-70 mt-0.5">{clock}</div>}
        </div>
        <div className="flex items-center gap-2.5 flex-1 min-w-0 justify-end text-right">
          <div className="min-w-0">
            <div className="font-bold text-sm truncate">{teams[home]?.name ?? home}</div>
            <div className="text-xs opacity-60">Home</div>
          </div>
          <TeamLogo abbr={home} logo={teams[home]?.logo} />
        </div>
      </div>
      {tense && (
        <button
          onClick={() => onTuneIn?.(league, game.id)}
          className="mt-2.5 w-full text-center text-xs font-semibold bg-white/20 rounded-xl py-1.5 hover:bg-white/30 active:bg-white/40 transition-colors"
        >
          ⚡ Getting close — tune in now
        </button>
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
            🔥 BEST BET
          </span>
          <span className="text-gray-400 text-xs">{leagueDisplayName(league)}</span>
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
        ) : spread?.favorite ? (
          <>
            <span className="text-yellow-300 font-bold">{teams[favAbbr]?.name ?? favAbbr}</span>
            {" "}is the listed favorite at <span className="font-bold text-white">{spread.favorite}</span>
            {spread.overUnder && <>, O/U <span className="font-bold text-white">{spread.overUnder}</span></>}.
            {" "}<span className="text-gray-300">Best available matchup today.</span>
          </>
        ) : (
          <span className="text-gray-300">
            No odds available yet for this game — check back closer to tip-off.
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Featured (🔥 Today) tab ──────────────────────────────────────────────────
// Cross-league dashboard: best live game, best bet, all live action, top upcoming.
function FeaturedSection({ bestLive, bestBet, allGames, scoreHistory, onTuneIn, favoriteIds, onToggleFavorite, myTeams, onToggleMyTeam, onSelectTeam, focusedGameId }) {
  // All live games grouped by league, in league order
  const liveByLeague = ALL_LEAGUE_IDS
    .map(slug => ({ slug, games: (allGames[slug] ?? []).filter(g => g.status === "in_progress") }))
    .filter(({ games }) => games.length > 0);

  // Upcoming games today with upset alerts or odds, sorted by start time
  const upcomingNotable = ALL_LEAGUE_IDS
    .flatMap(slug => (allGames[slug] ?? []).filter(g => g.status === "scheduled" && (g.win_probability || g.spread)))
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    .slice(0, 6);

  const isEmpty = !bestLive && !bestBet && liveByLeague.length === 0 && upcomingNotable.length === 0;

  if (isEmpty) {
    return (
      <div className="text-center py-16 text-gray-400">
        <div className="text-3xl mb-3">🏟️</div>
        <div className="font-semibold">No highlights right now</div>
        <div className="text-sm mt-1">Check back when games are live or scheduled for today.</div>
      </div>
    );
  }

  return (
    <div>
      {bestLive && <BestLiveCard bestLive={bestLive} onTuneIn={onTuneIn} />}
      {bestBet && <BestBetCard bestBet={bestBet} />}

      {liveByLeague.length > 0 && (
        <div className="mb-6">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 px-1">🔴 Live Now</div>
          {liveByLeague.map(({ slug, games }) => (
            <div key={slug}>
              <div className="text-xs font-semibold text-gray-300 uppercase tracking-wider px-1 mb-1.5">{leagueDisplayName(slug)}</div>
              {games.map(g => (
                <GameCard
                  key={g.id}
                  game={g}
                  isFavorited={favoriteIds.has(g.id)}
                  onToggleFavorite={onToggleFavorite}
                  scoreHistory={scoreHistory}
                  defaultExpanded={false}
                  myTeams={myTeams}
                  onToggleMyTeam={onToggleMyTeam}
                  onSelectTeam={onSelectTeam}
                  focusedGameId={focusedGameId}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {upcomingNotable.length > 0 && (
        <div>
          <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 px-1">📅 Worth Watching Today</div>
          {upcomingNotable.map(g => (
            <GameCard
              key={g.id}
              game={g}
              isFavorited={favoriteIds.has(g.id)}
              onToggleFavorite={onToggleFavorite}
              scoreHistory={scoreHistory}
              defaultExpanded={false}
              myTeams={myTeams}
              onToggleMyTeam={onToggleMyTeam}
              onSelectTeam={onSelectTeam}
              focusedGameId={focusedGameId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Team Stats Panel ─────────────────────────────────────────────────────────
// Inline right-column card, same visual language as the game card "Details" section.
// Appears beside the game list when a team crest is clicked.
function TeamStatsPanel({ team, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!team?.id) { setLoading(false); return; }
    setLoading(true);
    setData(null);
    fetch(`${API_BASE}/team/${team.sport}/${team.id}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [team?.sport, team?.id]);

  const logo = data?.logo ?? team.logo;
  const statKeys = SEASON_STAT_DISPLAY[team.sport] ?? [];
  const statRows = data?.seasonStats
    ? (() => {
        const configured = statKeys.filter(k => data.seasonStats[k]).map(k => data.seasonStats[k]);
        return configured.length > 0
          ? configured
          : Object.values(data.seasonStats).slice(0, 8); // fallback: show whatever ESPN returned
      })()
    : [];

  // Use color from team API data, fall back to color from scoreboard data (available immediately),
  // then fall back to dark. ESPN returns hex without #, but guard against both formats.
  const rawColor = data?.color ?? team.color;
  let bgColor = "#111827";
  if (rawColor) bgColor = rawColor.startsWith("#") ? rawColor : `#${rawColor}`;

  return (
    <div className="bg-white h-full flex flex-col overflow-hidden">

      {/* Header — team color band */}
      <div
        className="px-5 pt-5 pb-4 flex items-center gap-3.5 shrink-0 transition-colors duration-500"
        style={{ backgroundColor: bgColor }}
      >
        <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center shrink-0">
          {logo
            ? <img src={logo} alt="" className="w-9 h-9 object-contain" />
            : <span className="text-xs font-bold text-white">{team.abbr}</span>
          }
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-base text-white truncate leading-tight">{data?.name ?? team.name}</div>
          <div className="text-sm text-white/70 mt-0.5">
            {loading ? "Loading…" : (data?.record?.summary ?? "—")}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-white/60 hover:text-white text-2xl leading-none shrink-0 transition-colors ml-1"
        >×</button>
      </div>

      {/* Body — scrollable */}
      <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
        {loading ? (
          <div className="px-4 py-10 text-center text-xs text-gray-400">Loading…</div>
        ) : !data || data.error ? (
          <div className="px-4 py-10 text-center text-xs text-gray-400">No data available</div>
        ) : (
          <>
            {/* ── Streak ── */}
            {data.streak && (
              <div className="px-4 py-3">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Streak</div>
                <div className={`text-sm font-bold ${data.streak.type === "W" ? "text-green-600" : data.streak.type === "L" ? "text-red-500" : "text-gray-500"}`}>
                  {data.streak.type === "W" ? "🔥" : data.streak.type === "L" ? "❄️" : "➖"}
                  {" "}{data.streak.count} {data.streak.type === "W" ? "wins" : data.streak.type === "L" ? "losses" : "draws"} in a row
                </div>
              </div>
            )}

            {/* ── Season stats grid ── */}
            {statRows.length > 0 && (
              <div className="px-4 py-3">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Season Stats</div>
                <div className="grid grid-cols-2 gap-2">
                  {statRows.map((stat, i) => (
                    <div key={i} className="bg-gray-50 rounded-xl px-3 py-2.5">
                      <div className="text-lg font-extrabold text-gray-900 tabular-nums leading-none">{stat.value}</div>
                      <div className="text-xs text-gray-400 mt-1 font-medium">{stat.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Season highlights ── */}
            {(data.bestGame?.margin > 0 || data.worstGame?.margin < 0) && (
              <div className="px-4 py-3">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Highlights</div>
                <div className="space-y-1.5">
                  {data.bestGame?.margin > 0 && (
                    <div className="flex items-center gap-2 bg-green-50 rounded-xl px-3 py-2">
                      <span className="text-green-500 font-bold text-sm shrink-0">↑</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-400">Best win</div>
                        <div className="text-xs font-semibold text-gray-800 truncate">{data.bestGame.isHome ? "vs" : "@"} {data.bestGame.opponent}</div>
                      </div>
                      <span className="tabular-nums text-xs font-bold text-gray-700 shrink-0">{data.bestGame.teamScore}–{data.bestGame.oppScore}</span>
                    </div>
                  )}
                  {data.worstGame?.margin < 0 && (
                    <div className="flex items-center gap-2 bg-red-50 rounded-xl px-3 py-2">
                      <span className="text-red-400 font-bold text-sm shrink-0">↓</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-400">Worst loss</div>
                        <div className="text-xs font-semibold text-gray-800 truncate">{data.worstGame.isHome ? "vs" : "@"} {data.worstGame.opponent}</div>
                      </div>
                      <span className="tabular-nums text-xs font-bold text-gray-700 shrink-0">{data.worstGame.teamScore}–{data.worstGame.oppScore}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Recent form ── */}
            {data.recentGames?.length > 0 && (
              <div className="px-4 py-3">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                  Last {data.recentGames.length} games
                </div>
                <div className="flex gap-2 flex-wrap mb-2.5">
                  {data.recentGames.map((g, i) => (
                    <div key={i} className="flex flex-col items-center gap-0.5" title={`${g.isHome ? "vs" : "@"} ${g.opponent}`}>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0
                        ${g.result === "W" ? "bg-green-500" : g.result === "L" ? "bg-red-400" : "bg-gray-400"}`}
                      >{g.result}</div>
                      {g.teamScore != null && g.oppScore != null && (
                        <div className="text-[10px] tabular-nums text-gray-400 leading-none">{g.teamScore}–{g.oppScore}</div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="space-y-1.5">
                  {data.recentGames.map((g, i) => {
                    const dateStr = new Date(g.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
                    return (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className={`font-bold w-3 shrink-0 ${g.result === "W" ? "text-green-600" : g.result === "L" ? "text-red-500" : "text-gray-400"}`}>
                          {g.result}
                        </span>
                        <span className="text-gray-400 shrink-0 w-4">{g.isHome ? "vs" : "@"}</span>
                        <span className="font-medium text-gray-800 flex-1 truncate">{g.opponent}</span>
                        {g.teamScore != null && g.oppScore != null && (
                          <span className="tabular-nums text-gray-500 shrink-0">{g.teamScore}–{g.oppScore}</span>
                        )}
                        <span className="text-gray-300 shrink-0 w-12 text-right">{dateStr}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Roster ── */}
            {data.topPlayers?.length > 0 && (
              <div className="px-4 py-3 pb-5">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Roster</div>
                <div className="space-y-2.5">
                  {data.topPlayers.map((p, i) => (
                    <div key={i} className="flex items-center gap-2.5">
                      {p.headshot
                        ? <img src={p.headshot} alt="" className="w-8 h-8 rounded-full object-cover shrink-0 bg-gray-100" />
                        : <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500 shrink-0">
                            {p.jersey ?? "?"}
                          </div>
                      }
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-xs text-gray-900 truncate">{p.name}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {p.position && <span>{p.position}</span>}
                          {p.jersey && <span className="ml-1.5">#{p.jersey}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── GameCard (updated with features 2, 3, 4, 5) ─────────────────────────────

function GameCard({ game, isFavorited, onToggleFavorite, scoreHistory, defaultExpanded, myTeams, onToggleMyTeam, onSelectTeam, focusedGameId }) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const cardRef = useRef(null);
  useEffect(() => { setExpanded(defaultExpanded ?? false); }, [defaultExpanded]);

  // Scroll into view and auto-expand when this card is focused via "Tune In"
  useEffect(() => {
    if (focusedGameId === game.id && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      setExpanded(true);
    }
  }, [focusedGameId, game.id]);
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
    <div
      ref={cardRef}
      className={`bg-white rounded-2xl mb-3 overflow-hidden transition-all
        ${focusedGameId === game.id ? "ring-2 ring-orange-400 shadow-lg" : ""}
        ${isLive
          ? "shadow-md ring-2 ring-red-400/40"
          : isFavorited
          ? "shadow-sm ring-2 ring-indigo-300/60"
          : "shadow-sm hover:shadow-md border border-gray-100"}`}
    >

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
            <button
              onClick={(e) => { e.stopPropagation(); onSelectTeam?.({ abbr: away, id: awayTeam?.id, name: awayTeam?.name ?? away, logo: awayTeam?.logo ?? null, color: awayTeam?.color ?? null, sport: game.sport }); }}
              className="shrink-0 hover:scale-110 active:scale-95 transition-transform"
            >
              {awayTeam?.logo
                ? <img src={awayTeam.logo} alt={away} className="w-9 h-9 sm:w-10 sm:h-10 object-contain" />
                : <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500">{away}</div>
              }
            </button>
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
            <button
              onClick={(e) => { e.stopPropagation(); onSelectTeam?.({ abbr: home, id: homeTeam?.id, name: homeTeam?.name ?? home, logo: homeTeam?.logo ?? null, color: homeTeam?.color ?? null, sport: game.sport }); }}
              className="shrink-0 hover:scale-110 active:scale-95 transition-transform"
            >
              {homeTeam?.logo
                ? <img src={homeTeam.logo} alt={home} className="w-9 h-9 sm:w-10 sm:h-10 object-contain" />
                : <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500">{home}</div>
              }
            </button>
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
function FavoritesSection({ games, favoriteIds, onToggleFavorite, scoreHistory, defaultExpanded, myTeams, onToggleMyTeam, onSelectTeam, focusedGameId }) {
  const favGames = games.filter(g => favoriteIds.has(g.id));
  if (favGames.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 px-1">
        ★ Your Favorites
      </div>
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
          onSelectTeam={onSelectTeam}
          focusedGameId={focusedGameId}
        />
      ))}
      <div className="border-t border-gray-200 mb-4" />
    </div>
  );
}

function LeagueSection({ games, favoriteIds, onToggleFavorite, scoreHistory, expandDefault, onToggleExpand, myTeams, onToggleMyTeam, onSelectTeam, focusedGameId }) {
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
        onSelectTeam={onSelectTeam}
        focusedGameId={focusedGameId}
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
            onSelectTeam={onSelectTeam}
            focusedGameId={focusedGameId}
          />
        ))}
    </div>
  );
}
// ─── Mobile Tab Picker ────────────────────────────────────────────────────────
function MobileTabPicker({ activeTab, onSetTab, myTeams, allGames, followingGames }) {
  const [open, setOpen] = useState(false);

  const totalLive = Object.values(allGames).flat().filter(g => g.status === "in_progress").length;
  const followingLive = followingGames.filter(g => g.status === "in_progress").length;

  // Current tab label for the trigger button
  const activeLabel =
    activeTab === "🔥" ? "🔥 Today"
    : activeTab === "★" ? "★ Following"
    : leagueDisplayName(activeTab);
  const activeLiveBadge =
    activeTab === "🔥" ? (totalLive > 0 ? totalLive : null)
    : activeTab === "★" ? (followingLive > 0 ? followingLive : null)
    : ((allGames[activeTab] ?? []).filter(g => g.status === "in_progress").length || null);

  return (
    <div className="sm:hidden bg-white border-b border-gray-200 px-4 py-2.5 relative z-10">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-2.5 text-sm font-semibold text-gray-900"
      >
        <div className="flex items-center gap-2">
          <span>{activeLabel}</span>
          {activeLiveBadge && (
            <span className="bg-red-500 text-white text-xs font-bold px-1.5 py-px rounded-full leading-none">{activeLiveBadge}</span>
          )}
        </div>
        <span className={`text-gray-400 text-xs transition-transform duration-200 ${open ? "rotate-180" : ""}`}>▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-4 right-4 top-full mt-2 bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden z-40 max-h-[70vh] overflow-y-auto">
            {/* Today */}
            <button
              onClick={() => { onSetTab("🔥"); setOpen(false); }}
              className={`w-full flex items-center justify-between px-4 py-3.5 text-sm border-b border-gray-50 transition-colors
                ${activeTab === "🔥" ? "bg-gray-50 font-semibold text-gray-900" : "text-gray-600 hover:bg-gray-50"}`}
            >
              <span>🔥 Today</span>
              <div className="flex items-center gap-2">
                {totalLive > 0 && <span className="bg-red-500 text-white text-xs font-bold px-1.5 py-px rounded-full leading-none">{totalLive}</span>}
                {activeTab === "🔥" && <span className="text-indigo-500 text-sm font-bold">✓</span>}
              </div>
            </button>
            {/* Following */}
            {myTeams.size > 0 && (
              <button
                onClick={() => { onSetTab("★"); setOpen(false); }}
                className={`w-full flex items-center justify-between px-4 py-3.5 text-sm border-b border-gray-50 transition-colors
                  ${activeTab === "★" ? "bg-gray-50 font-semibold text-gray-900" : "text-gray-600 hover:bg-gray-50"}`}
              >
                <span>★ Following</span>
                <div className="flex items-center gap-2">
                  {followingLive > 0 && <span className="bg-red-500 text-white text-xs font-bold px-1.5 py-px rounded-full leading-none">{followingLive}</span>}
                  {activeTab === "★" && <span className="text-indigo-500 text-sm font-bold">✓</span>}
                </div>
              </button>
            )}
            {/* Sport groups + nested leagues */}
            {SPORT_GROUPS.map(group => {
              const groupLiveCount = group.leagues.reduce(
                (sum, l) => sum + (allGames[l.slug] ?? []).filter(g => g.status === "in_progress").length, 0
              );
              return (
                <div key={group.id}>
                  {/* Group header — not tappable, just a label */}
                  <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-100">
                    <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">{group.label}</span>
                    {groupLiveCount > 0 && (
                      <span className="bg-red-100 text-red-600 text-xs font-bold px-1.5 py-px rounded-full leading-none">{groupLiveCount}</span>
                    )}
                  </div>
                  {/* League rows */}
                  {group.leagues.map(league => {
                    const liveCount = (allGames[league.slug] ?? []).filter(g => g.status === "in_progress").length;
                    const isActive = activeTab === league.slug;
                    return (
                      <button
                        key={league.slug}
                        onClick={() => { onSetTab(league.slug); setOpen(false); }}
                        className={`w-full flex items-center justify-between pl-6 pr-4 py-3 text-sm border-b border-gray-50 last:border-0 transition-colors
                          ${isActive ? "bg-gray-50 font-semibold text-gray-900" : "text-gray-600 hover:bg-gray-50"}`}
                      >
                        <span>{league.label}</span>
                        <div className="flex items-center gap-2">
                          {liveCount > 0 && <span className="bg-red-500 text-white text-xs font-bold px-1.5 py-px rounded-full leading-none">{liveCount}</span>}
                          {isActive && <span className="text-indigo-500 text-sm font-bold">✓</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState("🔥");
  const [allGames, setAllGames] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [focusedGameId, setFocusedGameId] = useState(null);

  // "Tune in now" — switch to the right league tab and highlight the game card
  const handleTuneIn = useCallback((league, gameId) => {
    setActiveTab(league);
    setFocusedGameId(gameId);
    setTimeout(() => setFocusedGameId(null), 2000);
  }, []);

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

  const fetchLeague = useCallback(async (slug) => {
    const response = await fetch(`${API_BASE}/scores/${slug}`);
    if (!response.ok) throw new Error(`Server error for ${slug}: ${response.status}`);
    const data = await response.json();
    return { slug, games: data.games };
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Promise.allSettled lets individual league failures be skipped without killing the whole refresh
      const results = await Promise.allSettled(
        ALL_LEAGUE_IDS.map(slug => fetchLeague(slug))
      );

      const gameMap = {};
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const { slug, games } = result.value;
        gameMap[slug] = games;

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

      if (Object.keys(gameMap).length === 0) {
        setError("Could not reach the ChalkBoard server. Is it running? (node server.js)");
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

  // currentGames: activeTab is now always "🔥", "★", or a league slug
  const currentGames = activeTab === "★" ? followingGames : activeTab === "🔥" ? [] : (allGames[activeTab] ?? []);
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

      {/* Mobile tab picker — shown only on small screens */}
      <MobileTabPicker
        activeTab={activeTab}
        onSetTab={setActiveTab}
        myTeams={myTeams}
        allGames={allGames}
        followingGames={followingGames}
      />

      {/* Desktop tab bar — hidden on small screens, two-row sport group nav */}
      {(() => {
        const activeSportGroup = getSportGroup(activeTab);
        const totalLive = Object.values(allGames).flat().filter(g => g.status === "in_progress").length;
        const followingLive = followingGames.filter(g => g.status === "in_progress").length;
        return (
          <div className="hidden sm:block bg-white border-b border-gray-200">
            {/* Row 1: Today, Following, sport groups */}
            <div className="flex overflow-x-auto px-3">
              <button
                onClick={() => setActiveTab("🔥")}
                className={`flex items-center gap-1.5 px-4 py-3 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors
                  ${activeTab === "🔥"
                    ? "font-bold text-gray-900 border-gray-900"
                    : "font-medium text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300"}`}
              >
                🔥 Today
                {totalLive > 0 && (
                  <span className="bg-red-600 text-white text-xs font-bold px-1.5 py-px rounded-full leading-none">{totalLive}</span>
                )}
              </button>
              {myTeams.size > 0 && (
                <button
                  onClick={() => setActiveTab("★")}
                  className={`flex items-center gap-1.5 px-4 py-3 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors
                    ${activeTab === "★"
                      ? "font-bold text-gray-900 border-gray-900"
                      : "font-medium text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300"}`}
                >
                  ★ Following
                  {followingLive > 0 && (
                    <span className="bg-red-600 text-white text-xs font-bold px-1.5 py-px rounded-full leading-none">{followingLive}</span>
                  )}
                </button>
              )}
              {SPORT_GROUPS.map(group => {
                const isGroupActive = group.leagues.some(l => l.slug === activeTab);
                const groupLiveCount = group.leagues.reduce(
                  (sum, l) => sum + (allGames[l.slug] ?? []).filter(g => g.status === "in_progress").length, 0
                );
                const hasMultiple = group.leagues.length > 1;
                return (
                  <button
                    key={group.id}
                    onClick={() => { if (!isGroupActive) setActiveTab(group.leagues[0].slug); }}
                    className={`flex items-center gap-1.5 px-4 py-3 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors
                      ${isGroupActive
                        ? "font-bold text-gray-900 border-gray-900"
                        : "font-medium text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300"}`}
                  >
                    {group.label}
                    {hasMultiple && <span className="text-gray-400 text-xs">▾</span>}
                    {groupLiveCount > 0 && (
                      <span className="bg-red-600 text-white text-xs font-bold px-1.5 py-px rounded-full leading-none">{groupLiveCount}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Row 2: sub-leagues (only when a sport group with multiple leagues is active) */}
            {activeSportGroup && activeSportGroup.leagues.length > 1 && (
              <div className="flex overflow-x-auto px-4 py-1.5 gap-1 bg-gray-50 border-t border-gray-100">
                {activeSportGroup.leagues.map(league => {
                  const isActive = activeTab === league.slug;
                  const liveCount = (allGames[league.slug] ?? []).filter(g => g.status === "in_progress").length;
                  const tenseCount = (allGames[league.slug] ?? []).filter(g => isTenseMoment(g)).length;
                  return (
                    <button
                      key={league.slug}
                      onClick={() => setActiveTab(league.slug)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors
                        ${isActive
                          ? "bg-gray-900 text-white"
                          : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"}`}
                    >
                      {league.label}
                      {tenseCount > 0 && <span className="text-orange-400 animate-pulse">⚡</span>}
                      {liveCount > 0 && (
                        <span className={`text-xs font-bold px-1.5 py-px rounded-full leading-none
                          ${isActive ? "bg-red-500 text-white" : "bg-red-100 text-red-600"}`}>
                          {liveCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      <div className="bg-yellow-50 border-b border-yellow-200 px-6 py-2 text-xs text-yellow-800">
        📌 Win probabilities are statistical model outputs, not betting advice. Always gamble responsibly.
      </div>

      {/* Team stats panel — fixed right overlay, slides in with translateX */}
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-20 bg-black/25 transition-opacity duration-300 ${selectedTeam ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        onClick={() => setSelectedTeam(null)}
      />
      {/* Sliding panel */}
      <div className={`fixed right-0 top-0 h-full w-[min(27rem,100vw)] bg-white shadow-2xl z-30 transition-transform duration-300 ease-out overflow-hidden ${selectedTeam ? "translate-x-0" : "translate-x-full"}`}>
        {selectedTeam && (
          <TeamStatsPanel
            team={selectedTeam}
            onClose={() => setSelectedTeam(null)}
          />
        )}
      </div>

      {/* Content — single centered column, never shifts when panel opens */}
      <div className="px-4 py-6">
        <div className="flex justify-center">
          <div className="w-full max-w-2xl min-w-0">
            {!lastRefresh && loading ? (
              <div className="text-center py-16 text-gray-400">Connecting to ChalkBoard server...</div>
            ) : error && activeTab !== "🔥" && currentGames.length === 0 ? (
              <div className="bg-white border border-gray-200 rounded-xl px-5 py-8 text-center">
                <div className="text-2xl mb-2">🔌</div>
                <div className="font-semibold text-gray-700 mb-1">Server not connected</div>
                <div className="text-sm text-gray-500">
                  Run <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">node server.js</code> then click Refresh.
                </div>
              </div>
            ) : activeTab === "🔥" ? (
              <FeaturedSection
                bestLive={bestLive}
                bestBet={bestBet}
                allGames={allGames}
                scoreHistory={scoreHistory}
                onTuneIn={handleTuneIn}
                favoriteIds={favoriteIds}
                onToggleFavorite={toggleFavorite}
                myTeams={myTeams}
                onToggleMyTeam={toggleMyTeam}
                onSelectTeam={setSelectedTeam}
                focusedGameId={focusedGameId}
              />
            ) : currentGames.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                {activeTab === "★"
                  ? "Follow teams using the ♥ buttons on any game card."
                  : `No games found for ${leagueDisplayName(activeTab)}.`}
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
                onSelectTeam={setSelectedTeam}
                focusedGameId={focusedGameId}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
