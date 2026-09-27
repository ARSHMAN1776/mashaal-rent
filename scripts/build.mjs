// Builds src/client/app.ts into public/app.js, baking in the two Supabase
// values from the environment (see .env.example).
//
//   node scripts/build.mjs          one-off build
//   node scripts/build.mjs --serve  build, watch for changes, and serve
//                                   public/ at http://127.0.0.1:8765

import { context } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("..", import.meta.url);
const serve = process.argv.includes("--serve");

loadDotEnv(new URL(".env", ROOT));

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY"];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  console.error(`Missing ${missing.join(" and ")}.`);
  console.error("Copy .env.example to .env and fill in your Supabase project details,");
  console.error("or set them as environment variables in Netlify / Vercel (see HOW TO PUT ONLINE.md).");
  process.exit(1);
}

if (!serve) {
  // Type errors should stop the build; esbuild alone does not check types.
  // Run TypeScript's own script directly with node, so this works the same
  // on Windows, macOS, Linux, and on Netlify / Vercel's build servers.
  const tsc = fileURLToPath(new URL("node_modules/typescript/bin/tsc", ROOT));
  execFileSync(process.execPath, [tsc], { stdio: "inherit" });
}

const ctx = await context({
  entryPoints: ["src/client/app.ts"],
  bundle: true,
  minify: !serve,
  target: "es2020",
  outfile: "public/app.js",
  define: {
    "process.env.SUPABASE_URL": JSON.stringify(process.env.SUPABASE_URL),
    "process.env.SUPABASE_ANON_KEY": JSON.stringify(process.env.SUPABASE_ANON_KEY),
  },
  logLevel: "info",
});

if (serve) {
  await ctx.watch();
  await ctx.serve({ servedir: "public", host: "127.0.0.1", port: 8765 });
  console.log(`\n  Mashaal Rent a Car is running at http://127.0.0.1:8765/\n  Press Ctrl+C to stop.\n`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("Built public/app.js");
}

/** A minimal ".env" reader (KEY=VALUE per line) so local values never overwrite ones already set. */
function loadDotEnv(url) {
  if (!existsSync(url)) return;
  for (const line of readFileSync(url, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] === undefined) process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}
