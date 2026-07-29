import React, { useState, useEffect, useCallback, useRef } from "react";
import { loadRoster, saveRoster as persistRoster, isShared } from "./store.js";

// ---------- helpers ----------
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const genId = (prefix, list) => {
  const n = (list?.length || 0) + 1;
  return `${prefix}-${String(n).padStart(3, "0")}-${Math.random().toString(36).slice(2, 5)}`;
};
const slugUser = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
const termKey = (t) => (t || "term").trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "") || "term";
const money = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isRateLimit = (e) => /rate limit/i.test(e?.message || "");
const isNotFound = (e) => /not found|does not exist|no such key|no value/i.test(e?.message || "");

// Everything lives in ONE storage document. Separate per-class/per-term keys
// proved unreliable in practice, while this single key has always worked —
// so attendance and marks are kept inside it rather than in their own entries.
const ROSTER_KEY = "roster";

function useCooldown(ms = 1200) {
  const [onCooldown, setOnCooldown] = useState(false);
  const run = useCallback(async (fn) => {
    if (onCooldown) return;
    setOnCooldown(true);
    try {
      await fn();
    } finally {
      setTimeout(() => setOnCooldown(false), ms);
    }
  }, [onCooldown, ms]);
  return [onCooldown, run];
}

const STATUS = {
  present: { label: "Present", ink: "#3F7A5C", mark: "P" },
  absent: { label: "Absent", ink: "#B84C3E", mark: "A" },
  late: { label: "Late", ink: "#C98A2C", mark: "L" },
};

const SCHOOL_NAME = "Biyamathow Mixed Day and Boarding Senior School";
const SCHOOL_LOCATION = "Sabuli, Wajir County";
const DEFAULT_ADMIN_PASSWORD = "admin123";
const DEFAULT_TERM = "Term 1";
const DEFAULT_SUBJECTS = ["Math", "English", "Science", "Social", "IRE", "Kiswahili"];
const SCORE_OPTIONS = Array.from({ length: 100 }, (_, i) => i + 1);

const EMPTY_ROSTER = {
  classes: [],
  teachers: [],
  students: [],
  subjects: DEFAULT_SUBJECTS,
  attendance: {}, // { [classId]: { [date]: { [studentId]: status } } }
  marks: {},      // { [classId]: { [termKey]: { approved, grid: { [studentId]: { [subject]: score } } } } }
  settings: { adminPassword: DEFAULT_ADMIN_PASSWORD, currency: "KSh", passMark: 50 },
};

const FONT = {
  display: "'Source Serif 4', Georgia, serif",
  body: "'Inter', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
};

export default function SchoolRegister() {
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState(EMPTY_ROSTER);
  const [role, setRole] = useState(null);
  const [activeTeacherId, setActiveTeacherId] = useState(null);
  const [activeStudentId, setActiveStudentId] = useState(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const p = await loadRoster();
        if (p) {
          const loaded = {
            ...EMPTY_ROSTER,
            ...p,
            subjects: p.subjects?.length ? p.subjects : DEFAULT_SUBJECTS,
            attendance: p.attendance || {},
            marks: p.marks || {},
            settings: { ...EMPTY_ROSTER.settings, ...(p.settings || {}) },
          };
          rosterRef.current = loaded;
          setRoster(loaded);
        }
      } catch (e) { /* start from defaults if the first load fails */ }
      setLoading(false);
    })();
  }, []);

  const flashToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2600);
  };

  // ---- Batched background saving --------------------------------------
  // Every change lands in memory instantly and the screen updates straight
  // away. Writes are then coalesced and sent in the background, retrying on
  // their own if the storage service is misbehaving. Nothing the user does
  // is ever blocked by, or lost to, a failed network write.
  const rosterRef = useRef(EMPTY_ROSTER);
  const savingRef = useRef(false);
  const debounceRef = useRef(null);
  const retryRef = useRef(null);
  const [syncState, setSyncState] = useState("saved"); // saved | pending | saving | error

  const flush = useCallback(async () => {
    if (savingRef.current) return;
    clearTimeout(retryRef.current);
    const snapshot = rosterRef.current;
    savingRef.current = true;
    setSyncState("saving");
    try {
      await persistRoster(snapshot);
      savingRef.current = false;
      if (rosterRef.current === snapshot) {
        setSyncState("saved");
      } else {
        setSyncState("pending");
        debounceRef.current = setTimeout(flush, 900); // more arrived while saving
      }
    } catch (e) {
      savingRef.current = false;
      setSyncState("error");
      retryRef.current = setTimeout(flush, 7000); // keep trying quietly
    }
  }, []);

  const scheduleSave = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flush, 1200);
  }, [flush]);

  // Callers get an instant, always-successful update. Persistence happens
  // behind the scenes; the sync badge is what reports its real state.
  const saveRoster = useCallback((next, successMsg) => {
    rosterRef.current = next;
    setRoster(next);
    setSyncState("pending");
    scheduleSave();
    if (successMsg) flashToast(successMsg);
    return true;
  }, [scheduleSave]);

  useEffect(() => () => { clearTimeout(debounceRef.current); clearTimeout(retryRef.current); }, []);

  if (loading) {
    return <Shell><div style={{ padding: 40, color: "#F5F3EE", fontFamily: FONT.body }}>Opening the register…</div></Shell>;
  }

  return (
    <Shell>
      {toast && <Toast msg={toast} />}
      <SyncBadge state={syncState} onRetry={flush} />
      {!role && (
        <RoleGate
          roster={roster} saveRoster={saveRoster}
          onEnterAdmin={() => setRole("admin")}
          onEnterTeacher={(id) => { setActiveTeacherId(id); setRole("teacher"); }}
          onEnterFamily={(id) => { setActiveStudentId(id); setRole("family"); }}
        />
      )}
      {role === "admin" && <AdminView roster={roster} saveRoster={saveRoster} onExit={() => setRole(null)} syncState={syncState} onForceSave={flush} />}
      {role === "teacher" && <TeacherView roster={roster} saveRoster={saveRoster} teacherId={activeTeacherId} onExit={() => { setRole(null); setActiveTeacherId(null); }} />}
      {role === "family" && <FamilyView roster={roster} studentId={activeStudentId} onExit={() => { setRole(null); setActiveStudentId(null); }} />}
    </Shell>
  );
}

function SyncBadge({ state, onRetry }) {
  const map = {
    saved:   { text: "✓ All changes saved",   bg: "#24402F", fg: "#8FD3A8", border: "#3A6B4C" },
    pending: { text: "• Saving…",             bg: "#24402F", fg: "#B8C4B9", border: "#3A6B4C" },
    saving:  { text: "• Saving…",             bg: "#24402F", fg: "#B8C4B9", border: "#3A6B4C" },
    error:   { text: "⚠ Not saved yet — retrying", bg: "#4A2620", fg: "#F0A99B", border: "#7A3E33" },
  };
  const s = map[state] || map.saved;
  return (
    <div className="no-print" style={{
      position: "fixed", bottom: 12, left: "50%", transform: "translateX(-50%)", zIndex: 90,
      display: "flex", alignItems: "center", gap: 10,
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
      borderRadius: 20, padding: "6px 14px", fontFamily: FONT.mono, fontSize: 11.5,
      boxShadow: "0 3px 12px rgba(0,0,0,0.3)", maxWidth: "92vw",
    }}>
      <span>{s.text}</span>
      {state === "error" && (
        <button onClick={onRetry} style={{ background: "#E8B23D", color: "#1F3A2E", border: "none", borderRadius: 12, padding: "3px 10px", fontFamily: FONT.mono, fontSize: 11, fontWeight: 700 }}>Retry now</button>
      )}
    </div>
  );
}

