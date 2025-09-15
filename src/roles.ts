import fs from "fs";
import path from "path";

type RolesFile = {
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
  };
};

const DATA_PATH = path.resolve(process.cwd(), "data", "roles.map.json");

function readFileSafe(): RolesFile | null {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    return JSON.parse(raw) as RolesFile;
  } catch {
    return null;
  }
}

const file = readFileSafe();

export const COST: Record<string, number> = file?.COST ?? {};

export const ROLE = {
  winCon: new Set<string>(file?.ROLE.winCon ?? []),
  bigSpell: new Set<string>(file?.ROLE.bigSpell ?? []),
  smallSpell: new Set<string>(file?.ROLE.smallSpell ?? []),
  building: new Set<string>(file?.ROLE.building ?? []),
  airTarget: new Set<string>(file?.ROLE.airTarget ?? []),
  splash: new Set<string>(file?.ROLE.splash ?? []),
  reset: new Set<string>(file?.ROLE.reset ?? []),
  champion: new Set<string>(file?.ROLE.champion ?? [])
};

export function hasRolesData() {
  return file !== null;
}

