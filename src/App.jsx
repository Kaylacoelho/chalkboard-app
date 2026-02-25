import { useState, useEffect, useCallback, useRef } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:3001/api";
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
// A "best bet" is a game where:
//   - It hasn't started yet (status === "scheduled")
//   - We have win probability data
//   - The favorite has the highest probability gap over the underdog
//
// We return the game + which league it belongs to so we can label it.
function findBestBet(allGames) {
  let best = null;
  let bestSkew = 0; // "skew" = how lopsided the odds are

  for (const [league, games] of Object.entries(allGames)) {
    for (const game of games) {
      if (game.status !== "scheduled" || !game.win_probability) continue;

      const { home, away, win_probability } = game;
      const homePct = win_probability[home] ?? 50;
      const awayPct = win_probability[away] ?? 50;
      const skew = Math.abs(homePct - awayPct); // bigger = more lopsided

      if (skew > bestSkew) {
        bestSkew = skew;
        best = { game, league, favPct: Math.max(homePct, awayPct) };
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
              {/* Label the snapshot index. In production you'd use real game clock. */}
              {i === 0 ? "start" : `+${i * 30}s`}
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

// ─── FEATURE 1: Best Bet Card ─────────────────────────────────────────────────
// A highlighted hero card shown at the very top of the page.
// It's visually distinct to draw the eye immediately.
function BestBetCard({ bestBet }) {
  if (!bestBet) return null;
  const { game, league, favPct } = bestBet;
  const { home, away, teams, win_probability, spread, start_time } = game;
  const favAbbr = win_probability[home] >= win_probability[away] ? home : away;
  const undAbbr = favAbbr === home ? away : home;

  return (
    <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl p-5 mb-6 text-white shadow-lg">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {/* The ⭐ badge — this is what makes users notice it immediately */}
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
      </div>
    </div>
  );
}

// ─── GameCard (updated with features 2, 3, 4, 5) ─────────────────────────────
function GameCard({ game, isFavorited, onToggleFavorite, scoreHistory }) {
  const { home, away, teams, score, status, start_time, win_probability, spread } = game;
  const homeTeam = teams[home];
  const awayTeam = teams[away];
  const isScheduled = status === "scheduled";
  const isLive = status === "in_progress";
  const isFinal = status === "final" || status === "closed";

  // Feature 2: check if this game qualifies as an upset alert
  const showUpsetAlert = isScheduled && isUpsetAlert(win_probability, home, away);

  // Feature 5: which team (if any) is currently on a run?
  const onARun = isLive ? getMomentum(scoreHistory, game.id, home, away) : null;

  return (
    <div className={`bg-white border rounded-xl px-5 py-4 mb-2.5 shadow-sm transition-shadow
      ${isLive ? "border-red-200 ring-2 ring-red-200" : "border-gray-200"}
      ${isFavorited ? "border-l-4 border-l-indigo-400" : ""}`}>

      {/* Status row */}
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-2">
          {isLive ? <LiveBadge /> : (
            <span className={`text-xs font-semibold tracking-wide uppercase
              ${isFinal ? "text-gray-400" : "text-indigo-500"}`}>
              {isFinal ? "Final" : "Upcoming"}
            </span>
          )}
          {/* Feature 2: Upset Alert badge */}
          {showUpsetAlert && (
            <span className="bg-orange-100 text-orange-600 text-xs font-bold px-2 py-0.5 rounded-full">
              ⚡ Upset Alert
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">{formatTime(start_time)}</span>
          {/* Feature 3: Favorite star button
              onClick stops the event from bubbling up to parent elements.
              e.stopPropagation() means "don't let this click trigger other handlers." */}
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(game.id, home, away); }}
            className={`text-base leading-none transition-colors
              ${isFavorited ? "text-yellow-400" : "text-gray-200 hover:text-yellow-300"}`}
            title={isFavorited ? "Remove from favorites" : "Add to favorites"}
          >
            ★
          </button>
        </div>
      </div>

      {/* Teams + score */}
      <div className="flex items-center justify-between">
        <div className="flex-1 flex items-center gap-2">
          {awayTeam?.logo && <img src={awayTeam.logo} alt={awayTeam.name} className="w-7 h-7 object-contain" />}
          <div>
            <div className="font-semibold text-sm">{awayTeam?.name ?? away}</div>
            <div className="text-xs text-gray-400">Away</div>
          </div>
        </div>

        <div className="text-center min-w-[80px]">
          {!isScheduled ? (
            <div className="font-extrabold text-2xl tracking-tight font-mono tabular-nums">
              {score?.[away]} – {score?.[home]}
            </div>
          ) : (
            <div className="font-bold text-sm text-gray-300">vs</div>
          )}
        </div>

        <div className="flex-1 flex items-center justify-end gap-2 text-right">
          <div>
            <div className="font-semibold text-sm">{homeTeam?.name ?? home}</div>
            <div className="text-xs text-gray-400">Home</div>
          </div>
          {homeTeam?.logo && <img src={homeTeam.logo} alt={homeTeam.name} className="w-7 h-7 object-contain" />}
        </div>
      </div>

      {/* Feature 5: Momentum indicator
          Only shows during live games when one team is scoring consecutively */}
      {onARun && (
        <div className="mt-2 text-xs font-semibold text-orange-500">
          🔥 {teams[onARun]?.name ?? onARun} is on a run!
        </div>
      )}

      {win_probability && (isLive || isScheduled) && (
        <ProbBar
          home={win_probability[home]}
          homeAbbr={home}
          away={win_probability[away]}
          awayAbbr={away}
          draw={win_probability.draw}
        />
      )}

      {isScheduled && <SpreadBadge spread={spread} />}

      {/* Feature 4: Score timeline — only for live games with history */}
      {isLive && scoreHistory[game.id]?.length > 1 && (
        <ScoreTimeline
          history={scoreHistory[game.id]}
          homeAbbr={home}
          awayAbbr={away}
        />
      )}
    </div>
  );
}

// ─── FEATURE 3: Favorites section ────────────────────────────────────────────
// Shows favorited games pinned at the top of the current tab, before other games.
function FavoritesSection({ games, favoriteIds, onToggleFavorite, scoreHistory }) {
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
        />
      ))}
      <div className="border-t border-gray-200 mb-4" />
    </div>
  );
}

