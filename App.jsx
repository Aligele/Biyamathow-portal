import React, { useState, useEffect, useCallback, useRef } from "react";
import { loadRoster, saveRoster as persistRoster, isShared, isOffline, hasPendingChanges } from "./store.js";

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

// ---- Timetable & duty roster ----
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_FULL = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday" };
const DEFAULT_PERIODS = [
  { id: "p1", label: "1", time: "8:00–8:40" },
  { id: "p2", label: "2", time: "8:40–9:20" },
  { id: "p3", label: "3", time: "9:20–10:00" },
  { id: "p4", label: "4", time: "10:20–11:00" },
  { id: "p5", label: "5", time: "11:00–11:40" },
  { id: "p6", label: "6", time: "11:40–12:20" },
  { id: "p7", label: "7", time: "2:00–2:40" },
  { id: "p8", label: "8", time: "2:40–3:20" },
];

const getTimetable = (roster, classId) => roster.timetable?.[classId] || {};
const setLessonIn = (roster, classId, day, periodId, lesson) => {
  const cls = { ...(roster.timetable?.[classId] || {}) };
  const dayMap = { ...(cls[day] || {}) };
  if (lesson) dayMap[periodId] = lesson; else delete dayMap[periodId];
  cls[day] = dayMap;
  return { ...roster, timetable: { ...roster.timetable, [classId]: cls } };
};

