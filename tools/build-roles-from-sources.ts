import "dotenv/config";
import fs from "fs";
import path from "path";
import axios from "axios";

// --- Config
const DATA_DIR = path.resolve(process.cwd(), "data");
const OUT = path.join(DATA_DIR, "roles.map.json");

// Official API (canonical names)
const CR_API = "https://api.clashroyale.com/v1/cards";

// Public, static data set (elixir/type/rarity) published by RoyaleAPI
// We only read JSON files; we are NOT using their old API.
const RA_BASE = "https://royaleapi.github.io/cr-api-data/json/cards.json";

const EVOLUTION_SUFFIXES = [
  "(Evolved)", "(Evolution)", "(Evo)" // seen in various locales/UIs
];

// Optional: evolution-specific overrides (role tweaks for evolved forms)
const EVOLUTION_OVERRIDES: Record<string, Partial<RoleTags & { cost?: number }>> = {
  // Example: evolved Ice Spirit plays like a reset/splash hybrid
  "Ice Spirit": { reset: true },
};

type RoleTags = {
  winCon: boolean;
  bigSpell: boolean;
  smallSpell: boolean;
  building: boolean;
  airTarget: boolean;
  splash: boolean;
  reset: boolean;
  champion: boolean;
};

type RolesPayload = {
  COST: Record<string, number>;
  ROLE: {
    winCon: string[];
    bigSpell: string[];
    smallSpell: string[];
    building: string[];
    airTarget: string[];
    splash: string[];
    reset: string[];
    champion: string[];
    // (we keep your bait/bridgeSpam cores elsewhere; leave them as-is if you have them)
  };
};

const BASE_WINCONS = new Set([
  // Heuristic list; you can edit freely in the output file afterwards
  "Hog Rider","X-Bow","Mortar","Royal Giant","Lava Hound","Balloon",
  "Giant","Golem","Miner","Goblin Drill","Graveyard","Ram Rider",
  "Royal Hogs","Wall Breakers","Battle Ram","Goblin Barrel"
]);

const BIG_SPELLS = new Set(["Fireball","Poison","Rocket","Lightning"]);
const SMALL_SPELLS = new Set(["The Log","Zap","Barbarian Barrel","Arrows","Tornado","Earthquake"]);

function normalizeName(n: string) {
  let out = n.trim();
  for (const suf of EVOLUTION_SUFFIXES) {
    if (out.endsWith(suf)) {
      out = out.slice(0, -suf.length).trim();
      break;
    }
  }
  return out;
}

async function main() {
  if (!process.env.CR_TOKEN) {
    throw new Error("Missing CR_TOKEN in env for official API.");
  }

  // 1) Canonical names from official API
  const { data: official } = await axios.get(CR_API, {
    headers: { Authorization: `Bearer ${process.env.CR_TOKEN}` }
  });
  const officialItems = (official?.items ?? official) as Array<{ name: string }>;
  const officialNames = officialItems.map(c => c.name);

  // 2) Static data with elixir/type/rarity
  const { data: ra } = await axios.get(RA_BASE); // array of cards
  // Expected fields in RA cards.json: name, elixir, type ("Troop"/"Spell"/"Building"), rarity (e.g., "Champion")
  type RACard = { name: string; elixir?: number; type?: string; rarity?: string };
  const raMap = new Map<string, RACard>();
  (ra as RACard[]).forEach(c => raMap.set(normalizeName(c.name), c));

  const COST: Record<string, number> = {};
  const roleSets: Record<keyof RolesPayload["ROLE"], Set<string>> = {
    winCon: new Set(),
    bigSpell: new Set(),
    smallSpell: new Set(),
    building: new Set(),
    airTarget: new Set(),
    splash: new Set(),
    reset: new Set(),
    champion: new Set(),
  };

  // Simple air/splash/resets heuristics (augmentable later)
  const AIR_HINTS = new Set(["Musketeer","Archers","Mega Minion","Baby Dragon","Electro Wizard","Inferno Dragon",
    "Tesla","Minions","Bats","Phoenix","Archer Queen","Magic Archer","Hunter","Princess","Dart Goblin"]);
  const SPLASH_HINTS = new Set(["Baby Dragon","Valkyrie","Wizard","Executioner","Bowler","Bomb Tower","Princess","Magic Archer"]);
  const RESET_HINTS = new Set(["Zap","Electro Wizard","Electro Spirit","Zappies","Lightning","Snowball"]);

  for (const rawName of officialNames) {
    const name = rawName.trim();
    const base = normalizeName(name);
    const raCard = raMap.get(base);

    // 2a) cost
    const cost = (raCard?.elixir ?? 4); // fallback average cost
    COST[name] = cost;

    // 2b) core roles from type/rarity
    const isSpell = (raCard?.type || "").toLowerCase() === "spell";
    const isBuilding = (raCard?.type || "").toLowerCase() === "building";
    const isChampion = (raCard?.rarity || "").toLowerCase() === "champion";

    const tags: RoleTags = {
      winCon: BASE_WINCONS.has(base),
      bigSpell: isSpell && BIG_SPELLS.has(base),
      smallSpell: isSpell && SMALL_SPELLS.has(base),
      building: isBuilding,
      airTarget: AIR_HINTS.has(base) || (isBuilding && base === "Tesla"),
      splash: SPLASH_HINTS.has(base),
      reset: RESET_HINTS.has(base),
      champion: isChampion
    };

    // 2c) evolution-specific tweaks (apply to base; also apply if card name already has suffix)
    const evoTweak = EVOLUTION_OVERRIDES[base];
    if (evoTweak) {
      if (typeof evoTweak.cost === "number") COST[name] = evoTweak.cost;
      for (const [k, v] of Object.entries(evoTweak)) {
        if (k === "cost") continue;
        if (v === true) (tags as any)[k] = true;
      }
    }

    // 2d) place into sets
    (Object.keys(roleSets) as Array<keyof RolesPayload["ROLE"]>).forEach(k => {
      if ((tags as any)[k]) roleSets[k].add(name);
    });

    // 2e) spells not in big/small lists still count as smallSpell for composition
    if (isSpell && !tags.bigSpell && !tags.smallSpell) roleSets.smallSpell.add(name);
  }

  // Assemble payload
  const payload: RolesPayload = {
    COST,
    ROLE: {
      winCon: [...roleSets.winCon].sort(),
      bigSpell: [...roleSets.bigSpell].sort(),
      smallSpell: [...roleSets.smallSpell].sort(),
      building: [...roleSets.building].sort(),
      airTarget: [...roleSets.airTarget].sort(),
      splash: [...roleSets.splash].sort(),
      reset: [...roleSets.reset].sort(),
      champion: [...roleSets.champion].sort()
    }
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");
  console.log(`✅ Wrote ${OUT} with ${Object.keys(COST).length} cards.`);
}

main().catch(e => {
  console.error(e?.response?.data || e.message);
  process.exit(1);
});
