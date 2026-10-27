// Read-only proxy to TMDB so the API key stays server side (secret TMDB_API_KEY).
// Accepts either a v3 API key or a v4 "Read Access Token" (starts with eyJ).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED = [
  /^\/discover\/movie$/,
  /^\/genre\/movie\/list$/,
  /^\/watch\/providers\/movie$/,
  /^\/movie\/\d+$/,
  /^\/movie\/\d+\/watch\/providers$/,
  /^\/movie\/\d+\/videos$/,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const key = Deno.env.get("TMDB_API_KEY");
  if (!key) return json({ error: "TMDB_API_KEY missing" }, 500);

  let path = "";
  let params: Record<string, string | number | boolean> = {};
  try {
    ({ path, params = {} } = await req.json());
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  if (typeof path !== "string" || !ALLOWED.some((re) => re.test(path))) {
    return json({ error: "path not allowed" }, 400);
  }

  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("language", "fr-FR");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);

  const res = await fetch(url, { headers });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
});
