// Your Supabase project details, baked in at build time from environment
// variables (see .env.example, and "Environment variables" in
// HOW TO PUT ONLINE.md for Netlify / Vercel).
//
// The key is the public "anon" / "publishable" key. It is safe to expose:
// the database only lets logged-in users see or change data. Never use the
// "service_role" or "secret" key here.

declare const process: { env: Record<string, string | undefined> };

export const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
export const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ?? "";