// ================= SHELL =================
function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#1F3A2E" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        ::selection { background: #E8B23D; color: #1F3A2E; }
        button { font-family: inherit; cursor: pointer; }
        input, select { font-family: inherit; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #E8B23D; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
        .chalk-fade { animation: chalkIn 0.35s ease both; }
        @keyframes chalkIn { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: translateY(0);} }
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff !important; }
          .print-doc { box-shadow: none !important; border: none !important; margin: 0 !important; max-width: none !important; padding: 0 !important; }
        }
      `}</style>
      {children}
    </div>
  );
}

function Toast({ msg }) {
  return (
    <div className="chalk-fade" style={{
      position: "fixed", top: 18, left: "50%", transform: "translateX(-50%)",
      background: "#E8B23D", color: "#1F3A2E", padding: "8px 18px", borderRadius: 3,
      fontFamily: FONT.body, fontWeight: 600, fontSize: 13, zIndex: 100,
      boxShadow: "0 4px 14px rgba(0,0,0,0.25)", maxWidth: "84vw", textAlign: "center",
    }}>{msg}</div>
  );
}

function Stamp({ status, size = 30 }) {
  const s = STATUS[status];
  if (!s) return <div style={{ width: size, height: size, borderRadius: "50%", border: "1.5px dashed #B8B2A0" }} />;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", border: `2px solid ${s.ink}`,
      display: "flex", alignItems: "center", justifyContent: "center",
      color: s.ink, fontFamily: FONT.mono, fontWeight: 700, fontSize: size * 0.4,
      transform: "rotate(-6deg)", opacity: 0.9,
    }}>{s.mark}</div>
  );
}

function Seal({ size = 56, ink = "#E8B23D" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="47" fill="none" stroke={ink} strokeWidth="2.5" />
      <circle cx="50" cy="50" r="40" fill="none" stroke={ink} strokeWidth="1" opacity="0.6" />
      <path d="M50 22 L62 30 V50 C62 62 56 70 50 74 C44 70 38 62 38 50 V30 Z" fill="none" stroke={ink} strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M50 34 V60 M42 44 H58" stroke={ink} strokeWidth="2" />
      <path d="M18 50 C24 38 30 32 36 30" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <path d="M82 50 C76 38 70 32 64 30" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---------- shared styles ----------
const inputStyle = () => ({ width: "100%", padding: "10px 12px", borderRadius: 3, border: "1px solid #345645", background: "#1B3327", color: "#F5F3EE", fontFamily: FONT.body, fontSize: 14, marginBottom: 4 });
const backBtnStyle = () => ({ background: "none", border: "none", color: "#E8B23D", fontFamily: FONT.mono, fontSize: 12, padding: 0 });
const paperPanel = () => ({ background: "#FBF9F4", borderRadius: 6, border: "1px solid #D8D2C2", boxShadow: "0 8px 24px rgba(0,0,0,0.18)" });
const darkInput = () => ({ padding: "9px 11px", borderRadius: 3, border: "1px solid #D8D2C2", background: "#fff", color: "#22304A", fontSize: 13.5 });
const primaryBtn = () => ({ background: "#22304A", color: "#F5F3EE", border: "none", borderRadius: 3, padding: "9px 16px", fontFamily: FONT.body, fontSize: 13, fontWeight: 600 });
const classNameOf = (roster, id) => roster.classes.find((c) => c.id === id)?.name || "Unassigned";

function SectionTitle({ children }) {
  return <div style={{ fontFamily: FONT.display, fontSize: 18, fontWeight: 600, color: "#22304A", marginBottom: 10 }}>{children}</div>;
}
function StatCard({ label, value, tone }) {
  return (
    <div style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "12px 14px", background: "#F5F1E6" }}>
      <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368", letterSpacing: 1 }}>{label.toUpperCase()}</div>
      <div style={{ fontFamily: FONT.display, fontSize: 23, fontWeight: 700, color: tone || "#22304A" }}>{value}</div>
    </div>
  );
}
function topBar(title, onExit) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 6px", maxWidth: 960, margin: "0 auto", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Seal size={38} />
        <div>
          <div style={{ fontFamily: FONT.mono, color: "#E8B23D", fontSize: 10, letterSpacing: 1.4 }}>{SCHOOL_NAME.toUpperCase()}</div>
          <div style={{ fontFamily: FONT.mono, color: "#8AA090", fontSize: 9.5, letterSpacing: 1 }}>{SCHOOL_LOCATION}</div>
          <div style={{ fontFamily: FONT.display, color: "#F5F3EE", fontSize: 19, fontWeight: 600 }}>{title}</div>
        </div>
      </div>
      <button onClick={onExit} style={{ background: "transparent", border: "1px solid #4A6E58", color: "#F5F3EE", borderRadius: 3, padding: "7px 14px", fontFamily: FONT.body, fontSize: 12, whiteSpace: "nowrap" }}>Sign out</button>
    </div>
  );
}
function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <button key={t} onClick={() => onChange(t)} style={{
          background: active === t ? "#E8B23D" : "transparent", color: active === t ? "#1F3A2E" : "#F5F3EE",
          border: "1px solid " + (active === t ? "#E8B23D" : "#4A6E58"), borderRadius: 3, padding: "6px 13px",
          fontFamily: FONT.body, fontSize: 12.5, fontWeight: 600, textTransform: "capitalize",
        }}>{t}</button>
      ))}
    </div>
  );
}
function RowList({ items, render, onRemove }) {
  if (items.length === 0) return <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Nothing here yet.</div>;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {items.map((it) => (
        <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 3 }}>
          <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{render(it)}</span>
          {onRemove && <button onClick={() => onRemove(it.id)} style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 12 }}>remove</button>}
        </div>
      ))}
    </div>
  );
}

// ---------- data helpers ----------
const getMarksFor = (roster, classId, term) => roster.marks?.[classId]?.[termKey(term)] || { approved: false, grid: {} };
const setMarksFor = (roster, classId, term, data) => ({
  ...roster,
  marks: { ...roster.marks, [classId]: { ...(roster.marks?.[classId] || {}), [termKey(term)]: data } },
});
const getAttendanceFor = (roster, classId) => roster.attendance?.[classId] || {};
const setAttendanceFor = (roster, classId, log) => ({ ...roster, attendance: { ...roster.attendance, [classId]: log } });

const studentAverage = (grid, studentId) => {
  const scores = Object.values(grid?.[studentId] || {}).filter((v) => typeof v === "number");
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
};

// ================= ROLE GATE =================
function RoleGate({ roster, saveRoster, onEnterAdmin, onEnterTeacher, onEnterFamily }) {
  const [step, setStep] = useState("root");
  const [search, setSearch] = useState("");
  const [creds, setCreds] = useState({ username: "", password: "" });
  const [adminPass, setAdminPass] = useState("");
  const [err, setErr] = useState("");
  const [showReset, setShowReset] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");

  const tryTeacher = () => {
    const t = roster.teachers.find((x) => x.username?.toLowerCase() === creds.username.trim().toLowerCase());
    if (!t || t.password !== creds.password) return setErr("Username or password not recognized.");
    setErr(""); onEnterTeacher(t.id);
  };
  const tryAdmin = () => {
    if (adminPass !== (roster.settings?.adminPassword || DEFAULT_ADMIN_PASSWORD)) return setErr("Incorrect passcode.");
    setErr(""); onEnterAdmin();
  };
  const doReset = async () => {
    if (resetConfirm.trim().toUpperCase() !== "RESET") return setErr('Type RESET (in capitals) to confirm.');
    await saveRoster({ ...roster, settings: { ...roster.settings, adminPassword: DEFAULT_ADMIN_PASSWORD } }, `Passcode reset to ${DEFAULT_ADMIN_PASSWORD}`);
    setShowReset(false); setResetConfirm(""); setErr("");
  };

  const matches = roster.students.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="chalk-fade" style={{ maxWidth: 440, margin: "0 auto", padding: "7vh 20px 40px" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <Seal size={56} />
        <div style={{ fontFamily: FONT.mono, color: "#B8C4B9", fontSize: 10.5, letterSpacing: 1.4, marginTop: 10 }}>REPUBLIC OF KENYA · MINISTRY OF EDUCATION</div>
        <h1 style={{ fontFamily: FONT.display, color: "#F5F3EE", fontSize: 26, margin: "6px 0 0", fontWeight: 600, lineHeight: 1.25 }}>{SCHOOL_NAME}</h1>
        <div style={{ fontFamily: FONT.mono, color: "#E8B23D", fontSize: 12, marginTop: 4 }}>{SCHOOL_LOCATION}</div>
      </div>

      {step === "root" && (
        <div style={{ display: "grid", gap: 12 }}>
          <RoleCard title="Teacher login" desc="Mark attendance and enter exam results." onClick={() => { setStep("teacher"); setErr(""); }} />
          <RoleCard title="Admin" desc="Classes, teachers, students, fees and reports." onClick={() => { setStep("admin"); setErr(""); }} />
          <RoleCard title="Student / Parent" desc="View attendance, results, fees — print anytime." onClick={() => { setStep("family"); setErr(""); }} />
        </div>
      )}

      {step === "teacher" && (
        <div>
          <button onClick={() => setStep("root")} style={backBtnStyle()}>← back</button>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <input placeholder="Username" value={creds.username} onChange={(e) => setCreds({ ...creds, username: e.target.value })} onKeyDown={(e) => e.key === "Enter" && tryTeacher()} style={inputStyle()} />
            <input placeholder="Password" type="password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} onKeyDown={(e) => e.key === "Enter" && tryTeacher()} style={inputStyle()} />
            {err && <div style={{ color: "#E8967D", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
            <button onClick={tryTeacher} style={{ ...primaryBtn(), background: "#E8B23D", color: "#1F3A2E" }}>Sign in</button>
          </div>
        </div>
      )}

      {step === "admin" && !showReset && (
        <div>
          <button onClick={() => setStep("root")} style={backBtnStyle()}>← back</button>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <input placeholder="Admin passcode" type="password" value={adminPass} onChange={(e) => setAdminPass(e.target.value)} onKeyDown={(e) => e.key === "Enter" && tryAdmin()} style={inputStyle()} />
            {err && <div style={{ color: "#E8967D", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
            <button onClick={tryAdmin} style={{ ...primaryBtn(), background: "#E8B23D", color: "#1F3A2E" }}>Enter</button>
            <button onClick={() => { setShowReset(true); setErr(""); }} style={{ ...backBtnStyle(), marginTop: 4, textAlign: "left" }}>Forgot passcode?</button>
          </div>
        </div>
      )}

      {step === "admin" && showReset && (
        <div>
          <button onClick={() => { setShowReset(false); setErr(""); }} style={backBtnStyle()}>← back</button>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#B8C4B9" }}>This resets the admin passcode to <strong>{DEFAULT_ADMIN_PASSWORD}</strong>. Change it again once you're in.</div>
            <input placeholder='Type "RESET" to confirm' value={resetConfirm} onChange={(e) => setResetConfirm(e.target.value)} style={inputStyle()} />
            {err && <div style={{ color: "#E8967D", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
            <button onClick={doReset} style={{ ...primaryBtn(), background: "#B84C3E" }}>Reset passcode</button>
          </div>
        </div>
      )}

      {step === "family" && (
        <div>
          <button onClick={() => setStep("root")} style={backBtnStyle()}>← back</button>
          <input placeholder="Search student by name…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...inputStyle(), marginTop: 12 }} />
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {matches.map((s) => (
              <button key={s.id} onClick={() => onEnterFamily(s.id)} style={{ textAlign: "left", background: "#243F31", border: "1px solid #345645", borderRadius: 4, padding: "12px 14px", color: "#F5F3EE", fontFamily: FONT.body, fontSize: 14 }}>
                {s.name} · {classNameOf(roster, s.classId)}
              </button>
            ))}
            {search && matches.length === 0 && <div style={{ fontFamily: FONT.body, color: "#B8C4B9", fontSize: 13 }}>No matching students.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function RoleCard({ title, desc, onClick }) {
  return (
    <button onClick={onClick} style={{ textAlign: "left", background: "#243F31", border: "1px solid #345645", borderRadius: 4, padding: "16px 18px", color: "#F5F3EE" }}>
      <div style={{ fontFamily: FONT.display, fontSize: 19, fontWeight: 600 }}>{title}</div>
      <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#B8C4B9", marginTop: 3 }}>{desc}</div>
    </button>
  );
}

// ================= ADMIN =================
function AdminView({ roster, saveRoster, onExit, syncState, onForceSave }) {
  const [tab, setTab] = useState("overview");
  const [newClass, setNewClass] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [newTeacher, setNewTeacher] = useState({ name: "", classId: "", username: "", password: "" });
  const [newStudent, setNewStudent] = useState({ name: "", classId: "", parentName: "", feeDue: "" });
  const [newAdminPass, setNewAdminPass] = useState("");
  const [payment, setPayment] = useState({ studentId: "", amount: "" });
  const [marksClassId, setMarksClassId] = useState("");
  const cur = roster.settings.currency;

  const addClass = () => {
    if (!newClass.trim()) return;
    saveRoster({ ...roster, classes: [...roster.classes, { id: genId("CLS", roster.classes), name: newClass.trim() }] }, `Added ${newClass.trim()}`);
    setNewClass("");
  };
  const addSubject = () => {
    const s = newSubject.trim();
    if (!s || roster.subjects.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    saveRoster({ ...roster, subjects: [...roster.subjects, s] }, `Added ${s}`);
    setNewSubject("");
  };
  const addTeacher = () => {
    if (!newTeacher.name.trim() || !newTeacher.classId) return;
    const username = newTeacher.username.trim() || slugUser(newTeacher.name);
    if (roster.teachers.some((t) => t.username?.toLowerCase() === username.toLowerCase())) return;
    const password = newTeacher.password.trim() || Math.random().toString(36).slice(2, 8);
    const t = { id: genId("TCH", roster.teachers), name: newTeacher.name.trim(), classId: newTeacher.classId, username, password, subjects: [] };
    saveRoster({ ...roster, teachers: [...roster.teachers, t] }, `${t.name} — login: ${username} / ${password}`);
    setNewTeacher({ name: "", classId: "", username: "", password: "" });
  };
  const addStudent = () => {
    if (!newStudent.name.trim() || !newStudent.classId) return;
    const s = { id: genId("STU", roster.students), name: newStudent.name.trim(), classId: newStudent.classId, parentName: newStudent.parentName.trim(), feeDue: Number(newStudent.feeDue) || 0, feePaid: 0, payments: [] };
    saveRoster({ ...roster, students: [...roster.students, s] }, `Added ${s.name}`);
    setNewStudent({ name: "", classId: "", parentName: "", feeDue: "" });
  };
  const removeItem = (kind, id) => saveRoster({ ...roster, [kind]: roster[kind].filter((x) => x.id !== id) }, "Removed");
  const toggleTeacherSubject = (teacherId, subject) => {
    saveRoster({
      ...roster,
      teachers: roster.teachers.map((t) => {
        if (t.id !== teacherId) return t;
        const subs = t.subjects || [];
        return { ...t, subjects: subs.includes(subject) ? subs.filter((s) => s !== subject) : [...subs, subject] };
      }),
    });
  };
  const resetTeacherPassword = (id) => {
    const pw = Math.random().toString(36).slice(2, 8);
    const t = roster.teachers.find((x) => x.id === id);
    saveRoster({ ...roster, teachers: roster.teachers.map((x) => x.id === id ? { ...x, password: pw } : x) }, `${t?.name}'s new password: ${pw}`);
  };
  const setFeeDue = (id, val) => saveRoster({ ...roster, students: roster.students.map((s) => s.id === id ? { ...s, feeDue: Number(val) || 0 } : s) });
  const recordPayment = () => {
    const amt = Number(payment.amount);
    if (!payment.studentId || !amt || amt <= 0) return;
    const st = roster.students.find((s) => s.id === payment.studentId);
    saveRoster({
      ...roster,
      students: roster.students.map((s) => s.id === payment.studentId
        ? { ...s, feePaid: (s.feePaid || 0) + amt, payments: [...(s.payments || []), { date: todayISO(), amount: amt }] } : s),
    }, `Recorded ${cur}${money(amt)} from ${st?.name}`);
    setPayment({ studentId: "", amount: "" });
  };

  return (
    <div>
      {topBar("Admin", onExit)}
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 6px 60px" }}>
        <TabBar tabs={["overview", "classes", "subjects", "teachers", "students", "marks", "fees", "reports", "backup", "settings"]} active={tab} onChange={setTab} />
        <div style={{ ...paperPanel(), padding: 22 }} className="chalk-fade">

          {tab === "overview" && <AdminOverview roster={roster} />}

          {tab === "classes" && (
            <div>
              <SectionTitle>Classes</SectionTitle>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <input value={newClass} onChange={(e) => setNewClass(e.target.value)} placeholder="e.g. Form 1" style={{ ...darkInput(), flex: 1 }} onKeyDown={(e) => e.key === "Enter" && addClass()} />
                <button onClick={addClass} style={primaryBtn()}>Add class</button>
              </div>
              <RowList items={roster.classes} render={(c) => c.name} onRemove={(id) => removeItem("classes", id)} />
            </div>
          )}

          {tab === "subjects" && (
            <div>
              <SectionTitle>Subjects</SectionTitle>
              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 10 }}>These appear in the exam-entry dropdown and can be assigned to teachers.</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <input value={newSubject} onChange={(e) => setNewSubject(e.target.value)} placeholder="Add another subject" style={{ ...darkInput(), flex: 1 }} onKeyDown={(e) => e.key === "Enter" && addSubject()} />
                <button onClick={addSubject} style={primaryBtn()}>Add subject</button>
              </div>
              <RowList
                items={roster.subjects.map((s) => ({ id: s, name: s }))}
                render={(s) => s.name}
                onRemove={(id) => saveRoster({ ...roster, subjects: roster.subjects.filter((s) => s !== id) }, "Removed")}
              />
            </div>
          )}

          {tab === "teachers" && (
            <div>
              <SectionTitle>Teachers</SectionTitle>
              <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                <input value={newTeacher.name} onChange={(e) => setNewTeacher({ ...newTeacher, name: e.target.value })} placeholder="Teacher name" style={{ ...darkInput(), flex: 1, minWidth: 150 }} />
                <select value={newTeacher.classId} onChange={(e) => setNewTeacher({ ...newTeacher, classId: e.target.value })} style={darkInput()}>
                  <option value="">Assign class…</option>
                  {roster.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                <input value={newTeacher.username} onChange={(e) => setNewTeacher({ ...newTeacher, username: e.target.value })} placeholder="Username (auto if blank)" style={{ ...darkInput(), flex: 1, minWidth: 150 }} />
                <input value={newTeacher.password} onChange={(e) => setNewTeacher({ ...newTeacher, password: e.target.value })} placeholder="Password (auto if blank)" style={{ ...darkInput(), flex: 1, minWidth: 150 }} />
                <button onClick={addTeacher} style={primaryBtn()}>Add teacher</button>
              </div>

              {roster.teachers.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No teachers yet.</div>}
              <div style={{ display: "grid", gap: 10 }}>
                {roster.teachers.map((t) => (
                  <div key={t.id} style={{ padding: "12px 14px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                      <span style={{ fontFamily: FONT.body, fontSize: 14, color: "#22304A", fontWeight: 600 }}>{t.name}</span>
                      <span style={{ display: "flex", gap: 12 }}>
                        <button onClick={() => resetTeacherPassword(t.id)} style={{ background: "none", border: "none", color: "#22304A", fontFamily: FONT.mono, fontSize: 11.5 }}>reset password</button>
                        <button onClick={() => removeItem("teachers", t.id)} style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11.5 }}>remove</button>
                      </span>
                    </div>
                    <div style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368", marginTop: 2 }}>{classNameOf(roster, t.classId)} · login: {t.username}</div>
                    <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", margin: "9px 0 5px" }}>Subjects taught (tap to toggle):</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {roster.subjects.map((sub) => {
                        const on = (t.subjects || []).includes(sub);
                        return (
                          <button key={sub} onClick={() => toggleTeacherSubject(t.id, sub)} style={{
                            padding: "5px 11px", borderRadius: 20, fontSize: 12, fontFamily: FONT.body, fontWeight: 600,
                            border: `1px solid ${on ? "#3F7A5C" : "#D8D2C2"}`, background: on ? "#3F7A5C" : "#fff", color: on ? "#fff" : "#6B6552",
                          }}>{sub}</button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "students" && (
            <div>
              <SectionTitle>Students</SectionTitle>
              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                <input value={newStudent.name} onChange={(e) => setNewStudent({ ...newStudent, name: e.target.value })} placeholder="Student name" style={{ ...darkInput(), flex: 1, minWidth: 140 }} />
                <select value={newStudent.classId} onChange={(e) => setNewStudent({ ...newStudent, classId: e.target.value })} style={darkInput()}>
                  <option value="">Assign class…</option>
                  {roster.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <input value={newStudent.parentName} onChange={(e) => setNewStudent({ ...newStudent, parentName: e.target.value })} placeholder="Guardian (optional)" style={{ ...darkInput(), flex: 1, minWidth: 130 }} />
                <input value={newStudent.feeDue} onChange={(e) => setNewStudent({ ...newStudent, feeDue: e.target.value })} placeholder="Fee due" type="number" style={{ ...darkInput(), width: 100 }} />
                <button onClick={addStudent} style={primaryBtn()}>Add student</button>
              </div>
              <RowList items={roster.students} render={(s) => `${s.name} — ${classNameOf(roster, s.classId)}${s.parentName ? " · guardian: " + s.parentName : ""}`} onRemove={(id) => removeItem("students", id)} />
            </div>
          )}

          {tab === "marks" && (
            <div>
              <SectionTitle>Exam results</SectionTitle>
              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 12 }}>Enter or review any class's results — admin can enter every subject.</div>
              <select value={marksClassId} onChange={(e) => setMarksClassId(e.target.value)} style={{ ...darkInput(), marginBottom: 16, width: "100%", maxWidth: 320 }}>
                <option value="">Choose a class…</option>
                {roster.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {!marksClassId && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Select a class to enter results.</div>}
              {marksClassId && (
                <MarksEditor roster={roster} saveRoster={saveRoster} classId={marksClassId}
                  students={roster.students.filter((s) => s.classId === marksClassId)}
                  allowedSubjects={roster.subjects} />
              )}
            </div>
          )}

          {tab === "fees" && (
            <div>
              <SectionTitle>Fees</SectionTitle>
              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 4, padding: 12 }}>
                <select value={payment.studentId} onChange={(e) => setPayment({ ...payment, studentId: e.target.value })} style={darkInput()}>
                  <option value="">Record payment for…</option>
                  {roster.students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} placeholder="Amount" type="number" style={{ ...darkInput(), width: 110 }} />
                <button onClick={recordPayment} style={primaryBtn()}>Record payment</button>
              </div>
              {roster.students.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Add students first.</div>}
              <div style={{ display: "grid", gap: 6 }}>
                {roster.students.map((s) => {
                  const due = s.feeDue || 0, paid = s.feePaid || 0, bal = due - paid;
                  return (
                    <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "9px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 3, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({classNameOf(roster, s.classId)})</span></span>
                      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <input type="number" defaultValue={due} onBlur={(e) => setFeeDue(s.id, e.target.value)} style={{ ...darkInput(), width: 90, padding: "5px 8px" }} />
                        <span style={{ fontFamily: FONT.mono, fontSize: 12, color: "#3F7A5C" }}>paid {cur}{money(paid)}</span>
                        <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: bal > 0 ? "#B84C3E" : "#3F7A5C" }}>{bal > 0 ? `owes ${cur}${money(bal)}` : "cleared"}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "reports" && <AdminReports roster={roster} />}

          {tab === "backup" && <AdminBackup roster={roster} saveRoster={saveRoster} syncState={syncState} onForceSave={onForceSave} />}

          {tab === "settings" && (
            <div>
              <SectionTitle>Settings</SectionTitle>
              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 8 }}>Admin passcode</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
                <input value={newAdminPass} onChange={(e) => setNewAdminPass(e.target.value)} placeholder="New admin passcode" style={{ ...darkInput(), flex: 1 }} />
                <button onClick={() => { if (newAdminPass.trim()) { saveRoster({ ...roster, settings: { ...roster.settings, adminPassword: newAdminPass.trim() } }, "Passcode updated"); setNewAdminPass(""); } }} style={primaryBtn()}>Update</button>
              </div>

              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 8 }}>Pass mark (a student passes at or above this average)</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 20, alignItems: "center" }}>
                <select value={roster.settings.passMark} onChange={(e) => saveRoster({ ...roster, settings: { ...roster.settings, passMark: Number(e.target.value) } }, "Pass mark updated")} style={{ ...darkInput(), width: 110 }}>
                  {SCORE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <span style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552" }}>out of 100</span>
              </div>

              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 8 }}>Currency</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {["KSh", "$", "£", "€"].map((c) => (
                  <button key={c} onClick={() => saveRoster({ ...roster, settings: { ...roster.settings, currency: c } }, "Currency updated")} style={{
                    ...primaryBtn(), background: cur === c ? "#E8B23D" : "#22304A", color: cur === c ? "#1F3A2E" : "#F5F3EE",
                  }}>{c}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AdminOverview({ roster }) {
  const cur = roster.settings.currency;
  const totalDue = roster.students.reduce((a, s) => a + (s.feeDue || 0), 0);
  const totalPaid = roster.students.reduce((a, s) => a + (s.feePaid || 0), 0);
  const today = todayISO();
  let presentToday = 0;
  Object.values(roster.attendance || {}).forEach((cls) => {
    Object.values(cls[today] || {}).forEach((v) => { if (v === "present" || v === "late") presentToday++; });
  });
  const cleared = roster.students.filter((s) => (s.feeDue || 0) - (s.feePaid || 0) <= 0).length;

  return (
    <div>
      <SectionTitle>Overview</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px,1fr))", gap: 12, marginTop: 10 }}>
        <StatCard label="Classes" value={roster.classes.length} />
        <StatCard label="Teachers" value={roster.teachers.length} />
        <StatCard label="Students" value={roster.students.length} />
        <StatCard label="Present today" value={presentToday} />
        <StatCard label="Fees collected" value={`${cur}${money(totalPaid)}`} tone="#3F7A5C" />
        <StatCard label="Fees outstanding" value={`${cur}${money(totalDue - totalPaid)}`} tone={totalDue - totalPaid > 0 ? "#B84C3E" : "#3F7A5C"} />
        <StatCard label="Fees cleared" value={`${cleared}/${roster.students.length}`} />
      </div>
      {roster.students.length === 0 && (
        <p style={{ fontFamily: FONT.body, color: "#6B6552", fontSize: 13, marginTop: 18 }}>
          Start by adding a class, then a teacher (this creates their login), then students.
        </p>
      )}
    </div>
  );
}

// ---------- Admin reports: fees paid/unpaid, exam pass/fail ----------
function AdminReports({ roster }) {
  const cur = roster.settings.currency;
  const passMark = roster.settings.passMark || 50;
  const [view, setView] = useState("fees");
  const [classId, setClassId] = useState("");
  const [term, setTerm] = useState(DEFAULT_TERM);

  const paid = [], partial = [], unpaid = [];
  roster.students.forEach((s) => {
    const due = s.feeDue || 0, p = s.feePaid || 0;
    if (due > 0 && p >= due) paid.push(s);
    else if (p > 0) partial.push(s);
    else unpaid.push(s);
  });

  const examClasses = classId ? roster.classes.filter((c) => c.id === classId) : roster.classes;
  const passed = [], failed = [], noResult = [];
  examClasses.forEach((c) => {
    const { grid } = getMarksFor(roster, c.id, term);
    roster.students.filter((s) => s.classId === c.id).forEach((s) => {
      const avg = studentAverage(grid, s.id);
      if (avg === null) noResult.push({ s, c });
      else if (avg >= passMark) passed.push({ s, c, avg });
      else failed.push({ s, c, avg });
    });
  });

  const List = ({ items, empty, render, tone }) => (
    items.length === 0
      ? <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368", marginBottom: 14 }}>{empty}</div>
      : <div style={{ display: "grid", gap: 5, marginBottom: 16 }}>
          {items.map((it, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#F5F1E6", border: `1px solid ${tone || "#E4DFCF"}`, borderLeft: `4px solid ${tone || "#E4DFCF"}`, borderRadius: 3 }}>
              {render(it)}
            </div>
          ))}
        </div>
  );

  return (
    <div>
      <SectionTitle>Reports</SectionTitle>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {["fees", "exam"].map((v) => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: "6px 14px", borderRadius: 3, fontFamily: FONT.body, fontSize: 12.5, fontWeight: 600, textTransform: "capitalize",
            border: `1px solid ${view === v ? "#22304A" : "#D8D2C2"}`, background: view === v ? "#22304A" : "#fff", color: view === v ? "#fff" : "#6B6552",
          }}>{v === "fees" ? "Fee status" : "Exam results"}</button>
        ))}
      </div>

      {view === "fees" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px,1fr))", gap: 10, marginBottom: 18 }}>
            <StatCard label="Fully paid" value={paid.length} tone="#3F7A5C" />
            <StatCard label="Part paid" value={partial.length} tone="#C98A2C" />
            <StatCard label="Not paid" value={unpaid.length} tone="#B84C3E" />
          </div>

          <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#3F7A5C", marginBottom: 8 }}>✓ Fully paid ({paid.length})</div>
          <List items={paid} empty="Nobody has cleared their fees yet." tone="#3F7A5C" render={(s) => (<>
            <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({classNameOf(roster, s.classId)})</span></span>
            <span style={{ fontFamily: FONT.mono, fontSize: 12.5, color: "#3F7A5C" }}>{cur}{money(s.feePaid)}</span>
          </>)} />

          <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#C98A2C", marginBottom: 8 }}>◐ Part paid ({partial.length})</div>
          <List items={partial} empty="No partial payments." tone="#C98A2C" render={(s) => (<>
            <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({classNameOf(roster, s.classId)})</span></span>
            <span style={{ fontFamily: FONT.mono, fontSize: 12.5, color: "#B84C3E" }}>owes {cur}{money((s.feeDue || 0) - (s.feePaid || 0))}</span>
          </>)} />

          <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#B84C3E", marginBottom: 8 }}>✗ Not paid ({unpaid.length})</div>
          <List items={unpaid} empty="Everyone has paid something." tone="#B84C3E" render={(s) => (<>
            <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({classNameOf(roster, s.classId)})</span></span>
            <span style={{ fontFamily: FONT.mono, fontSize: 12.5, color: "#B84C3E" }}>{cur}{money(s.feeDue)} due</span>
          </>)} />
        </div>
      )}

      {view === "exam" && (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ ...darkInput(), flex: 1, minWidth: 150 }}>
              <option value="">All classes</option>
              {roster.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Term" style={{ ...darkInput(), width: 120 }} />
          </div>
          <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14 }}>Pass mark: <strong>{passMark}/100</strong> average (change in Settings).</div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px,1fr))", gap: 10, marginBottom: 18 }}>
            <StatCard label="Passed" value={passed.length} tone="#3F7A5C" />
            <StatCard label="Failed" value={failed.length} tone="#B84C3E" />
            <StatCard label="No results" value={noResult.length} />
          </div>

          <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#3F7A5C", marginBottom: 8 }}>✓ Passed ({passed.length})</div>
          <List items={passed} empty="No passes recorded for this term." tone="#3F7A5C" render={({ s, c, avg }) => (<>
            <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({c.name})</span></span>
            <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: "#3F7A5C" }}>{avg}/100</span>
          </>)} />

          <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#B84C3E", marginBottom: 8 }}>✗ Failed ({failed.length})</div>
          <List items={failed} empty="No failures recorded for this term." tone="#B84C3E" render={({ s, c, avg }) => (<>
            <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({c.name})</span></span>
            <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: "#B84C3E" }}>{avg}/100</span>
          </>)} />

          {noResult.length > 0 && (
            <>
              <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#8A8368", marginBottom: 8 }}>— No results yet ({noResult.length})</div>
              <List items={noResult} empty="" render={({ s, c }) => (
                <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({c.name})</span></span>
              )} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ================= MARKS EDITOR (shared: admin + teacher) =================
function MarksEditor({ roster, saveRoster, classId, students, allowedSubjects }) {
  const [term, setTerm] = useState(DEFAULT_TERM);
  const [entry, setEntry] = useState({ studentId: "", subject: "", score: "" });
  const { approved, grid } = getMarksFor(roster, classId, term);
  const passMark = roster.settings.passMark || 50;

  const addMark = () => {
    if (!entry.studentId || !entry.subject || entry.score === "") return;
    const nextGrid = { ...grid, [entry.studentId]: { ...(grid[entry.studentId] || {}), [entry.subject]: Number(entry.score) } };
    saveRoster(setMarksFor(roster, classId, term, { approved, grid: nextGrid }), "Result added");
    setEntry({ studentId: entry.studentId, subject: "", score: "" }); // keep student for quick next subject
  };

  const removeMark = (studentId, subject) => {
    const nextGrid = { ...grid, [studentId]: { ...grid[studentId] } };
    delete nextGrid[studentId][subject];
    saveRoster(setMarksFor(roster, classId, term, { approved, grid: nextGrid }), "Result removed");
  };

  const setApproved = (val) => saveRoster(setMarksFor(roster, classId, term, { approved: val, grid }), val ? `Results published for ${term}` : `Results unpublished`);

  const rows = [];
  students.forEach((s) => {
    Object.entries(grid[s.id] || {}).forEach(([subject, score]) => {
      if (score !== undefined && (allowedSubjects.includes(subject) || true)) rows.push({ sId: s.id, name: s.name, subject, score });
    });
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
        <div style={{
          display: "inline-block", padding: "5px 12px", borderRadius: 12, fontFamily: FONT.mono, fontSize: 11, fontWeight: 700,
          background: approved ? "#E4F0E8" : "#F5E8DC", color: approved ? "#3F7A5C" : "#C98A2C", border: `1px solid ${approved ? "#B8D9C4" : "#E8CBA0"}`,
        }}>{approved ? "● PUBLISHED to students & parents" : "○ DRAFT — hidden from students/parents"}</div>
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Term" style={{ ...darkInput(), width: 120 }} />
      </div>

      {allowedSubjects.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#B84C3E" }}>No subjects assigned to you — ask admin to assign the subjects you teach.</div>}
      {allowedSubjects.length > 0 && students.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No students in this class yet.</div>}

      {allowedSubjects.length > 0 && students.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <select value={entry.studentId} onChange={(e) => setEntry({ ...entry, studentId: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 130 }}>
              <option value="">Student…</option>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={entry.subject} onChange={(e) => setEntry({ ...entry, subject: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 120 }}>
              <option value="">Subject…</option>
              {allowedSubjects.map((sub) => <option key={sub} value={sub}>{sub}</option>)}
            </select>
            <select value={entry.score} onChange={(e) => setEntry({ ...entry, score: e.target.value })} style={{ ...darkInput(), width: 100 }}>
              <option value="">Score…</option>
              {SCORE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button onClick={addMark} disabled={!entry.studentId || !entry.subject || entry.score === ""} style={primaryBtn()}>
              Add result
            </button>
          </div>

          {rows.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No results entered for {term} yet.</div>}
          <div style={{ display: "grid", gap: 5 }}>
            {rows.map((r) => (
              <div key={r.sId + r.subject} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 3 }}>
                <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>
                  {r.name} — {r.subject}: <strong style={{ color: r.score >= passMark ? "#3F7A5C" : "#B84C3E" }}>{r.score}/100</strong>
                </span>
                <button onClick={() => removeMark(r.sId, r.subject)} style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11.5 }}>remove</button>
              </div>
            ))}
          </div>

          {rows.length > 0 && (
            <div style={{ marginTop: 16 }}>
              {!approved
                ? <button onClick={() => setApproved(true)} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Publish results</button>
                : <button onClick={() => setApproved(false)} style={{ ...primaryBtn(), background: "#B84C3E" }}>Unpublish</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ================= TEACHER =================
function TeacherView({ roster, saveRoster, teacherId, onExit }) {
  const teacher = roster.teachers.find((t) => t.id === teacherId);
  const [tab, setTab] = useState("attendance");
  if (!teacher) return <div style={{ color: "#F5F3EE", padding: 30 }}>Teacher not found. <button onClick={onExit} style={backBtnStyle()}>go back</button></div>;
  const classId = teacher.classId;
  const students = roster.students.filter((s) => s.classId === classId);
  const mySubjects = teacher.subjects?.length ? teacher.subjects : [];

  return (
    <div>
      {topBar(`${teacher.name} · ${classNameOf(roster, classId)}`, onExit)}
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 6px 60px" }}>
        <TabBar tabs={["attendance", "results"]} active={tab} onChange={setTab} />
        <div style={{ ...paperPanel(), padding: 22 }} className="chalk-fade">
          {tab === "attendance" && <TeacherAttendance roster={roster} saveRoster={saveRoster} classId={classId} students={students} />}
          {tab === "results" && (
            <div>
              <SectionTitle>Exam results</SectionTitle>
              <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
                You can enter results for: {mySubjects.length ? mySubjects.join(", ") : "— no subjects assigned yet —"}
              </div>
              <MarksEditor roster={roster} saveRoster={saveRoster} classId={classId} students={students} allowedSubjects={mySubjects} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TeacherAttendance({ roster, saveRoster, classId, students }) {
  const [date, setDate] = useState(todayISO());
  const log = getAttendanceFor(roster, classId);
  const marks = log[date] || {};

  const setMark = (studentId, status) => {
    const nextLog = { ...log, [date]: { ...(log[date] || {}), [studentId]: status } };
    saveRoster(setAttendanceFor(roster, classId, nextLog));
  };

  const history = [...Array(7)].map((_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const day = log[iso] || {};
    return { d: iso, total: Object.keys(day).length, present: Object.values(day).filter((v) => v === "present" || v === "late").length };
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <SectionTitle>Mark attendance</SectionTitle>
        <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} style={darkInput()} />
      </div>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>Each tap saves right away — no separate save button.</div>

      {students.length === 0 && <div style={{ fontFamily: FONT.body, color: "#8A8368", fontSize: 13 }}>No students in this class yet.</div>}
      <div style={{ display: "grid", gap: 6 }}>
        {students.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 3 }}>
            <div>
              <div style={{ fontFamily: FONT.body, fontSize: 14, color: "#22304A", fontWeight: 500 }}>{s.name}</div>
              <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368" }}>{s.id}</div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {Object.entries(STATUS).map(([key, val]) => (
                <button key={key} onClick={() => setMark(s.id, key)} title={val.label} style={{
                  width: 34, height: 34, borderRadius: "50%",
                  border: `2px solid ${marks[s.id] === key ? val.ink : "#D8D2C2"}`,
                  background: marks[s.id] === key ? val.ink : "transparent",
                  color: marks[s.id] === key ? "#fff" : val.ink,
                  fontFamily: FONT.mono, fontWeight: 700, fontSize: 13,
                }}>{val.mark}</button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 22 }}>
        <SectionTitle>Last 7 days</SectionTitle>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {history.map((h) => (
            <div key={h.d} style={{ textAlign: "center", minWidth: 62 }}>
              <div style={{ fontFamily: FONT.mono, fontSize: 9.5, color: "#8A8368" }}>{fmtDate(h.d)}</div>
              <div style={{ fontFamily: FONT.display, fontSize: 17, fontWeight: 700, color: "#22304A" }}>{h.total ? `${h.present}/${h.total}` : "—"}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ================= FAMILY =================
function FamilyView({ roster, studentId, onExit }) {
  const student = roster.students.find((s) => s.id === studentId);
  const [term, setTerm] = useState(DEFAULT_TERM);
  const [printDoc, setPrintDoc] = useState(null);
  if (!student) return <div style={{ color: "#F5F3EE", padding: 30 }}>Student not found. <button onClick={onExit} style={backBtnStyle()}>go back</button></div>;

  const cur = roster.settings.currency;
  const passMark = roster.settings.passMark || 50;
  const { approved, grid } = getMarksFor(roster, student.classId, term);
  const termMarks = approved ? (grid[student.id] || {}) : {};
  const avg = approved ? studentAverage(grid, student.id) : null;

  const classLog = getAttendanceFor(roster, student.classId);
  const log = [...Array(30)].map((_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    return { d: iso, status: classLog[iso]?.[student.id] };
  }).filter((r) => r.status);
  const presentDays = log.filter((r) => r.status === "present" || r.status === "late").length;
  const rate = log.length ? Math.round((presentDays / log.length) * 100) : null;
  const due = student.feeDue || 0, paid = student.feePaid || 0, balance = due - paid;

  if (printDoc === "invoice") return <InvoiceDoc roster={roster} student={student} onBack={() => setPrintDoc(null)} />;
  if (printDoc === "report") return <ReportDoc roster={roster} student={student} term={term} termMarks={termMarks} avg={avg} rate={rate} onBack={() => setPrintDoc(null)} />;

  return (
    <div>
      {topBar(`${student.name}'s record`, onExit)}
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "0 6px 60px" }}>
        <div style={{ ...paperPanel(), padding: 22 }} className="chalk-fade">
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 14, marginBottom: 16 }}>
            <div>
              <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368" }}>{student.id}</div>
              <div style={{ fontFamily: FONT.display, fontSize: 20, fontWeight: 600, color: "#22304A" }}>{student.name}</div>
              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552" }}>{classNameOf(roster, student.classId)}{student.parentName ? ` · Guardian: ${student.parentName}` : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <StatCard label="Attendance" value={rate === null ? "—" : `${rate}%`} />
              <StatCard label="Fee balance" value={`${cur}${money(balance)}`} tone={balance > 0 ? "#B84C3E" : "#3F7A5C"} />
            </div>
          </div>

          <button onClick={() => setPrintDoc("invoice")} style={{ ...primaryBtn(), marginBottom: 22 }}>Open printable fee invoice</button>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <SectionTitle>Results — {term}</SectionTitle>
            <button onClick={() => approved && setPrintDoc("report")} disabled={!approved} style={{ ...primaryBtn(), opacity: approved ? 1 : 0.45 }}>Open report card</button>
          </div>
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Term" style={{ ...darkInput(), width: 120, marginBottom: 12 }} />

          {!approved && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368", marginBottom: 18 }}>Results for this term haven't been published yet.</div>}
          {approved && Object.keys(termMarks).length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368", marginBottom: 18 }}>No results recorded for this term.</div>}
          {approved && Object.keys(termMarks).length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: "grid", gap: 5, marginBottom: 10 }}>
                {Object.entries(termMarks).map(([subject, score]) => (
                  <div key={subject} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 3 }}>
                    <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{subject}</span>
                    <span style={{ fontFamily: FONT.mono, fontWeight: 700, color: score >= passMark ? "#3F7A5C" : "#B84C3E" }}>{score}/100</span>
                  </div>
                ))}
              </div>
              {avg !== null && (
                <div style={{ padding: "10px 12px", borderRadius: 3, background: avg >= passMark ? "#E4F0E8" : "#F7E4E1", border: `1px solid ${avg >= passMark ? "#B8D9C4" : "#E8C4BD"}`, fontFamily: FONT.body, fontSize: 14, color: "#22304A" }}>
                  Average <strong>{avg}/100</strong> — <strong style={{ color: avg >= passMark ? "#3F7A5C" : "#B84C3E" }}>{avg >= passMark ? "PASS" : "FAIL"}</strong> <span style={{ color: "#8A8368", fontSize: 12 }}>(pass mark {passMark})</span>
                </div>
              )}
            </div>
          )}

          <SectionTitle>Recent attendance</SectionTitle>
          {log.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No attendance recorded yet.</div>}
          <div style={{ display: "grid", gap: 5 }}>
            {log.map((r) => (
              <div key={r.d} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 3 }}>
                <Stamp status={r.status} size={26} />
                <div style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{fmtDate(r.d)}</div>
                <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368", marginLeft: "auto" }}>{STATUS[r.status]?.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ================= PRINTABLE DOCUMENTS (inline, no pop-up) =================
function DocShell({ title, onBack, children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#1F3A2E" }}>
      <div className="no-print" style={{ maxWidth: 720, margin: "0 auto", padding: "14px 12px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={onBack} style={{ background: "transparent", border: "1px solid #4A6E58", color: "#F5F3EE", borderRadius: 3, padding: "8px 14px", fontFamily: FONT.body, fontSize: 13 }}>← Back</button>
        <button onClick={() => window.print()} style={{ ...primaryBtn(), background: "#E8B23D", color: "#1F3A2E" }}>Print / Save as PDF</button>
        <span style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#8AA090" }}>{title}</span>
      </div>
      <div className="print-doc" style={{
        maxWidth: 720, margin: "0 auto 24px", background: "#fff", color: "#22304A",
        border: "1px solid #D8D2C2", borderRadius: 4, padding: "30px 32px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)", fontFamily: "Georgia, 'Times New Roman', serif",
      }}>{children}</div>
      <div className="no-print" style={{ maxWidth: 720, margin: "0 auto", padding: "0 12px 50px", fontFamily: FONT.body, fontSize: 12, color: "#8AA090", lineHeight: 1.5 }}>
        If the Print button doesn't respond, use your browser menu (⋮ → Print or Share → Print), or screenshot the document above.
      </div>
    </div>
  );
}

function DocHeader({ subtitle }) {
  return (
    <div style={{ textAlign: "center", borderBottom: "2px solid #22304A", paddingBottom: 14, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "center" }}><Seal size={50} ink="#22304A" /></div>
      <div style={{ fontFamily: FONT.mono, fontSize: 10, letterSpacing: 1.3, color: "#6B6552", marginTop: 8 }}>REPUBLIC OF KENYA · MINISTRY OF EDUCATION</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{SCHOOL_NAME}</div>
      <div style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368", marginTop: 2 }}>{SCHOOL_LOCATION}</div>
      <div style={{ fontWeight: "bold", marginTop: 10, fontSize: 14 }}>{subtitle}</div>
    </div>
  );
}

function DocInfo({ roster, student }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 20, fontSize: 13 }}>
      <div><strong>Student:</strong> {student.name}</div>
      <div><strong>Admission No:</strong> {student.id}</div>
      <div><strong>Class:</strong> {classNameOf(roster, student.classId)}</div>
      <div><strong>Guardian:</strong> {student.parentName || "—"}</div>
    </div>
  );
}

const docTh = { borderBottom: "1px solid #E4DFCF", padding: "7px 8px", textAlign: "left", fontFamily: FONT.mono, fontSize: 9.5, textTransform: "uppercase", color: "#8A8368", letterSpacing: 0.5 };
const docTd = { borderBottom: "1px solid #E4DFCF", padding: "7px 8px", fontSize: 13 };
const docSig = { borderTop: "1px solid #B8B2A0", paddingTop: 6, fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368", textAlign: "center" };

function InvoiceDoc({ roster, student, onBack }) {
  const cur = roster.settings.currency;
  const due = student.feeDue || 0;
  const payments = student.payments || [];
  const paid = payments.reduce((a, p) => a + (p.amount || 0), 0);
  const balance = due - paid;

  return (
    <DocShell title="Fee invoice" onBack={onBack}>
      <DocHeader subtitle="Fee Invoice / Statement" />
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18, fontSize: 12.5, flexWrap: "wrap", gap: 8 }}>
        <div><strong>Invoice No:</strong> INV-{student.id}-{todayISO().replace(/-/g, "")}</div>
        <div><strong>Date:</strong> {fmtDate(todayISO())}</div>
      </div>
      <DocInfo roster={roster} student={student} />
      <div style={{ fontWeight: "bold", marginBottom: 8 }}>Payment history</div>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 16 }}>
        <thead><tr><th style={docTh}>#</th><th style={docTh}>Date</th><th style={docTh}>Description</th><th style={{ ...docTh, textAlign: "right" }}>Amount</th></tr></thead>
        <tbody>
          {payments.length === 0 && <tr><td style={{ ...docTd, color: "#6B6552" }} colSpan={4}>No payments recorded yet.</td></tr>}
          {payments.map((p, i) => (
            <tr key={i}>
              <td style={docTd}>{i + 1}</td>
              <td style={docTd}>{fmtDate(p.date)}</td>
              <td style={{ ...docTd, color: "#6B6552" }}>Fee payment</td>
              <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontWeight: 700 }}>{cur}{money(p.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginLeft: "auto", width: 250 }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13 }}><span>Total fee due</span><span>{cur}{money(due)}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13 }}><span>Total paid</span><span>{cur}{money(paid)}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", borderTop: "2px solid #22304A", marginTop: 4, paddingTop: 10, fontWeight: "bold", fontSize: 16 }}>
          <span>Balance</span><span>{cur}{money(balance)}</span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 55 }}>
        <div style={docSig}>Parent/Guardian Signature</div>
        <div style={docSig}>Bursar's Signature</div>
      </div>
    </DocShell>
  );
}

function ReportDoc({ roster, student, term, termMarks, avg, rate, onBack }) {
  const cur = roster.settings.currency;
  const passMark = roster.settings.passMark || 50;
  const entries = Object.entries(termMarks);
  const due = student.feeDue || 0, paid = student.feePaid || 0;
  const remark = (s) => (s >= 80 ? "Excellent" : s >= 65 ? "Good" : s >= passMark ? "Fair" : "Needs improvement");

  return (
    <DocShell title="Report card" onBack={onBack}>
      <DocHeader subtitle={`Student Report Card — ${term}`} />
      <DocInfo roster={roster} student={student} />
      <div style={{ fontWeight: "bold", marginBottom: 8 }}>Academic performance</div>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 16 }}>
        <thead><tr><th style={docTh}>Subject</th><th style={docTh}>Score</th><th style={docTh}>Remark</th></tr></thead>
        <tbody>
          {entries.length === 0 && <tr><td style={{ ...docTd, color: "#6B6552" }} colSpan={3}>No results recorded.</td></tr>}
          {entries.map(([subject, score]) => (
            <tr key={subject}>
              <td style={docTd}>{subject}</td>
              <td style={{ ...docTd, fontFamily: FONT.mono, fontWeight: 700 }}>{score}/100</td>
              <td style={{ ...docTd, color: "#6B6552", fontSize: 12 }}>{remark(score)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {avg !== null && avg !== undefined && (
        <div style={{ marginBottom: 20, fontSize: 14 }}>
          <strong>Term average: {avg}/100</strong> — <strong>{avg >= passMark ? "PASS" : "FAIL"}</strong> <span style={{ color: "#6B6552", fontSize: 12 }}>(pass mark {passMark})</span>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, margin: "18px 0 30px" }}>
        <div style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "10px 12px", background: "#F5F1E6" }}>
          <div style={{ fontFamily: FONT.mono, fontSize: 9, color: "#8A8368", letterSpacing: 1 }}>ATTENDANCE</div>
          <div style={{ fontSize: 17, fontWeight: "bold", marginTop: 3 }}>{rate === null ? "—" : `${rate}%`}</div>
        </div>
        <div style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "10px 12px", background: "#F5F1E6" }}>
          <div style={{ fontFamily: FONT.mono, fontSize: 9, color: "#8A8368", letterSpacing: 1 }}>FEES DUE / PAID / BALANCE</div>
          <div style={{ fontSize: 14, fontWeight: "bold", marginTop: 3 }}>{cur}{money(due)} / {cur}{money(paid)} / {cur}{money(due - paid)}</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 45 }}>
        <div style={docSig}>Class Teacher's Signature</div>
        <div style={docSig}>Head Teacher's Signature</div>
      </div>
    </DocShell>
  );
}

