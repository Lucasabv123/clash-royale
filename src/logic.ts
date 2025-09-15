import axios from "axios";
import { COST, ROLE } from "./roles.js";

export type CardName = string;
export type Deck = CardName[];

export type Archetype =
  | "Cycle"
  | "Bait"
  | "Beatdown"
  | "Control"
  | "Siege"
  | "Bridge Spam"
  | "Hybrid/Other";

export type DeckAnalysis = {
  avgElixir: number;
  roles: {
    hasBigSpell: boolean;
    hasSmallSpell: boolean;
    hasBuilding: boolean;
    hasAirTargeting: boolean;
    hasSplash: boolean;
    hasReset: boolean;   // zap / e-spirit / e-wiz etc.
    cheapCycleCount: number; // cards costing <=2 elixir
    winCons: string[];
  };
  archetype: Archetype;
  notes: string[];
};

const API = axios.create({
  baseURL: "https://api.clashroyale.com/v1",
  headers: { Authorization: `Bearer ${process.env.CR_TOKEN}` }
});

// Elixir costs and role tags now loaded from data/roles.map.json via src/roles.ts

const is = (name: string, set: Set<string>) => set.has(name);

// Detects presence ignoring evolutions / skins suffixes
const normalize = (n: string) => n.replace(/\s*\(.*\)$/, "");

export function analyzeDeck(cards: Deck): DeckAnalysis {
  const names = cards.map(normalize);
  const costs = names.map(c => COST[c] ?? 4);
  const avgElixir = Math.round((costs.reduce((a,b)=>a+b,0)/costs.length) * 10)/10;

  const roles = {
    hasBigSpell: names.some(c => is(c, ROLE.bigSpell)),
    hasSmallSpell: names.some(c => is(c, ROLE.smallSpell)),
    hasBuilding: names.some(c => is(c, ROLE.building)),
    hasAirTargeting: names.some(c => is(c, ROLE.airTarget)),
    hasSplash: names.some(c => is(c, ROLE.splash)),
    hasReset: names.some(c => is(c, ROLE.reset)),
    cheapCycleCount: names.filter(c => (COST[c] ?? 99) <= 2).length,
    winCons: names.filter(c => is(c, ROLE.winCon))
  };

  const archetype = classifyArchetype(names, avgElixir, roles);
  const notes: string[] = [];
  if (!roles.hasAirTargeting) notes.push("No reliable anti-air.");
  if (!roles.hasSmallSpell) notes.push("No small spell (Log/Zap/etc.).");
  if (!roles.hasBigSpell) notes.push("No big spell (Fireball/Poison/etc.).");
  if (roles.cheapCycleCount < 2) notes.push("Consider 1–2 cheap cycle cards.");
  if (!roles.hasSplash) notes.push("Little splash vs swarms.");
  if (avgElixir >= 4.5 && archetype !== "Beatdown") notes.push("High elixir for non-beatdown.");

  return { avgElixir, roles, archetype, notes };
}

function classifyArchetype(names: string[], avg: number, roles: DeckAnalysis["roles"]): Archetype {
  if (names.some(n => n === "X-Bow" || n === "Mortar")) return "Siege";
  if (names.some(n => ["Golem","Giant","Lava Hound","Elixir Golem","Electro Giant"].includes(n)) && avg >= 4.1)
    return "Beatdown";
  const baitCore = names.filter(n => ["Goblin Barrel","Princess","Goblin Gang","Rascals"].includes(n)).length >= 2;
  if (baitCore) return "Bait";
  if (names.some(n => ["Hog Rider","Ram Rider","Royal Hogs","Wall Breakers"].includes(n)) && avg <= 3.2)
    return "Cycle";
  const bridgeSpam = names.filter(n => ["Bandit","Battle Ram","Royal Ghost","Dark Prince","P.E.K.K.A"].includes(n)).length >= 2;
  if (bridgeSpam) return "Bridge Spam";
  if (names.some(n => ["Miner","Goblin Drill","Graveyard"].includes(n))) return "Control";
  return "Hybrid/Other";
}

// --- API helpers ---
function encodePlayerTag(tag: string) {
  // Accept raw ("P22...") or already-encoded ("%23P22...") values from routes
  const decoded = safeDecode(tag);
  const withHash = decoded.startsWith("#") ? decoded : `#${decoded}`;
  return encodeURIComponent(withHash);
}

