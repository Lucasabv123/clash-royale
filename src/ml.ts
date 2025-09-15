import { analyzeDeck, getBattlelog, type Deck, type Archetype } from "./logic.js";
import { COST, ROLE } from "./roles.js";
import fs from "fs";
import path from "path";

// Simple feature builder and logistic regression trainer (no external deps)

type Example = { x: number[]; y: number };

const ARCHES: Archetype[] = [
  "Cycle","Bait","Beatdown","Control","Siege","Bridge Spam","Hybrid/Other"
];

const WINCONS = [
  "Hog Rider","X-Bow","Mortar","Royal Giant","Lava Hound","Balloon",
  "Giant","Golem","Miner","Goblin Drill","Graveyard","Ram Rider",
  "Royal Hogs","Wall Breakers","Battle Ram","Goblin Barrel"
];

function deckWinconOneHot(deck: Deck): number[] {
  const names = deck.map(n => n.replace(/\s*\(.*\)$/, ""));
  return WINCONS.map(w => (names.includes(w) ? 1 : 0));
}

function archetypeOneHot(a: Archetype): number[] {
  return ARCHES.map(x => (x === a ? 1 : 0));
}

function has(set: Set<string>, deck: Deck): number { return deck.some(c => set.has(c)) ? 1 : 0; }

function avgElixir(deck: Deck): number {
  const names = deck.map(n => n.replace(/\s*\(.*\)$/, ""));
  const costs = names.map(n => COST[n] ?? 4);
  return +(costs.reduce((a,b)=>a+b,0)/Math.max(1,costs.length)).toFixed(2);
}

// Feature vector layout:
// [bias=1, myAvg, hasBig, hasSmall, hasBldg, hasAir, hasSplash, hasReset, hasChamp,
//  ...wincon16,
//  ...oppArchetype7,
//  crownDiff]
function buildFeatures(deck: Deck, oppArch: Archetype, crownDiff = 0): number[] {
  const myAvg = avgElixir(deck);
  const f: number[] = [
    1,
    myAvg,
    has(ROLE.bigSpell, deck),
    has(ROLE.smallSpell, deck),
    has(ROLE.building, deck),
    has(ROLE.airTarget, deck),
    has(ROLE.splash, deck),
    has(ROLE.reset, deck),
    // crude champion signal: presence of any known champion in deck
    has(ROLE.champion, deck),
    ...deckWinconOneHot(deck),
    ...archetypeOneHot(oppArch),
    Math.max(-3, Math.min(3, crownDiff))
  ];
  return f;
}

function sigmoid(z: number) { return 1 / (1 + Math.exp(-z)); }

function dot(w: number[], x: number[]) { let s = 0; for (let i=0;i<w.length;i++) s += w[i]*x[i]; return s; }

function trainLogReg(examples: Example[], l2 = 1e-3, lr = 0.1, epochs = 200) {
  if (examples.length === 0) return { w: [] as number[], dims: 0 };
  const dims = examples[0].x.length;
  let w = new Array(dims).fill(0);
  for (let e=0; e<epochs; e++) {
    // one pass SGD
    for (const ex of examples) {
      const p = sigmoid(dot(w, ex.x));
      const err = p - ex.y; // derivative of BCE wrt logit
      for (let j=0;j<dims;j++) {
        const grad = err * ex.x[j] + l2 * w[j];
        w[j] -= lr * grad;
      }
    }
  }
  return { w, dims };
}

export type WinProbModel = { w: number[]; dims: number; feat: (deck: Deck, opp: Archetype) => number[] };

export async function trainWinProbModel(tag: string) {
  const battles = await getBattlelog(tag, 50);
  const ex: Example[] = [];
  const dist = new Map<Archetype, number>();

  for (const b of battles) {
    const me = b.team?.[0];
    const opp = b.opponent?.[0];
    if (!me?.cards || !opp?.cards) continue;
    const myDeck = me.cards.map((c: any) => c.name as string);
    const oppDeck = opp.cards.map((c: any) => c.name as string);
    const oppArch = analyzeDeck(oppDeck).archetype;
    dist.set(oppArch, 1 + (dist.get(oppArch) ?? 0));

    const crownDiff = (me.crowns ?? 0) - (opp.crowns ?? 0);
    const x = buildFeatures(myDeck, oppArch, crownDiff);
    const y = (me.crowns ?? 0) > (opp.crowns ?? 0) ? 1 : 0;
    ex.push({ x, y });
  }

  // normalize dist
  const total = [...dist.values()].reduce((a,b)=>a+b,0) || 1;
  const oppDist = Object.fromEntries(ARCHES.map(a => [a, (dist.get(a) ?? 0)/total])) as Record<Archetype, number>;

  if (ex.length < 10) {
    return { model: null as WinProbModel | null, oppDist, samples: ex.length };
  }

  const { w, dims } = trainLogReg(ex);
  const model: WinProbModel = { w, dims, feat: (d, a) => buildFeatures(d, a, 0) };
  return { model, oppDist, samples: ex.length };
}

export function predictWinProb(model: WinProbModel, deck: Deck, oppArch: Archetype) {
  const x = model.feat(deck, oppArch);
  if (x.length !== model.dims) return 0.5;
  return sigmoid(dot(model.w, x));
}

export function expectedWinProb(model: WinProbModel, deck: Deck, dist: Record<Archetype, number>) {
  let p = 0;
  for (const arch of ARCHES) {
    const w = dist[arch] ?? 0;
    if (w === 0) continue;
    p += w * predictWinProb(model, deck, arch);
  }
  return +p.toFixed(4);
}

// --- Simple disk cache to avoid retraining on each request ---
type CachedPayload = {
  tag: string;
  version: number; // bump if features/layout change
  trainedAt: string; // ISO
  samples: number;
  dims: number;
  w: number[];
  oppDist: Record<Archetype, number>;
};

const DATA_DIR = path.resolve(process.cwd(), "data");
const MODEL_DIR = path.join(DATA_DIR, "models");
const MODEL_VERSION = 1;

function safeTag(tag: string) {
  return tag.replace(/^#/, "").replace(/[^A-Za-z0-9_-]+/g, "_").toUpperCase();
}

function modelPath(tag: string) {
  return path.join(MODEL_DIR, `${safeTag(tag)}.json`);
}

function loadCached(tag: string): CachedPayload | null {
  try {
    const raw = fs.readFileSync(modelPath(tag), "utf8");
    const obj = JSON.parse(raw) as CachedPayload;
    if (obj.version !== MODEL_VERSION) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveCached(tag: string, payload: CachedPayload) {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  fs.writeFileSync(modelPath(tag), JSON.stringify(payload, null, 2), "utf8");
}

export async function getOrTrainWinProbModel(tag: string, opts?: { force?: boolean }) {
  if (!opts?.force) {
    const cached = loadCached(tag);
    if (cached) {
      const model: WinProbModel = {
        w: cached.w,
        dims: cached.dims,
        feat: (d, a) => buildFeatures(d, a, 0)
      };
      return { model, oppDist: cached.oppDist, samples: cached.samples, fromCache: true } as const;
    }
  }

  const trained = await trainWinProbModel(tag);
  if (trained.model) {
    const payload: CachedPayload = {
      tag: safeTag(tag),
      version: MODEL_VERSION,
      trainedAt: new Date().toISOString(),
      samples: trained.samples,
      dims: trained.model.dims,
      w: trained.model.w,
      oppDist: trained.oppDist
    };
    saveCached(tag, payload);
    return { ...trained, fromCache: false } as const;
  }

  return { ...trained, fromCache: false } as const;
}