// ---------- Backup / restore: an escape hatch so data is never trapped ----------
function AdminBackup({ roster, saveRoster, syncState, onForceSave }) {
  const [restoreText, setRestoreText] = useState("");
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(roster, null, 2);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      setCopied(false);
    }
  };

  const restore = () => {
    let parsed;
    try {
      parsed = JSON.parse(restoreText);
    } catch (e) {
      alert("That doesn't look like a valid backup. Paste the whole text you copied earlier.");
      return;
    }
    if (!parsed || !Array.isArray(parsed.students)) {
      alert("That backup is missing student data — not restoring.");
      return;
    }
    if (!confirm("Replace ALL current data with this backup? This cannot be undone.")) return;
    saveRoster({ ...EMPTY_ROSTER, ...parsed, settings: { ...EMPTY_ROSTER.settings, ...(parsed.settings || {}) } }, "Backup restored");
    setRestoreText("");
  };

  const stateText = {
    saved: "All changes are saved to the server.",
    pending: "Saving your latest changes…",
    saving: "Saving your latest changes…",
    error: "The server isn't accepting saves right now. Your work is safe on this screen — copy the backup below so you don't lose it.",
  }[syncState] || "";

  return (
    <div>
      <SectionTitle>Backup &amp; restore</SectionTitle>

      <div style={{
        padding: "10px 13px", borderRadius: 4, marginBottom: 14,
        background: isShared ? "#E4F0E8" : "#FDF3E0",
        border: `1px solid ${isShared ? "#B8D9C4" : "#EBD9AE"}`,
        fontFamily: FONT.body, fontSize: 12.5, color: "#22304A",
      }}>
        {isShared
          ? "Shared database is active — every teacher, parent and admin sees the same data."
          : "This device only: no shared database is connected yet, so data saved here isn't visible to other people's phones. Keep a copy using the backup below."}
      </div>

      <div style={{
        padding: "12px 14px", borderRadius: 4, marginBottom: 18,
        background: syncState === "error" ? "#F7E4E1" : "#E4F0E8",
        border: `1px solid ${syncState === "error" ? "#E8C4BD" : "#B8D9C4"}`,
        fontFamily: FONT.body, fontSize: 13, color: "#22304A",
      }}>
        {stateText}
        {syncState === "error" && (
          <div style={{ marginTop: 10 }}>
            <button onClick={onForceSave} style={primaryBtn()}>Try saving again now</button>
          </div>
        )}
      </div>

      <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 8 }}>
        Copy this text somewhere safe (Notes, WhatsApp to yourself, email). It contains every class, teacher, student, mark, and payment.
      </div>
      <textarea readOnly value={json} onFocus={(e) => e.target.select()} style={{
        width: "100%", height: 120, fontFamily: FONT.mono, fontSize: 11, padding: 10,
        border: "1px solid #D8D2C2", borderRadius: 3, background: "#F5F1E6", color: "#22304A", resize: "vertical",
      }} />
      <button onClick={copy} style={{ ...primaryBtn(), marginTop: 8, marginBottom: 26 }}>{copied ? "✓ Copied" : "Copy backup"}</button>

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#B84C3E", marginBottom: 6 }}>Restore from a backup</div>
      <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 8 }}>
        Paste a backup here to replace everything currently in the system.
      </div>
      <textarea value={restoreText} onChange={(e) => setRestoreText(e.target.value)} placeholder="Paste backup text here…" style={{
        width: "100%", height: 90, fontFamily: FONT.mono, fontSize: 11, padding: 10,
        border: "1px solid #D8D2C2", borderRadius: 3, background: "#fff", color: "#22304A", resize: "vertical",
      }} />
      <button onClick={restore} disabled={!restoreText.trim()} style={{ ...primaryBtn(), background: "#B84C3E", marginTop: 8, opacity: restoreText.trim() ? 1 : 0.5 }}>Restore this backup</button>
    </div>
  );
}
