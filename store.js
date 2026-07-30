// Storage layer — authenticated, offline-capable, conflict-safe.
//
// The browser no longer touches the database table directly. Every request
// goes through a database function that checks a session token first:
//
//   staff_login      username + password  -> session token (password bcrypt-checked)
//   state_get        token                -> the whole school
//   state_save       token + data         -> conditional write, refuses stale saves
//   student_record   admission no + PIN   -> ONLY that child's records
//
// So even with the site link and the public key, an outsider gets nothing:
// the table itself rejects direct reads and writes.
//
// Vercel → Settings → Environment Variables:
//   VITE_SUPABASE_URL       = https://<project-ref>.supabase.co
//   VITE_SUPABASE_ANON_KEY  = <publishable / anon key>

const URL_BASE = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isShared = Boolean(URL_BASE && ANON_KEY);

const MIRROR_KEY  = "biyamathow_mirror_v2";
const BASE_KEY    = "biyamathow_base_v2";
const PENDING_KEY = "biyamathow_pending_v2";
const TOKEN_KEY   = "biyamathow_token_v1";
const WHO_KEY     = "biyamathow_who_v1";

const readJSON  = (k) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const del       = (k) => { try { localStorage.removeItem(k); } catch (e) {} };

export const hasPendingChanges = () => { try { return localStorage.getItem(PENDING_KEY) === "1"; } catch (e) { return false; } };
const setPending = (v) => { try { v ? localStorage.setItem(PENDING_KEY, "1") : del(PENDING_KEY); } catch (e) {} };
export const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
export const getWho   = () => readJSON(WHO_KEY);
const setSession = (token, who) => {
  if (token) { try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {} writeJSON(WHO_KEY, who); }
  else { del(TOKEN_KEY); del(WHO_KEY); }
};

let lastSeenUpdatedAt = null;

async function rpc(fn, args) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${fn} failed (${res.status})${txt ? ": " + txt.slice(0, 140) : ""}`);
  }
  return res.json();
}

// ---------- authentication ----------
export async function staffLogin(username, password) {
  if (!isShared) throw new Error("No database configured");
  const rows = await rpc("staff_login", { p_username: username, p_password: password });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.token) return null;              // wrong credentials
  const who = { role: row.role, name: row.name, teacherId: row.teacher_id, username };
  setSession(row.token, who);
  return who;
}

export async function staffLogout() {
  const t = getToken();
  setSession(null, null);
  del(MIRROR_KEY); del(BASE_KEY); del(PENDING_KEY);  // don't leave school data on a shared phone
  if (t && isShared) { try { await rpc("staff_logout", { p_token: t }); } catch (e) {} }
}

// Restores a session after a reload; null means the token expired.
export async function restoreSession() {
  const t = getToken();
  if (!t || !isShared) return null;
  try {
    const rows = await rpc("staff_me", { p_token: t });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) { setSession(null, null); return null; }
    const who = { role: row.role, name: row.name, teacherId: row.teacher_id, username: row.username };
    writeJSON(WHO_KEY, who);
    return who;
  } catch (e) {
    return getWho();       // offline: trust the cached identity until reconnect
  }
}

export const changeMyPassword = async (oldPw, newPw) => {
  const r = await rpc("change_my_password", { p_token: getToken(), p_old: oldPw, p_new: newPw });
  return r === true;
};

// ---------- staff accounts (admin) ----------
export const staffList = () => rpc("staff_list", { p_token: getToken() });
export const staffUpsert = (username, name, role, password, teacherId) =>
  rpc("staff_upsert", { p_token: getToken(), p_username: username, p_name: name, p_role: role, p_password: password || null, p_teacher_id: teacherId || null });
export const staffDeactivate = (username) => rpc("staff_deactivate", { p_token: getToken(), p_username: username });

// ---------- parents ----------
export async function parentLookup(admissionNo, pin) {
  if (!isShared) return null;
  return rpc("student_record", { p_adm: admissionNo, p_pin: pin });
}

// ---------- three-way merge (unchanged: protects simultaneous saves) ----------
function mergeValue(base, mine, yours) {
  if (mine === yours) return mine;
  if (JSON.stringify(mine) === JSON.stringify(base)) return yours;
  if (JSON.stringify(yours) === JSON.stringify(base)) return mine;
  if (Array.isArray(mine) && Array.isArray(yours)) return mergeArrays(base, mine, yours);
  if (mine && yours && typeof mine === "object" && typeof yours === "object") {
    const out = { ...yours };
    new Set([...Object.keys(mine), ...Object.keys(yours)]).forEach((k) => {
      const b = base && typeof base === "object" ? base[k] : undefined;
      if (!(k in mine)) { if (JSON.stringify(yours[k]) === JSON.stringify(b)) delete out[k]; }
      else out[k] = mergeValue(b, mine[k], yours[k]);
    });
    return out;
  }
  return mine;
}
function mergeArrays(base, mine, yours) {
  const hasIds = (a) => Array.isArray(a) && a.every((x) => x && typeof x === "object" && "id" in x);
  if (!hasIds(mine) || !hasIds(yours)) return mine;
  const baseArr = Array.isArray(base) ? base : [];
  const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
  const B = byId(baseArr), M = byId(mine);
  const out = []; const seen = new Set();
  yours.forEach((y) => {
    seen.add(y.id);
    if (y.id in M) out.push(mergeValue(B[y.id], M[y.id], y));
    else if (!(y.id in B)) out.push(y);
  });
  mine.forEach((m) => { if (!seen.has(m.id) && !(m.id in B)) out.push(m); });
  return out;
}

// ---------- reading / saving the school ----------
export async function loadRoster() {
  if (!isShared) return readJSON(MIRROR_KEY);
  if (hasPendingChanges()) { const local = readJSON(MIRROR_KEY); if (local) return local; }

  try {
    const rows = await rpc("state_get", { p_token: getToken() });
    const row = Array.isArray(rows) ? rows[0] : rows;
    const data = row?.data ?? null;
    lastSeenUpdatedAt = row?.updated_at ?? null;
    if (data) { writeJSON(MIRROR_KEY, data); writeJSON(BASE_KEY, data); }
    return data;
  } catch (e) {
    const local = readJSON(MIRROR_KEY);
    if (local) return local;         // offline
    throw e;
  }
}

export async function saveRoster(data) {
  writeJSON(MIRROR_KEY, data);       // device copy first — never lose work
  if (!isShared) return;

  try {
    let rows = await rpc("state_save", { p_token: getToken(), p_data: data, p_expected: lastSeenUpdatedAt });
    let row = Array.isArray(rows) ? rows[0] : rows;

    if (row && row.ok === false) {
      // Someone else saved first — merge their version with ours and retry.
      const base = readJSON(BASE_KEY) || {};
      const merged = mergeValue(base, data, row.data || {});
      lastSeenUpdatedAt = row.updated_at;
      rows = await rpc("state_save", { p_token: getToken(), p_data: merged, p_expected: lastSeenUpdatedAt });
      row = Array.isArray(rows) ? rows[0] : rows;
      if (!row?.ok) throw new Error("Busy — another device is saving. Retrying…");
      lastSeenUpdatedAt = row.updated_at;
      writeJSON(MIRROR_KEY, merged); writeJSON(BASE_KEY, merged);
      setPending(false);
      return merged;                 // caller adopts the merged result
    }

    lastSeenUpdatedAt = row?.updated_at ?? lastSeenUpdatedAt;
    writeJSON(BASE_KEY, data);
    setPending(false);
  } catch (e) {
    setPending(true);
    throw e;
  }
}
