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

function findBestBet(allGames) {
  let best = null;
  let bestSkew = 0;
  for (const [league, games] of Object.entries(allGames)) {
    for (const game of games) {
      if (game.status !== "scheduled" || !game.win_probability) continue;
      const homePct = game.win_probability[game.home] ?? 50;
      const awayPct = game.win_probability[game.away] ?? 50;
      const skew = Math.abs(homePct - awayPct);
      if (skew > bestSkew) {
        best = { game, league, favPct: Math.max(homePct, awayPct) };
        bestSkew = skew;
      }
    }
  }
  return best;
}

function isUpsetAlert(win_probability, home, away) {
  if (!win_probability) return false;
  const diff = Math.abs((win_probability[home] ?? 50) - (win_probability[away] ?? 50));
  return diff <= 15;
}

function getMomentum(scoreHistory, gameId, homeAbbr, awayAbbr) {
  const history = scoreHistory[gameId];
  if (!history || history.length < 2) return null;
  const prev = history[history.length - 2], curr = history[history.length - 1];
  const homeScored = curr[homeAbbr] > prev[homeAbbr], awayScored = curr[awayAbbr] > prev[awayAbbr];
  if (homeScored && !awayScored) return homeAbbr;
  if (awayScored && !homeScored) return awayAbbr;
  return null;
}

// ─── Components ────────────────────────────────────────────────────────────────

function ScoreTimeline({ history, homeAbbr, awayAbbr }) {
  if (!history || history.length < 2) return null;
  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="text-xs text-gray-400 mb-1.5 font-medium">Score timeline</div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {history.map((snap, i) => (
          <div key={i} className="flex flex-col items-center min-w-[40px]">
            <div className="text-xs font-mono font-bold text-gray-700">{snap[awayAbbr]}–{snap[homeAbbr]}</div>
            <div className="text-xs text-gray-300 mt-0.5">{i === 0 ? "start" : `+${i * 30}s`}</div>
          </div>
        ))}
        <div className="text-gray-200 self-center text-sm">→</div>
      </div>
    </div>
  );
}

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 bg-red-100 text-red-600 text-xs font-bold tracking-wider px-2 py-0.5 rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
      LIVE
    </span>
  );
}

