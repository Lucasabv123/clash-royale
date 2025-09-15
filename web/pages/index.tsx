import { useEffect, useMemo, useState } from "react";

type RolesPayload = {
  COST: Record<string, number>;
  ROLE: Record<"winCon"|"bigSpell"|"smallSpell"|"building"|"airTarget"|"splash"|"reset"|"champion", string[]>;
};

type DeckAnalysis = {
  avgElixir: number;
  roles: {
    hasBigSpell: boolean;
    hasSmallSpell: boolean;
    hasBuilding: boolean;
    hasAirTargeting: boolean;
    hasSplash: boolean;
    hasReset: boolean;
    cheapCycleCount: number;
    winCons: string[];
  };
  archetype: string;
  notes: string[];
};

type Suggestion = {
  deck: string[];
  score: number;
  ml?: number;
  analysis: DeckAnalysis;
};

export default function Home() {
  const [roles, setRoles] = useState<RolesPayload | null>(null);
  useEffect(() => { fetch("/api/roles").then(r=>r.json()).then(setRoles).catch(()=>{}); }, []);

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", padding: 16, maxWidth: 960, margin: "0 auto" }}>
      <h1>CR Decksmith</h1>
      <p style={{ color: "#555" }}>Paste a deck or a player tag to analyze and get suggestions.</p>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <DeckAnalyzer roles={roles} />
        <PlayerSuggest roles={roles} />
      </section>
    </div>
  );
}

function DeckAnalyzer({ roles }: { roles: RolesPayload | null }) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<DeckAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    setError(null);
    const cards = input.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    if (cards.length !== 8) { setError("Please enter exactly 8 card names, comma-separated."); return; }
    const res = await fetch("/api/analyze-deck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cards }) });
    if (!res.ok) { setError("Analysis failed"); return; }
    const data = await res.json();
    setResult(data);
  }

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16 }}>
      <h2>Analyze Deck</h2>
      <textarea value={input} onChange={e=>setInput(e.target.value)} rows={4} style={{ width: "100%", fontFamily: "inherit" }} placeholder="Hog Rider, The Log, Fireball, Cannon, Musketeer, Skeletons, Ice Spirit, Earthquake" />
      <button onClick={analyze} style={{ marginTop: 8 }}>Analyze</button>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {result && <DeckReport data={result} roles={roles} />}
    </div>
  );
}

function DeckReport({ data, roles }: { data: DeckAnalysis; roles: RolesPayload | null }) {
  const checklist = [
    { label: "Big spell", ok: data.roles.hasBigSpell },
    { label: "Small spell", ok: data.roles.hasSmallSpell },
    { label: "Building", ok: data.roles.hasBuilding },
    { label: "Air target", ok: data.roles.hasAirTargeting },
    { label: "Splash", ok: data.roles.hasSplash },
    { label: "Reset", ok: data.roles.hasReset },
    { label: ">=2 cheap cyclers", ok: data.roles.cheapCycleCount >= 2 },
  ];
  return (
    <div style={{ marginTop: 12 }}>
      <div>Avg elixir: <b>{data.avgElixir}</b> · Archetype: <b>{data.archetype}</b></div>
      <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
        {checklist.map((c, i) => (
          <li key={i} style={{ color: c.ok ? "#0a0" : "#a00" }}>
            {c.ok ? "✓" : "✗"} {c.label}
          </li>
        ))}
      </ul>
      {data.notes?.length ? (
        <div style={{ marginTop: 8, color: "#555" }}>
          <b>Notes:</b>
          <ul>
            {data.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PlayerSuggest({ roles }: { roles: RolesPayload | null }) {
  const [tag, setTag] = useState("");
  const [style, setStyle] = useState<any | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setStyle(null); setSuggestions(null);
    const enc = encodeURIComponent(tag.startsWith("#") ? tag : `#${tag}`);
    const styleRes = await fetch(`/api/analyze-player/${enc}`);
    if (!styleRes.ok) { setError("Failed to analyze player"); return; }
    setStyle(await styleRes.json());
    const sugRes = await fetch(`/api/suggest/${enc}?rank=ml`);
    if (!sugRes.ok) { setError("Failed to get suggestions"); return; }
    const sug = await sugRes.json();
    setSuggestions((sug.suggestions || []).slice(0, 3));
  }

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16 }}>
      <h2>Player Suggestions</h2>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={tag} onChange={e=>setTag(e.target.value)} placeholder="#TAG" style={{ flex: 1 }} />
        <button onClick={run}>Analyze</button>
      </div>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {style && (
        <div style={{ marginTop: 8, color: "#333" }}>
          <div>Sample: {style.sample} · Avg elixir: <b>{style.avgElixir}</b></div>
          <div>Favored archetype: <b>{style.favoredArchetype}</b></div>
        </div>
      )}
      {suggestions && (
        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          {suggestions.map((s, idx) => (
            <SuggestionCard key={idx} s={s} roles={roles} tag={tag} />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionCard({ s, roles, tag }: { s: Suggestion; roles: RolesPayload | null; tag?: string }) {
  const [deck, setDeck] = useState<string[]>(s.deck);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [score, setScore] = useState<number>(s.score);
  const [ml, setMl] = useState<number | undefined>(s.ml);
  const [analysis, setAnalysis] = useState<DeckAnalysis>(s.analysis);
  const [loading, setLoading] = useState(false);

  function swapsFor(card: string) {
    if (!roles) return [] as string[];
    const flags = roleFlags(card, roles);
    const pool = new Set<string>();
    for (const [k, arr] of Object.entries(roles.ROLE)) {
      if ((flags as any)[k]) arr.forEach(c => pool.add(c));
    }
    deck.forEach(c => pool.delete(c));
    pool.delete(card);
    return Array.from(pool).slice(0, 10);
  }

  async function doSwap(i: number, replacement: string) {
    const next = [...deck];
    next[i] = replacement;
    setDeck(next);
    // Re-score with server (includes ML if tag provided)
    try {
      setLoading(true);
      const res = await fetch("/api/score-deck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: next, tag })
      });
      if (res.ok) {
        const data = await res.json();
        setScore(data.heuristic);
        setMl(data.ml);
        setAnalysis(data.analysis);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ border: "1px solid #eee", borderRadius: 6, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <b>Deck</b> · Heuristic: {score.toFixed(2)}{ml !== undefined ? ` · ML: ${ml.toFixed(3)}` : ""}{loading ? " · scoring..." : ""}
        </div>
        <small style={{ color: "#666" }}>Avg: {analysis.avgElixir} · {analysis.archetype}</small>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 8 }}>
        {deck.map((c, i) => (
          <div key={i} style={{ border: "1px solid #ddd", padding: 8, borderRadius: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{c}</span>
              <button onClick={() => setOpenIdx(openIdx === i ? null : i)} style={{ fontSize: 12 }}>Swap</button>
            </div>
            {openIdx === i && (
              <div style={{ marginTop: 6 }}>
                <SwapList current={c} options={swapsFor(c)} onPick={(rep) => { doSwap(i, rep); setOpenIdx(null); }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function roleFlags(card: string, roles: RolesPayload) {
  const res: Record<string, boolean> = {};
  for (const [k, arr] of Object.entries(roles.ROLE)) res[k] = arr.includes(card);
  return res;
}

function SwapList({ current, options, onPick }: { current: string; options: string[]; onPick: (c: string) => void }) {
  if (options.length === 0) return <div style={{ color: "#888" }}>No quick swaps found.</div>;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {options.map((o, i) => (
        <button key={i} onClick={() => onPick(o)} style={{ textAlign: "left" }}>{o}</button>
      ))}
    </div>
  );
}
