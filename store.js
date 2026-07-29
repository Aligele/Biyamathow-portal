// Storage layer for the hosted app.
//
// If Supabase env vars are present at build time, all data is read from and
// written to a single shared row — so every teacher, parent and admin sees the
// same information. If they're absent, it falls back to this device's own
// browser storage so the app still works (but isn't shared).
//
// To switch on sharing, set these in Vercel → Project → Settings → Environment
// Variables, then redeploy:
//   VITE_SUPABASE_URL       = https://<project-ref>.supabase.co
//   VITE_SUPABASE_ANON_KEY  = <publishable / anon key>

const URL_BASE = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isShared = Boolean(URL_BASE && ANON_KEY);

const TABLE = "app_state";
const ROW_ID = "roster";
const LOCAL_KEY = "biyamathow_roster_v1";

const headers = () => ({
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

export async function loadRoster() {
  if (!isShared) {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  const res = await fetch(`${URL_BASE}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data`, { headers: headers() });
  if (!res.ok) throw new Error(`Load failed (${res.status})`);
  const rows = await res.json();
  return rows?.[0]?.data ?? null;
}

export async function saveRoster(data) {
  if (!isShared) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
    return;
  }
  // upsert the single row
  const res = await fetch(`${URL_BASE}/rest/v1/${TABLE}?on_conflict=id`, {
    method: "POST",
    headers: { ...headers(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ id: ROW_ID, data }]),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Save failed (${res.status})${txt ? ": " + txt.slice(0, 120) : ""}`);
  }
}