function safeDecode(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export async function getPlayer(tag: string) {
  const enc = encodePlayerTag(tag);
  const { data } = await API.get(`/players/${enc}`);
  return data;
}

export async function getBattlelog(tag: string, limit = 25) {
  const enc = encodePlayerTag(tag);
  const { data } = await API.get(`/players/${enc}/battlelog`);
  return (data as any[]).slice(0, limit);
}

// --- Player style analysis from battlelog ---
export async function analyzePlayerStyle(tag: string) {
  const battles = await getBattlelog(tag);
  // take the player’s deck from each battle (1v1 only)
  const myDecks: Deck[] = battles
    .filter(b => b.team && b.team[0]?.cards)
    .map(b => b.team[0].cards.map((c: any) => c.name as string));

  const perDeck = myDecks.map(analyzeDeck);
  const avgElixir = +(
    perDeck.reduce((a, d) => a + d.avgElixir, 0) / Math.max(1, perDeck.length)
  ).toFixed(1);

  const counts = new Map<Archetype, number>();
  perDeck.forEach(d => counts.set(d.archetype, 1 + (counts.get(d.archetype) ?? 0)));

  const favored = [...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] ?? "Hybrid/Other";

  const crowns = battles.map(b => ({ me: b.team?.[0]?.crowns ?? 0, opp: b.opponent?.[0]?.crowns ?? 0 }));
  const avgCrowns = +(
    crowns.reduce((a, c) => a + c.me, 0) / Math.max(1, crowns.length)
  ).toFixed(2);

  return {
    sample: perDeck.length,
    avgElixir,
    favoredArchetype: favored,
    archetypeHistogram: Object.fromEntries(counts),
    avgCrownsForMe: avgCrowns
  };
}

// --- Simple deck generator by archetype with card-availability filter ---
type Pool = { winCons: CardName[]; supports: CardName[]; cheapCycle: CardName[]; bigSpells: CardName[]; smallSpells: CardName[]; buildings: CardName[]; air: CardName[]; splash: CardName[]; };

const POOLS: Record<Archetype, Pool> = {
  "Cycle": {
    winCons: ["Hog Rider","Wall Breakers","Royal Hogs"],
    supports: ["Musketeer","Archers","Electro Wizard","Phoenix","Knight"],
    cheapCycle: ["Skeletons","Ice Spirit","Fire Spirit","Ice Golem","Bats"],
    bigSpells: ["Fireball","Poison"],
    smallSpells: ["The Log","Zap","Barbarian Barrel","Earthquake"],
    buildings: ["Cannon","Tesla"],
    air: ["Musketeer","Archers","Phoenix"],
    splash: ["Valkyrie","Bomb Tower","Baby Dragon"]
  },
  "Beatdown": {
    winCons: ["Golem","Giant","Lava Hound","Electro Giant"],
    supports: ["Baby Dragon","Mega Minion","Inferno Dragon","Night Witch","Phoenix"],
    cheapCycle: ["Skeletons","Ice Spirit","Bats"],
    bigSpells: ["Lightning","Fireball","Poison","Rocket"],
    smallSpells: ["Zap","Barbarian Barrel","Arrows"],
    buildings: ["Bomb Tower","Inferno Tower","Goblin Cage"],
    air: ["Mega Minion","Baby Dragon","Phoenix"],
    splash: ["Baby Dragon","Bomb Tower","Valkyrie"]
  },
  "Control": {
    winCons: ["Miner","Goblin Drill","Graveyard","Ram Rider"],
    supports: ["Valkyrie","Electro Wizard","Phoenix","Knight","Baby Dragon"],
    cheapCycle: ["Skeletons","Ice Spirit","Bats"],
    bigSpells: ["Poison","Fireball","Rocket"],
    smallSpells: ["The Log","Zap","Barbarian Barrel","Arrows","Tornado"],
    buildings: ["Bomb Tower","Tesla","Cannon"],
    air: ["Musketeer","Archers","Phoenix","Baby Dragon"],
    splash: ["Valkyrie","Bomb Tower","Baby Dragon"]
  },
  "Siege": {
    winCons: ["X-Bow","Mortar"],
    supports: ["Archers","Knight","Tesla","Ice Golem","Musketeer"],
    cheapCycle: ["Skeletons","Ice Spirit","Fire Spirit"],
    bigSpells: ["Fireball","Rocket"],
    smallSpells: ["The Log","Zap","Barbarian Barrel"],
    buildings: ["Tesla","Cannon","Bomb Tower"],
    air: ["Musketeer","Archers","Tesla"],
    splash: ["Bomb Tower","Valkyrie"]
  },
  "Bridge Spam": {
    winCons: ["Ram Rider","Battle Ram","Royal Hogs"],
    supports: ["Bandit","Royal Ghost","Dark Prince","P.E.K.K.A","Magic Archer"],
    cheapCycle: ["Skeletons","Ice Spirit","Bats"],
    bigSpells: ["Fireball","Poison","Lightning"],
    smallSpells: ["The Log","Zap","Barbarian Barrel","Arrows"],
    buildings: ["Bomb Tower","Tesla"],
    air: ["Musketeer","Phoenix","Archers"],
    splash: ["Valkyrie","Bomb Tower","Magic Archer"]
  },
  "Bait": {
    winCons: ["Goblin Barrel","Goblin Drill","Wall Breakers"],
    supports: ["Princess","Goblin Gang","Dark Prince","Knight"],
    cheapCycle: ["Skeletons","Ice Spirit","Fire Spirit","Bats"],
    bigSpells: ["Rocket","Fireball"],
    smallSpells: ["The Log","Zap","Barbarian Barrel"],
    buildings: ["Inferno Tower","Cannon","Bomb Tower"],
    air: ["Musketeer","Archers","Princess"],
    splash: ["Valkyrie","Bomb Tower","Princess"]
  },
  "Hybrid/Other": {
    winCons: ["Royal Giant","Hog Rider","Miner"],
    supports: ["Musketeer","Electro Wizard","Phoenix","Valkyrie","Knight"],
    cheapCycle: ["Skeletons","Ice Spirit","Bats"],
    bigSpells: ["Fireball","Poison","Rocket"],
    smallSpells: ["The Log","Zap","Barbarian Barrel","Earthquake"],
    buildings: ["Tesla","Cannon","Bomb Tower"],
    air: ["Musketeer","Archers","Phoenix"],
    splash: ["Valkyrie","Bomb Tower","Baby Dragon"]
  }
};

export function generateDeck(archetype: Archetype, allowed: Set<CardName>, targetAvg = 3.0): Deck {
  const P = POOLS[archetype];
  const pick = (pool: CardName[], n=1) =>
    pool.filter(c => allowed.has(c)).slice(0, n);

  const deck = new Set<CardName>();
  // 1) Win condition(s)
  pick(P.winCons, 1).forEach(c => deck.add(c));

  // 2) Small + big spell
  pick(P.smallSpells, 1).forEach(c => deck.add(c));
  pick(P.bigSpells, 1).forEach(c => deck.add(c));

  // 3) A building (except some Cycle variants)
  if (archetype !== "Bridge Spam") pick(P.buildings, 1).forEach(c => deck.add(c));

  // 4) Anti-air + Splash
  pick(P.air, 1).forEach(c => deck.add(c));
  pick(P.splash, 1).forEach(c => deck.add(c));

  // 5) Fill with supports / cheap cycle to reach 8 cards and move avg toward target
  const candidates = [...P.supports, ...P.cheapCycle].filter(c => allowed.has(c));
  for (const c of candidates) {
    if (deck.size >= 8) break;
    deck.add(c);
  }

  // If still short (poor availability), backfill from any known cheap cards
  const ANY = ["Skeletons","Ice Spirit","Bats","Knight","Archers","Musketeer","Valkyrie","Phoenix","Cannon","Tesla"];
  for (const c of ANY) { if (deck.size < 8 && allowed.has(c)) deck.add(c); }

  return [...deck].slice(0, 8);
}

// rank suggested decks for a player
export function scoreDeckForPlayer(d: Deck, style: Awaited<ReturnType<typeof analyzePlayerStyle>>) {
  const a = analyzeDeck(d);
  let score = 0;
  // match playstyle archetype
  if (a.archetype === style.favoredArchetype) score += 2;
  // avg elixir closeness bonus
  score += Math.max(0, 1.5 - Math.abs(a.avgElixir - style.avgElixir));
  // composition bonuses
  if (a.roles.hasSmallSpell) score += 0.6;
  if (a.roles.hasBigSpell) score += 0.6;
  if (a.roles.hasAirTargeting) score += 0.6;
  if (a.roles.hasSplash) score += 0.4;
  return { score: +score.toFixed(2), analysis: a };
}
