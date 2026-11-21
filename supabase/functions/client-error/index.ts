// Supabase Edge Function: client-error. The game posts uncaught errors here
// (src/error-report.ts) so crashes on players' devices show up in this
// function's logs. A report holds the error message, a short stack, the game
// version and the platform; no player ID. Nothing is stored.
//
// Deno-targeted; outside ./src so the app's tsc and vite ignore it.

const cors = { 'Access-Control-Allow-Origin': '*' };
const clip = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: cors });
  const text = await req.text();
  if (text.length > 4_000) return new Response(null, { status: 413, headers: cors });
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); } catch { return new Response(null, { status: 400, headers: cors }); }
  // One line per report, so the log view can be filtered and counted.
  console.error('client error', JSON.stringify({
    message: clip(body.message, 300),
    stack: clip(body.stack, 1500),
    version: clip(body.version, 20),
    platform: clip(body.platform, 20),
  }));
  return new Response(null, { status: 204, headers: cors });
});
