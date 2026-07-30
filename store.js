// Storage layer with offline support.
//
// Every read and write also goes through a local mirror on the device, so the
// portal keeps working with no signal:
//   • loading offline  -> falls back to the last data seen on this device
//   • saving offline   -> written locally straight away, then pushed to the
//                         server automatically once the connection returns
//
// If Supabase env vars are absent, the mirror IS the storage (device-only).
//
// Vercel → Settings → Environment Variables:
//   VITE_SUPABASE_URL       = https://<project-ref>.supabase.co
//   VITE_SUPABASE_ANON_KEY  = <publishable / anon key>

const URL_BASE = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isShared = Boolean(URL_BASE && ANON_KEY);

const TABLE = "app_state";
const ROW_ID = "roster";
const MIRROR_KEY = "biyamathow_mirror_v1";
const PENDING_KEY = "biyamathow_pending_v1";

const headers = () => ({
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  "Content-Type": "application/json",
});

// ---- local mirror ----
function readMirror() {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function writeMirror(data) {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(data));
  } catch (e) {
    /* storage full or blocked — nothing we can do */
  }
}
export function hasPendingChanges() {
  try {
    return localStorage.getItem(PENDING_KEY) === "1";
  } catch (e) {
    return false;
  }
}
function setPending(v) {
  try {
    if (v) localStorage.setItem(PENDING_KEY, "1");
    else localStorage.removeItem(PENDING_KEY);
  } catch (e) { /* ignore */ }
}

export const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

// ---- public API ----
export async function loadRoster() {
  if (!isShared) return readMirror();

  // Unsent local edits win — otherwise a stale server copy would wipe them.
  if (hasPendingChanges()) {
    const local = readMirror();
    if (local) return local;
  }

  try {
    const res = await fetch(`${URL_BASE}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data`, { headers: headers() });
    if (!res.ok) throw new Error(`Load failed (${res.status})`);
    const rows = await res.json();
    const data = rows?.[0]?.data ?? null;
    if (data) writeMirror(data);
    return data;
  } catch (e) {
    // No signal (or server down): carry on with what this device already has.
    const local = readMirror();
    if (local) return local;
    throw e;
  }
}

export async function saveRoster(data) {
  // Always keep the device copy first, so nothing is lost even if the app closes.
  writeMirror(data);

  if (!isShared) return;

  try {
    const res = await fetch(`${URL_BASE}/rest/v1/${TABLE}?on_conflict=id`, {
      method: "POST",
      headers: { ...headers(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ id: ROW_ID, data }]),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Save failed (${res.status})${txt ? ": " + txt.slice(0, 120) : ""}`);
    }
    setPending(false);
  } catch (e) {
    // Saved on the device; the app retries automatically and on reconnect.
    setPending(true);
    throw e;
  }
}
