import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  getPlayer, analyzeDeck, analyzePlayerStyle, generateDeck, scoreDeckForPlayer,
  type Archetype
} from "./logic.js";
import { getOrTrainWinProbModel, trainWinProbModel, expectedWinProb } from "./ml.js";
import { COST as COST_MAP, ROLE as ROLE_SETS } from "./roles.js";

const app = express();
app.use(express.json());

// Health
app.get("/", (_req: Request, res: Response) => res.json({ ok: true }));

// Expose roles and cost map for frontend helpers
app.get("/roles", (_, res) => {
  const ROLE = Object.fromEntries(Object.entries(ROLE_SETS).map(([k, v]) => [k, Array.from(v as Set<string>)]));
  res.json({ COST: COST_MAP, ROLE });
});

// Score an arbitrary 8-card deck; optional tag enables player-style heuristic and ML
app.post("/score-deck", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({ cards: z.array(z.string()).length(8), tag: z.string().optional() });
    const { cards, tag } = schema.parse(req.body);

    const analysis = analyzeDeck(cards);

    // Heuristic scoring
    let heuristic = 0;
    if (tag) {
      const style = await analyzePlayerStyle(tag);
      heuristic = scoreDeckForPlayer(cards, style).score;
    } else {
      if (analysis.roles.hasSmallSpell) heuristic += 0.6;
      if (analysis.roles.hasBigSpell) heuristic += 0.6;
      if (analysis.roles.hasAirTargeting) heuristic += 0.6;
      if (analysis.roles.hasSplash) heuristic += 0.4;
      heuristic += Math.max(0, 1.0 - Math.abs(analysis.avgElixir - 3.0));
      heuristic = +heuristic.toFixed(2);
    }

    // ML probability if tag provided and model exists
    let ml: number | undefined = undefined;
    if (tag) {
      const { model, oppDist } = await getOrTrainWinProbModel(tag);
      if (model) ml = expectedWinProb(model, cards, oppDist);
    }

    res.json({ analysis, heuristic, ml });
  } catch (e) { next(e); }
});

// Analyze a given 8-card deck (array of card names)
app.post("/analyze-deck", (req: Request, res: Response) => {
  const schema = z.object({ cards: z.array(z.string()).length(8) });
  const { cards } = schema.parse(req.body);
  return res.json(analyzeDeck(cards));
});

// Analyze a player’s style from battlelog
app.get("/analyze-player/:tag", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tag = req.params.tag;
    const style = await analyzePlayerStyle(tag);
    res.json(style);
  } catch (e) { next(e); }
});

// Generate + rank suggestions for a player
app.get("/suggest/:tag", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tag = req.params.tag;
    const archetype = (req.query.archetype as Archetype) || "Cycle";
    const targetAvg = req.query.avg ? Number(req.query.avg) : undefined;
    const rankParam = String(req.query.rank || "").toLowerCase();
    const forceHeuristic = rankParam === "heuristic" || rankParam === "none";
    const forceML = rankParam === "ml";
    const forceRetrain = rankParam === "retrain";

    const player = await getPlayer(tag);
    const owned = new Set<string>(player.cards?.map((c: any) => c.name) ?? []); // uses names from API payload

    const style = await (await import("./logic.js")).analyzePlayerStyle(tag);
    // generate a few variants
    const candidates = Array.from({ length: 5 }, () => generateDeck(archetype, owned, targetAvg));
    let ranked = candidates
      .map(d => ({ deck: d, ...scoreDeckForPlayer(d, style), ml: undefined as number | undefined }))
      .sort((a,b) => b.score - a.score);

    // Default behavior: try ML if not explicitly forced to heuristic. If model exists, use it.
    let mlInfo: any = { used: false };
    let ranker: "ml" | "heuristic" = "heuristic";
    if (!forceHeuristic || forceML || forceRetrain) {
      const { model, oppDist, samples, fromCache } = forceRetrain
        ? await trainWinProbModel(tag)
        : await getOrTrainWinProbModel(tag);
      mlInfo = { used: !!model, samples, oppDist, fromCache: !!fromCache };
      if (model) {
        ranked = ranked
          .map(r => ({ ...r, ml: expectedWinProb(model, r.deck, oppDist) }))
          .sort((a,b) => (b.ml ?? 0) - (a.ml ?? 0) || b.score - a.score);
        ranker = "ml";
      }
    }

    res.json({ style, archetype, ranker, mlInfo, suggestions: ranked });
  } catch (e) { next(e); }
});

const PORT = process.env.PORT || 5173;
app.listen(PORT, () => console.log(`CR-Decksmith listening on :${PORT}`));
