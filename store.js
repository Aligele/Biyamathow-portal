// Storage layer: offline-capable, with conflict-safe saving.
//
// Two problems this solves beyond plain read/write:
//
//  1. OFFLINE — every read and write also goes through a local mirror, so the
//     portal keeps working with no signal and syncs when it returns.
//
//  2. CONCURRENCY — the whole school shares one record. Without care, two
//     teachers saving at the same moment means the second silently erases the
//     first. Saves are therefore conditional on the row not having changed
//     since we loaded it; if it has, we fetch the server's copy, merge our
//     changes into it field by field, and retry. Nobody's work disappears.
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
const BASE_KEY = "biyamathow_base_v1"; // server copy we last saw, for 3-way merge

const headers = () => ({
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  "Content-Type": "application/json",
});

// ---------- local storage helpers ----------
const readJSON = (k) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full/blocked */ } };

export const hasPendingChanges = () => { try { return localStorage.getItem(PENDING_KEY) === "1"; } catch (e) { return false; } };
const setPending = (v) => { try { v ? localStorage.setItem(PENDING_KEY, "1") : localStorage.removeItem(PENDING_KEY); } catch (e) {} };
export const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

let lastSeenUpdatedAt = null; // row version we based our edits on

// ---------- three-way merge ----------
// base  = server copy we last saw
// mine  = what this device wants to save
// yours = what the server has now (someone else saved)
// Anything I changed wins over the server; anything I didn't touch keeps the
// server's newer value. Applied leaf by leaf, so two teachers editing
// different classes/subjects never clobber each other.
function mergeValue(base, mine, yours) {
  if (mine === yours) return mine;
  if (JSON.stringify(mine) === JSON.stringify(base)) return yours; // I didn't touch it
  if (JSON.stringify(yours) === JSON.stringify(base)) return mine; // they didn't touch it

  // both changed
  if (Array.isArray(mine) && Array.isArray(yours)) return mergeArrays(base, mine, yours);
  if (mine && yours && typeof mine === "object" && typeof yours === "object") {
    const out = { ...yours };
    const keys = new Set([...Object.keys(mine), ...Object.keys(yours)]);
    keys.forEach((k) => {
      const b = base && typeof base === "object" ? base[k] : undefined;
      if (!(k in mine)) {
        // I deleted it — only honour that if the server didn't change it
        if (JSON.stringify(yours[k]) === JSON.stringify(b)) delete out[k];
      } else {
        out[k] = mergeValue(b, mine[k], yours[k]);
      }
    });
    return out;
  }
  return mine; // primitive clash — this device's edit wins
}

// Arrays of records (students, teachers, classes, payments) merge by id.
function mergeArrays(base, mine, yours) {
  const hasIds = (a) => Array.isArray(a) && a.every((x) => x && typeof x === "object" && "id" in x);
  if (!hasIds(mine) || !hasIds(yours)) return mine;

  const baseArr = Array.isArray(base) ? base : [];
  const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
  const B = byId(baseArr), M = byId(mine), Y = byId(yours);
  const out = [];
  const seen = new Set();

  yours.forEach((y) => {
    seen.add(y.id);
    if (y.id in M) out.push(mergeValue(B[y.id], M[y.id], y));
    else if (!(y.id in B)) out.push(y);       // they added it
    // in base but not mine -> I deleted it; honour the deletion
  });
  mine.forEach((m) => { if (!seen.has(m.id) && !(m.id in B)) out.push(m); }); // I added it
  return out;
}

// ---------- public API ----------
export async function loadRoster() {
  if (!isShared) return readJSON(MIRROR_KEY);

  if (hasPendingChanges()) {
    const local = readJSON(MIRROR_KEY);
    if (local) return local; // unsent edits win over a stale server copy
  }

  try {
    const res = await fetch(`${URL_BASE}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data,updated_at`, { headers: headers() });
    if (!res.ok) throw new Error(`Load failed (${res.status})`);
    const rows = await res.json();
    const row = rows?.[0];
    const data = row?.data ?? null;
    lastSeenUpdatedAt = row?.updated_at ?? null;
    if (data) { writeJSON(MIRROR_KEY, data); writeJSON(BASE_KEY, data); }
    return data;
  } catch (e) {
    const local = readJSON(MIRROR_KEY);
    if (local) return local;
    throw e;
  }
}

async function fetchServer() {
  const res = await fetch(`${URL_BASE}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data,updated_at`, { headers: headers() });
  if (!res.ok) throw new Error(`Reload failed (${res.status})`);
  const rows = await res.json();
  return rows?.[0] || null;
}

// Conditional write: only succeeds if the row still matches the version we
// loaded. Returns the number of rows written.
async function conditionalUpdate(data) {
  const filter = lastSeenUpdatedAt
    ? `id=eq.${ROW_ID}&updated_at=eq.${encodeURIComponent(lastSeenUpdatedAt)}`
    : `id=eq.${ROW_ID}`;
  const res = await fetch(`${URL_BASE}/rest/v1/${TABLE}?${filter}`, {
    method: "PATCH",
    headers: { ...headers(), Prefer: "return=representation" },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Save failed (${res.status})${txt ? ": " + txt.slice(0, 120) : ""}`);
  }
  const rows = await res.json();
  if (rows?.[0]?.updated_at) lastSeenUpdatedAt = rows[0].updated_at;
  return rows?.length || 0;
}

async function insertFirstRow(data) {
  const res = await fetch(`${URL_BASE}/rest/v1/${TABLE}?on_conflict=id`, {
    method: "POST",
    headers: { ...headers(), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ id: ROW_ID, data, updated_at: new Date().toISOString() }]),
  });
  if (!res.ok) throw new Error(`Save failed (${res.status})`);
  const rows = await res.json();
  if (rows?.[0]?.updated_at) lastSeenUpdatedAt = rows[0].updated_at;
}

export async function saveRoster(data) {
  writeJSON(MIRROR_KEY, data); // device copy first — never lose work
  if (!isShared) return;

  try {
    let written = await conditionalUpdate(data);

    if (written === 0) {
      // Someone else saved since we loaded. Merge rather than overwrite.
      const server = await fetchServer();
      if (!server) { await insertFirstRow(data); }
      else {
        const base = readJSON(BASE_KEY) || {};
        const merged = mergeValue(base, data, server.data || {});
        lastSeenUpdatedAt = server.updated_at;
        written = await conditionalUpdate(merged);
        if (written === 0) throw new Error("Busy — another device is saving. Retrying…");
        writeJSON(MIRROR_KEY, merged);
        writeJSON(BASE_KEY, merged);
        setPending(false);
        return merged; // caller refreshes its state with the merged result
      }
    }

    writeJSON(BASE_KEY, data);
    setPending(false);
  } catch (e) {
    setPending(true);
    throw e;
  }
}