function LeagueSection({ games, favoriteIds, onToggleFavorite, scoreHistory }) {
  const live = games.filter(g => g.status === "in_progress");
  const upcoming = games.filter(g => g.status === "scheduled");
  const finished = games.filter(g => g.status === "final" || g.status === "closed");
  const sorted = [
    ...live,
    ...upcoming.sort((a, b) => new Date(a.start_time) - new Date(b.start_time)),
    ...finished,
  ];

  return (
    <div>
      {/* Favorites pinned at top */}
      <FavoritesSection
        games={sorted}
        favoriteIds={favoriteIds}
        onToggleFavorite={onToggleFavorite}
        scoreHistory={scoreHistory}
      />
      {/* All games */}
      {sorted.map(g => (
        // Don't render a duplicate card if it's already shown in favorites
        !favoriteIds.has(g.id) && (
          <GameCard
            key={g.id}
            game={g}
            isFavorited={false}
            onToggleFavorite={onToggleFavorite}
            scoreHistory={scoreHistory}
          />
        )
      ))}
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
            const currentSnap = { [game.home]: game.score[game.home], [game.away]: game.score[game.away] };

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

  const currentGames = allGames[activeTab] ?? [];
  const bestBet = findBestBet(allGames); // computed across ALL leagues

  return (
    <div className="bg-gray-50 min-h-screen font-sans">

      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 sticky top-0 z-10 flex items-center justify-between">
        <div>
          <div className="font-extrabold text-lg tracking-tight">🟫 ChalkBoard</div>
          <div className="text-xs text-gray-400 mt-0.5">
            {loading && !lastRefresh ? "Loading..." : lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : ""}
          </div>
        </div>
        <button
          onClick={fetchAll}
          disabled={loading}
          className="text-xs text-gray-500 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40 transition-colors"
        >
          {loading ? "Refreshing..." : "↻ Refresh"}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-3 text-sm text-red-700">
          ⚠️ {error}
        </div>
      )}

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 flex overflow-x-auto px-6">
        {LEAGUES.map(l => {
          const liveCount = (allGames[l] ?? []).filter(g => g.status === "in_progress").length;
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
      <div className="max-w-2xl mx-auto px-4 py-6">
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
            {/* Feature 1: Best Bet card — shown on every tab */}
            <BestBetCard bestBet={bestBet} />

            {currentGames.length === 0 ? (
              <div className="text-center py-16 text-gray-400">No games found for {activeTab}.</div>
            ) : (
              <LeagueSection
                games={currentGames}
                favoriteIds={favoriteIds}
                onToggleFavorite={toggleFavorite}
                scoreHistory={scoreHistory}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
