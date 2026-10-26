import fs from "node:fs";

globalThis.window = {};
await import("../public/data/seed-contests.js");

const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const candidates = window.SEED_CONTESTS.flatMap(contest => contest.candidates);
const missing = candidates.filter(candidate => !fs.existsSync(new URL(`../public/assets/headshots/${slug(candidate.sourceName || candidate.name)}.jpg`, import.meta.url)));

console.log(JSON.stringify({ candidateCount: candidates.length, headshotCount: candidates.length - missing.length, missing: missing.map(candidate => candidate.name) }, null, 2));
if (missing.length) process.exitCode = 1;