// Monday of the week containing a given date
const mondayOf = (iso) => {
  const d = new Date(iso + "T00:00:00");
  const shift = (d.getDay() + 6) % 7; // Sun=0 -> 6
  d.setDate(d.getDate() - shift);
  return d.toISOString().slice(0, 10);
};
const weekLabel = (iso) => {
  const start = new Date(iso + "T00:00:00");
  const end = new Date(start); end.setDate(end.getDate() + 4);
  const f = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${f(start)} – ${f(end)}`;
};


// ---- Assessments: two CATs plus the main exam, combined by weight ----
const ASSESSMENTS = [
  { key: "cat1", label: "CAT 1", short: "CAT 1" },
  { key: "cat2", label: "CAT 2", short: "CAT 2" },
  { key: "exam", label: "Main Exam", short: "EXAM" },
];
const DEFAULT_WEIGHTS = { cat1: 15, cat2: 15, exam: 70 };

// KCSE-style grading used by Kenyan senior schools
const GRADE_BANDS = [[80,"A"],[75,"A-"],[70,"B+"],[65,"B"],[60,"B-"],[55,"C+"],[50,"C"],[45,"C-"],[40,"D+"],[35,"D"],[30,"D-"],[0,"E"]];
const gradeOf = (score) => {
  if (score === null || score === undefined) return "—";
  for (const [min, g] of GRADE_BANDS) if (score >= min) return g;
  return "E";
};
const gradeInk = (score) => (score === null || score === undefined) ? "#8A8368" : score >= 65 ? "#3F7A5C" : score >= 50 ? "#C98A2C" : "#B84C3E";

// Older records stored a single number; treat that as the main exam mark.
const normEntry = (e) => (typeof e === "number" ? { exam: e } : (e || {}));

// Weighted final mark for one subject, scaled to whatever components exist yet.
const subjectFinal = (entry, weights) => {
  const e = normEntry(entry);
  let sum = 0, wsum = 0;
  for (const a of ASSESSMENTS) {
    const v = e[a.key];
    if (typeof v === "number") { sum += v * (weights[a.key] || 0); wsum += (weights[a.key] || 0); }
  }
  return wsum ? Math.round(sum / wsum) : null;
};

const studentSummary = (grid, studentId, subjects, weights) => {
  const per = {};
  let total = 0, count = 0;
  subjects.forEach((sub) => {
    const f = subjectFinal(grid?.[studentId]?.[sub], weights);
    if (f !== null) { per[sub] = f; total += f; count++; }
  });
  return { per, total, count, average: count ? Math.round(total / count) : null };
};

// Ranks a class, sharing a position on ties (1,2,2,4 …).
const classPositions = (grid, students, subjects, weights) => {
  const rows = students
    .map((s) => ({ student: s, ...studentSummary(grid, s.id, subjects, weights) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.average - a.average);
  let pos = 0, prev = null, seen = 0;
  rows.forEach((r) => { seen++; if (r.average !== prev) { pos = seen; prev = r.average; } r.position = pos; });
  return rows;
};
const positionOf = (rows, studentId) => {
  const r = rows.find((x) => x.student.id === studentId);
  return r ? { position: r.position, outOf: rows.length, average: r.average, total: r.total } : null;
};


const EMPTY_ROSTER = {
  classes: [],
  teachers: [],
  students: [],
  subjects: DEFAULT_SUBJECTS,
  attendance: {},      // { [classId]: { [date]: { [studentId]: status } } }
  staffAttendance: {}, // { [date]: { [teacherId]: status } }
  marks: {},           // { [classId]: { [termKey]: { approved, grid: { [studentId]: { [subject]: {cat1,cat2,exam} } } } } }
  timetable: {},       // { [classId]: { [day]: { [periodId]: { subject, teacherId } } } }
  duty: [],            // [ { id, weekStart, teacherId, note } ]
  settings: { adminPassword: DEFAULT_ADMIN_PASSWORD, currency: "KSh", passMark: 50, weights: DEFAULT_WEIGHTS, periods: DEFAULT_PERIODS },
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
            staffAttendance: p.staffAttendance || {},
            marks: p.marks || {},
            timetable: p.timetable || {},
            duty: p.duty || [],
            settings: {
              ...EMPTY_ROSTER.settings, ...(p.settings || {}),
              weights: { ...DEFAULT_WEIGHTS, ...(p.settings?.weights || {}) },
              periods: p.settings?.periods?.length ? p.settings.periods : DEFAULT_PERIODS,
            },
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

  // Offline awareness: report it honestly, and push pending work the moment
  // the connection comes back rather than waiting for the next retry tick.
  const [offline, setOffline] = useState(isOffline());
  useEffect(() => {
    const goOnline = () => { setOffline(false); flush(); };
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); };
  }, [flush]);

  useEffect(() => () => { clearTimeout(debounceRef.current); clearTimeout(retryRef.current); }, []);

  if (loading) {
    return <Shell><div style={{ padding: 40, color: "#F5F3EE", fontFamily: FONT.body }}>Opening the register…</div></Shell>;
  }

  return (
    <Shell>
      {toast && <Toast msg={toast} />}
      <SyncBadge state={syncState} offline={offline} onRetry={flush} />
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

function SyncBadge({ state, offline, onRetry }) {
  const map = {
    saved:   { text: "✓ All changes saved",   bg: "#24402F", fg: "#8FD3A8", border: "#3A6B4C" },
    pending: { text: "• Saving…",             bg: "#24402F", fg: "#B8C4B9", border: "#3A6B4C" },
    saving:  { text: "• Saving…",             bg: "#24402F", fg: "#B8C4B9", border: "#3A6B4C" },
    error:   { text: "⚠ Not saved yet — retrying", bg: "#4A2620", fg: "#F0A99B", border: "#7A3E33" },
  };
  // Offline is not a fault — work is held on the device and syncs later.
  const offlineSaved = { text: "⛅ Offline — saved on this phone", bg: "#3D3722", fg: "#E8C97A", border: "#6B5F35" };
  const s = offline ? offlineSaved : (map[state] || map.saved);
  return (
    <div className="no-print" style={{
      position: "fixed", bottom: 12, left: "50%", transform: "translateX(-50%)", zIndex: 90,
      display: "flex", alignItems: "center", gap: 10,
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
      borderRadius: 20, padding: "6px 14px", fontFamily: FONT.mono, fontSize: 11.5,
      boxShadow: "0 3px 12px rgba(0,0,0,0.3)", maxWidth: "92vw",
    }}>
      <span>{s.text}</span>
      {state === "error" && !offline && (
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
        .rise { animation: rise 0.5s cubic-bezier(.2,.7,.3,1) both; }
        @keyframes rise { from { opacity: 0; transform: translateY(14px);} to { opacity: 1; transform: translateY(0);} }
        .gate-bg {
          position: fixed; inset: 0; pointer-events: none;
          background:
            radial-gradient(60% 40% at 50% 0%, rgba(232,178,61,0.16), transparent 70%),
            radial-gradient(50% 40% at 85% 100%, rgba(63,122,92,0.28), transparent 70%),
            linear-gradient(180deg, #1B3327 0%, #1F3A2E 45%, #17281F 100%);
        }
        .role-card { transition: transform .18s ease, border-color .18s ease, background .18s ease; }
        .role-card:active { transform: scale(0.985); }
        @media (hover:hover) { .role-card:hover { border-color: #E8B23D; background: #2A4636; } }
        .rule { height:1px; flex:1; background:linear-gradient(90deg,transparent,#4A6E58,transparent); }
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

// ================= ROLE GATE =================
function RoleGate({ roster, saveRoster, onEnterAdmin, onEnterTeacher, onEnterFamily }) {
  const [step, setStep] = useState("root");
  const [adm, setAdm] = useState("");
  const [pin, setPin] = useState("");
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

  const tryFamily = () => {
    const key = adm.trim().toLowerCase();
    const st = roster.students.find((x) => x.id.toLowerCase() === key || (x.admNo || "").toLowerCase() === key);
    if (!st) return setErr("Admission number not found.");
    const expected = String(st.pin || "").trim();
    if (!expected) return setErr("No PIN set for this student yet — ask the school office.");
    if (pin.trim() !== expected) return setErr("Incorrect PIN.");
    setErr("");
    onEnterFamily(st.id);
  };

  return (
    <>
    <div className="gate-bg" />
    <div className="rise" style={{ position: "relative", maxWidth: 430, margin: "0 auto", padding: "6vh 20px 44px" }}>
      <div style={{ textAlign: "center", marginBottom: 30 }}>
        <div style={{
          width: 84, height: 84, margin: "0 auto", borderRadius: "50%",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "radial-gradient(circle at 35% 25%, #2E5040, #1C3327)",
          border: "1px solid #4A6E58",
          boxShadow: "0 0 0 6px rgba(232,178,61,0.07), 0 10px 26px rgba(0,0,0,0.35)",
        }}>
          <Seal size={52} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 0" }}>
          <span className="rule" /><span style={{ fontFamily: FONT.mono, color: "#93A899", fontSize: 9.5, letterSpacing: 2, whiteSpace: "nowrap" }}>REPUBLIC OF KENYA</span><span className="rule" />
        </div>
        <div style={{ fontFamily: FONT.mono, color: "#93A899", fontSize: 9.5, letterSpacing: 2, marginTop: 5 }}>MINISTRY OF EDUCATION</div>
        <h1 style={{ fontFamily: FONT.display, color: "#F7F5EF", fontSize: 25, margin: "12px 0 0", fontWeight: 700, lineHeight: 1.22, letterSpacing: 0.2 }}>{SCHOOL_NAME}</h1>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 9, padding: "4px 12px", borderRadius: 20, border: "1px solid #3E6350", background: "rgba(30,55,42,0.6)" }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#E8B23D" }} />
          <span style={{ fontFamily: FONT.mono, color: "#E8B23D", fontSize: 11, letterSpacing: 0.8 }}>{SCHOOL_LOCATION}</span>
        </div>
      </div>

      {step === "root" && (
        <div style={{ display: "grid", gap: 12 }}>
          <RoleCard glyph="T" title="Teacher Login" desc="Mark attendance, enter CATs and exam results." onClick={() => { setStep("teacher"); setErr(""); }} />
          <RoleCard glyph="A" title="Administration" desc="Classes, staff, students, fees and full reports." onClick={() => { setStep("admin"); setErr(""); }} />
          <RoleCard glyph="P" title="Student / Parent" desc="Results with class position, attendance and fees." onClick={() => { setStep("family"); setErr(""); }} />
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
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#A8BCAC", lineHeight: 1.5, marginBottom: 2 }}>
              Enter the admission number and PIN printed on your child's report card.
            </div>
            <input placeholder="Admission number (e.g. STU-001-abc)" value={adm}
              onChange={(e) => setAdm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && tryFamily()} style={inputStyle()} />
            <input placeholder="PIN" type="password" inputMode="numeric" value={pin}
              onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === "Enter" && tryFamily()} style={inputStyle()} />
            {err && <div style={{ color: "#E8967D", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
            <button onClick={tryFamily} style={{ ...primaryBtn(), background: "#E8B23D", color: "#1F3A2E" }}>View results</button>
            <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#7B9585", marginTop: 4, lineHeight: 1.5 }}>
              Lost the PIN? Ask the school office — Admin can look it up or set a new one.
            </div>
          </div>
        </div>
      )}

      <div style={{ textAlign: "center", marginTop: 34, fontFamily: FONT.mono, fontSize: 9.5, color: "#5F7A68", letterSpacing: 1 }}>
        ROLL · RECORD · REGISTER
      </div>
    </div>
    </>
  );
}

function RoleCard({ title, desc, onClick, glyph }) {
  return (
    <button onClick={onClick} className="role-card" style={{
      display: "flex", alignItems: "center", gap: 14, width: "100%", textAlign: "left",
      background: "rgba(36,63,49,0.72)", border: "1px solid #375A45", borderRadius: 10,
      padding: "15px 16px", color: "#F5F3EE", backdropFilter: "blur(6px)",
      boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
    }}>
      <span style={{
        flex: "0 0 auto", width: 42, height: 42, borderRadius: 10,
        border: "1px solid #4A6E58", background: "linear-gradient(160deg,#2C4B39,#213A2C)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "#E8B23D", fontFamily: FONT.mono, fontSize: 17, fontWeight: 700,
      }}>{glyph}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: FONT.display, fontSize: 18, fontWeight: 600, letterSpacing: 0.2 }}>{title}</span>
        <span style={{ display: "block", fontFamily: FONT.body, fontSize: 12.5, color: "#A8BCAC", marginTop: 2, lineHeight: 1.35 }}>{desc}</span>
      </span>
      <span style={{ flex: "0 0 auto", color: "#6E8F79", fontSize: 20, fontFamily: FONT.body }}>›</span>
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
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const s = { id: genId("STU", roster.students), name: newStudent.name.trim(), classId: newStudent.classId, parentName: newStudent.parentName.trim(), feeDue: Number(newStudent.feeDue) || 0, feePaid: 0, payments: [], pin };
    saveRoster({ ...roster, students: [...roster.students, s] }, `Added ${s.name} — PIN ${pin}`);
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
        <TabBar tabs={["overview", "classes", "subjects", "teachers", "staff", "students", "marks", "timetable", "duty", "fees", "reports", "backup", "settings"]} active={tab} onChange={setTab} />
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
              <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", marginBottom: 8 }}>
                Each student gets a PIN. Parents sign in with the admission number + PIN, so only they can see their child's results.
              </div>
              {roster.students.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No students yet.</div>}
              <div style={{ display: "grid", gap: 6 }}>
                {roster.students.map((st) => (
                  <div key={st.id} style={{ padding: "10px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                      <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", fontWeight: 600 }}>{st.name}</span>
                      <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
                        <span style={{ fontFamily: FONT.mono, fontSize: 12.5, background: "#fff", border: "1px solid #D8D2C2", borderRadius: 3, padding: "2px 8px", color: "#22304A" }}>
                          PIN {st.pin || "—"}
                        </span>
                        <button onClick={() => {
                          const np = String(Math.floor(1000 + Math.random() * 9000));
                          saveRoster({ ...roster, students: roster.students.map((x) => x.id === st.id ? { ...x, pin: np } : x) }, `${st.name}'s new PIN: ${np}`);
                        }} style={{ background: "none", border: "none", color: "#22304A", fontFamily: FONT.mono, fontSize: 11.5 }}>new PIN</button>
                        <button onClick={() => removeItem("students", st.id)} style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11.5 }}>remove</button>
                      </span>
                    </div>
                    <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368", marginTop: 3 }}>
                      {st.id} · {classNameOf(roster, st.classId)}{st.parentName ? " · guardian: " + st.parentName : ""}
                    </div>
                  </div>
                ))}
              </div>
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

          {tab === "staff" && <StaffAttendance roster={roster} saveRoster={saveRoster} />}

          {tab === "timetable" && <TimetableAdmin roster={roster} saveRoster={saveRoster} />}

          {tab === "duty" && <DutyRoster roster={roster} saveRoster={saveRoster} />}

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

              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 8 }}>
                Assessment weighting (must total 100)
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap", alignItems: "center" }}>
                {ASSESSMENTS.map((a) => (
                  <label key={a.key} style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: FONT.body, fontSize: 12.5, color: "#22304A" }}>
                    {a.label}
                    <input type="number" min="0" max="100"
                      value={(roster.settings.weights || DEFAULT_WEIGHTS)[a.key]}
                      onChange={(e) => saveRoster({ ...roster, settings: { ...roster.settings, weights: { ...(roster.settings.weights || DEFAULT_WEIGHTS), [a.key]: Number(e.target.value) || 0 } } })}
                      style={{ ...darkInput(), width: 66, padding: "6px 8px" }} />%
                  </label>
                ))}
              </div>
              {(() => {
                const w = roster.settings.weights || DEFAULT_WEIGHTS;
                const total = (w.cat1 || 0) + (w.cat2 || 0) + (w.exam || 0);
                return (
                  <div style={{ fontFamily: FONT.mono, fontSize: 11.5, color: total === 100 ? "#3F7A5C" : "#B84C3E", marginBottom: 20 }}>
                    Total: {total}%{total === 100 ? " ✓" : " — should be 100"}
                  </div>
                );
              })()}

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
  const weights = roster.settings.weights || DEFAULT_WEIGHTS;
  const [view, setView] = useState("fees");
  const [classId, setClassId] = useState("");
  const [term, setTerm] = useState(DEFAULT_TERM);

  // ---- fees ----
  const paidList = [], partialList = [], unpaidList = [];
  roster.students.forEach((s) => {
    const due = s.feeDue || 0, p = s.feePaid || 0;
    if (due > 0 && p >= due) paidList.push(s);
    else if (p > 0) partialList.push(s);
    else unpaidList.push(s);
  });

  // ---- exam / positions ----
  const examClasses = classId ? roster.classes.filter((c) => c.id === classId) : roster.classes;
  const perClass = examClasses.map((c) => {
    const { grid } = getMarksFor(roster, c.id, term);
    const studentsIn = roster.students.filter((s) => s.classId === c.id);
    return { cls: c, ranked: classPositions(grid, studentsIn, roster.subjects, weights), size: studentsIn.length };
  }).filter((x) => x.size > 0);

  const allRanked = perClass.flatMap((x) => x.ranked);
  const passedCount = allRanked.filter((r) => r.average >= passMark).length;
  const failedCount = allRanked.filter((r) => r.average < passMark).length;

  // ---- staff attendance (last 30 days) ----
  const days = [...Array(30)].map((_, i2) => { const d = new Date(); d.setDate(d.getDate() - i2); return d.toISOString().slice(0, 10); });
  const staffRows = roster.teachers.map((t) => {
    let present = 0, absent = 0, late = 0;
    days.forEach((d) => {
      const st = roster.staffAttendance?.[d]?.[t.id];
      if (st === "present") present++;
      else if (st === "late") late++;
      else if (st === "absent") absent++;
    });
    const marked = present + absent + late;
    return { t, present, absent, late, marked, rate: marked ? Math.round(((present + late) / marked) * 100) : null };
  });

  const Bar = ({ label, value, tone }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderLeft: `4px solid ${tone}`, borderRadius: 3 }}>{label}{value}</div>
  );

  return (
    <div>
      <SectionTitle>Reports</SectionTitle>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {[["fees", "Fee status"], ["exam", "Results & position"], ["staff", "Teacher attendance"]].map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: "6px 13px", borderRadius: 3, fontFamily: FONT.body, fontSize: 12.5, fontWeight: 600,
            border: `1px solid ${view === v ? "#22304A" : "#D8D2C2"}`, background: view === v ? "#22304A" : "#fff", color: view === v ? "#fff" : "#6B6552",
          }}>{label}</button>
        ))}
      </div>

      {view === "fees" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(115px,1fr))", gap: 10, marginBottom: 18 }}>
            <StatCard label="Fully paid" value={paidList.length} tone="#3F7A5C" />
            <StatCard label="Part paid" value={partialList.length} tone="#C98A2C" />
            <StatCard label="Not paid" value={unpaidList.length} tone="#B84C3E" />
          </div>
          {[["✓ Fully paid", paidList, "#3F7A5C", (s) => `${cur}${money(s.feePaid)}`],
            ["◐ Part paid", partialList, "#C98A2C", (s) => `owes ${cur}${money((s.feeDue||0)-(s.feePaid||0))}`],
            ["✗ Not paid", unpaidList, "#B84C3E", (s) => `${cur}${money(s.feeDue)} due`]].map(([title, list, tone, val]) => (
            <div key={title}>
              <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: tone, margin: "0 0 8px" }}>{title} ({list.length})</div>
              {list.length === 0
                ? <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368", marginBottom: 14 }}>None.</div>
                : <div style={{ display: "grid", gap: 5, marginBottom: 16 }}>
                    {list.map((s) => (
                      <Bar key={s.id} tone={tone}
                        label={<span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({classNameOf(roster, s.classId)})</span></span>}
                        value={<span style={{ fontFamily: FONT.mono, fontSize: 12.5, color: tone }}>{val(s)}</span>} />
                    ))}
                  </div>}
            </div>
          ))}
        </div>
      )}

      {view === "exam" && (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ ...darkInput(), flex: 1, minWidth: 140 }}>
              <option value="">All classes</option>
              {roster.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Term" style={{ ...darkInput(), width: 110 }} />
          </div>
          <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", marginBottom: 14 }}>
            Final = CAT 1 {weights.cat1}% + CAT 2 {weights.cat2}% + Exam {weights.exam}%. Pass mark {passMark}.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(115px,1fr))", gap: 10, marginBottom: 20 }}>
            <StatCard label="Passed" value={passedCount} tone="#3F7A5C" />
            <StatCard label="Failed" value={failedCount} tone="#B84C3E" />
            <StatCard label="With results" value={allRanked.length} />
          </div>

          {perClass.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No classes with students yet.</div>}

          {perClass.map(({ cls, ranked, size }) => (
            <div key={cls.id} style={{ marginBottom: 24 }}>
              <div style={{ fontFamily: FONT.display, fontSize: 16, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>
                {cls.name} <span style={{ fontFamily: FONT.mono, fontSize: 11.5, color: "#8A8368" }}>· {ranked.length} of {size} with results</span>
              </div>
              {ranked.length === 0
                ? <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No results entered for {term}.</div>
                : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 340 }}>
                      <thead>
                        <tr>
                          {["Pos", "Student", "Total", "Avg", "Grade", ""].map((h, k) => (
                            <th key={k} style={{ borderBottom: "1px solid #E4DFCF", padding: "6px 8px", textAlign: k > 1 ? "right" : "left", fontFamily: FONT.mono, fontSize: 9.5, textTransform: "uppercase", color: "#8A8368", letterSpacing: 0.5 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ranked.map((r) => (
                          <tr key={r.student.id} style={{ background: r.position <= 3 ? "#F7F2E2" : "transparent" }}>
                            <td style={{ borderBottom: "1px solid #EFEADC", padding: "7px 8px", fontFamily: FONT.mono, fontWeight: 700, fontSize: 12.5, color: r.position === 1 ? "#B8860B" : "#22304A" }}>{r.position}</td>
                            <td style={{ borderBottom: "1px solid #EFEADC", padding: "7px 8px", fontFamily: FONT.body, fontSize: 13, color: "#22304A" }}>{r.student.name}</td>
                            <td style={{ borderBottom: "1px solid #EFEADC", padding: "7px 8px", textAlign: "right", fontFamily: FONT.mono, fontSize: 12.5 }}>{r.total}</td>
                            <td style={{ borderBottom: "1px solid #EFEADC", padding: "7px 8px", textAlign: "right", fontFamily: FONT.mono, fontSize: 12.5 }}>{r.average}</td>
                            <td style={{ borderBottom: "1px solid #EFEADC", padding: "7px 8px", textAlign: "right", fontFamily: FONT.mono, fontWeight: 700, fontSize: 12.5, color: gradeInk(r.average) }}>{gradeOf(r.average)}</td>
                            <td style={{ borderBottom: "1px solid #EFEADC", padding: "7px 8px", textAlign: "right", fontFamily: FONT.mono, fontSize: 10.5, color: r.average >= passMark ? "#3F7A5C" : "#B84C3E" }}>{r.average >= passMark ? "PASS" : "FAIL"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          ))}
        </div>
      )}

      {view === "staff" && (
        <div>
          <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14 }}>Teacher attendance over the last 30 days. Mark it daily under the <strong>Staff</strong> tab.</div>
          {staffRows.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No teachers added yet.</div>}
          <div style={{ display: "grid", gap: 6 }}>
            {staffRows.map((r) => (
              <div key={r.t.id} style={{ padding: "10px 13px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                  <span style={{ fontFamily: FONT.body, fontSize: 13.5, fontWeight: 600, color: "#22304A" }}>{r.t.name} <span style={{ color: "#8A8368", fontSize: 12, fontWeight: 400 }}>({classNameOf(roster, r.t.classId)})</span></span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: r.rate === null ? "#8A8368" : r.rate >= 90 ? "#3F7A5C" : r.rate >= 75 ? "#C98A2C" : "#B84C3E" }}>
                    {r.rate === null ? "no records" : `${r.rate}%`}
                  </span>
                </div>
                <div style={{ fontFamily: FONT.mono, fontSize: 11, color: "#6B6552", marginTop: 4 }}>
                  present {r.present} · late {r.late} · absent {r.absent} · days marked {r.marked}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Staff (teacher) attendance marking ----------
function StaffAttendance({ roster, saveRoster }) {
  const [date, setDate] = useState(todayISO());
  const dayLog = roster.staffAttendance?.[date] || {};

  const setMark = (teacherId, status) => {
    saveRoster({
      ...roster,
      staffAttendance: { ...(roster.staffAttendance || {}), [date]: { ...dayLog, [teacherId]: status } },
    });
  };

  const history = [...Array(7)].map((_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const day = roster.staffAttendance?.[iso] || {};
    return { d: iso, total: Object.keys(day).length, present: Object.values(day).filter((v) => v === "present" || v === "late").length };
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
        <SectionTitle>Teacher attendance</SectionTitle>
        <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} style={darkInput()} />
      </div>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>Each tap saves right away.</div>

      {roster.teachers.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Add teachers first.</div>}
      <div style={{ display: "grid", gap: 6 }}>
        {roster.teachers.map((t) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 3 }}>
            <div>
              <div style={{ fontFamily: FONT.body, fontSize: 14, color: "#22304A", fontWeight: 500 }}>{t.name}</div>
              <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368" }}>{classNameOf(roster, t.classId)}</div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {Object.entries(STATUS).map(([key, val]) => (
                <button key={key} onClick={() => setMark(t.id, key)} title={val.label} style={{
                  width: 34, height: 34, borderRadius: "50%",
                  border: `2px solid ${dayLog[t.id] === key ? val.ink : "#D8D2C2"}`,
                  background: dayLog[t.id] === key ? val.ink : "transparent",
                  color: dayLog[t.id] === key ? "#fff" : val.ink,
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

// ================= MARKS EDITOR (shared: admin + teacher) =================
function MarksEditor({ roster, saveRoster, classId, students, allowedSubjects }) {
  const [term, setTerm] = useState(DEFAULT_TERM);
  const [entry, setEntry] = useState({ studentId: "", subject: "", assessment: "exam", score: "" });
  const { approved, grid } = getMarksFor(roster, classId, term);
  const weights = roster.settings.weights || DEFAULT_WEIGHTS;
  const passMark = roster.settings.passMark || 50;

  const addMark = () => {
    if (!entry.studentId || !entry.subject || entry.score === "") return;
    const existing = normEntry(grid[entry.studentId]?.[entry.subject]);
    const nextGrid = {
      ...grid,
      [entry.studentId]: {
        ...(grid[entry.studentId] || {}),
        [entry.subject]: { ...existing, [entry.assessment]: Number(entry.score) },
      },
    };
    const label = ASSESSMENTS.find((a) => a.key === entry.assessment)?.label;
    saveRoster(setMarksFor(roster, classId, term, { approved, grid: nextGrid }), `${label} mark added`);
    setEntry({ ...entry, score: "" });
  };

  const removeComponent = (studentId, subject, key) => {
    const existing = { ...normEntry(grid[studentId]?.[subject]) };
    delete existing[key];
    const subjects = { ...(grid[studentId] || {}) };
    if (Object.keys(existing).length === 0) delete subjects[subject];
    else subjects[subject] = existing;
    saveRoster(setMarksFor(roster, classId, term, { approved, grid: { ...grid, [studentId]: subjects } }), "Mark removed");
  };

  const setApproved = (val) => saveRoster(setMarksFor(roster, classId, term, { approved: val, grid }), val ? `Results published for ${term}` : "Results unpublished");

  const ranked = classPositions(grid, students, roster.subjects, weights);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
        <div style={{
          display: "inline-block", padding: "5px 12px", borderRadius: 12, fontFamily: FONT.mono, fontSize: 11, fontWeight: 700,
          background: approved ? "#E4F0E8" : "#F5E8DC", color: approved ? "#3F7A5C" : "#C98A2C", border: `1px solid ${approved ? "#B8D9C4" : "#E8CBA0"}`,
        }}>{approved ? "● PUBLISHED to students & parents" : "○ DRAFT — hidden from students/parents"}</div>
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Term" style={{ ...darkInput(), width: 120 }} />
      </div>

      <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", marginBottom: 12 }}>
        Final mark = CAT 1 ({weights.cat1}%) + CAT 2 ({weights.cat2}%) + Main Exam ({weights.exam}%). Weights are set in Settings.
      </div>

      {allowedSubjects.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#B84C3E" }}>No subjects assigned to you — ask admin to assign the subjects you teach.</div>}
      {allowedSubjects.length > 0 && students.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No students in this class yet.</div>}

      {allowedSubjects.length > 0 && students.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <select value={entry.studentId} onChange={(e) => setEntry({ ...entry, studentId: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 130 }}>
              <option value="">Student…</option>
              {students.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
            </select>
            <select value={entry.subject} onChange={(e) => setEntry({ ...entry, subject: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 120 }}>
              <option value="">Subject…</option>
              {allowedSubjects.map((sub) => <option key={sub} value={sub}>{sub}</option>)}
            </select>
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            {ASSESSMENTS.map((a) => (
              <button key={a.key} onClick={() => setEntry({ ...entry, assessment: a.key })} style={{
                padding: "7px 14px", borderRadius: 20, fontFamily: FONT.body, fontSize: 12.5, fontWeight: 600,
                border: `1px solid ${entry.assessment === a.key ? "#22304A" : "#D8D2C2"}`,
                background: entry.assessment === a.key ? "#22304A" : "#fff",
                color: entry.assessment === a.key ? "#fff" : "#6B6552",
              }}>{a.label}</button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
            <select value={entry.score} onChange={(e) => setEntry({ ...entry, score: e.target.value })} style={{ ...darkInput(), width: 110 }}>
              <option value="">Score…</option>
              {SCORE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button onClick={addMark} disabled={!entry.studentId || !entry.subject || entry.score === ""} style={primaryBtn()}>Add mark</button>
          </div>

          {ranked.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No marks entered for {term} yet.</div>}

          {ranked.length > 0 && (
            <div style={{ display: "grid", gap: 10 }}>
              {ranked.map((r) => (
                <div key={r.student.id} style={{ background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 5, padding: "11px 13px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontFamily: FONT.body, fontSize: 14, fontWeight: 600, color: "#22304A" }}>
                      <span style={{ fontFamily: FONT.mono, color: "#8A8368", fontSize: 11.5, marginRight: 7 }}>#{r.position}</span>{r.student.name}
                    </span>
                    <span style={{ fontFamily: FONT.mono, fontSize: 12.5, color: gradeInk(r.average) }}>
                      avg {r.average} · {gradeOf(r.average)}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: 4 }}>
                    {roster.subjects.filter((sub) => grid[r.student.id]?.[sub]).map((sub) => {
                      const e = normEntry(grid[r.student.id][sub]);
                      const fin = subjectFinal(e, weights);
                      return (
                        <div key={sub} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, fontFamily: FONT.body, color: "#22304A" }}>
                          <span style={{ minWidth: 78, fontWeight: 500 }}>{sub}</span>
                          {ASSESSMENTS.map((a) => (
                            <span key={a.key} style={{ fontFamily: FONT.mono, fontSize: 11, color: typeof e[a.key] === "number" ? "#22304A" : "#B8B2A0" }}>
                              {a.short} {typeof e[a.key] === "number" ? e[a.key] : "–"}
                              {typeof e[a.key] === "number" && (
                                <button onClick={() => removeComponent(r.student.id, sub, a.key)} title={`Remove ${a.label}`} style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11, padding: "0 0 0 2px" }}>×</button>
                              )}
                            </span>
                          ))}
                          <span style={{ marginLeft: "auto", fontFamily: FONT.mono, fontWeight: 700, fontSize: 12.5, color: gradeInk(fin) }}>
                            {fin === null ? "—" : `${fin} ${gradeOf(fin)}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {ranked.length > 0 && (
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
        <TabBar tabs={["attendance", "results", "timetable"]} active={tab} onChange={setTab} />
        <div style={{ ...paperPanel(), padding: 22 }} className="chalk-fade">
          {tab === "attendance" && <TeacherAttendance roster={roster} saveRoster={saveRoster} classId={classId} students={students} />}
          {tab === "timetable" && <MyTimetable roster={roster} teacher={teacher} />}

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
  const weights = roster.settings.weights || DEFAULT_WEIGHTS;
  const { approved, grid } = getMarksFor(roster, student.classId, term);
  const termMarks = approved ? (grid[student.id] || {}) : {};
  const classmates = roster.students.filter((s) => s.classId === student.classId);
  const ranked = approved ? classPositions(grid, classmates, roster.subjects, weights) : [];
  const rank = approved ? positionOf(ranked, student.id) : null;
  const avg = rank ? rank.average : null;

  const classLog = getAttendanceFor(roster, student.classId);
  const log = [...Array(30)].map((_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    return { d: iso, status: classLog[iso]?.[student.id] };
  }).filter((r) => r.status);
  const presentDays = log.filter((r) => r.status === "present" || r.status === "late").length;
  const rate = log.length ? Math.round((presentDays / log.length) * 100) : null;
  const due = student.feeDue || 0, paid = student.feePaid || 0, balance = due - paid;

  if (printDoc === "timetable") return <TimetableDoc roster={roster} classId={student.classId} onBack={() => setPrintDoc(null)} />;
  if (printDoc === "invoice") return <InvoiceDoc roster={roster} student={student} onBack={() => setPrintDoc(null)} />;
  if (printDoc === "report") return <ReportDoc roster={roster} student={student} term={term} termMarks={termMarks} avg={avg} rank={rank} rate={rate} onBack={() => setPrintDoc(null)} />;

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

          <div style={{ display: "flex", gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
            <button onClick={() => setPrintDoc("invoice")} style={primaryBtn()}>Fee invoice</button>
            <button onClick={() => setPrintDoc("timetable")} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Class timetable</button>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <SectionTitle>Results — {term}</SectionTitle>
            <button onClick={() => approved && setPrintDoc("report")} disabled={!approved} style={{ ...primaryBtn(), opacity: approved ? 1 : 0.45 }}>Open report card</button>
          </div>
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Term" style={{ ...darkInput(), width: 120, marginBottom: 12 }} />

          {!approved && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368", marginBottom: 18 }}>Results for this term haven't been published yet.</div>}
          {approved && Object.keys(termMarks).length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368", marginBottom: 18 }}>No results recorded for this term.</div>}
          {approved && Object.keys(termMarks).length > 0 && (
            <div style={{ marginBottom: 18 }}>
              {rank && (
                <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                  <StatCard label="Position in class" value={`${rank.position} of ${rank.outOf}`} tone={rank.position <= 3 ? "#B8860B" : "#22304A"} />
                  <StatCard label="Total marks" value={rank.total} />
                  <StatCard label="Mean grade" value={gradeOf(avg)} tone={gradeInk(avg)} />
                </div>
              )}
              <div style={{ overflowX: "auto", marginBottom: 10 }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320 }}>
                  <thead>
                    <tr>
                      {["Subject", "CAT 1", "CAT 2", "Exam", "Final", "Gr"].map((h, k) => (
                        <th key={k} style={{ borderBottom: "1px solid #E4DFCF", padding: "6px 7px", textAlign: k === 0 ? "left" : "right", fontFamily: FONT.mono, fontSize: 9, textTransform: "uppercase", color: "#8A8368", letterSpacing: 0.4 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(termMarks).map((subject) => {
                      const e = normEntry(termMarks[subject]);
                      const fin = subjectFinal(e, weights);
                      return (
                        <tr key={subject}>
                          <td style={{ borderBottom: "1px solid #EFEADC", padding: "7px 7px", fontFamily: FONT.body, fontSize: 13, color: "#22304A" }}>{subject}</td>
                          {ASSESSMENTS.map((a) => (
                            <td key={a.key} style={{ borderBottom: "1px solid #EFEADC", padding: "7px 7px", textAlign: "right", fontFamily: FONT.mono, fontSize: 12, color: typeof e[a.key] === "number" ? "#22304A" : "#B8B2A0" }}>
                              {typeof e[a.key] === "number" ? e[a.key] : "–"}
                            </td>
                          ))}
                          <td style={{ borderBottom: "1px solid #EFEADC", padding: "7px 7px", textAlign: "right", fontFamily: FONT.mono, fontWeight: 700, fontSize: 12.5, color: gradeInk(fin) }}>{fin === null ? "—" : fin}</td>
                          <td style={{ borderBottom: "1px solid #EFEADC", padding: "7px 7px", textAlign: "right", fontFamily: FONT.mono, fontWeight: 700, fontSize: 12, color: gradeInk(fin) }}>{gradeOf(fin)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {avg !== null && (
                <div style={{ padding: "10px 12px", borderRadius: 3, background: avg >= passMark ? "#E4F0E8" : "#F7E4E1", border: `1px solid ${avg >= passMark ? "#B8D9C4" : "#E8C4BD"}`, fontFamily: FONT.body, fontSize: 14, color: "#22304A" }}>
                  Average <strong>{avg}/100</strong> · grade <strong>{gradeOf(avg)}</strong> — <strong style={{ color: avg >= passMark ? "#3F7A5C" : "#B84C3E" }}>{avg >= passMark ? "PASS" : "FAIL"}</strong> <span style={{ color: "#8A8368", fontSize: 12 }}>(pass mark {passMark})</span>
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


// ================= TIMETABLE =================
function TimetableAdmin({ roster, saveRoster }) {
  const [classId, setClassId] = useState("");
  const [entry, setEntry] = useState({ day: "Mon", periodId: "", subject: "", teacherId: "" });
  const [showPeriods, setShowPeriods] = useState(false);
  const [printing, setPrinting] = useState(false);
  const periods = roster.settings.periods || DEFAULT_PERIODS;
  const tt = getTimetable(roster, classId);

  const addLesson = () => {
    if (!classId || !entry.periodId || !entry.subject) return;
    saveRoster(setLessonIn(roster, classId, entry.day, entry.periodId, { subject: entry.subject, teacherId: entry.teacherId || "" }), "Lesson added");
    setEntry({ ...entry, subject: "", teacherId: "" });
  };
  const removeLesson = (day, periodId) => saveRoster(setLessonIn(roster, classId, day, periodId, null), "Lesson removed");

  const updatePeriod = (id, field, value) => {
    saveRoster({ ...roster, settings: { ...roster.settings, periods: periods.map((p) => p.id === id ? { ...p, [field]: value } : p) } });
  };
  const addPeriod = () => {
    const n = periods.length + 1;
    saveRoster({ ...roster, settings: { ...roster.settings, periods: [...periods, { id: "p" + Date.now(), label: String(n), time: "" }] } }, "Period added");
  };
  const removePeriod = (id) => saveRoster({ ...roster, settings: { ...roster.settings, periods: periods.filter((p) => p.id !== id) } }, "Period removed");

  if (printing && classId) {
    return <TimetableDoc roster={roster} classId={classId} onBack={() => setPrinting(false)} />;
  }

  return (
    <div>
      <SectionTitle>Class timetable</SectionTitle>
      <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ ...darkInput(), marginBottom: 14, width: "100%", maxWidth: 320 }}>
        <option value="">Choose a class…</option>
        {roster.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>

      {!classId && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Select a class to build its timetable.</div>}

      {classId && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <select value={entry.day} onChange={(e) => setEntry({ ...entry, day: e.target.value })} style={{ ...darkInput(), minWidth: 110 }}>
              {DAYS.map((d) => <option key={d} value={d}>{DAY_FULL[d]}</option>)}
            </select>
            <select value={entry.periodId} onChange={(e) => setEntry({ ...entry, periodId: e.target.value })} style={{ ...darkInput(), minWidth: 130 }}>
              <option value="">Period…</option>
              {periods.map((p) => <option key={p.id} value={p.id}>Period {p.label}{p.time ? ` (${p.time})` : ""}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <select value={entry.subject} onChange={(e) => setEntry({ ...entry, subject: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 120 }}>
              <option value="">Subject…</option>
              {roster.subjects.map((sub) => <option key={sub} value={sub}>{sub}</option>)}
            </select>
            <select value={entry.teacherId} onChange={(e) => setEntry({ ...entry, teacherId: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 120 }}>
              <option value="">Teacher (optional)…</option>
              {roster.teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button onClick={addLesson} disabled={!entry.periodId || !entry.subject} style={primaryBtn()}>Add lesson</button>
          </div>

          <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
            {DAYS.map((day) => {
              const lessons = periods.map((p) => ({ p, l: tt[day]?.[p.id] })).filter((x) => x.l);
              return (
                <div key={day} style={{ background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 5, padding: "10px 12px" }}>
                  <div style={{ fontFamily: FONT.display, fontSize: 14.5, fontWeight: 600, color: "#22304A", marginBottom: 6 }}>{DAY_FULL[day]}</div>
                  {lessons.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#8A8368" }}>No lessons set.</div>}
                  <div style={{ display: "grid", gap: 4 }}>
                    {lessons.map(({ p, l }) => (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontFamily: FONT.body, color: "#22304A" }}>
                        <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368", minWidth: 92 }}>P{p.label} {p.time}</span>
                        <span style={{ fontWeight: 600 }}>{l.subject}</span>
                        <span style={{ color: "#6B6552", fontSize: 12 }}>{l.teacherId ? roster.teachers.find((t) => t.id === l.teacherId)?.name || "" : ""}</span>
                        <button onClick={() => removeLesson(day, p.id)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11 }}>remove</button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <button onClick={() => setPrinting(true)} style={{ ...primaryBtn(), marginBottom: 18 }}>Open printable timetable</button>

          <div>
            <button onClick={() => setShowPeriods(!showPeriods)} style={{ ...backBtnStyle(), color: "#22304A", fontSize: 12.5 }}>
              {showPeriods ? "▾" : "▸"} Edit period times
            </button>
            {showPeriods && (
              <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                {periods.map((p) => (
                  <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input value={p.label} onChange={(e) => updatePeriod(p.id, "label", e.target.value)} style={{ ...darkInput(), width: 60, padding: "6px 8px" }} />
                    <input value={p.time} onChange={(e) => updatePeriod(p.id, "time", e.target.value)} placeholder="8:00–8:40" style={{ ...darkInput(), flex: 1, minWidth: 120, padding: "6px 8px" }} />
                    <button onClick={() => removePeriod(p.id)} style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11.5 }}>remove</button>
                  </div>
                ))}
                <button onClick={addPeriod} style={{ ...primaryBtn(), justifySelf: "start" }}>Add period</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TimetableDoc({ roster, classId, onBack }) {
  const periods = roster.settings.periods || DEFAULT_PERIODS;
  const tt = getTimetable(roster, classId);
  const nameOf = (id) => roster.teachers.find((t) => t.id === id)?.name || "";

  return (
    <DocShell title="Class timetable" onBack={onBack}>
      <DocHeader subtitle={`Class Timetable — ${classNameOf(roster, classId)}`} />
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 16 }}>
        <thead>
          <tr>
            <th style={docTh}>Period</th>
            {DAYS.map((d) => <th key={d} style={docTh}>{d}</th>)}
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.id}>
              <td style={{ ...docTd, fontFamily: FONT.mono, fontSize: 10.5, whiteSpace: "nowrap" }}>
                <strong>P{p.label}</strong>{p.time ? <div style={{ color: "#8A8368" }}>{p.time}</div> : null}
              </td>
              {DAYS.map((d) => {
                const l = tt[d]?.[p.id];
                return (
                  <td key={d} style={{ ...docTd, fontSize: 11.5 }}>
                    {l ? <><strong>{l.subject}</strong>{l.teacherId ? <div style={{ color: "#6B6552", fontSize: 10 }}>{nameOf(l.teacherId)}</div> : null}</> : <span style={{ color: "#C8C2B0" }}>—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 40 }}>
        <div style={docSig}>Class Teacher's Signature</div>
        <div style={docSig}>Principal's Signature</div>
      </div>
    </DocShell>
  );
}

// ================= DUTY ROSTER =================
function DutyRoster({ roster, saveRoster }) {
  const [entry, setEntry] = useState({ weekStart: mondayOf(todayISO()), teacherId: "", note: "" });
  const duty = [...(roster.duty || [])].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  const thisWeek = mondayOf(todayISO());

  const add = () => {
    if (!entry.teacherId || !entry.weekStart) return;
    const rec = { id: genId("DTY", roster.duty || []), weekStart: mondayOf(entry.weekStart), teacherId: entry.teacherId, note: entry.note.trim() };
    saveRoster({ ...roster, duty: [...(roster.duty || []), rec] }, "Duty added");
    setEntry({ ...entry, teacherId: "", note: "" });
  };
  const remove = (id) => saveRoster({ ...roster, duty: (roster.duty || []).filter((d) => d.id !== id) }, "Duty removed");

  const onDutyNow = duty.filter((d) => d.weekStart === thisWeek);

  return (
    <div>
      <SectionTitle>Duty roster</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
        Assign the teacher on duty for each week (weeks run Monday to Friday).
      </div>

      <div style={{
        padding: "12px 14px", borderRadius: 5, marginBottom: 18,
        background: onDutyNow.length ? "#E4F0E8" : "#F5F1E6",
        border: `1px solid ${onDutyNow.length ? "#B8D9C4" : "#E4DFCF"}`,
      }}>
        <div style={{ fontFamily: FONT.mono, fontSize: 10, color: "#8A8368", letterSpacing: 1 }}>THIS WEEK · {weekLabel(thisWeek)}</div>
        {onDutyNow.length === 0
          ? <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368", marginTop: 4 }}>Nobody assigned yet.</div>
          : onDutyNow.map((d) => (
              <div key={d.id} style={{ fontFamily: FONT.display, fontSize: 17, fontWeight: 700, color: "#22304A", marginTop: 3 }}>
                {roster.teachers.find((t) => t.id === d.teacherId)?.name || "—"}
                {d.note && <span style={{ fontFamily: FONT.body, fontSize: 12.5, fontWeight: 400, color: "#6B6552" }}> · {d.note}</span>}
              </div>
            ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <input type="date" value={entry.weekStart} onChange={(e) => setEntry({ ...entry, weekStart: e.target.value })} style={{ ...darkInput(), minWidth: 150 }} />
        <select value={entry.teacherId} onChange={(e) => setEntry({ ...entry, teacherId: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 140 }}>
          <option value="">Teacher on duty…</option>
          {roster.teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        <input value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })} placeholder="Note (optional) — e.g. assembly, games" style={{ ...darkInput(), flex: 1, minWidth: 160 }} />
        <button onClick={add} disabled={!entry.teacherId} style={primaryBtn()}>Add duty</button>
      </div>

      {duty.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No duties assigned yet.</div>}
      <div style={{ display: "grid", gap: 6 }}>
        {duty.map((d) => {
          const current = d.weekStart === thisWeek;
          const past = d.weekStart < thisWeek;
          return (
            <div key={d.id} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap",
              padding: "9px 12px", background: "#F5F1E6", borderRadius: 3,
              border: `1px solid ${current ? "#3F7A5C" : "#E4DFCF"}`,
              borderLeft: `4px solid ${current ? "#3F7A5C" : past ? "#D8D2C2" : "#C98A2C"}`,
              opacity: past ? 0.75 : 1,
            }}>
              <span>
                <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", fontWeight: 600 }}>
                  {roster.teachers.find((t) => t.id === d.teacherId)?.name || "—"}
                </span>
                <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368", marginLeft: 8 }}>{weekLabel(d.weekStart)}</span>
                {current && <span style={{ fontFamily: FONT.mono, fontSize: 10, color: "#3F7A5C", marginLeft: 8 }}>THIS WEEK</span>}
                {d.note && <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", marginTop: 2 }}>{d.note}</div>}
              </span>
              <button onClick={() => remove(d.id)} style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11.5 }}>remove</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Teacher's own timetable + duty ----------
function MyTimetable({ roster, teacher }) {
  const periods = roster.settings.periods || DEFAULT_PERIODS;
  const thisWeek = mondayOf(todayISO());
  const myDuty = (roster.duty || []).filter((d) => d.teacherId === teacher.id && d.weekStart >= thisWeek)
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  // every lesson across all classes assigned to this teacher, plus their own class
  const rows = {};
  DAYS.forEach((d) => { rows[d] = []; });
  roster.classes.forEach((c) => {
    const tt = getTimetable(roster, c.id);
    DAYS.forEach((day) => {
      periods.forEach((p) => {
        const l = tt[day]?.[p.id];
        if (l && (l.teacherId === teacher.id || (!l.teacherId && c.id === teacher.classId))) {
          rows[day].push({ p, subject: l.subject, cls: c.name });
        }
      });
    });
  });
  DAYS.forEach((d) => rows[d].sort((a, b) => periods.findIndex((x) => x.id === a.p.id) - periods.findIndex((x) => x.id === b.p.id)));
  const hasAny = DAYS.some((d) => rows[d].length > 0);

  return (
    <div>
      <SectionTitle>My timetable</SectionTitle>

      {myDuty.length > 0 && (
        <div style={{ padding: "11px 13px", borderRadius: 5, marginBottom: 16, background: myDuty[0].weekStart === thisWeek ? "#E4F0E8" : "#F5F1E6", border: `1px solid ${myDuty[0].weekStart === thisWeek ? "#B8D9C4" : "#E4DFCF"}` }}>
          <div style={{ fontFamily: FONT.mono, fontSize: 10, color: "#8A8368", letterSpacing: 1 }}>YOUR DUTY WEEKS</div>
          {myDuty.slice(0, 3).map((d) => (
            <div key={d.id} style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", marginTop: 3 }}>
              {weekLabel(d.weekStart)}
              {d.weekStart === thisWeek && <strong style={{ color: "#3F7A5C" }}> — THIS WEEK</strong>}
              {d.note && <span style={{ color: "#6B6552", fontSize: 12 }}> · {d.note}</span>}
            </div>
          ))}
        </div>
      )}

      {!hasAny && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No lessons assigned to you yet — ask admin to build the class timetable.</div>}

      <div style={{ display: "grid", gap: 10 }}>
        {DAYS.filter((d) => rows[d].length > 0).map((day) => (
          <div key={day} style={{ background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 5, padding: "10px 12px" }}>
            <div style={{ fontFamily: FONT.display, fontSize: 14.5, fontWeight: 600, color: "#22304A", marginBottom: 6 }}>{DAY_FULL[day]}</div>
            <div style={{ display: "grid", gap: 4 }}>
              {rows[day].map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontFamily: FONT.body, color: "#22304A" }}>
                  <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368", minWidth: 92 }}>P{r.p.label} {r.p.time}</span>
                  <span style={{ fontWeight: 600 }}>{r.subject}</span>
                  <span style={{ color: "#6B6552", fontSize: 12, marginLeft: "auto" }}>{r.cls}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
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

function ReportDoc({ roster, student, term, termMarks, avg, rank, rate, onBack }) {
  const cur = roster.settings.currency;
  const passMark = roster.settings.passMark || 50;
  const weights = roster.settings.weights || DEFAULT_WEIGHTS;
  const subjects = Object.keys(termMarks);
  const due = student.feeDue || 0, paid = student.feePaid || 0;
  const remark = (sc) => (sc >= 80 ? "Excellent" : sc >= 65 ? "Good" : sc >= passMark ? "Fair" : "Needs improvement");

  return (
    <DocShell title="Report card" onBack={onBack}>
      <DocHeader subtitle={`Student Report Card — ${term}`} />
      <DocInfo roster={roster} student={student} />

      <div style={{ fontWeight: "bold", marginBottom: 8 }}>Academic performance</div>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 14 }}>
        <thead>
          <tr>
            <th style={docTh}>Subject</th>
            <th style={{ ...docTh, textAlign: "right" }}>CAT 1<div style={{ fontSize: 8, fontWeight: 400 }}>{weights.cat1}%</div></th>
            <th style={{ ...docTh, textAlign: "right" }}>CAT 2<div style={{ fontSize: 8, fontWeight: 400 }}>{weights.cat2}%</div></th>
            <th style={{ ...docTh, textAlign: "right" }}>Exam<div style={{ fontSize: 8, fontWeight: 400 }}>{weights.exam}%</div></th>
            <th style={{ ...docTh, textAlign: "right" }}>Final</th>
            <th style={{ ...docTh, textAlign: "center" }}>Grade</th>
            <th style={docTh}>Remark</th>
          </tr>
        </thead>
        <tbody>
          {subjects.length === 0 && <tr><td style={{ ...docTd, color: "#6B6552" }} colSpan={7}>No results recorded.</td></tr>}
          {subjects.map((sub) => {
            const e = normEntry(termMarks[sub]);
            const fin = subjectFinal(e, weights);
            return (
              <tr key={sub}>
                <td style={docTd}>{sub}</td>
                {ASSESSMENTS.map((a) => (
                  <td key={a.key} style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontSize: 12 }}>
                    {typeof e[a.key] === "number" ? e[a.key] : "–"}
                  </td>
                ))}
                <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontWeight: 700 }}>{fin === null ? "—" : fin}</td>
                <td style={{ ...docTd, textAlign: "center", fontFamily: FONT.mono, fontWeight: 700 }}>{gradeOf(fin)}</td>
                <td style={{ ...docTd, color: "#6B6552", fontSize: 11.5 }}>{fin === null ? "—" : remark(fin)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, margin: "16px 0 24px" }}>
        {[["POSITION", rank ? `${rank.position} / ${rank.outOf}` : "—"],
          ["TOTAL", rank ? rank.total : "—"],
          ["AVERAGE", avg === null || avg === undefined ? "—" : `${avg}/100`],
          ["MEAN GRADE", gradeOf(avg)]].map(([l, v]) => (
          <div key={l} style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "9px 10px", background: "#F5F1E6", textAlign: "center" }}>
            <div style={{ fontFamily: FONT.mono, fontSize: 8.5, color: "#8A8368", letterSpacing: 0.8 }}>{l}</div>
            <div style={{ fontSize: 16, fontWeight: "bold", marginTop: 3 }}>{v}</div>
          </div>
        ))}
      </div>

      {avg !== null && avg !== undefined && (
        <div style={{ marginBottom: 18, fontSize: 13.5 }}>
          Outcome: <strong>{avg >= passMark ? "PASS" : "FAIL"}</strong>
          <span style={{ color: "#6B6552", fontSize: 11.5 }}> (pass mark {passMark})</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 26 }}>
        <div style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "10px 12px", background: "#F5F1E6" }}>
          <div style={{ fontFamily: FONT.mono, fontSize: 9, color: "#8A8368", letterSpacing: 1 }}>ATTENDANCE</div>
          <div style={{ fontSize: 17, fontWeight: "bold", marginTop: 3 }}>{rate === null ? "—" : `${rate}%`}</div>
        </div>
        <div style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "10px 12px", background: "#F5F1E6" }}>
          <div style={{ fontFamily: FONT.mono, fontSize: 9, color: "#8A8368", letterSpacing: 1 }}>FEES DUE / PAID / BALANCE</div>
          <div style={{ fontSize: 13.5, fontWeight: "bold", marginTop: 3 }}>{cur}{money(due)} / {cur}{money(paid)} / {cur}{money(due - paid)}</div>
        </div>
      </div>

      <div style={{ borderTop: "1px solid #E4DFCF", paddingTop: 10, marginBottom: 14, fontSize: 11, color: "#6B6552", fontFamily: FONT.mono }}>
        GRADING: A 80+ · A- 75 · B+ 70 · B 65 · B- 60 · C+ 55 · C 50 · C- 45 · D+ 40 · D 35 · D- 30 · E below 30
      </div>

      <div style={{ border: "1px dashed #B8B2A0", borderRadius: 4, padding: "9px 11px", marginBottom: 20, fontSize: 11.5, fontFamily: FONT.mono, color: "#22304A" }}>
        PARENT PORTAL LOGIN — Admission No: <strong>{student.id}</strong> · PIN: <strong>{student.pin || "—"}</strong>
        <div style={{ color: "#8A8368", marginTop: 3 }}>Keep this private. It shows only this student's records.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 30 }}>
        <div style={docSig}>Class Teacher's Signature</div>
        <div style={docSig}>Principal's Signature</div>
      </div>
    </DocShell>
  );
}