function ProbBar({ home = 50, homeAbbr, away = 50, awayAbbr, draw }) {
  const showDraw = draw != null;
  const total = home + away + (draw ?? 0);
  const homePct = (home / total) * 100;
  const awayPct = (away / total) * 100;
  const drawPct = showDraw ? (draw / total) * 100 : 0;
  const favPct = Math.max(home, away);
  const favTeam = home >= away ? homeAbbr : awayAbbr;

  return (
    <div className="mt-3">
      <div className="flex justify-between mb-1 text-xs text-gray-500">
        <span>{homeAbbr} <strong className={probTextClass(home)}>{home.toFixed(0)}%</strong></span>
        {showDraw && <span>Draw <strong className={probTextClass(draw)}>{draw.toFixed(0)}%</strong></span>}
        <span><strong className={probTextClass(away)}>{away.toFixed(0)}%</strong> {awayAbbr}</span>
      </div>
      <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-100">
        <div className={`${probBgClass(home)} transition-all duration-500`} style={{ width: `${homePct}%` }} />
        {showDraw && <div className={`${probBgClass(draw)} transition-all duration-500`} style={{ width: `${drawPct}%` }} />}
        <div className={`${probBgClass(away)} transition-all duration-500`} style={{ width: `${awayPct}%` }} />
      </div>
      <div className="mt-1.5 text-xs text-gray-500">
        📊 <span className={`font-semibold ${probTextClass(favPct)}`}>{edgeLabel(favPct)}</span> → <strong>{favTeam}</strong>
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

function BestBetCard({ bestBet }) {
  if (!bestBet) return null;
  const { game, league, favPct } = bestBet;
  const favAbbr = game.win_probability[game.home] >= game.win_probability[game.away] ? game.home : game.away;

  return (
    <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl p-5 mb-6 text-white shadow-lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="bg-yellow-400 text-gray-900 text-xs font-extrabold px-2 py-0.5 rounded-full tracking-wide">⭐ BEST BET</span>
          <span className="text-gray-400 text-xs">{league}</span>
        </div>
        <span className="text-gray-400 text-xs">{formatTime(game.start_time)}</span>
      </div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex-1">
          <div className="font-bold">{game.teams[game.away]?.name ?? game.away}</div>
          <div className="text-xs text-gray-400">Away</div>
        </div>
        <div className="text-gray-500 font-bold px-4">vs</div>
        <div className="flex-1 text-right">
          <div className="font-bold">{game.teams[game.home]?.name ?? game.home}</div>
          <div className="text-xs text-gray-400">Home</div>
        </div>
      </div>
      <div className="bg-white/10 rounded-xl px-4 py-3 text-sm">
        <span className="text-yellow-300 font-bold">{game.teams[favAbbr]?.name ?? favAbbr}</span> is favored at{" "}
        <span className={`font-bold ${probTextClass(favPct)}`}>{favPct.toFixed(0)}%</span> win probability
        {game.spread && <> with a spread of <span className="font-bold text-white">{game.spread.favorite}</span></>}.
      </div>
    </div>
  );
}

// ─── Date Utilities ───────────────────────────────────────────────────────────

function getNextDateWithGames(games, today = new Date()) {
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const grouped = games.reduce((acc, game) => {
    const d = new Date(game.start_time);
    let label;
    if (d.toDateString() === today.toDateString()) label = "Today";
    else if (d.toDateString() === tomorrow.toDateString()) label = "Tomorrow";
    else label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    (acc[label] = acc[label] || []).push(game);
    return acc;
  }, {});
  const futureLabels = Object.keys(grouped).filter(l => l !== "Today");
  if (!futureLabels.length) return null;
  return futureLabels.reduce((earliest, label) => {
    const parseLabel = label === "Tomorrow" ? tomorrow : new Date(`${label} ${today.getFullYear()}`);
    return parseLabel < new Date(`${earliest} ${today.getFullYear()}`) ? label : earliest;
  }, futureLabels[0]);
}

// ─── Game Card ───────────────────────────────────────────────────────────────

function GameCard({ game, isFavorited, onToggleFavorite, scoreHistory }) {
  const { home, away, teams, score, status, start_time, win_probability, spread, id } = game;
  const isLive = status === "in_progress";
  const isFinal = status === "final" || status === "closed";
  const showUpsetAlert = isUpsetAlert(win_probability, home, away);
  const onARun = isLive ? getMomentum(scoreHistory, id, home, away) : null;
  const homeScore = score?.[home] ?? 0;
  const awayScore = score?.[away] ?? 0;

  return (
    <div className={`bg-white rounded-2xl mb-3 overflow-hidden transition-all
      ${isLive ? "shadow-md ring-2 ring-red-400/40" : isFavorited ? "shadow-sm ring-2 ring-indigo-300/60" : "shadow-sm hover:shadow-md border border-gray-100"}`}>
      {isLive && <div className="h-1 bg-gradient-to-r from-red-400 to-orange-400" />}
      {isFavorited && !isLive && <div className="h-1 bg-gradient-to-r from-indigo-400 to-violet-400" />}
      <div className="px-5 py-4">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-2">
            {isLive ? <LiveBadge /> : <span className={`text-xs font-semibold tracking-wide uppercase ${isFinal ? "text-gray-400" : "text-indigo-500"}`}>{isFinal ? "Final" : "Upcoming"}</span>}
            {showUpsetAlert && <span className="bg-orange-100 text-orange-600 text-xs font-bold px-2 py-0.5 rounded-full">⚡ Upset Alert</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">{formatTime(start_time)}</span>
            <button onClick={() => onToggleFavorite(id)} className={`text-lg leading-none transition-all ${isFavorited ? "text-yellow-400 scale-110" : "text-gray-200 hover:text-yellow-300"}`}>★</button>
          </div>
        </div>

        <div className="flex items-center justify-between mb-3">
          <div className="flex-1">
            <div className="font-bold">{teams[away]?.name ?? away}</div>
            <div className="text-xs text-gray-400">Away</div>
          </div>
          <div className="text-gray-500 font-bold px-4">{isLive || isFinal ? `${awayScore}–${homeScore}` : "vs"}</div>
          <div className="flex-1 text-right">
            <div className="font-bold">{teams[home]?.name ?? home}</div>
            <div className="text-xs text-gray-400">Home</div>
          </div>
        </div>

        <ProbBar home={win_probability?.[home] ?? 50} away={win_probability?.[away] ?? 50} homeAbbr={home} awayAbbr={away} />
        <SpreadBadge spread={spread} />
        <ScoreTimeline history={scoreHistory[id]} homeAbbr={home} awayAbbr={away} />
      </div>
    </div>
  );
}

// ─── Favorites Section ───────────────────────────────────────────────────────

function FavoritesSection({ games, favoriteIds, onToggleFavorite, scoreHistory }) {
  const favGames = games.filter(g => favoriteIds.has(g.id));
  if (!favGames.length) return null;
  return (
    <div className="mb-4">
      <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 px-1">★ Your Favorites</div>
      {favGames.map(g => <GameCard key={g.id} game={g} isFavorited={true} onToggleFavorite={onToggleFavorite} scoreHistory={scoreHistory} />)}
      <div className="border-t border-gray-200 mb-4" />
    </div>
  );
}

// ─── League Section ──────────────────────────────────────────────────────────

function LeagueSection({ games, favoriteIds, onToggleFavorite, scoreHistory }) {
  const today = new Date();
  const grouped = games.reduce((acc, game) => {
    const d = new Date(game.start_time);
    let label = d.toDateString() === today.toDateString() ? "Today" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    (acc[label] = acc[label] || []).push(game);
    return acc;
  }, {});
  const sortedLabels = Object.keys(grouped).sort((a, b) => new Date(grouped[a][0].start_time) - new Date(grouped[b][0].start_time));
  const hasGamesToday = grouped["Today"]?.length > 0;
  const nextDateWithGames = getNextDateWithGames(games, today);

  return (
    <div>
      <FavoritesSection games={games} favoriteIds={favoriteIds} onToggleFavorite={onToggleFavorite} scoreHistory={scoreHistory} />
      {!hasGamesToday && nextDateWithGames && grouped[nextDateWithGames]?.map(g => <GameCard key={g.id} game={g} isFavorited={favoriteIds.has(g.id)} onToggleFavorite={onToggleFavorite} scoreHistory={scoreHistory} />)}
      {sortedLabels.map(label => (
        <div key={label} className="mb-6">
          {label !== "Today" && <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 px-1">{label}</div>}
          {grouped[label].map(g => <GameCard key={g.id} game={g} isFavorited={favoriteIds.has(g.id)} onToggleFavorite={onToggleFavorite} scoreHistory={scoreHistory} />)}
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function AllLeagues() {
  const [allGames, setAllGames] = useState({});
  const [favoriteIds, setFavoriteIds] = useState(() => new Set(JSON.parse(localStorage.getItem("favorites") || "[]")));
  const scoreHistoryRef = useRef({});

  const fetchAll = useCallback(async () => {
    const newAll = {};
    for (const league of LEAGUES) {
      try {
        const res = await fetch(`${API_BASE}/games?league=${LEAGUE_SLUGS[league]}`);
        const json = await res.json();
        newAll[league] = json;
        json.forEach(game => {
          if (!scoreHistoryRef.current[game.id]) scoreHistoryRef.current[game.id] = [];
          scoreHistoryRef.current[game.id].push(game.score ?? {});
          if (scoreHistoryRef.current[game.id].length > 10) scoreHistoryRef.current[game.id].shift();
        });
      } catch (e) { console.error("Failed to fetch", league, e); }
    }
    setAllGames(newAll);
  }, []);

  useEffect(() => { fetchAll(); const interval = setInterval(fetchAll, REFRESH_INTERVAL); return () => clearInterval(interval); }, [fetchAll]);
  const toggleFavorite = useCallback((id) => { setFavoriteIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); localStorage.setItem("favorites", JSON.stringify(Array.from(next))); return next; }); }, []);
  const bestBet = findBestBet(allGames);

  return (
    <div className="max-w-3xl mx-auto p-4">
      {bestBet && <BestBetCard bestBet={bestBet} />}
      {LEAGUES.map(league => (
        <div key={league} className="mb-8">
          <div className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-2">{league}</div>
          <LeagueSection
            games={allGames[league] || []}
            favoriteIds={favoriteIds}
            onToggleFavorite={toggleFavorite}
            scoreHistory={scoreHistoryRef.current}
          />
        </div>
      ))}
    </div>
  );
}
