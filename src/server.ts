import express from "express";
import { z } from "zod";
import {
  getPlayer, analyzeDeck, analyzePlayerStyle, generateDeck, scoreDeckForPlayer,
  type Archetype
} from "./logic.js";

const app = express();
app.use(express.json());

// Health
app.get("/", (_, res) => res.json({ ok: true }));

// Analyze a given 8-card deck (array of card names)
app.post("/analyze-deck", (req, res) => {
  const schema = z.object({ cards: z.array(z.string()).length(8) });
  const { cards } = schema.parse(req.body);
  return res.json(analyzeDeck(cards));
});

// Analyze a player’s style from battlelog
app.get("/analyze-player/:tag", async (req, res, next) => {
  try {
    const tag = req.params.tag;
    const style = await analyzePlayerStyle(tag);
    res.json(style);
  } catch (e) { next(e); }
});

// Generate + rank suggestions for a player
app.get("/suggest/:tag", async (req, res, next) => {
  try {
    const tag = req.params.tag;
    const archetype = (req.query.archetype as Archetype) || "Cycle";
    const targetAvg = req.query.avg ? Number(req.query.avg) : undefined;

    const player = await getPlayer(tag);
    const owned = new Set<string>(player.cards?.map((c: any) => c.name) ?? []); // uses names from API payload

    const style = await (await import("./logic.js")).analyzePlayerStyle(tag);
    // generate a few variants
    const candidates = Array.from({ length: 5 }, () => generateDeck(archetype, owned, targetAvg));
    const ranked = candidates
      .map(d => ({ deck: d, ...scoreDeckForPlayer(d, style) }))
      .sort((a,b) => b.score - a.score);

    res.json({ style, archetype, suggestions: ranked });
  } catch (e) { next(e); }
});

const PORT = process.env.PORT || 5173;
app.listen(PORT, () => console.log(`CR-Decksmith listening on :${PORT}`));
