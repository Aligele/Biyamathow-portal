import React, { useState, useEffect, useCallback, useRef } from "react";
import { qrMatrix, qrSvgPath } from "./qr.js";
import {
  loadRoster, saveRoster as persistRoster, isShared, isOffline, hasPendingChanges,
  staffLogin, staffLogout, restoreSession, getWho, changeMyPassword,
  staffList, staffUpsert, staffDeactivate, parentLookup,
  requestReset, confirmReset, staffSetEmail, staffSetContact, schoolInfo,
  photoSet, photoDelete, photosGet, photosWhich,
  healthCheck, backupsList, backupNow, backupRestore, staffResetPassword,
  geofenceGet, geofenceSet, locationRecent, locationRecord, currentPosition, metresBetween,
  leaveApply, leaveList, leaveDecide, leaveCancel, leaveToday,
  expenseCategories, expenseAdd, expenseList, expenseSummary, expenseDelete,
  mpesaClaim, mpesaLookup, mpesaRecent, mpesaRelease,
} from "./store.js";

// ---------- helpers ----------
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
// Admission numbers look like STU/2026/001 — sequential within the year.
// Existing numbers are scanned so removing a student never causes a clash.
const nextAdmissionNo = (students) => {
  const year = new Date().getFullYear();
  const prefix = `STU/${year}/`;
  let max = 0;
  (students || []).forEach((s) => {
    const m = String(s.id || "").match(/^STU\/(\d{4})\/(\d+)$/);
    if (m && m[1] === String(year)) max = Math.max(max, parseInt(m[2], 10));
  });
  return prefix + String(max + 1).padStart(3, "0");
};

// Sequential receipt numbers, e.g. RCP/2026/001
const nextReceiptNo = (roster) => {
  const year = new Date().getFullYear();
  let max = 0;
  (roster.students || []).forEach((s) => (s.payments || []).forEach((p) => {
    const m = String(p.receiptNo || "").match(/^RCP\/(\d{4})\/(\d+)$/);
    if (m && m[1] === String(year)) max = Math.max(max, parseInt(m[2], 10));
  }));
  return `RCP/${year}/` + String(max + 1).padStart(3, "0");
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

const APP_VERSION = "v34 · printable leave records";

// Keeps the last 400 actions so the school can see who changed what.
const logAction = (roster, actor, action) => {
  const entry = { ts: new Date().toISOString(), actor: actor || "—", action };
  const audit = [entry, ...(roster.audit || [])].slice(0, 400);
  return { ...roster, audit };
};
// The school's identity is stored in Settings so the portal can serve any
// school. These are only fallbacks used before the details load.
const DEFAULT_SCHOOL_NAME = "Banane Shantral Primary School";
const DEFAULT_SCHOOL_LOCATION = "Sabuli, Wajir County";
const DEFAULT_MOTTO = "ROLL · RECORD · REGISTER";

// Shared across the app so every screen and printed document agrees.
let SCHOOL_NAME = DEFAULT_SCHOOL_NAME;
let SCHOOL_LOCATION = DEFAULT_SCHOOL_LOCATION;
let SCHOOL_MOTTO = DEFAULT_MOTTO;
const applySchoolIdentity = (s) => {
  SCHOOL_NAME = s?.schoolName || s?.name || DEFAULT_SCHOOL_NAME;
  SCHOOL_LOCATION = s?.schoolLocation || s?.location || DEFAULT_SCHOOL_LOCATION;
  SCHOOL_MOTTO = s?.schoolMotto || s?.motto || DEFAULT_MOTTO;
};
const DEFAULT_ADMIN_PASSWORD = "admin123";
const DEFAULT_TERM = "Term 1";
const DEFAULT_SUBJECTS = ["Math", "English", "Science", "Social", "IRE", "Kiswahili"];
const SCORE_OPTIONS = Array.from({ length: 100 }, (_, i) => i + 1);

// ---- CBC levels: which learning areas belong to which grades ----
// Kenya's rationalised curriculum gives each level its own set. A Grade 2
// class does Environmental Activities; by Grade 4 that has become Science and
// Technology; by Grade 7, Integrated Science. Showing every area to every
// teacher invites marks against the wrong subject, so the lists are filtered.
const CBC_LEVELS = {
  lower:  { label: "Lower Primary (Grades 1–3)",  grades: [1, 2, 3] },
  upper:  { label: "Upper Primary (Grades 4–6)",  grades: [4, 5, 6] },
  junior: { label: "Junior School (Grades 7–9)",  grades: [7, 8, 9] },
};

// Learning areas per level. Anything not listed here is treated as
// school-specific and offered at every level.
const CBC_LEVEL_SUBJECTS = {
  lower: [
    "English", "Kiswahili", "Mathematics",
    "Environmental Activities", "Creative Arts and Sports",
    "Religious Education (IRE)",
  ],
  upper: [
    "English", "Kiswahili", "Mathematics",
    "Science and Technology", "Social Studies",
    "Agriculture and Nutrition", "Creative Arts and Sports",
    "Religious Education (IRE)",
  ],
  junior: [
    "English", "Kiswahili", "Mathematics",
    "Integrated Science", "Social Studies", "Pre-Technical Studies",
    "Agriculture and Nutrition", "Creative Arts and Sports",
    "Religious Education (IRE)",
  ],
};

// Works out the level from the class name, e.g. "Grade 4" or "Class 7B".
const levelOfClassName = (name) => {
  const m = String(name || "").match(/(\d+)/);
  if (!m) return null;
  const g = parseInt(m[1], 10);
  return Object.keys(CBC_LEVELS).find((k) => CBC_LEVELS[k].grades.includes(g)) || null;
};

// The learning areas a given class actually studies. Falls back to the whole
// list when the class name carries no grade number, so nothing is ever hidden
// by accident.
const subjectsForClass = (roster, classId) => {
  const all = roster.subjects || [];
  const level = levelOfClassName(classNameOf(roster, classId));
  if (!level) return all;
  const allowed = CBC_LEVEL_SUBJECTS[level];
  const filtered = all.filter((sub) => allowed.includes(sub));
  // keep any subject the school added itself, which no level claims
  const custom = all.filter((sub) => !Object.values(CBC_LEVEL_SUBJECTS).flat().includes(sub));
  return [...filtered, ...custom];
};

// A teacher is rarely tied to one class. Their real workload is whatever the
// timetable says they teach, plus the class they register. This reads both and
// returns, per class, exactly which learning areas they may enter marks for.
const teachingAssignments = (roster, teacherId) => {
  const teacher = roster.teachers.find((t) => t.id === teacherId);
  if (!teacher) return [];

  const byClass = {};       // classId -> Set of subjects
  const add = (classId, subject) => {
    if (!classId || !subject) return;
    if (!byClass[classId]) byClass[classId] = new Set();
    byClass[classId].add(subject);
  };

  // 1. everything the timetable assigns to them, across any class
  Object.entries(roster.timetable || {}).forEach(([classId, days]) => {
    Object.values(days || {}).forEach((periods) => {
      Object.values(periods || {}).forEach((lesson) => {
        if (lesson && lesson.teacherId === teacherId) add(classId, lesson.subject);
      });
    });
  });

  // 2. their own class, with the subjects recorded against them. A class
  //    teacher usually takes most areas without every one being timetabled.
  (teacher.subjects || []).forEach((sub) => add(teacher.classId, sub));

  return roster.classes
    .filter((c) => byClass[c.id]?.size)
    .map((c) => ({
      classId: c.id,
      className: c.name,
      isHomeClass: c.id === teacher.classId,
      // only areas that class actually studies at its level
      subjects: [...byClass[c.id]].filter((sub) => subjectsForClass(roster, c.id).includes(sub)),
    }))
    .filter((a) => a.subjects.length > 0);
};

// A teacher can only be in one room at a time. This looks across every class
// for the same day and period, so a clash is caught when it is created rather
// than discovered on the morning it matters.
const teacherClashAt = (roster, day, periodId, teacherId, exceptClassId) => {
  if (!teacherId) return null;
  for (const [cid, days] of Object.entries(roster.timetable || {})) {
    if (cid === exceptClassId) continue;
    const lesson = days?.[day]?.[periodId];
    if (lesson && lesson.teacherId === teacherId) {
      return { classId: cid, subject: lesson.subject };
    }
  }
  return null;
};

// Every clash currently in the timetable — used to show the administrator
// anything that slipped in before this check existed.
const allTimetableClashes = (roster) => {
  const seen = {};   // day|period|teacher -> [ {classId, subject} ]
  Object.entries(roster.timetable || {}).forEach(([cid, days]) => {
    Object.entries(days || {}).forEach(([day, periods]) => {
      Object.entries(periods || {}).forEach(([pid, lesson]) => {
        if (!lesson?.teacherId) return;
        const k = `${day}|${pid}|${lesson.teacherId}`;
        (seen[k] = seen[k] || []).push({ classId: cid, subject: lesson.subject });
      });
    });
  });
  return Object.entries(seen)
    .filter(([, v]) => v.length > 1)
    .map(([k, v]) => {
      const [day, periodId, teacherId] = k.split("|");
      return { day, periodId, teacherId, where: v };
    });
};

const levelLabelForClass = (roster, classId) => {
  const level = levelOfClassName(classNameOf(roster, classId));
  return level ? CBC_LEVELS[level].label : null;
};

// Staff must sign in at school by this time; later counts as late.
const ARRIVAL_CUTOFF = { hour: 8, minute: 0 };
// Staff may not sign out before this time without a reason for admin to approve.
const DEPARTURE_TIME = { hour: 16, minute: 0 };
const nowHM = () => { const d = new Date(); return { h: d.getHours(), m: d.getMinutes() }; };
const fmtHM = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const isLateNow = () => {
  const { h, m } = nowHM();
  return h > ARRIVAL_CUTOFF.hour || (h === ARRIVAL_CUTOFF.hour && m > ARRIVAL_CUTOFF.minute);
};
// True when it is still before the 16:00 close of day — leaving now is "early".
const isEarlyDeparture = () => {
  const { h, m } = nowHM();
  return h < DEPARTURE_TIME.hour || (h === DEPARTURE_TIME.hour && m < DEPARTURE_TIME.minute);
};

const DISCIPLINE_CATEGORIES = [
  "Lateness", "Absenteeism", "Noise making", "Bullying", "Fighting",
  "Dishonesty", "Damage to property", "Uniform", "Homework not done", "Other",
];
const DISCIPLINE_ACTIONS = [
  "Verbal warning", "Written warning", "Parent to be called",
  "Counselling recommended", "Referred to admin", "Other",
];

// ---- Timetable & duty roster ----
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_FULL = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday" };
// A school day is lessons punctuated by breaks. Break rows run across every
// day of the week, so they are part of the timetable rather than a gap in it.
const DEFAULT_PERIODS = [
  { id: "p1", label: "1", time: "8:00–8:40", type: "lesson" },
  { id: "p2", label: "2", time: "8:40–9:20", type: "lesson" },
  { id: "p3", label: "3", time: "9:20–10:00", type: "lesson" },
  { id: "b1", label: "Short break", time: "10:00–10:20", type: "break" },
  { id: "p4", label: "4", time: "10:20–11:00", type: "lesson" },
  { id: "p5", label: "5", time: "11:00–11:40", type: "lesson" },
  { id: "p6", label: "6", time: "11:40–12:20", type: "lesson" },
  { id: "l1", label: "Lunch", time: "12:20–14:00", type: "lunch" },
  { id: "p7", label: "7", time: "14:00–14:40", type: "lesson" },
  { id: "p8", label: "8", time: "14:40–15:20", type: "lesson" },
  { id: "b2", label: "Games / Clubs", time: "15:20–16:00", type: "break" },
];

const PERIOD_TYPES = {
  lesson: { label: "Lesson", bg: "#FFFFFF", fg: "#22304A", band: null },
  break:  { label: "Break",  bg: "#F5E8DC", fg: "#8A6A2C", band: "#F5E8DC" },
  lunch:  { label: "Lunch",  bg: "#E4F0E8", fg: "#2E6B4F", band: "#E4F0E8" },
};
const isLessonPeriod = (p) => (p.type || "lesson") === "lesson";

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
// CBC performance levels (Competency Based Curriculum, Kenya).
// Primary schools report levels 1–4 rather than KCSE letter grades.
const CBC_BANDS = [
  { min: 76, level: 4, code: "EE", label: "Exceeding Expectation",   ink: "#2E6B4F" },
  { min: 51, level: 3, code: "ME", label: "Meeting Expectation",     ink: "#3F7A5C" },
  { min: 26, level: 2, code: "AE", label: "Approaching Expectation", ink: "#C98A2C" },
  { min: 0,  level: 1, code: "BE", label: "Below Expectation",       ink: "#B84C3E" },
];
const cbcBand = (score) => {
  if (score === null || score === undefined) return null;
  return CBC_BANDS.find((b) => score >= b.min) || CBC_BANDS[CBC_BANDS.length - 1];
};
// Short code shown in tables, e.g. "ME"; full wording used on report cards.
const gradeOf = (score) => cbcBand(score)?.code || "—";
const gradeLevel = (score) => cbcBand(score)?.level ?? null;
const gradeLabel = (score) => cbcBand(score)?.label || "—";
const gradeInk = (score) => cbcBand(score)?.ink || "#8A8368";

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
  discipline: [],      // [ { id, ts, studentId, classId, byTeacher, category, detail, action, status, adminNote } ]
  checkins: {},        // { [date]: { [teacherId]: { time, status, note, approved } } }
  examTimetable: {},   // { [level]: { title, papers: [ { id, date, start, end, subject, invigilator, note } ] } }
  memos: [],           // [ { id, ts, by, title, body, priority, expires, readBy: [teacherId] } ]
  audit: [],           // [ { ts, actor, action } ] — who changed what
  archives: [],        // [ { year, savedAt, snapshot } ] — closed school years
  settings: { currency: "KSh", passMark: 51, weights: DEFAULT_WEIGHTS, periods: DEFAULT_PERIODS,
              schoolName: DEFAULT_SCHOOL_NAME, schoolLocation: DEFAULT_SCHOOL_LOCATION, schoolMotto: DEFAULT_MOTTO },
};

const FONT = {
  display: "'Source Serif 4', Georgia, serif",
  body: "'Inter', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
};

export default function SchoolRegister() {
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState(EMPTY_ROSTER);
  const [role, setRole] = useState(null);          // "admin" | "teacher" | "family"
  const [who, setWho] = useState(null);            // signed-in staff { role, name, teacherId }
  const [parentData, setParentData] = useState(null); // the one child a parent may see
  const [activeTeacherId, setActiveTeacherId] = useState(null);
  const [activeStudentId, setActiveStudentId] = useState(null);
  const [toast, setToast] = useState("");

  // Restore a previous staff session, then load the school if signed in.
  useEffect(() => {
    (async () => {
      let session = null;
      try { session = await restoreSession(); } catch (e) { session = getWho(); }
      if (session) {
        setWho(session);
        setRole(session.role);
        if (session.role === "teacher") setActiveTeacherId(session.teacherId);
      } else {
        setLoading(false);
        return;                       // show the login screen
      }
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
            discipline: p.discipline || [],
            checkins: p.checkins || {},
            examTimetable: p.examTimetable || {},
            memos: p.memos || [],
            audit: p.audit || [],
            archives: p.archives || [],
            settings: {
              ...EMPTY_ROSTER.settings, ...(p.settings || {}),
              weights: { ...DEFAULT_WEIGHTS, ...(p.settings?.weights || {}) },
              periods: p.settings?.periods?.length ? p.settings.periods : DEFAULT_PERIODS,
            },
          };
          applySchoolIdentity(loaded.settings);
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
      const merged = await persistRoster(snapshot);
      if (merged) { rosterRef.current = merged; setRoster(merged); } // another device had saved; keep both sets of changes
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
          onStaffSignedIn={async (session) => {
            setWho(session);
            setRole(session.role);
            if (session.role === "teacher") setActiveTeacherId(session.teacherId);
            const p = await loadRoster();
            if (p) {
              const loaded = {
                ...EMPTY_ROSTER, ...p,
                subjects: p.subjects?.length ? p.subjects : DEFAULT_SUBJECTS,
                attendance: p.attendance || {}, staffAttendance: p.staffAttendance || {},
                marks: p.marks || {}, timetable: p.timetable || {}, duty: p.duty || [],
                audit: p.audit || [], archives: p.archives || [],
                settings: {
                  ...EMPTY_ROSTER.settings, ...(p.settings || {}),
                  weights: { ...DEFAULT_WEIGHTS, ...(p.settings?.weights || {}) },
                  periods: p.settings?.periods?.length ? p.settings.periods : DEFAULT_PERIODS,
                },
              };
              rosterRef.current = loaded;
              setRoster(loaded);
            }
          }}
          onParentSignedIn={(payload) => { setParentData(payload); setRole("family"); }}
        />
      )}
      {role === "admin" && (
        <AdminView roster={roster} saveRoster={saveRoster} who={who} syncState={syncState} onForceSave={flush}
          onExit={async () => { await staffLogout(); setRole(null); setWho(null); setRoster(EMPTY_ROSTER); }} />
      )}
      {role === "teacher" && (
        <TeacherView roster={roster} saveRoster={saveRoster} teacherId={activeTeacherId} who={who}
          onExit={async () => { await staffLogout(); setRole(null); setWho(null); setActiveTeacherId(null); setRoster(EMPTY_ROSTER); }} />
      )}
      {role === "finance" && (
        <FinanceView roster={roster} saveRoster={saveRoster} who={who} syncState={syncState} onForceSave={flush}
          onExit={async () => { await staffLogout(); setRole(null); setWho(null); setRoster(EMPTY_ROSTER); }} />
      )}
      {role === "family" && (
        <ParentView payload={parentData} onExit={() => { setParentData(null); setRole(null); }} />
      )}
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

        /* --- interaction: feedback the eye reads faster than text --- */
        button, [role="button"] { transition: transform .11s cubic-bezier(.2,.7,.3,1), filter .15s ease, box-shadow .15s ease; }
        button:not(:disabled):active { transform: scale(.975); }
        button:not(:disabled):hover { filter: brightness(1.06); }
        .lift { transition: transform .16s cubic-bezier(.2,.7,.3,1), box-shadow .16s ease; }
        .lift:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,.14); }
        .lift:active { transform: translateY(0); }
        input, select, textarea { transition: border-color .14s ease, box-shadow .14s ease; }
        input:focus, select:focus, textarea:focus { box-shadow: 0 0 0 3px rgba(232,178,61,.18); }
        @keyframes pulseIn { 0% { transform: scale(.94); opacity:.5 } 60% { transform: scale(1.02) } 100% { transform: scale(1); opacity:1 } }
        .pulse { animation: pulseIn .34s cubic-bezier(.2,.7,.3,1); }
        @keyframes shimmer { 0% { background-position:-420px 0 } 100% { background-position:420px 0 } }
        .skeleton { background: linear-gradient(90deg, rgba(241,236,225,.05) 25%, rgba(241,236,225,.13) 37%, rgba(241,236,225,.05) 63%);
                    background-size: 900px 100%; animation: shimmer 1.3s linear infinite; border-radius: 3px; }
        @keyframes slideUp { from { opacity:0; transform: translateY(9px) } to { opacity:1; transform:none } }
        .enter { animation: slideUp .3s cubic-bezier(.2,.7,.3,1) both; }
        @keyframes spin { to { transform: rotate(360deg) } }
        .spin { animation: spin .9s linear infinite; }
        .ring { transform: rotate(-90deg); }
        .ring circle { transition: stroke-dashoffset .6s cubic-bezier(.2,.7,.3,1); }

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
          .report-page { page-break-after: always; }
          .report-page:last-child { page-break-after: auto; }
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

// Results move: draft → submitted (teacher) → approved (admin publishes to parents).
// Older records only had a boolean, so they map onto the new states cleanly.
const MARK_STATUS = {
  draft:     { label: "DRAFT — not yet sent to admin",        bg: "#F5E8DC", fg: "#C98A2C", border: "#E8CBA0" },
  submitted: { label: "SENT FOR APPROVAL — awaiting admin",   bg: "#E3E9F5", fg: "#3B5998", border: "#BCCAE6" },
  approved:  { label: "APPROVED — visible to students & parents", bg: "#E4F0E8", fg: "#3F7A5C", border: "#B8D9C4" },
  returned:  { label: "RETURNED BY ADMIN — needs correction", bg: "#F7E4E1", fg: "#B84C3E", border: "#E8C4BD" },
};
const statusOf = (m) => m?.status || (m?.approved ? "approved" : "draft");
const setMarksFor = (roster, classId, term, data) => ({
  ...roster,
  marks: { ...roster.marks, [classId]: { ...(roster.marks?.[classId] || {}), [termKey(term)]: data } },
});
const getAttendanceFor = (roster, classId) => roster.attendance?.[classId] || {};
const setAttendanceFor = (roster, classId, log) => ({ ...roster, attendance: { ...roster.attendance, [classId]: log } });

// ================= ROLE GATE =================
function RoleGate({ onStaffSignedIn, onParentSignedIn }) {
  const [step, setStep] = useState("root");
  const [creds, setCreds] = useState({ username: "", password: "" });
  const [adm, setAdm] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState({ stage: "ask", username: "", code: "", pw1: "", pw2: "" });
  const [note, setNote] = useState("");
  const [, forceRender] = useState(0);

  // The school's name lives in the database, so fetch it before sign-in.
  useEffect(() => {
    let cancelled = false;
    schoolInfo().then((info) => {
      if (!cancelled && info) { applySchoolIdentity(info); forceRender((n) => n + 1); }
    });
    return () => { cancelled = true; };
  }, []);

  const sendCode = async () => {
    const u = reset.username.trim() || creds.username.trim();
    if (!u) return setErr("Enter your username or email first.");
    setBusy(true); setErr(""); setNote("");
    try {
      await requestReset(u);
      setReset({ ...reset, username: u, stage: "code" });
      setNote("If that account has an email on file, a 6-digit code is on its way. It expires in 20 minutes.");
    } catch (e) {
      setErr(String(e.message || e).slice(0, 180));
    }
    setBusy(false);
  };

  const applyReset = async () => {
    if (!reset.code.trim()) return setErr("Enter the code from the email.");
    if (reset.pw1.length < 6) return setErr("New password must be at least 6 characters.");
    if (reset.pw1 !== reset.pw2) return setErr("The two passwords do not match.");
    setBusy(true); setErr(""); setNote("");
    try {
      const ok = await confirmReset(reset.username, reset.code, reset.pw1);
      if (!ok) { setErr("That code is wrong or has expired."); setBusy(false); return; }
      setNote("Password changed. You can sign in now.");
      setCreds({ username: reset.username, password: "" });
      setReset({ stage: "ask", username: "", code: "", pw1: "", pw2: "" });
      setStep("staff");
    } catch (e) {
      setErr(String(e.message || e).slice(0, 180));
    }
    setBusy(false);
  };

  // One sign-in for all staff. The database decides whether this person is
  // an admin or a teacher — the app no longer takes their word for it.
  const signIn = async () => {
    if (!creds.username.trim() || !creds.password) return setErr("Enter your username and password.");
    setBusy(true); setErr("");
    try {
      const session = await staffLogin(creds.username, creds.password);
      if (!session) { setErr("Username or password not recognised."); setBusy(false); return; }
      await onStaffSignedIn(session);
    } catch (e) {
      // Show the real reason — a generic message makes problems impossible to diagnose.
      setErr(isOffline()
        ? "You are offline — sign in once with a connection."
        : "Sign-in failed: " + String(e.message || e).slice(0, 180));
      setBusy(false);
    }
  };

  const parentSignIn = async () => {
    if (!adm.trim() || !pin.trim()) return setErr("Enter the admission number and PIN.");
    setBusy(true); setErr("");
    try {
      const payload = await parentLookup(adm.trim(), pin.trim());
      if (!payload) { setErr("Admission number or PIN not recognised."); setBusy(false); return; }
      onParentSignedIn(payload);
    } catch (e) {
      setErr(isOffline()
        ? "You are offline — a connection is needed to view results."
        : "Lookup failed: " + String(e.message || e).slice(0, 180));
      setBusy(false);
    }
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
        <h1 style={{ fontFamily: FONT.display, color: "#F7F5EF", fontSize: 25, margin: "12px 0 0", fontWeight: 700, lineHeight: 1.22 }}>{SCHOOL_NAME}</h1>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 9, padding: "4px 12px", borderRadius: 20, border: "1px solid #3E6350", background: "rgba(30,55,42,0.6)" }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#E8B23D" }} />
          <span style={{ fontFamily: FONT.mono, color: "#E8B23D", fontSize: 11, letterSpacing: 0.8 }}>{SCHOOL_LOCATION}</span>
        </div>
      </div>

      {step === "root" && (
        <div style={{ display: "grid", gap: 12 }}>
          <RoleCard glyph="S" title="Staff Login" desc="Teachers and administration — sign in with your username." onClick={() => { setStep("staff"); setErr(""); }} />
          <RoleCard glyph="P" title="Student / Parent" desc="Results with class position, attendance and fees." onClick={() => { setStep("parent"); setErr(""); }} />
        </div>
      )}

      {step === "staff" && (
        <div>
          <button onClick={() => { setStep("root"); setErr(""); }} style={backBtnStyle()}>← back</button>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <input placeholder="Username" autoCapitalize="none" value={creds.username}
              onChange={(e) => setCreds({ ...creds, username: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && signIn()} style={inputStyle()} />
            <input placeholder="Password" type="password" value={creds.password}
              onChange={(e) => setCreds({ ...creds, password: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && signIn()} style={inputStyle()} />
            {err && <div style={{ color: "#E8967D", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
            <button onClick={signIn} disabled={busy} style={{ ...primaryBtn(), background: "#E8B23D", color: "#1F3A2E", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            {note && <div style={{ color: "#8FD3A8", fontFamily: FONT.body, fontSize: 12, lineHeight: 1.5 }}>{note}</div>}
            <button onClick={() => { setStep("forgot"); setErr(""); setNote(""); setReset({ ...reset, username: creds.username, stage: "ask" }); }}
              style={{ ...backBtnStyle(), marginTop: 6, textAlign: "left" }}>
              Forgotten your password?
            </button>
          </div>
        </div>
      )}

      {step === "forgot" && (
        <div>
          <button onClick={() => { setStep("staff"); setErr(""); }} style={backBtnStyle()}>← back to sign in</button>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <div style={{ fontFamily: FONT.display, color: "#F5F3EE", fontSize: 17, fontWeight: 600 }}>Reset your password</div>

            {reset.stage === "ask" && (
              <>
                <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#A8BCAC", lineHeight: 1.5 }}>
                  Enter your username. If an email address is on file for it, we'll send a 6-digit code.
                </div>
                <input placeholder="Username or email" autoCapitalize="none" value={reset.username}
                  onChange={(e) => setReset({ ...reset, username: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && sendCode()} style={inputStyle()} />
                {err && <div style={{ color: "#E8967D", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
                {note && <div style={{ color: "#8FD3A8", fontFamily: FONT.body, fontSize: 12, lineHeight: 1.5 }}>{note}</div>}
                <button onClick={sendCode} disabled={busy} style={{ ...primaryBtn(), background: "#E8B23D", color: "#1F3A2E", opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Sending…" : "Send code"}
                </button>
                <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#7B9585", marginTop: 4, lineHeight: 1.5 }}>
                  No email on your account? The school administrator can set a new password for you.
                </div>
              </>
            )}

            {reset.stage === "code" && (
              <>
                {note && <div style={{ color: "#8FD3A8", fontFamily: FONT.body, fontSize: 12, lineHeight: 1.5 }}>{note}</div>}
                <input placeholder="6-digit code" inputMode="numeric" value={reset.code}
                  onChange={(e) => setReset({ ...reset, code: e.target.value })} style={inputStyle()} />
                <input placeholder="New password" type="password" value={reset.pw1}
                  onChange={(e) => setReset({ ...reset, pw1: e.target.value })} style={inputStyle()} />
                <input placeholder="Repeat new password" type="password" value={reset.pw2}
                  onChange={(e) => setReset({ ...reset, pw2: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && applyReset()} style={inputStyle()} />
                {err && <div style={{ color: "#E8967D", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
                <button onClick={applyReset} disabled={busy} style={{ ...primaryBtn(), background: "#E8B23D", color: "#1F3A2E", opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Saving…" : "Set new password"}
                </button>
                <button onClick={sendCode} disabled={busy} style={{ ...backBtnStyle(), marginTop: 4, textAlign: "left" }}>Send another code</button>
              </>
            )}
          </div>
        </div>
      )}

      {step === "parent" && (
        <div>
          <button onClick={() => { setStep("root"); setErr(""); }} style={backBtnStyle()}>← back</button>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#A8BCAC", lineHeight: 1.5 }}>
              Enter the admission number and PIN printed on your child's report card.
            </div>
            <input placeholder="Admission number (e.g. STU/2026/001)" autoCapitalize="characters" value={adm}
              onChange={(e) => setAdm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && parentSignIn()} style={inputStyle()} />
            <input placeholder="PIN" type="password" inputMode="numeric" value={pin}
              onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === "Enter" && parentSignIn()} style={inputStyle()} />
            {err && <div style={{ color: "#E8967D", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
            <button onClick={parentSignIn} disabled={busy} style={{ ...primaryBtn(), background: "#E8B23D", color: "#1F3A2E", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Checking…" : "View results"}
            </button>
            <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#7B9585", marginTop: 4 }}>
              Lost the PIN? Ask the school office.
            </div>
          </div>
        </div>
      )}

      <div style={{ textAlign: "center", marginTop: 34, fontFamily: FONT.mono, fontSize: 9.5, color: "#5F7A68", letterSpacing: 1 }}>
        {SCHOOL_MOTTO}
        <div style={{ marginTop: 5, fontSize: 8.5, color: "#4A6355", letterSpacing: 0.5 }}>{APP_VERSION}</div>
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


// ---------- Icons for the navigation drawer ----------
const NavIcon = ({ d, size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}>
    {d}
  </svg>
);
const ICONS = {
  overview:  <><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></>,
  approvals: <><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></>,
  logins:    <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>,
  classes:   <><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></>,
  subjects:  <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></>,
  teachers:  <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></>,
  staff:     <><path d="M9 11H3v10h6z"/><path d="M15 3H9v18h6z"/><path d="M21 7h-6v14h6z"/></>,
  students:  <><path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/></>,
  marks:     <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></>,
  timetable: <><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></>,
  duty:      <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  fees:      <><circle cx="12" cy="12" r="9"/><path d="M15 9.5a3 3 0 0 0-3-1.5c-1.7 0-3 .9-3 2s1.3 2 3 2 3 .9 3 2-1.3 2-3 2a3 3 0 0 1-3-1.5"/><path d="M12 6v12"/></>,
  reports:   <><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></>,
  yearend:   <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></>,
  backup:    <><path d="M21 8v13H3V8"/><rect x="1" y="3" width="22" height="5" rx="1"/><path d="M10 12h4"/></>,
  settings:  <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V7a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></>,
  attendance:<><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></>,
};

// Grouped navigation drawer, in the style of a university student portal.
function Sidebar({ open, onClose, groups, active, onPick, heading, subheading }) {
  return (
    <>
      <div onClick={onClose} className="no-print" style={{
        position: "fixed", inset: 0, background: "rgba(10,20,15,0.55)", zIndex: 200,
        opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none", transition: "opacity .22s ease",
      }} />
      <nav className="no-print" style={{
        position: "fixed", top: 0, left: 0, bottom: 0, width: 268, maxWidth: "84vw", zIndex: 201,
        background: "linear-gradient(180deg,#1B3327,#16281F)", borderRight: "1px solid #2E4B3A",
        transform: open ? "translateX(0)" : "translateX(-102%)", transition: "transform .24s cubic-bezier(.2,.7,.3,1)",
        overflowY: "auto", boxShadow: open ? "6px 0 24px rgba(0,0,0,0.35)" : "none",
      }}>
        <div style={{ padding: "18px 18px 14px", borderBottom: "1px solid #2E4B3A", display: "flex", alignItems: "center", gap: 11 }}>
          <Seal size={34} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: FONT.display, color: "#F5F3EE", fontSize: 15, fontWeight: 600, lineHeight: 1.2 }}>{heading}</div>
            <div style={{ fontFamily: FONT.mono, color: "#8AA090", fontSize: 10, marginTop: 2 }}>{subheading}</div>
          </div>
        </div>

        <div style={{ padding: "10px 0 26px" }}>
          {groups.map((g) => (
            <div key={g.title} style={{ marginBottom: 6 }}>
              <div style={{ fontFamily: FONT.mono, fontSize: 9.5, letterSpacing: 1.4, color: "#E8B23D", padding: "12px 18px 6px" }}>
                {g.title}
              </div>
              {g.items.map((it) => {
                const on = active === it.key;
                return (
                  <button key={it.key} onClick={() => { onPick(it.key); onClose(); }} style={{
                    display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
                    padding: "11px 18px", border: "none", background: on ? "#2A4636" : "transparent",
                    borderLeft: `3px solid ${on ? "#E8B23D" : "transparent"}`,
                    color: on ? "#F5F3EE" : "#B8C4B9", fontFamily: FONT.body, fontSize: 13.5,
                    fontWeight: on ? 600 : 400,
                  }}>
                    <span style={{ color: on ? "#E8B23D" : "#7B9585", display: "flex" }}><NavIcon d={ICONS[it.icon] || ICONS.overview} /></span>
                    <span style={{ flex: 1 }}>{it.label}</span>
                    {it.badge > 0 && (
                      <span style={{ background: "#B84C3E", color: "#fff", borderRadius: 10, padding: "1px 7px", fontFamily: FONT.mono, fontSize: 10, fontWeight: 700 }}>{it.badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}

// Header bar with the menu button and the current section name.
function PortalHeader({ title, section, onMenu, onExit }) {
  return (
    <div className="no-print" style={{
      display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
      background: "rgba(27,51,39,0.92)", borderBottom: "1px solid #2E4B3A",
      position: "sticky", top: 0, zIndex: 120, backdropFilter: "blur(6px)",
    }}>
      <button onClick={onMenu} aria-label="Menu" style={{
        display: "flex", flexDirection: "column", gap: 4, background: "transparent",
        border: "1px solid #3E6350", borderRadius: 6, padding: "9px 10px",
      }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 16, height: 2, background: "#E8B23D", borderRadius: 2, display: "block" }} />)}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: FONT.mono, color: "#8AA090", fontSize: 9.5, letterSpacing: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ fontFamily: FONT.display, color: "#F5F3EE", fontSize: 17, fontWeight: 600, textTransform: "capitalize" }}>{section}</div>
      </div>
      <button onClick={onExit} style={{ background: "transparent", border: "1px solid #4A6E58", color: "#F5F3EE", borderRadius: 4, padding: "7px 12px", fontFamily: FONT.body, fontSize: 12, whiteSpace: "nowrap" }}>Sign out</button>
    </div>
  );
}

// ================= ADMIN =================
function AdminView({ roster, saveRoster, onExit, syncState, onForceSave, who }) {
  const [tab, setTab] = useState("overview");
  const [newClass, setNewClass] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [newTeacher, setNewTeacher] = useState({ name: "", classId: "", username: "", password: "" });
  const [newStudent, setNewStudent] = useState({ name: "", classId: "", parentName: "", feeDue: "" });
  const [lastAddedClassId, setLastAddedClassId] = useState("");
  const [newAdminPass, setNewAdminPass] = useState("");
  const [payment, setPayment] = useState({ studentId: "", amount: "", method: "cash", code: "", sender: "" });
  const [payErr, setPayErr] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  const [marksClassId, setMarksClassId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [receipt, setReceipt] = useState(null);   // { student, payment } to print
  const cur = roster.settings.currency;

  let pendingCount = 0;
  Object.values(roster.marks || {}).forEach((terms) =>
    Object.values(terms || {}).forEach((rec) => { if (statusOf(rec) === "submitted") pendingCount++; }));

  const NAV = [
    { title: "DASHBOARD", items: [
      { key: "overview", label: "Overview", icon: "overview" },
      { key: "approvals", label: "Approvals", icon: "approvals", badge: pendingCount },
      { key: "memos", label: "Memos to staff", icon: "subjects" },
      { key: "leave", label: "Leave applications", icon: "duty" },
    ]},
    { title: "ACADEMICS", items: [
      { key: "marks", label: "Exam results", icon: "marks" },
      { key: "timetable", label: "Class timetable", icon: "timetable" },
      { key: "examtt", label: "Exam timetable", icon: "marks" },
      { key: "subjects", label: "Subjects", icon: "subjects" },
      { key: "classes", label: "Classes", icon: "classes" },
    ]},
    { title: "PEOPLE", items: [
      { key: "students", label: "Students", icon: "students" },
      { key: "discipline", label: "Discipline cases", icon: "approvals" },
      { key: "photos", label: "Pupil photos", icon: "students" },
      { key: "idcards", label: "Student ID cards", icon: "logins" },
      { key: "signins", label: "Arrival sign-ins", icon: "duty" },
      { key: "teachers", label: "Teachers", icon: "teachers" },
      { key: "logins", label: "Staff logins", icon: "logins" },
      { key: "staff", label: "Staff attendance", icon: "staff" },
      { key: "duty", label: "Duty roster", icon: "duty" },
    ]},
    { title: "FINANCIALS", items: [
      { key: "fees", label: "Fees & receipts", icon: "fees" },
      { key: "feeroll", label: "Printable fee list", icon: "reports" },
      { key: "spending", label: "Where money went", icon: "reports" },
    ]},
    { title: "REPORTS", items: [
      { key: "reports", label: "Reports", icon: "reports" },
      { key: "year end", label: "End of year", icon: "yearend" },
      { key: "history", label: "History", icon: "reports" },
    ]},
    { title: "SYSTEM", items: [
      { key: "health", label: "System health", icon: "approvals" },
      { key: "geofence", label: "School boundary", icon: "duty" },
      { key: "backup", label: "Backup", icon: "backup" },
      { key: "settings", label: "Settings", icon: "settings" },
    ]},
  ];

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
    const s = { id: nextAdmissionNo(roster.students), name: newStudent.name.trim(), classId: newStudent.classId, parentName: newStudent.parentName.trim(), feeDue: Number(newStudent.feeDue) || 0, feePaid: 0, payments: [], pin };
    saveRoster(logAction({ ...roster, students: [...roster.students, s] }, "Admin", `Added student ${s.name} (${s.id})`), `Added ${s.name} — PIN ${pin}`);
    setLastAddedClassId(s.classId);
    // keep the class selected, so registering a whole class is quick
    setNewStudent({ name: "", classId: newStudent.classId, parentName: "", feeDue: newStudent.feeDue });
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
  const recordPayment = async () => {
    const amt = Number(payment.amount);
    if (!payment.studentId || !amt || amt <= 0) return;
    const st = roster.students.find((s) => s.id === payment.studentId);
    const receiptNo = nextReceiptNo(roster);
    setPayErr(""); setPayBusy(true);

    // For M-Pesa, claim the confirmation code first. If it has been used
    // before the claim fails and no payment is recorded, so the books cannot
    // be inflated by entering the same SMS twice.
    let code = "";
    if (payment.method === "mpesa") {
      if (!payment.code.trim()) { setPayErr("Enter the M-Pesa confirmation code from the SMS."); setPayBusy(false); return; }
      try {
        code = await mpesaClaim(payment.code, payment.studentId, amt, todayISO(), payment.sender);
      } catch (e) {
        setPayErr(String(e.message || e).replace(/^mpesa_claim \d+: /, "").slice(0, 200));
        setPayBusy(false);
        return;
      }
    }

    const entry = { date: todayISO(), amount: amt, receiptNo, method: payment.method };
    if (code) { entry.mpesaCode = code; if (payment.sender.trim()) entry.sender = payment.sender.trim(); }

    const next = {
      ...roster,
      students: roster.students.map((s) => s.id === payment.studentId
        ? { ...s, feePaid: (s.feePaid || 0) + amt, payments: [...(s.payments || []), entry] } : s),
    };
    saveRoster(logAction(next, "Admin",
      `Receipt ${receiptNo} — ${cur}${money(amt)} from ${st?.name}${code ? " (M-Pesa " + code + ")" : " (cash)"}`),
      `${receiptNo} · ${cur}${money(amt)} from ${st?.name}`);
    setPayment({ studentId: "", amount: "", method: payment.method, code: "", sender: "" });
    setPayBusy(false);
  };

  if (receipt) {
    return <ReceiptDoc roster={roster} student={receipt.student} payment={receipt.payment}
             onBack={() => setReceipt(null)} />;
  }

  return (
    <div>
      <PortalHeader title={SCHOOL_NAME.toUpperCase()} section={NAV.flatMap((g) => g.items).find((i) => i.key === tab)?.label || tab}
        onMenu={() => setMenuOpen(true)} onExit={onExit} />
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} groups={NAV} active={tab} onPick={setTab}
        heading="Administration" subheading={who?.name || "Signed in"} />
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "14px 6px 60px" }}>
        <div style={{ ...paperPanel(), padding: 22 }} className="chalk-fade">

          {tab === "overview" && <AdminOverview roster={roster} />}

          {tab === "approvals" && <Approvals roster={roster} saveRoster={saveRoster} />}

          {tab === "memos" && <MemoBoard roster={roster} saveRoster={saveRoster} who={who} />}

          {tab === "leave" && <LeaveApprovals roster={roster} />}

          {tab === "logins" && <StaffAccounts roster={roster} who={who} />}

          {tab === "discipline" && <DisciplineReport roster={roster} saveRoster={saveRoster} classId={null} actorName="Admin" role="admin" />}

          {tab === "signins" && <CheckInApprovals roster={roster} saveRoster={saveRoster} />}

          {tab === "photos" && <PhotoManager roster={roster} classId={null} />}

          {tab === "idcards" && <IdCardDashboard roster={roster} />}

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
              <div style={{ padding: "10px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF",
                            borderRadius: 4, fontFamily: FONT.body, fontSize: 12, color: "#6B6552",
                            lineHeight: 1.55, marginBottom: 12 }}>
                A teacher's class here is the one they register and write report cards for.
                To let them teach <strong>other</strong> classes, put them on the <strong>Timetable</strong> —
                every lesson assigned to them there lets them enter marks for that class and subject.
              </div>
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
                    {(() => {
                      const extra = teachingAssignments(roster, t.id).filter((a) => !a.isHomeClass);
                      return extra.length > 0 ? (
                        <div style={{ margin: "8px 0 4px", padding: "7px 10px", background: "#E3E9F5",
                                      border: "1px solid #BCCAE6", borderRadius: 4,
                                      fontFamily: FONT.body, fontSize: 11.5, color: "#22304A", lineHeight: 1.5 }}>
                          <strong>Also teaches</strong> (from the timetable):{" "}
                          {extra.map((a) => `${a.className} — ${a.subjects.join(", ")}`).join(" · ")}
                        </div>
                      ) : null;
                    })()}
                    <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", margin: "9px 0 5px" }}>
                      Subjects taught in their own class (tap to toggle):
                      {levelLabelForClass(roster, t.classId) && (
                        <span style={{ color: "#8A8368" }}> — {levelLabelForClass(roster, t.classId)}</span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {subjectsForClass(roster, t.classId).map((sub) => {
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
              <StudentsByClass roster={roster} saveRoster={saveRoster} removeItem={removeItem} openClassId={lastAddedClassId} />
            </div>
          )}

          {tab === "marks" && (
            <div>
              <SectionTitle>Exam results</SectionTitle>
              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 12 }}>
                Pick a grade to open its results. Only that grade is loaded, so nothing else is in the way.
              </div>

              {marksClassId ? (
                <>
                  <button onClick={() => setMarksClassId("")} style={{ ...backBtnStyle(), color: "#22304A", marginBottom: 12 }}>
                    ← all grades
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: FONT.display, fontSize: 18, fontWeight: 700, color: "#22304A" }}>
                      {classNameOf(roster, marksClassId)}
                    </span>
                    {levelLabelForClass(roster, marksClassId) && (
                      <span style={{ fontFamily: FONT.mono, fontSize: 10, color: "#6B6552", background: "#F5F1E6",
                                     border: "1px solid #E4DFCF", borderRadius: 10, padding: "2px 9px" }}>
                        {levelLabelForClass(roster, marksClassId)}
                      </span>
                    )}
                  </div>
                  <MarksEditor roster={roster} saveRoster={saveRoster} classId={marksClassId}
                    students={roster.students.filter((s) => s.classId === marksClassId)}
                    allowedSubjects={subjectsForClass(roster, marksClassId)} role="admin" />
                </>
              ) : (
                <ClassPicker roster={roster} onPick={setMarksClassId} />
              )}
            </div>
          )}

          {tab === "feeroll" && <AdminFeeRoll roster={roster} />}

          {tab === "spending" && <SpendReport roster={roster} refreshKey={0} />}

          {tab === "fees" && (
            <div>
              <SectionTitle>Fees</SectionTitle>
              <div style={{ marginBottom: 16, background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 4, padding: 12 }}>
                {/* how the money arrived */}
                <div style={{ display: "flex", gap: 7, marginBottom: 9, flexWrap: "wrap" }}>
                  {[["cash", "Cash"], ["mpesa", "M-Pesa"], ["bank", "Bank"]].map(([k, label]) => (
                    <button key={k} onClick={() => { setPayment({ ...payment, method: k }); setPayErr(""); }}
                      style={{
                        padding: "6px 15px", borderRadius: 16, fontFamily: FONT.body, fontSize: 12.5, fontWeight: 600,
                        border: `1px solid ${payment.method === k ? "#22304A" : "#D8D2C2"}`,
                        background: payment.method === k ? "#22304A" : "#fff",
                        color: payment.method === k ? "#fff" : "#6B6552",
                      }}>{label}</button>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <select value={payment.studentId} onChange={(e) => setPayment({ ...payment, studentId: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 150 }}>
                    <option value="">Record payment for…</option>
                    {roster.students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <input value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} placeholder="Amount" type="number" inputMode="numeric" style={{ ...darkInput(), width: 110 }} />
                </div>

                {payment.method === "mpesa" && (
                  <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                    <input value={payment.code}
                      onChange={(e) => setPayment({ ...payment, code: e.target.value.toUpperCase() })}
                      placeholder="M-Pesa code (e.g. TFH5XY9Z12)" autoCapitalize="characters"
                      style={{ ...darkInput(), flex: 1, minWidth: 170, fontFamily: FONT.mono, letterSpacing: 1 }} />
                    <input value={payment.sender}
                      onChange={(e) => setPayment({ ...payment, sender: e.target.value })}
                      placeholder="Sent from (phone)" inputMode="tel"
                      style={{ ...darkInput(), flex: 1, minWidth: 140 }} />
                  </div>
                )}

                {payErr && (
                  <div style={{ padding: "8px 11px", borderRadius: 4, background: "#F7E4E1", border: "1px solid #E8C4BD",
                                fontFamily: FONT.body, fontSize: 12.5, color: "#B84C3E", marginBottom: 8, lineHeight: 1.45 }}>
                    {payErr}
                  </div>
                )}

                <button onClick={recordPayment} disabled={payBusy} style={{ ...primaryBtn(), opacity: payBusy ? 0.5 : 1 }}>
                  {payBusy ? "Checking…" : "Record payment"}
                </button>

                {payment.method === "mpesa" && (
                  <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#6B6552", marginTop: 8, lineHeight: 1.5 }}>
                    Copy the code from the M-Pesa SMS. Each code can only be recorded once — if it has
                    already been used the payment is refused, so the same message cannot be counted twice.
                  </div>
                )}
              </div>
              {roster.students.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Add students first.</div>}
              <div style={{ display: "grid", gap: 8 }}>
                {roster.students.map((s) => {
                  const due = s.feeDue || 0, paid = s.feePaid || 0, bal = due - paid;
                  const pays = [...(s.payments || [])].reverse();
                  return (
                    <div key={s.id} style={{ padding: "10px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({classNameOf(roster, s.classId)})</span></span>
                        <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <input type="number" defaultValue={due} onBlur={(e) => setFeeDue(s.id, e.target.value)} style={{ ...darkInput(), width: 90, padding: "5px 8px" }} />
                          <span style={{ fontFamily: FONT.mono, fontSize: 12, color: "#3F7A5C" }}>paid {cur}{money(paid)}</span>
                          <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: bal > 0 ? "#B84C3E" : "#3F7A5C" }}>{bal > 0 ? `owes ${cur}${money(bal)}` : "cleared"}</span>
                        </span>
                      </div>

                      {pays.length > 0 && (
                        <div style={{ marginTop: 8, borderTop: "1px solid #E4DFCF", paddingTop: 7, display: "grid", gap: 4 }}>
                          {pays.map((p, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#6B6552" }}>
                                {p.receiptNo || "receipt —"} · {fmtDate(p.date)} · {cur}{money(p.amount)}
                                {p.mpesaCode
                                  ? <span style={{ color: "#3F7A5C" }}> · M-PESA {p.mpesaCode}</span>
                                  : p.method && p.method !== "cash" ? <span> · {p.method}</span> : null}
                              </span>
                              <button onClick={() => setReceipt({ student: s, payment: p })}
                                style={{ background: "none", border: "none", color: "#22304A", fontFamily: FONT.mono, fontSize: 11, textDecoration: "underline" }}>
                                print receipt
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "staff" && <StaffAttendance roster={roster} saveRoster={saveRoster} />}

          {tab === "timetable" && <TimetableAdmin roster={roster} saveRoster={saveRoster} />}

          {tab === "examtt" && <ExamTimetable roster={roster} saveRoster={saveRoster} />}

          {tab === "duty" && <DutyRoster roster={roster} saveRoster={saveRoster} />}

          {tab === "reports" && <AdminReports roster={roster} />}

          {tab === "year end" && <YearEnd roster={roster} saveRoster={saveRoster} />}

          {tab === "history" && <History roster={roster} />}

          {tab === "health" && <SystemHealth roster={roster} />}

          {tab === "geofence" && <GeofenceSettings who={who} />}

          {tab === "backup" && <AdminBackup roster={roster} saveRoster={saveRoster} syncState={syncState} onForceSave={onForceSave} />}

          {tab === "settings" && (
            <div>
              <SectionTitle>Settings</SectionTitle>
              <div style={{ padding: "10px 12px", borderRadius: 4, background: "#E4F0E8", border: "1px solid #B8D9C4", fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", marginBottom: 20 }}>
                Passwords now live in the <strong>Logins</strong> tab, stored encrypted. The old shared
                passcode has been retired.
              </div>

              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 8 }}>Pass mark (a student passes at or above this average)</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 20, alignItems: "center" }}>
                <select value={roster.settings.passMark} onChange={(e) => saveRoster({ ...roster, settings: { ...roster.settings, passMark: Number(e.target.value) } }, "Pass mark updated")} style={{ ...darkInput(), width: 110 }}>
                  {SCORE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <span style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552" }}>out of 100</span>
              </div>

              <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>School identity</div>
              <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 10 }}>
                Shown on the login screen, every page header, report cards and invoices.
              </div>
              <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                <input defaultValue={roster.settings.schoolName || DEFAULT_SCHOOL_NAME}
                  onBlur={(e) => saveRoster({ ...roster, settings: { ...roster.settings, schoolName: e.target.value.trim() || DEFAULT_SCHOOL_NAME } }, "School name updated")}
                  placeholder="School name" style={darkInput()} />
                <input defaultValue={roster.settings.schoolLocation || DEFAULT_SCHOOL_LOCATION}
                  onBlur={(e) => saveRoster({ ...roster, settings: { ...roster.settings, schoolLocation: e.target.value.trim() || DEFAULT_SCHOOL_LOCATION } }, "Location updated")}
                  placeholder="Location, e.g. Sabuli, Wajir County" style={darkInput()} />
                <input defaultValue={roster.settings.schoolMotto || DEFAULT_MOTTO}
                  onBlur={(e) => saveRoster({ ...roster, settings: { ...roster.settings, schoolMotto: e.target.value.trim() || DEFAULT_MOTTO } }, "Motto updated")}
                  placeholder="Motto (shown small on the login screen)" style={darkInput()} />
              </div>
              <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#8A8368", marginBottom: 22 }}>
                Changes appear after the next page reload.
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
  let pendingApprovals = 0;
  Object.values(roster.marks || {}).forEach((terms) => Object.values(terms || {}).forEach((rec) => { if (statusOf(rec) === "submitted") pendingApprovals++; }));

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
        <StatCard label="Awaiting approval" value={pendingApprovals} tone={pendingApprovals > 0 ? "#3B5998" : "#22304A"} />
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
                            <td style={{ borderBottom: "1px solid #EFEADC", padding: "7px 8px", textAlign: "right", fontFamily: FONT.mono, fontSize: 10.5, color: gradeInk(r.average) }}>L{gradeLevel(r.average)}</td>
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


// ---------- Pupils grouped under their class ----------
// A single long list becomes unusable past a few dozen pupils, so each class
// is its own section that opens and closes. A newly registered pupil lands in
// their class straight away, and that class opens so you can see it happen.
function StudentsByClass({ roster, saveRoster, removeItem, openClassId }) {
  const [open, setOpen] = useState({});
  const [search, setSearch] = useState("");

  // When a pupil has just been registered, open their class so you can see
  // them arrive rather than wondering where they went.
  useEffect(() => {
    if (openClassId) setOpen((o) => ({ ...o, [openClassId]: true }));
  }, [openClassId]);

  const q = search.trim().toLowerCase();
  const matches = (st) => !q || st.name.toLowerCase().includes(q) || st.id.toLowerCase().includes(q)
    || (st.parentName || "").toLowerCase().includes(q);

  // classes in their natural order, plus a catch-all for anyone unassigned
  const groups = roster.classes.map((c) => ({
    id: c.id, name: c.name,
    pupils: roster.students.filter((s) => s.classId === c.id && matches(s)),
  }));
  const orphans = roster.students.filter(
    (s) => !roster.classes.some((c) => c.id === s.classId) && matches(s));
  if (orphans.length) groups.push({ id: "__none", name: "Not in any class", pupils: orphans });

  const shown = groups.filter((g) => g.pupils.length > 0 || !q);
  const total = roster.students.filter(matches).length;

  const newPin = (st) => {
    const np = String(Math.floor(1000 + Math.random() * 9000));
    saveRoster({ ...roster, students: roster.students.map((x) => x.id === st.id ? { ...x, pin: np } : x) },
      `${st.name}'s new PIN: ${np}`);
  };

  const move = (st, classId) => {
    saveRoster(logAction(
      { ...roster, students: roster.students.map((x) => x.id === st.id ? { ...x, classId } : x) },
      "Admin", `Moved ${st.name} to ${classNameOf(roster, classId)}`),
      `${st.name} moved to ${classNameOf(roster, classId)}`);
  };

  return (
    <div>
      <input value={search} onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name, admission number or guardian"
        style={{ ...darkInput(), width: "100%", marginBottom: 10 }} />

      {q && (
        <div style={{ fontFamily: FONT.mono, fontSize: 11, color: "#6B6552", marginBottom: 8 }}>
          {total} match{total === 1 ? "" : "es"}
        </div>
      )}

      <div style={{ display: "grid", gap: 7 }}>
        {shown.map((g) => {
          const isOpen = q ? true : !!open[g.id];
          return (
            <div key={g.id} style={{ border: "1px solid #E4DFCF", borderRadius: 5, overflow: "hidden" }}>
              <button onClick={() => setOpen({ ...open, [g.id]: !open[g.id] })}
                style={{
                  width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                  gap: 10, padding: "11px 13px", border: "none", textAlign: "left",
                  background: g.id === "__none" ? "#F7E4E1" : (isOpen ? "#22304A" : "#F5F1E6"),
                  color: g.id === "__none" ? "#B84C3E" : (isOpen ? "#fff" : "#22304A"),
                }}>
                <span style={{ fontFamily: FONT.display, fontSize: 14.5, fontWeight: 600 }}>
                  {g.name}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{
                    fontFamily: FONT.mono, fontSize: 11, padding: "2px 9px", borderRadius: 10,
                    background: isOpen ? "rgba(255,255,255,0.18)" : "#E4DFCF",
                    color: isOpen ? "#fff" : "#6B6552",
                  }}>{g.pupils.length}</span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 12 }}>{isOpen ? "▾" : "▸"}</span>
                </span>
              </button>

              {isOpen && (
                <div style={{ padding: "8px 10px", display: "grid", gap: 5, background: "#FBF9F3" }}>
                  {g.pupils.length === 0 && (
                    <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#8A8368", padding: "4px 2px" }}>
                      No pupils in this class yet.
                    </div>
                  )}
                  {g.pupils.map((st) => (
                    <div key={st.id} style={{ padding: "9px 11px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                        <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", fontWeight: 600 }}>{st.name}</span>
                        <span style={{ display: "flex", gap: 11, alignItems: "center" }}>
                          <span style={{ fontFamily: FONT.mono, fontSize: 12, background: "#fff", border: "1px solid #D8D2C2", borderRadius: 3, padding: "2px 8px", color: "#22304A" }}>
                            PIN {st.pin || "—"}
                          </span>
                          <button onClick={() => newPin(st)} style={{ background: "none", border: "none", color: "#22304A", fontFamily: FONT.mono, fontSize: 11 }}>new PIN</button>
                          <button onClick={() => removeItem("students", st.id)} style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11 }}>remove</button>
                        </span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                        <span style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368" }}>
                          {st.id}{st.parentName ? " · guardian: " + st.parentName : ""}
                        </span>
                        <select value={st.classId} onChange={(e) => move(st, e.target.value)}
                          style={{ ...darkInput(), padding: "3px 7px", fontSize: 11.5, minWidth: 110 }}>
                          {roster.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ---------- Choose a grade before anything loads ----------
// Showing every class's results at once is unreadable on a phone and slow to
// scroll. Each grade is a card carrying just enough to decide which to open:
// how many pupils, and whether the results are still a draft.
function ClassPicker({ roster, onPick }) {
  const weights = roster.settings.weights || DEFAULT_WEIGHTS;

  const summarise = (classId) => {
    const terms = roster.marks?.[classId] || {};
    const keys = Object.keys(terms);
    if (!keys.length) return { status: "none", label: "no results yet" };
    // report on the most recently touched term
    const latest = keys[keys.length - 1];
    const st = statusOf(terms[latest]);
    return {
      status: st,
      label: { draft: "draft", submitted: "awaiting approval", approved: "published", returned: "returned to teacher" }[st] || st,
      term: latest.replace(/_/g, " "),
    };
  };

  const TONE = {
    none:      { bg: "#F5F1E6", fg: "#8A8368", edge: "#D8D2C2" },
    draft:     { bg: "#F5E8DC", fg: "#C98A2C", edge: "#E8CBA0" },
    submitted: { bg: "#E3E9F5", fg: "#3B5998", edge: "#BCCAE6" },
    approved:  { bg: "#E4F0E8", fg: "#3F7A5C", edge: "#B8D9C4" },
    returned:  { bg: "#F7E4E1", fg: "#B84C3E", edge: "#E8C4BD" },
  };

  if (roster.classes.length === 0) {
    return <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Add classes first.</div>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 9 }}>
      {roster.classes.map((c) => {
        const count = roster.students.filter((s) => s.classId === c.id).length;
        const sum = summarise(c.id);
        const tone = TONE[sum.status] || TONE.none;
        return (
          <button key={c.id} onClick={() => onPick(c.id)} style={{
            textAlign: "left", padding: "13px 14px", borderRadius: 6,
            background: "#fff", border: `1px solid #E4DFCF`,
            borderLeft: `4px solid ${tone.fg}`, display: "grid", gap: 5,
          }}>
            <span style={{ fontFamily: FONT.display, fontSize: 16, fontWeight: 700, color: "#22304A" }}>{c.name}</span>
            <span style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368" }}>
              {count} pupil{count === 1 ? "" : "s"}
            </span>
            <span style={{
              justifySelf: "start", fontFamily: FONT.mono, fontSize: 9.5, fontWeight: 700,
              background: tone.bg, color: tone.fg, border: `1px solid ${tone.edge}`,
              borderRadius: 10, padding: "2px 8px",
            }}>
              {sum.label.toUpperCase()}
            </span>
          </button>
        );
      })}
    </div>
  );
}


// ---------- A teacher's results, across every class they actually teach ----------
// Subject teachers commonly cover several classes. Rather than tying them to
// one, this lists whatever the timetable assigns them, plus their own class,
// and limits each to the learning areas they hold there.
function TeacherResults({ roster, saveRoster, teacher }) {
  const assignments = teachingAssignments(roster, teacher.id);
  const [picked, setPicked] = useState(assignments.length === 1 ? assignments[0].classId : "");

  const current = assignments.find((a) => a.classId === picked);

  if (assignments.length === 0) {
    return (
      <div>
        <SectionTitle>Exam results</SectionTitle>
        <div style={{ padding: "13px 15px", borderRadius: 5, background: "#F5E8DC", border: "1px solid #E8CBA0",
                      fontFamily: FONT.body, fontSize: 13, color: "#22304A", lineHeight: 1.6 }}>
          You have not been given any subjects yet, so there is nothing to enter.
          <div style={{ marginTop: 8 }}>
            Ask the administrator to either tap your subject chips under <strong>Teachers</strong>,
            or put you on the <strong>Timetable</strong> for the classes you teach. Both work —
            the timetable is what lets you teach more than one class.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionTitle>Exam results</SectionTitle>

      {!current && (
        <>
          <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
            You teach {assignments.length} class{assignments.length === 1 ? "" : "es"}. Choose one to enter results.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px,1fr))", gap: 9 }}>
            {assignments.map((a) => {
              const rec = getMarksFor(roster, a.classId, DEFAULT_TERM);
              const st = statusOf(rec);
              const tone = { draft: "#C98A2C", submitted: "#3B5998", approved: "#3F7A5C", returned: "#B84C3E" }[st] || "#8A8368";
              const count = roster.students.filter((s) => s.classId === a.classId).length;
              return (
                <button key={a.classId} onClick={() => setPicked(a.classId)} style={{
                  textAlign: "left", padding: "13px 14px", borderRadius: 6, background: "#fff",
                  border: "1px solid #E4DFCF", borderLeft: `4px solid ${tone}`, display: "grid", gap: 5,
                }}>
                  <span style={{ fontFamily: FONT.display, fontSize: 15.5, fontWeight: 700, color: "#22304A" }}>
                    {a.className}
                    {a.isHomeClass && <span style={{ fontFamily: FONT.mono, fontSize: 8.5, color: "#B8860B", marginLeft: 6 }}>MY CLASS</span>}
                  </span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 10, color: "#8A8368" }}>
                    {count} pupil{count === 1 ? "" : "s"} · {a.subjects.length} subject{a.subjects.length === 1 ? "" : "s"}
                  </span>
                  <span style={{ fontFamily: FONT.body, fontSize: 11, color: "#6B6552", lineHeight: 1.35 }}>
                    {a.subjects.join(", ")}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {current && (
        <>
          {assignments.length > 1 && (
            <button onClick={() => setPicked("")} style={{ ...backBtnStyle(), color: "#22304A", marginBottom: 12 }}>
              ← my classes
            </button>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6, flexWrap: "wrap" }}>
            <span style={{ fontFamily: FONT.display, fontSize: 17, fontWeight: 700, color: "#22304A" }}>{current.className}</span>
            {levelLabelForClass(roster, current.classId) && (
              <span style={{ fontFamily: FONT.mono, fontSize: 9.5, color: "#6B6552", background: "#F5F1E6",
                             border: "1px solid #E4DFCF", borderRadius: 10, padding: "2px 9px" }}>
                {levelLabelForClass(roster, current.classId)}
              </span>
            )}
          </div>
          <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", marginBottom: 12 }}>
            You may enter: {current.subjects.join(", ")}
          </div>

          <MarksEditor roster={roster} saveRoster={saveRoster} classId={current.classId}
            students={roster.students.filter((s) => s.classId === current.classId)}
            allowedSubjects={current.subjects}
            role="teacher" actorName={teacher.name} />
        </>
      )}
    </div>
  );
}

// ================= MARKS EDITOR (shared: admin + teacher) =================
function MarksEditor({ roster, saveRoster, classId, students, allowedSubjects, role = "admin", actorName = "" }) {
  const [term, setTerm] = useState(DEFAULT_TERM);
  const [entry, setEntry] = useState({ studentId: "", subject: "", assessment: "exam", score: "" });
  const [printing, setPrinting] = useState(false);
  const [openPupil, setOpenPupil] = useState(null);   // which pupil's breakdown is showing
  const record = getMarksFor(roster, classId, term);
  const { grid } = record;
  const status = statusOf(record);
  const locked = status === "submitted" || status === "approved";
  const weights = roster.settings.weights || DEFAULT_WEIGHTS;
  const passMark = roster.settings.passMark || 50;

  const writeRecord = (patch, msg) => {
    const next = setMarksFor(roster, classId, term, {
      ...record, grid, ...patch,
      approved: (patch.status || status) === "approved",
    });
    const who = role === "teacher" ? (actorName || "Teacher") : "Admin";
    const verb = { submitted: "sent for approval", approved: "APPROVED & published", returned: "returned to teacher", draft: "unpublished/withdrew" }[patch.status];
    const logged = verb ? logAction(next, who, `${classNameOf(roster, classId)} ${term} results ${verb}`) : next;
    return saveRoster(logged, msg);
  };

  const addMark = () => {
    if (locked) return;
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
    saveRoster(setMarksFor(roster, classId, term, { ...record, status: status === "returned" ? "draft" : status, grid: nextGrid, approved: false }), `${label} mark added`);
    setEntry({ ...entry, score: "" });
  };

  const removeComponent = (studentId, subject, key) => {
    if (locked) return;
    const existing = { ...normEntry(grid[studentId]?.[subject]) };
    delete existing[key];
    const subjects = { ...(grid[studentId] || {}) };
    if (Object.keys(existing).length === 0) delete subjects[subject];
    else subjects[subject] = existing;
    saveRoster(setMarksFor(roster, classId, term, { ...record, grid: { ...grid, [studentId]: subjects }, approved: false }), "Mark removed");
  };

  const submit = () => writeRecord({ status: "submitted", submittedBy: actorName, submittedAt: todayISO(), note: "" }, "Sent to admin for approval");
  const withdraw = () => writeRecord({ status: "draft" }, "Withdrawn — you can edit again");
  const approve = () => writeRecord({ status: "approved", approvedAt: todayISO(), note: "" }, `Approved & published for ${term}`);
  const unpublish = () => writeRecord({ status: "draft" }, "Unpublished");
  const returnToTeacher = () => {
    const note = window.prompt("Message to the teacher (optional):", "") || "";
    writeRecord({ status: "returned", note }, "Returned to teacher");
  };

  const ranked = classPositions(grid, students, roster.subjects, weights);

  if (printing) return <ClassMarksheetDoc roster={roster} classId={classId} term={term} onBack={() => setPrinting(false)} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
        <div style={{
          display: "inline-block", padding: "5px 12px", borderRadius: 12, fontFamily: FONT.mono, fontSize: 10.5, fontWeight: 700,
          background: MARK_STATUS[status].bg, color: MARK_STATUS[status].fg, border: `1px solid ${MARK_STATUS[status].border}`,
        }}>{MARK_STATUS[status].label}</div>
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Term" style={{ ...darkInput(), width: 120 }} />
      </div>

      <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", marginBottom: 10 }}>
        Final mark = CAT 1 ({weights.cat1}%) + CAT 2 ({weights.cat2}%) + Main Exam ({weights.exam}%). Weights are set in Settings.
        {levelLabelForClass(roster, classId) && (
          <div style={{ marginTop: 3 }}>
            Showing the learning areas for <strong>{levelLabelForClass(roster, classId)}</strong>.
          </div>
        )}
      </div>

      {record.note && status === "returned" && (
        <div style={{ padding: "9px 12px", borderRadius: 4, background: "#F7E4E1", border: "1px solid #E8C4BD", fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", marginBottom: 10 }}>
          <strong>Admin says:</strong> {record.note}
        </div>
      )}

      {locked && (
        <div style={{ padding: "9px 12px", borderRadius: 4, background: "#F5F1E6", border: "1px solid #E4DFCF", fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 10 }}>
          {status === "submitted"
            ? (role === "teacher"
                ? "Marks are locked while admin reviews them. Tap “Withdraw & edit” if you need to change something."
                : "Submitted by " + (record.submittedBy || "a teacher") + (record.submittedAt ? " on " + fmtDate(record.submittedAt) : "") + ". Review below, then approve or return.")
            : "Approved and published. " + (role === "admin" ? "Unpublish first if corrections are needed." : "Ask admin to unpublish if a correction is needed.")}
        </div>
      )}

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
            <button onClick={addMark} disabled={locked || !entry.studentId || !entry.subject || entry.score === ""} style={{ ...primaryBtn(), opacity: locked ? 0.45 : 1 }}>Add mark</button>
          </div>

          {ranked.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No marks entered for {term} yet.</div>}

          {ranked.length > 0 && (
            <div style={{ display: "grid", gap: 7 }}>
              {ranked.map((r) => (
                <div key={r.student.id} style={{ background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 5, padding: "11px 13px" }}>
                  {/* one line per pupil; tap to see the subject breakdown */}
                  <button onClick={() => setOpenPupil(openPupil === r.student.id ? null : r.student.id)}
                    style={{ width: "100%", background: "none", border: "none", padding: 0, textAlign: "left",
                             display: "flex", justifyContent: "space-between", alignItems: "baseline",
                             flexWrap: "wrap", gap: 8 }}>
                    <span style={{ fontFamily: FONT.body, fontSize: 14, fontWeight: 600, color: "#22304A" }}>
                      <span style={{ fontFamily: FONT.mono, color: "#8A8368", fontSize: 11.5, marginRight: 7 }}>#{r.position}</span>{r.student.name}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: FONT.mono, fontSize: 12.5, color: gradeInk(r.average) }}>
                        avg {r.average} · {gradeOf(r.average)}
                      </span>
                      <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368" }}>
                        {openPupil === r.student.id ? "▾" : "▸"}
                      </span>
                    </span>
                  </button>
                  <div style={{ display: openPupil === r.student.id ? "grid" : "none", gap: 4, marginTop: 8 }}>
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
            <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
              {role === "teacher" && status === "submitted" && (
                <button onClick={withdraw} style={{ ...primaryBtn(), background: "#C98A2C" }}>Withdraw &amp; edit</button>
              )}
              {role === "teacher" && (status === "draft" || status === "returned") && (
                <button onClick={submit} style={{ ...primaryBtn(), background: "#3B5998" }}>Send to admin for approval</button>
              )}
              {role === "admin" && status === "submitted" && (
                <>
                  <button onClick={approve} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Approve &amp; publish</button>
                  <button onClick={returnToTeacher} style={{ ...primaryBtn(), background: "#B84C3E" }}>Return to teacher</button>
                </>
              )}
              {role === "admin" && (status === "draft" || status === "returned") && (
                <button onClick={approve} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Approve &amp; publish</button>
              )}
              {role === "admin" && status === "approved" && (
                <button onClick={unpublish} style={{ ...primaryBtn(), background: "#B84C3E" }}>Unpublish</button>
              )}
              <button onClick={() => setPrinting(true)} style={{ ...primaryBtn(), background: "#22304A" }}>
                Print class marksheet
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ================= TEACHER =================
function TeacherView({ roster, saveRoster, teacherId, onExit, who }) {
  const teacher = roster.teachers.find((t) => t.id === teacherId);
  const [tab, setTab] = useState("attendance");

  // The school's data arrives after this screen mounts, so the check for
  // unread memos has to wait for it. Done once, so a teacher who deliberately
  // navigates away is not dragged back.
  const memoJumpDone = useRef(false);
  useEffect(() => {
    if (memoJumpDone.current || !teacherId || !roster.teachers.length) return;
    if (unreadMemos(roster, teacherId).length > 0) {
      memoJumpDone.current = true;
      setTab("memos");
    }
  }, [roster, teacherId]);
  const [menuOpen, setMenuOpen] = useState(false);
  // A staff login can exist without being linked to a teacher record — for
  // example if the record was deleted, or the account was created before the
  // teacher was added. Explain what to do rather than showing a dead end.
  if (!teacher) {
    return (
      <div>
        <PortalHeader title={SCHOOL_NAME.toUpperCase()} section="Not set up yet"
          onMenu={() => {}} onExit={onExit} />
        <div style={{ maxWidth: 560, margin: "0 auto", padding: "20px 14px 60px" }}>
          <div style={{ ...paperPanel(), padding: 22 }}>
            <SectionTitle>Your account isn't linked to a class yet</SectionTitle>
            <div style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", lineHeight: 1.6, marginBottom: 14 }}>
              You signed in successfully{who?.name ? ` as ${who.name}` : ""}, but the portal doesn't yet know
              which class you teach — so there is nothing to show you.
            </div>
            <div style={{ padding: "12px 14px", background: "#F5E8DC", border: "1px solid #E8CBA0",
                          borderRadius: 4, fontFamily: FONT.body, fontSize: 13, color: "#22304A", lineHeight: 1.6 }}>
              <strong>Ask the administrator to:</strong>
              <ol style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                <li>Open <strong>Teachers</strong> and add you, choosing your class and subjects.</li>
                <li>Open <strong>Staff logins</strong>, find <strong>{who?.username || "your username"}</strong>,
                    and set <em>“Link to teacher record”</em> to your name.</li>
              </ol>
            </div>
            <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", marginTop: 14 }}>
              Once that is done, sign out and back in and your class will appear.
            </div>
            <button onClick={onExit} style={{ ...primaryBtn(), marginTop: 16 }}>Sign out</button>
          </div>
        </div>
      </div>
    );
  }
  const classId = teacher.classId;
  const students = roster.students.filter((s) => s.classId === classId);
  const mySubjects = teacher.subjects?.length ? teacher.subjects : [];

  return (
    <div>
      <PortalHeader title={`${classNameOf(roster, classId).toUpperCase()} · ${teacher.name.toUpperCase()}`}
        section={{ memos: "Memos", leave: "Leave", signin: "Sign in", attendance: "Pupil attendance", results: "Exam results",
                   reportcards: "Report cards", timetable: "My timetable",
                   register: "Register a pupil", photos: "Pupil photos", examtt: "Exam timetable",
                   discipline: "Discipline report" }[tab] || tab}
        onMenu={() => setMenuOpen(true)} onExit={onExit} />
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} active={tab} onPick={setTab}
        heading={teacher.name} subheading={classNameOf(roster, classId)}
        groups={[
          { title: "DAILY", items: [
            { key: "memos", label: "Memos", icon: "subjects", badge: unreadMemos(roster, teacher.id).length },
            { key: "leave", label: "Apply for leave", icon: "duty" },
            { key: "signin", label: "Sign in (arrival)", icon: "duty" },
            { key: "attendance", label: "Pupil attendance", icon: "attendance" },
          ]},
          { title: "ACADEMICS", items: [
            { key: "results", label: "Exam results", icon: "marks" },
            { key: "reportcards", label: "Print report cards", icon: "reports" },
            { key: "timetable", label: "My timetable", icon: "timetable" },
            { key: "examtt", label: "Exam timetable", icon: "marks" },
          ]},
          { title: "MY CLASS", items: [
            { key: "register", label: "Register a pupil", icon: "students" },
            { key: "photos", label: "Pupil photos", icon: "logins" },
            { key: "discipline", label: "Discipline report", icon: "approvals" },
          ]},
        ]} />
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "14px 6px 60px" }}>
        {tab !== "memos" && unreadMemos(roster, teacher.id).length > 0 && (
          <button onClick={() => setTab("memos")} style={{
            width: "100%", textAlign: "left", padding: "11px 13px", marginBottom: 12,
            background: "#F5E8DC", border: "1px solid #E8CBA0", borderLeft: "4px solid #C98A2C",
            borderRadius: 5, fontFamily: FONT.body, fontSize: 13, color: "#22304A",
          }}>
            <strong>{unreadMemos(roster, teacher.id).length} unread memo{unreadMemos(roster, teacher.id).length === 1 ? "" : "s"}</strong> from the office — tap to read
          </button>
        )}
        <div style={{ ...paperPanel(), padding: 22 }} className="chalk-fade">
          {tab === "attendance" && (
            <GeoGate action="attendance" label="Marking the register">
              <TeacherAttendance roster={roster} saveRoster={saveRoster} classId={classId} students={students} />
            </GeoGate>
          )}
          {tab === "memos" && <MemoBoard roster={roster} saveRoster={saveRoster} who={who} teacherId={teacher.id} />}

          {tab === "leave" && <MyLeave who={who} roster={roster} />}

          {tab === "signin" && (
            <GeoGate action="signin" label="Signing in">
              <StaffCheckIn roster={roster} saveRoster={saveRoster} teacherId={teacher.id} teacherName={teacher.name} />
            </GeoGate>
          )}

          {tab === "register" && <TeacherAddStudent roster={roster} saveRoster={saveRoster} classId={classId} actorName={teacher.name} />}

          {tab === "photos" && <PhotoManager roster={roster} classId={classId} />}

          {tab === "discipline" && <DisciplineReport roster={roster} saveRoster={saveRoster} classId={classId} actorName={teacher.name} role="teacher" />}

          {tab === "reportcards" && <TeacherReportCards roster={roster} classId={classId} teacher={teacher} />}

          {tab === "timetable" && <MyTimetable roster={roster} teacher={teacher} />}

          {tab === "examtt" && <ExamTimetable roster={roster} saveRoster={saveRoster} readOnly />}

          {tab === "results" && (
            <TeacherResults roster={roster} saveRoster={saveRoster} teacher={teacher} />
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
// Parents only ever receive their own child's payload from the database,
// so this view never has access to the rest of the school.
function ParentView({ payload, onExit }) {
  const [term, setTerm] = useState(DEFAULT_TERM);
  const [printDoc, setPrintDoc] = useState(null);
  if (!payload) return <div style={{ color: "#F5F3EE", padding: 30 }}>Session ended. <button onClick={onExit} style={backBtnStyle()}>go back</button></div>;

  const student = payload.student;
  const settings = payload.settings || {};
  const cur = settings.currency || "KSh";
  const passMark = settings.passMark || 50;
  const weights = settings.weights || DEFAULT_WEIGHTS;
  const subjects = payload.subjects || [];

  // shim so the shared print components can be reused unchanged
  const roster = {
    classes: [{ id: payload.classId, name: payload.className }],
    students: (payload.classmates || []).map((c) => ({ id: c.id, classId: payload.classId })),
    subjects,
    settings: { currency: cur, passMark, weights, periods: settings.periods || DEFAULT_PERIODS },
    timetable: { [payload.classId]: payload.timetable || {} },
    teachers: [],
  };

  const rec = (payload.marks || {})[termKey(term)];
  const approved = !!rec;
  const grid = rec?.grid || {};
  const termMarks = approved ? (grid[student.id] || {}) : {};
  const ranked = approved ? classPositions(grid, roster.students, subjects, weights) : [];
  const rank = approved ? positionOf(ranked, student.id) : null;
  const avg = rank ? rank.average : null;

  const classLog = payload.attendance || {};
  const log = [...Array(30)].map((_, i2) => {
    const d = new Date(); d.setDate(d.getDate() - i2);
    const iso = d.toISOString().slice(0, 10);
    return { d: iso, status: classLog[iso]?.[student.id] };
  }).filter((r) => r.status);
  const presentDays = log.filter((r) => r.status === "present" || r.status === "late").length;
  const rate = log.length ? Math.round((presentDays / log.length) * 100) : null;
  const due = student.feeDue || 0, paid = student.feePaid || 0, balance = due - paid;

  if (printDoc === "timetable") return <TimetableDoc roster={roster} classId={payload.classId} onBack={() => setPrintDoc(null)} />;
  if (printDoc === "examtt") {
    const lvl = levelOfClassName(payload.className);
    const shim = { ...roster, examTimetable: { [lvl]: payload.examTimetable } };
    return <ExamTimetableDoc roster={shim} level={lvl} onBack={() => setPrintDoc(null)} />;
  }
  if (printDoc === "invoice") return <InvoiceDoc roster={roster} student={student} onBack={() => setPrintDoc(null)} />;
  if (printDoc === "statement") return <FeeStatement roster={roster} student={student} term={DEFAULT_TERM} onBack={() => setPrintDoc(null)} />;
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
              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552" }}>{payload.className}{student.parentName ? ` · Guardian: ${student.parentName}` : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <StatCard label="Attendance" value={rate === null ? "—" : `${rate}%`} />
              <StatCard label="Fee balance" value={`${cur}${money(balance)}`} tone={balance > 0 ? "#B84C3E" : "#3F7A5C"} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
            <button onClick={() => setPrintDoc("invoice")} style={primaryBtn()}>Fee invoice</button>
            <button onClick={() => setPrintDoc("statement")} style={{ ...primaryBtn(), background: "#22304A" }}>Fee statement</button>
            <button onClick={() => setPrintDoc("timetable")} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Class timetable</button>
            {payload.examTimetable?.papers?.length > 0 && (
              <button onClick={() => setPrintDoc("examtt")} style={{ ...primaryBtn(), background: "#22304A" }}>Exam timetable</button>
            )}
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
                  <StatCard label="Performance level" value={avg === null ? "—" : `L${gradeLevel(avg)} ${gradeOf(avg)}`} tone={gradeInk(avg)} />
                </div>
              )}
              <div style={{ overflowX: "auto", marginBottom: 10 }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320 }}>
                  <thead>
                    <tr>{["Subject", "CAT 1", "CAT 2", "Exam", "Final", "Gr"].map((h, k) => (
                      <th key={k} style={{ borderBottom: "1px solid #E4DFCF", padding: "6px 7px", textAlign: k === 0 ? "left" : "right", fontFamily: FONT.mono, fontSize: 9, textTransform: "uppercase", color: "#8A8368" }}>{h}</th>
                    ))}</tr>
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
                  Average <strong>{avg}/100</strong> — <strong style={{ color: gradeInk(avg) }}>Level {gradeLevel(avg)}: {gradeLabel(avg)}</strong>
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


// ---------- Admin: results waiting for approval ----------
function Approvals({ roster, saveRoster }) {
  const weights = roster.settings.weights || DEFAULT_WEIGHTS;
  const pending = [];
  Object.entries(roster.marks || {}).forEach(([classId, terms]) => {
    Object.entries(terms || {}).forEach(([tKey, rec]) => {
      if (statusOf(rec) === "submitted") pending.push({ classId, tKey, rec });
    });
  });

  const act = (classId, tKey, rec, status, msg, note) => {
    const marks = { ...roster.marks, [classId]: { ...roster.marks[classId], [tKey]: {
      ...rec, status, note: note ?? "", approved: status === "approved",
      approvedAt: status === "approved" ? todayISO() : rec.approvedAt } } };
    saveRoster(logAction({ ...roster, marks }, "Admin",
      `${classNameOf(roster, classId)} ${tKey.replace(/_/g, " ")} results ${status === "approved" ? "APPROVED & published" : "returned to teacher"}`), msg);
  };

  return (
    <div>
      <SectionTitle>Approvals</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14 }}>
        Results a teacher has sent for approval. Nothing reaches students or parents until you approve it.
      </div>

      {pending.length === 0 && (
        <div style={{ padding: "14px 15px", borderRadius: 5, background: "#F5F1E6", border: "1px solid #E4DFCF", fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>
          Nothing waiting for approval right now.
        </div>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {pending.map(({ classId, tKey, rec }) => {
          const studentsIn = roster.students.filter((s) => s.classId === classId);
          const ranked = classPositions(rec.grid || {}, studentsIn, roster.subjects, weights);
          return (
            <div key={classId + tKey} style={{ background: "#F5F1E6", border: "1px solid #BCCAE6", borderLeft: "4px solid #3B5998", borderRadius: 5, padding: "12px 14px" }}>
              <div style={{ fontFamily: FONT.display, fontSize: 15.5, fontWeight: 600, color: "#22304A" }}>
                {classNameOf(roster, classId)} — {tKey.replace(/_/g, " ")}
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 11, color: "#6B6552", marginTop: 3 }}>
                Sent by {rec.submittedBy || "a teacher"}{rec.submittedAt ? " · " + fmtDate(rec.submittedAt) : ""} · {ranked.length} student{ranked.length === 1 ? "" : "s"} with results
              </div>

              {ranked.length > 0 && (
                <div style={{ display: "grid", gap: 3, margin: "9px 0 11px" }}>
                  {ranked.slice(0, 5).map((r) => (
                    <div key={r.student.id} style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT.body, fontSize: 12.5, color: "#22304A" }}>
                      <span><span style={{ fontFamily: FONT.mono, color: "#8A8368", marginRight: 6 }}>#{r.position}</span>{r.student.name}</span>
                      <span style={{ fontFamily: FONT.mono, fontWeight: 700, color: gradeInk(r.average) }}>{r.average} {gradeOf(r.average)}</span>
                    </div>
                  ))}
                  {ranked.length > 5 && <div style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368" }}>…and {ranked.length - 5} more</div>}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => act(classId, tKey, rec, "approved", "Approved & published")} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Approve &amp; publish</button>
                <button onClick={() => {
                  const note = window.prompt("Message to the teacher (optional):", "") || "";
                  act(classId, tKey, rec, "returned", "Returned to teacher", note);
                }} style={{ ...primaryBtn(), background: "#B84C3E" }}>Return to teacher</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Backup / restore ----------
function AdminBackup({ roster, saveRoster, syncState, onForceSave }) {
  const [restoreText, setRestoreText] = useState("");
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(roster, null, 2);

  const copy = async () => {
    try { await navigator.clipboard.writeText(json); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    catch (e) { setCopied(false); }
  };

  const restore = () => {
    let parsed;
    try { parsed = JSON.parse(restoreText); }
    catch (e) { alert("That doesn't look like a valid backup."); return; }
    if (!parsed || !Array.isArray(parsed.students)) { alert("That backup is missing student data — not restoring."); return; }
    if (!confirm("Replace ALL current data with this backup? This cannot be undone.")) return;
    saveRoster({ ...EMPTY_ROSTER, ...parsed, settings: { ...EMPTY_ROSTER.settings, ...(parsed.settings || {}) } }, "Backup restored");
    setRestoreText("");
  };

  const stateText = {
    saved: "All changes are saved to the server.",
    pending: "Saving your latest changes…",
    saving: "Saving your latest changes…",
    error: "The server isn't accepting saves right now. Your work is safe on this screen — copy the backup below.",
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
          : "This device only: no shared database is connected yet."}
      </div>

      <div style={{
        padding: "12px 14px", borderRadius: 4, marginBottom: 18,
        background: syncState === "error" ? "#F7E4E1" : "#E4F0E8",
        border: `1px solid ${syncState === "error" ? "#E8C4BD" : "#B8D9C4"}`,
        fontFamily: FONT.body, fontSize: 13, color: "#22304A",
      }}>
        {stateText}
        {syncState === "error" && (
          <div style={{ marginTop: 10 }}><button onClick={onForceSave} style={primaryBtn()}>Try saving again now</button></div>
        )}
      </div>

      <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552", marginBottom: 8 }}>
        Copy this somewhere safe. It contains every class, teacher, student, mark and payment.
      </div>
      <textarea readOnly value={json} onFocus={(e) => e.target.select()} style={{
        width: "100%", height: 120, fontFamily: FONT.mono, fontSize: 11, padding: 10,
        border: "1px solid #D8D2C2", borderRadius: 3, background: "#F5F1E6", color: "#22304A", resize: "vertical",
      }} />
      <button onClick={copy} style={{ ...primaryBtn(), marginTop: 8, marginBottom: 26 }}>{copied ? "✓ Copied" : "Copy backup"}</button>

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#B84C3E", marginBottom: 6 }}>Restore from a backup</div>
      <textarea value={restoreText} onChange={(e) => setRestoreText(e.target.value)} placeholder="Paste backup text here…" style={{
        width: "100%", height: 90, fontFamily: FONT.mono, fontSize: 11, padding: 10,
        border: "1px solid #D8D2C2", borderRadius: 3, background: "#fff", color: "#22304A", resize: "vertical",
      }} />
      <button onClick={restore} disabled={!restoreText.trim()} style={{ ...primaryBtn(), background: "#B84C3E", marginTop: 8, opacity: restoreText.trim() ? 1 : 0.5 }}>Restore this backup</button>
    </div>
  );
}

// ---------- Admin: staff logins (real accounts, hashed passwords) ----------
function StaffAccounts({ roster, who }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({ username: "", name: "", role: "teacher", password: "", teacherId: "", email: "", phone: "" });
  const [pw, setPw] = useState({ old: "", next: "" });

  const refresh = async () => {
    try { setRows(await staffList()); setErr(""); }
    catch (e) { setErr("Could not load staff accounts."); setRows([]); }
  };
  useEffect(() => { refresh(); }, []);

  const save = async () => {
    if (!form.username.trim() || !form.name.trim()) return setErr("Username and name are required.");
    try {
      await staffUpsert(form.username.trim(), form.name.trim(), form.role, form.password.trim() || null, form.teacherId || null);
      if (form.email.trim() || form.phone.trim()) {
        await staffSetContact(form.username.trim(), form.email.trim(), form.phone.trim());
      }
      setMsg(`Saved ${form.username.trim()}${form.password ? " — password set" : ""}`);
      setForm({ username: "", name: "", role: "teacher", password: "", teacherId: "", email: "", phone: "" });
      setErr(""); refresh();
      setTimeout(() => setMsg(""), 4000);
    } catch (e) { setErr(String(e.message || e).slice(0, 160)); }
  };

  // Only the password changes here. It used to go through staffUpsert, which
  // also wrote the role — quietly turning administrators into teachers.
  const resetPassword = async (username) => {
    const np = String(Math.floor(100000 + Math.random() * 900000));
    try {
      await staffResetPassword(username, np);
      setMsg(`${username}'s new password: ${np} — write this down, it is not shown again.`);
      setErr("");
      refresh();
    } catch (e) { setErr(String(e.message || e).slice(0, 160)); }
  };

  const deactivate = async (username) => {
    if (!window.confirm(`Disable the login for ${username}? They will be signed out everywhere.`)) return;
    try { await staffDeactivate(username); refresh(); } catch (e) { setErr(String(e.message || e).slice(0, 160)); }
  };

  const changeMine = async () => {
    if (!pw.old || !pw.next) return setErr("Enter your current and new password.");
    try {
      const ok = await changeMyPassword(pw.old, pw.next);
      setMsg(ok ? "Your password has been changed." : "Current password was wrong.");
      setErr(""); setPw({ old: "", next: "" });
    } catch (e) { setErr(String(e.message || e).slice(0, 160)); }
  };

  return (
    <div>
      <SectionTitle>Staff logins</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14 }}>
        Real accounts with encrypted passwords. Passwords are never stored in readable form —
        if one is forgotten it can only be replaced, not looked up.
        <div style={{ marginTop: 6 }}>
          Tap a name below to load that account into the form. Take care with the
          <strong> role</strong> — saving with the wrong one changes what that person can do.
        </div>
      </div>

      {msg && <div style={{ padding: "9px 12px", borderRadius: 4, background: "#E4F0E8", border: "1px solid #B8D9C4", fontFamily: FONT.mono, fontSize: 12.5, color: "#22304A", marginBottom: 12 }}>{msg}</div>}
      {err && <div style={{ padding: "9px 12px", borderRadius: 4, background: "#F7E4E1", border: "1px solid #E8C4BD", fontFamily: FONT.body, fontSize: 12.5, color: "#B84C3E", marginBottom: 12 }}>{err}</div>}

      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="Username" autoCapitalize="none" style={{ ...darkInput(), flex: 1, minWidth: 130 }} />
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name" style={{ ...darkInput(), flex: 1, minWidth: 130 }} />
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
          style={{ ...darkInput(), minWidth: 110,
                   borderColor: form.role === "admin" ? "#B8860B" : "#D8D2C2",
                   color: form.role === "admin" ? "#B8860B" : "#22304A", fontWeight: 600 }}>
          <option value="teacher">Teacher</option>
          <option value="admin">Administrator</option>
        </select>
        <select value={form.teacherId} onChange={(e) => setForm({ ...form, teacherId: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 130 }}>
          <option value="">Link to teacher record…</option>
          {roster.teachers.map((t) => <option key={t.id} value={t.id}>{t.name} · {classNameOf(roster, t.classId)}</option>)}
        </select>
        <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Password" style={{ ...darkInput(), flex: 1, minWidth: 120 }} />
        <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email (for password reset)" inputMode="email" autoCapitalize="none" style={{ ...darkInput(), flex: 1, minWidth: 160 }} />
        <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone (e.g. 0722 000000)" inputMode="tel" style={{ ...darkInput(), flex: 1, minWidth: 140 }} />
        <button onClick={save} style={primaryBtn()}>Save account</button>
      </div>

      {rows === null && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Loading…</div>}
      <div style={{ display: "grid", gap: 6, marginBottom: 24 }}>
        {(rows || []).map((r) => (
          <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 4, opacity: r.active ? 1 : 0.5 }}>
            <span>
              <button onClick={() => setForm({ username: r.username, name: r.name, role: r.role,
                        password: "", teacherId: r.teacher_id || "", email: r.email || "", phone: r.phone || "" })}
                style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer" }}>
                <span style={{ fontFamily: FONT.body, fontSize: 13.5, fontWeight: 600, color: "#22304A", textDecoration: "underline" }}>{r.name}</span>
              </button>
              <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368", marginLeft: 8 }}>{r.username}</span>
              <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: r.role === "admin" ? "#B8860B" : "#6B6552", marginTop: 2 }}>
                {r.role === "admin" ? "ADMINISTRATOR" : "TEACHER"}{!r.active ? " · DISABLED" : ""}
                {r.email ? " · " + r.email : " · no email (cannot self-reset)"}
                {r.phone ? " · " + r.phone : ""}
              </div>
            </span>
            <span style={{ display: "flex", gap: 12 }}>
              <button onClick={() => resetPassword(r.username)} style={{ background: "none", border: "none", color: "#22304A", fontFamily: FONT.mono, fontSize: 11.5 }}>new password</button>
              {r.username !== who?.username && (
                <button onClick={() => deactivate(r.username)} style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11.5 }}>disable</button>
              )}
            </span>
          </div>
        ))}
      </div>

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>Change my own password</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input type="password" value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} placeholder="Current password" style={{ ...darkInput(), flex: 1, minWidth: 140 }} />
        <input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} placeholder="New password" style={{ ...darkInput(), flex: 1, minWidth: 140 }} />
        <button onClick={changeMine} style={primaryBtn()}>Change</button>
      </div>
    </div>
  );
}

// ---------- Admin: end of year — promote, archive, audit trail ----------
function YearEnd({ roster, saveRoster }) {
  const [view, setView] = useState("promote");
  const [map, setMap] = useState({}); // classId -> destination classId | "graduate" | ""
  const year = new Date().getFullYear();

  const promote = () => {
    const moves = Object.entries(map).filter(([, dest]) => dest);
    if (moves.length === 0) return;
    const graduating = roster.students.filter((s) => map[s.classId] === "graduate").length;
    const moving = roster.students.filter((s) => map[s.classId] && map[s.classId] !== "graduate").length;
    if (!window.confirm(`Promote ${moving} student(s) and graduate ${graduating}? Marks and attendance stay archived against the old year.`)) return;

    const students = roster.students
      .filter((s) => map[s.classId] !== "graduate")
      .map((s) => (map[s.classId] ? { ...s, classId: map[s.classId] } : s));
    const graduates = roster.students.filter((s) => map[s.classId] === "graduate")
      .map((s) => ({ ...s, graduatedYear: year }));

    const next = {
      ...roster,
      students,
      alumni: [...(roster.alumni || []), ...graduates],
    };
    saveRoster(logAction(next, "Admin", `Promoted ${moving}, graduated ${graduating} (${year})`), "Students promoted");
    setMap({});
  };

  const archiveYear = () => {
    if (!window.confirm(`Archive ${year}? A full copy is stored, then marks, attendance and duty are cleared so you can start a fresh year. Students, staff and classes stay.`)) return;
    const snapshot = { marks: roster.marks, attendance: roster.attendance, staffAttendance: roster.staffAttendance, duty: roster.duty, students: roster.students };
    const next = {
      ...roster,
      archives: [...(roster.archives || []), { year, savedAt: new Date().toISOString(), snapshot }],
      marks: {}, attendance: {}, staffAttendance: {}, duty: [],
      students: roster.students.map((s) => ({ ...s, feePaid: 0, payments: [] })),
    };
    saveRoster(logAction(next, "Admin", `Archived school year ${year}`), `${year} archived`);
  };

  const restore = (a) => {
    if (!window.confirm(`Restore the ${a.year} archive? This replaces current marks, attendance and fees.`)) return;
    const next = { ...roster, ...a.snapshot };
    saveRoster(logAction(next, "Admin", `Restored archive ${a.year}`), `${a.year} restored`);
  };

  return (
    <div>
      <SectionTitle>End of year</SectionTitle>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {[["promote", "Promote students"], ["archive", "Archive year"], ["audit", "Activity log"]].map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: "6px 13px", borderRadius: 3, fontFamily: FONT.body, fontSize: 12.5, fontWeight: 600,
            border: `1px solid ${view === v ? "#22304A" : "#D8D2C2"}`, background: view === v ? "#22304A" : "#fff", color: view === v ? "#fff" : "#6B6552",
          }}>{label}</button>
        ))}
      </div>

      {view === "promote" && (
        <div>
          <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
            Choose where each class moves to at the end of the year. Leave blank to keep a class where it is.
          </div>
          {roster.classes.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No classes yet.</div>}
          <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
            {roster.classes.map((c) => {
              const count = roster.students.filter((s) => s.classId === c.id).length;
              return (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 4 }}>
                  <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", minWidth: 110 }}>
                    {c.name} <span style={{ color: "#8A8368", fontSize: 12 }}>({count})</span>
                  </span>
                  <span style={{ fontFamily: FONT.mono, color: "#8A8368" }}>→</span>
                  <select value={map[c.id] || ""} onChange={(e) => setMap({ ...map, [c.id]: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 130 }}>
                    <option value="">stays in {c.name}</option>
                    {roster.classes.filter((x) => x.id !== c.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    <option value="graduate">graduate / leave school</option>
                  </select>
                </div>
              );
            })}
          </div>
          <button onClick={promote} disabled={Object.values(map).filter(Boolean).length === 0} style={{ ...primaryBtn(), opacity: Object.values(map).filter(Boolean).length ? 1 : 0.5 }}>Promote students</button>
          {(roster.alumni || []).length > 0 && (
            <div style={{ marginTop: 18, fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552" }}>
              {(roster.alumni || []).length} former student{(roster.alumni || []).length === 1 ? "" : "s"} on record.
            </div>
          )}
        </div>
      )}

      {view === "archive" && (
        <div>
          <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
            Archiving stores a full copy of {year}, then clears marks, attendance, duty and fee payments so the new year starts clean. Students, staff and classes are kept. Take a Backup copy first as well.
          </div>
          <button onClick={archiveYear} style={{ ...primaryBtn(), background: "#B84C3E", marginBottom: 18 }}>Archive {year} and start fresh</button>

          <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>Archived years</div>
          {(roster.archives || []).length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>None yet.</div>}
          <div style={{ display: "grid", gap: 6 }}>
            {(roster.archives || []).slice().reverse().map((a) => (
              <div key={a.year + a.savedAt} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 3, flexWrap: "wrap", gap: 8 }}>
                <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>
                  {a.year} <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368" }}>· saved {fmtDate(a.savedAt.slice(0, 10))}</span>
                </span>
                <button onClick={() => restore(a)} style={{ background: "none", border: "none", color: "#22304A", fontFamily: FONT.mono, fontSize: 11.5 }}>restore</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "audit" && (
        <div>
          <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
            Recent changes to results, fees and records — useful if a mark or payment is ever queried.
          </div>
          {(roster.audit || []).length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Nothing logged yet.</div>}
          <div style={{ display: "grid", gap: 4 }}>
            {(roster.audit || []).slice(0, 120).map((a, i) => (
              <div key={i} style={{ display: "flex", gap: 10, padding: "7px 11px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 3, flexWrap: "wrap" }}>
                <span style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368", minWidth: 128 }}>
                  {new Date(a.ts).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                <span style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", flex: 1 }}>{a.action}</span>
                <span style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#6B6552" }}>{a.actor}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ================= TIMETABLE =================
function TimetableAdmin({ roster, saveRoster }) {
  const [classId, setClassId] = useState("");
  const [entry, setEntry] = useState({ day: "Mon", periodId: "", subject: "", teacherId: "" });
  const [clashMsg, setClashMsg] = useState("");
  const [showPeriods, setShowPeriods] = useState(false);
  const [printing, setPrinting] = useState(false);
  const periods = roster.settings.periods || DEFAULT_PERIODS;
  const tt = getTimetable(roster, classId);

  const addLesson = () => {
    if (!classId || !entry.periodId || !entry.subject) return;

    // Refuse to put a teacher in two rooms at the same time.
    const clash = teacherClashAt(roster, entry.day, entry.periodId, entry.teacherId, classId);
    if (clash) {
      const who = roster.teachers.find((t) => t.id === entry.teacherId)?.name || "That teacher";
      const per = periods.find((x) => x.id === entry.periodId);
      setClashMsg(`${who} already teaches ${clash.subject} to ${classNameOf(roster, clash.classId)} `
        + `on ${entry.day} at ${per?.time || "that period"}. Choose a different teacher or period.`);
      return;
    }
    setClashMsg("");
    saveRoster(setLessonIn(roster, classId, entry.day, entry.periodId, { subject: entry.subject, teacherId: entry.teacherId || "" }), "Lesson added");
    setEntry({ ...entry, subject: "", teacherId: "" });
  };
  const removeLesson = (day, periodId) => saveRoster(setLessonIn(roster, classId, day, periodId, null), "Lesson removed");

  const updatePeriod = (id, field, value) => {
    saveRoster({ ...roster, settings: { ...roster.settings, periods: periods.map((p) => p.id === id ? { ...p, [field]: value } : p) } });
  };
  const addPeriod = (type = "lesson") => {
    const lessons = periods.filter(isLessonPeriod).length;
    const label = type === "lesson" ? String(lessons + 1) : (type === "lunch" ? "Lunch" : "Break");
    saveRoster({ ...roster, settings: { ...roster.settings,
      periods: [...periods, { id: type[0] + Date.now(), label, time: "", type }] } }, `${PERIOD_TYPES[type].label} added`);
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
              {periods.filter(isLessonPeriod).map((p) => <option key={p.id} value={p.id}>Period {p.label}{p.time ? ` (${p.time})` : ""}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <select value={entry.subject} onChange={(e) => setEntry({ ...entry, subject: e.target.value })} style={{ ...darkInput(), flex: 1, minWidth: 120 }}>
              <option value="">Subject…</option>
              {subjectsForClass(roster, classId).map((sub) => <option key={sub} value={sub}>{sub}</option>)}
            </select>
            <select value={entry.teacherId} onChange={(e) => { setEntry({ ...entry, teacherId: e.target.value }); setClashMsg(""); }}
              style={{ ...darkInput(), flex: 1, minWidth: 120 }}>
              <option value="">Teacher (optional)…</option>
              {roster.teachers.map((t) => {
                // say who is already busy before the choice is made
                const busy = entry.periodId
                  ? teacherClashAt(roster, entry.day, entry.periodId, t.id, classId) : null;
                return (
                  <option key={t.id} value={t.id} disabled={!!busy}>
                    {t.name}{busy ? ` — busy with ${classNameOf(roster, busy.classId)}` : ""}
                  </option>
                );
              })}
            </select>
            <button onClick={addLesson} disabled={!entry.periodId || !entry.subject} style={primaryBtn()}>Add lesson</button>
          </div>

          {clashMsg && (
            <div className="enter" style={{ padding: "10px 13px", borderRadius: 4, marginBottom: 14,
                  background: "#F7E4E1", border: "1px solid #E8C4BD", borderLeft: "4px solid #B84C3E",
                  fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", lineHeight: 1.55 }}>
              <strong style={{ color: "#B84C3E" }}>Clash.</strong> {clashMsg}
            </div>
          )}

          <ClashReport roster={roster} periods={periods} />

          <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
            {DAYS.map((day) => {
              // keep breaks in the list so the day reads in real order
              const lessons = periods
                .map((p) => ({ p, l: tt[day]?.[p.id] }))
                .filter((x) => x.l || !isLessonPeriod(x.p));
              return (
                <div key={day} style={{ background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 5, padding: "10px 12px" }}>
                  <div style={{ fontFamily: FONT.display, fontSize: 14.5, fontWeight: 600, color: "#22304A", marginBottom: 6 }}>{DAY_FULL[day]}</div>
                  {lessons.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#8A8368" }}>No lessons set.</div>}
                  <div style={{ display: "grid", gap: 4 }}>
                    {lessons.map(({ p, l }) => (
                      isLessonPeriod(p) ? (
                        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontFamily: FONT.body, color: "#22304A" }}>
                          <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368", minWidth: 92 }}>P{p.label} {p.time}</span>
                          <span style={{ fontWeight: 600 }}>{l.subject}</span>
                          <span style={{ color: "#6B6552", fontSize: 12 }}>{l.teacherId ? roster.teachers.find((t) => t.id === l.teacherId)?.name || "" : ""}</span>
                          <button onClick={() => removeLesson(day, p.id)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11 }}>remove</button>
                        </div>
                      ) : (
                        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12,
                              fontFamily: FONT.body, padding: "3px 7px", borderRadius: 3,
                              background: PERIOD_TYPES[p.type].band, color: PERIOD_TYPES[p.type].fg }}>
                          <span style={{ fontFamily: FONT.mono, fontSize: 10.5, minWidth: 92 }}>{p.time}</span>
                          <span style={{ fontWeight: 600 }}>{p.label}</span>
                        </div>
                      )
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
                {periods.map((p) => {
                  const type = p.type || "lesson";
                  return (
                    <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
                          padding: type === "lesson" ? 0 : "5px 7px", borderRadius: 3,
                          background: type === "lesson" ? "transparent" : PERIOD_TYPES[type].band }}>
                      <select value={type} onChange={(e) => updatePeriod(p.id, "type", e.target.value)}
                        style={{ ...darkInput(), width: 96, padding: "6px 6px", fontSize: 12 }}>
                        <option value="lesson">Lesson</option>
                        <option value="break">Break</option>
                        <option value="lunch">Lunch</option>
                      </select>
                      <input value={p.label} onChange={(e) => updatePeriod(p.id, "label", e.target.value)}
                        placeholder={type === "lesson" ? "1" : "Short break"}
                        style={{ ...darkInput(), width: type === "lesson" ? 60 : 120, padding: "6px 8px" }} />
                      <input value={p.time} onChange={(e) => updatePeriod(p.id, "time", e.target.value)}
                        placeholder="8:00–8:40" style={{ ...darkInput(), flex: 1, minWidth: 110, padding: "6px 8px" }} />
                      <button onClick={() => removePeriod(p.id)} style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11.5 }}>remove</button>
                    </div>
                  );
                })}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => addPeriod("lesson")} style={primaryBtn()}>Add lesson</button>
                  <button onClick={() => addPeriod("break")} style={{ ...primaryBtn(), background: "#C98A2C" }}>Add break</button>
                  <button onClick={() => addPeriod("lunch")} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Add lunch</button>
                </div>
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
          {periods.map((p) => {
            // A break runs across the whole week, so it prints as one band
            // rather than five identical cells.
            if (!isLessonPeriod(p)) {
              const tone = PERIOD_TYPES[p.type] || PERIOD_TYPES.break;
              return (
                <tr key={p.id}>
                  <td style={{ ...docTd, fontFamily: FONT.mono, fontSize: 10, whiteSpace: "nowrap",
                               background: tone.band, color: tone.fg }}>
                    {p.time}
                  </td>
                  <td colSpan={DAYS.length} style={{ ...docTd, textAlign: "center", fontSize: 11,
                        fontWeight: "bold", letterSpacing: 1.5, textTransform: "uppercase",
                        background: tone.band, color: tone.fg }}>
                    {p.label}
                  </td>
                </tr>
              );
            }
            return (
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
            );
          })}
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

  // slot the breaks back in, so the day reads as it is actually lived
  const withBreaks = (day) => {
    const mine = rows[day];
    if (!mine.length) return [];
    const first = periods.findIndex((x) => x.id === mine[0].p.id);
    const last = periods.findIndex((x) => x.id === mine[mine.length - 1].p.id);
    return periods.slice(first, last + 1)
      .map((p) => isLessonPeriod(p) ? mine.find((r) => r.p.id === p.id) : { p, isBreak: true })
      .filter(Boolean);
  };

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
              {withBreaks(day).map((r, i) => r.isBreak ? (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12,
                      fontFamily: FONT.body, padding: "3px 7px", borderRadius: 3,
                      background: PERIOD_TYPES[r.p.type].band, color: PERIOD_TYPES[r.p.type].fg }}>
                  <span style={{ fontFamily: FONT.mono, fontSize: 10.5, minWidth: 92 }}>{r.p.time}</span>
                  <span style={{ fontWeight: 600 }}>{r.p.label}</span>
                </div>
              ) : (
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


// ---------- Teacher: register a pupil into their own class ----------
function TeacherAddStudent({ roster, saveRoster, classId, actorName }) {
  const [form, setForm] = useState({ name: "", parentName: "", feeDue: "" });
  const [msg, setMsg] = useState("");
  const mine = roster.students.filter((s) => s.classId === classId);

  const add = () => {
    if (!form.name.trim()) return;
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const s = {
      id: nextAdmissionNo(roster.students), name: form.name.trim(), classId,
      parentName: form.parentName.trim(), feeDue: Number(form.feeDue) || 0,
      feePaid: 0, payments: [], pin,
    };
    const next = logAction({ ...roster, students: [...roster.students, s] },
      actorName || "Teacher", `Registered pupil ${s.name} (${s.id})`);
    saveRoster(next, `${s.name} added — Adm ${s.id}, PIN ${pin}`);
    setMsg(`${s.name} registered. Admission No: ${s.id} · PIN: ${pin} — write these down for the parent.`);
    setForm({ name: "", parentName: "", feeDue: "" });
  };

  return (
    <div>
      <SectionTitle>Register a pupil</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
        New pupils are added straight into <strong>{classNameOf(roster, classId)}</strong>.
        An admission number and parent PIN are generated automatically.
      </div>

      {msg && (
        <div style={{ padding: "10px 12px", borderRadius: 4, background: "#E4F0E8", border: "1px solid #B8D9C4",
                      fontFamily: FONT.mono, fontSize: 12.5, color: "#22304A", marginBottom: 12 }}>{msg}</div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Pupil's full name" style={{ ...darkInput(), flex: 1, minWidth: 160 }} />
        <input value={form.parentName} onChange={(e) => setForm({ ...form, parentName: e.target.value })}
          placeholder="Parent / guardian" style={{ ...darkInput(), flex: 1, minWidth: 140 }} />
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        <input value={form.feeDue} onChange={(e) => setForm({ ...form, feeDue: e.target.value })}
          placeholder="Term fee due" type="number" style={{ ...darkInput(), width: 130 }} />
        <button onClick={add} disabled={!form.name.trim()} style={primaryBtn()}>Register pupil</button>
      </div>

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>
        Pupils in this class ({mine.length})
      </div>
      {mine.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>None yet.</div>}
      <div style={{ display: "grid", gap: 5 }}>
        {mine.map((s) => (
          <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                                    padding: "8px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF",
                                    borderRadius: 3, flexWrap: "wrap", gap: 6 }}>
            <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name}</span>
            <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#6B6552" }}>
              {s.id} · PIN {s.pin || "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Teacher: raise a disciplinary report to admin ----------
function DisciplineReport({ roster, saveRoster, classId, actorName, role = "teacher" }) {
  const [form, setForm] = useState({ studentId: "", category: "", detail: "", action: "" });
  const scope = classId
    ? (roster.discipline || []).filter((d) => d.classId === classId)
    : (roster.discipline || []);
  const list = [...scope].sort((a, b) => b.ts.localeCompare(a.ts));
  const students = classId ? roster.students.filter((s) => s.classId === classId) : roster.students;

  const submit = () => {
    if (!form.studentId || !form.category || !form.detail.trim()) return;
    const stu = roster.students.find((s) => s.id === form.studentId);
    const rec = {
      id: genId("DSC", roster.discipline || []),
      ts: new Date().toISOString(),
      studentId: form.studentId, classId: stu?.classId || classId,
      byTeacher: actorName || "Teacher",
      category: form.category, detail: form.detail.trim(), action: form.action || "",
      status: "submitted", adminNote: "",
    };
    const next = logAction({ ...roster, discipline: [...(roster.discipline || []), rec] },
      actorName || "Teacher", `Discipline report raised for ${stu?.name} (${form.category})`);
    saveRoster(next, "Report sent to admin");
    setForm({ studentId: "", category: "", detail: "", action: "" });
  };

  const nameOf = (id) => roster.students.find((s) => s.id === id)?.name || "—";
  const TONE = { submitted: "#3B5998", reviewed: "#3F7A5C", dismissed: "#8A8368" };

  return (
    <div>
      <SectionTitle>{role === "admin" ? "Disciplinary reports" : "Report a discipline case"}</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
        {role === "admin"
          ? "Cases raised by teachers. Review each one and record the action taken."
          : "Reports go to the administrator for review. Keep the description factual."}
      </div>

      {role === "teacher" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <select value={form.studentId} onChange={(e) => setForm({ ...form, studentId: e.target.value })}
              style={{ ...darkInput(), flex: 1, minWidth: 140 }}>
              <option value="">Pupil…</option>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
              style={{ ...darkInput(), flex: 1, minWidth: 140 }}>
              <option value="">Category…</option>
              {DISCIPLINE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <textarea value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })}
            placeholder="What happened? Include date, place and what was said or done."
            style={{ ...darkInput(), width: "100%", height: 74, marginBottom: 8, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
            <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}
              style={{ ...darkInput(), flex: 1, minWidth: 160 }}>
              <option value="">Action already taken (optional)…</option>
              {DISCIPLINE_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <button onClick={submit} disabled={!form.studentId || !form.category || !form.detail.trim()}
              style={{ ...primaryBtn(), background: "#3B5998" }}>Send to admin</button>
          </div>
        </>
      )}

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>
        {role === "admin" ? `Cases (${list.length})` : `My reports (${list.length})`}
      </div>
      {list.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Nothing recorded.</div>}

      <div style={{ display: "grid", gap: 8 }}>
        {list.map((d) => (
          <div key={d.id} style={{ padding: "11px 13px", background: "#F5F1E6", borderRadius: 4,
                border: "1px solid #E4DFCF", borderLeft: `4px solid ${TONE[d.status] || "#E4DFCF"}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
              <span style={{ fontFamily: FONT.body, fontSize: 13.5, fontWeight: 600, color: "#22304A" }}>
                {nameOf(d.studentId)} <span style={{ color: "#8A8368", fontWeight: 400, fontSize: 12 }}>· {d.category}</span>
              </span>
              <span style={{ fontFamily: FONT.mono, fontSize: 10, color: TONE[d.status] || "#6B6552" }}>
                {d.status.toUpperCase()}
              </span>
            </div>
            <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", marginTop: 5 }}>{d.detail}</div>
            <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#6B6552", marginTop: 5 }}>
              {classNameOf(roster, d.classId)} · by {d.byTeacher} · {fmtDate(d.ts.slice(0, 10))}
              {d.action ? ` · action: ${d.action}` : ""}
            </div>
            {d.adminNote && (
              <div style={{ marginTop: 6, padding: "7px 10px", background: "#E4F0E8", border: "1px solid #B8D9C4",
                            borderRadius: 3, fontFamily: FONT.body, fontSize: 12, color: "#22304A" }}>
                <strong>Admin:</strong> {d.adminNote}
              </div>
            )}

            {role === "admin" && d.status === "submitted" && (
              <div style={{ display: "flex", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
                <button onClick={() => {
                  const note = window.prompt("Action taken / note to the teacher:", "") || "";
                  saveRoster(logAction({ ...roster, discipline: roster.discipline.map((x) =>
                    x.id === d.id ? { ...x, status: "reviewed", adminNote: note } : x) },
                    "Admin", `Discipline case reviewed — ${nameOf(d.studentId)}`), "Case reviewed");
                }} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Mark reviewed</button>
                <button onClick={() => {
                  const note = window.prompt("Reason for dismissing (optional):", "") || "";
                  saveRoster({ ...roster, discipline: roster.discipline.map((x) =>
                    x.id === d.id ? { ...x, status: "dismissed", adminNote: note } : x) }, "Case dismissed");
                }} style={{ ...primaryBtn(), background: "#8A8368" }}>Dismiss</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Teacher: sign in on arrival; late after 08:00, admin approves ----------
function StaffCheckIn({ roster, saveRoster, teacherId, teacherName }) {
  const today = todayISO();
  const mine = roster.checkins?.[today]?.[teacherId];
  const [note, setNote] = useState("");
  const [outNote, setOutNote] = useState("");

  const signIn = () => {
    const { h, m } = nowHM();
    const late = isLateNow();
    if (late && !note.trim()) {
      window.alert("You are signing in after 08:00. Please give a reason before sending it to admin.");
      return;
    }
    const rec = {
      time: fmtHM(h, m),
      status: late ? "late" : "present",
      note: note.trim(),
      approved: null,            // admin decides
      ts: new Date().toISOString(),
    };
    const day = { ...(roster.checkins?.[today] || {}), [teacherId]: rec };
    const next = logAction({ ...roster, checkins: { ...(roster.checkins || {}), [today]: day } },
      teacherName, `Signed in at ${rec.time} (${rec.status})`);
    saveRoster(next, late ? `Signed in ${rec.time} — marked LATE, sent to admin` : `Signed in ${rec.time} — on time`);
    setNote("");
  };

  // Signing out. Before 16:00 counts as leaving early and needs a reason that
  // the administrator must approve.
  const signOut = () => {
    const { h, m } = nowHM();
    const early = isEarlyDeparture();
    if (early && !outNote.trim()) {
      window.alert("The school day ends at 16:00. Give a genuine reason for leaving early — the administrator must approve it.");
      return;
    }
    const rec = {
      ...mine,
      outTime: fmtHM(h, m),
      outStatus: early ? "early" : "full-day",
      outNote: outNote.trim(),
      outApproved: early ? null : true,   // a full day needs no approval
      outTs: new Date().toISOString(),
    };
    const day = { ...(roster.checkins?.[today] || {}), [teacherId]: rec };
    const next = logAction({ ...roster, checkins: { ...(roster.checkins || {}), [today]: day } },
      teacherName, `Signed out at ${rec.outTime} (${rec.outStatus})${early ? " — reason: " + rec.outNote : ""}`);
    saveRoster(next, early ? `Signed out ${rec.outTime} — EARLY, sent to admin` : `Signed out ${rec.outTime} — full day`);
    setOutNote("");
  };

  // last 7 days for this teacher
  const history = [...Array(7)].map((_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    return { d: iso, rec: roster.checkins?.[iso]?.[teacherId] };
  });

  const late = isLateNow();
  const { h, m } = nowHM();

  return (
    <div>
      <SectionTitle>Sign in for today</SectionTitle>

      {!mine && (
        <div style={{
          padding: "13px 15px", borderRadius: 5, marginBottom: 14,
          background: late ? "#F7E4E1" : "#E4F0E8",
          border: `1px solid ${late ? "#E8C4BD" : "#B8D9C4"}`,
        }}>
          <div style={{ fontFamily: FONT.mono, fontSize: 10, color: "#8A8368", letterSpacing: 1 }}>TIME NOW</div>
          <div style={{ fontFamily: FONT.display, fontSize: 26, fontWeight: 700, color: "#22304A" }}>{fmtHM(h, m)}</div>
          <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: late ? "#B84C3E" : "#3F7A5C", marginTop: 4 }}>
            {late
              ? "After 08:00 — you will be marked LATE and admin must approve."
              : "Before 08:00 — you will be marked on time."}
          </div>
        </div>
      )}

      {mine ? (
        <>
        <div style={{
          padding: "13px 15px", borderRadius: 5, marginBottom: 12,
          background: mine.status === "late" ? "#F7E4E1" : "#E4F0E8",
          border: `1px solid ${mine.status === "late" ? "#E8C4BD" : "#B8D9C4"}`,
        }}>
          <div style={{ fontFamily: FONT.display, fontSize: 17, fontWeight: 700, color: "#22304A" }}>
            Signed in at {mine.time} — {mine.status === "late" ? "LATE" : "on time"}
          </div>
          {mine.note && <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginTop: 4 }}>Reason: {mine.note}</div>}
          <div style={{ fontFamily: FONT.mono, fontSize: 11, marginTop: 6,
                        color: mine.approved === true ? "#3F7A5C" : mine.approved === false ? "#B84C3E" : "#C98A2C" }}>
            {mine.approved === true ? "APPROVED BY ADMIN"
              : mine.approved === false ? "NOT APPROVED — see admin"
              : "AWAITING ADMIN APPROVAL"}
          </div>
        </div>

        {/* Sign-out half of the day */}
        {mine.outTime ? (
          <div style={{
            padding: "13px 15px", borderRadius: 5, marginBottom: 16,
            background: mine.outStatus === "early" ? "#F7E4E1" : "#E4F0E8",
            border: `1px solid ${mine.outStatus === "early" ? "#E8C4BD" : "#B8D9C4"}`,
          }}>
            <div style={{ fontFamily: FONT.display, fontSize: 17, fontWeight: 700, color: "#22304A" }}>
              Signed out at {mine.outTime} — {mine.outStatus === "early" ? "LEFT EARLY" : "full day"}
            </div>
            {mine.outNote && <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginTop: 4 }}>Reason: {mine.outNote}</div>}
            {mine.outStatus === "early" && (
              <div style={{ fontFamily: FONT.mono, fontSize: 11, marginTop: 6,
                            color: mine.outApproved === true ? "#3F7A5C" : mine.outApproved === false ? "#B84C3E" : "#C98A2C" }}>
                {mine.outApproved === true ? "EARLY DEPARTURE APPROVED"
                  : mine.outApproved === false ? "NOT APPROVED — see admin"
                  : "AWAITING ADMIN APPROVAL"}
              </div>
            )}
          </div>
        ) : (
          <div style={{
            padding: "13px 15px", borderRadius: 5, marginBottom: 16,
            background: isEarlyDeparture() ? "#F5E8DC" : "#E4F0E8",
            border: `1px solid ${isEarlyDeparture() ? "#E8CBA0" : "#B8D9C4"}`,
          }}>
            <div style={{ fontFamily: FONT.mono, fontSize: 10, color: "#8A8368", letterSpacing: 1 }}>END OF DAY</div>
            <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", margin: "5px 0 9px", lineHeight: 1.5 }}>
              {isEarlyDeparture()
                ? `The school day ends at ${fmtHM(DEPARTURE_TIME.hour, DEPARTURE_TIME.minute)}. Leaving now is early — give a genuine reason and the administrator must approve it.`
                : `It is after ${fmtHM(DEPARTURE_TIME.hour, DEPARTURE_TIME.minute)}. You may sign out for the day.`}
            </div>
            {isEarlyDeparture() && (
              <textarea value={outNote} onChange={(e) => setOutNote(e.target.value)}
                placeholder="Reason for leaving before 16:00 (required)"
                style={{ ...darkInput(), width: "100%", height: 62, marginBottom: 9, resize: "vertical" }} />
            )}
            <button onClick={signOut} style={{ ...primaryBtn(), background: isEarlyDeparture() ? "#C98A2C" : "#3F7A5C" }}>
              {isEarlyDeparture() ? "Sign out EARLY — needs approval" : "Sign out — full day"}
            </button>
          </div>
        )}
        </>
      ) : (
        <>
          {late && (
            <textarea value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Reason for arriving after 08:00 (required)"
              style={{ ...darkInput(), width: "100%", height: 64, marginBottom: 10, resize: "vertical" }} />
          )}
          <button onClick={signIn} style={{ ...primaryBtn(), background: late ? "#C98A2C" : "#3F7A5C", marginBottom: 18 }}>
            {late ? "Sign in as LATE" : "Sign in — on time"}
          </button>
        </>
      )}

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>Last 7 days</div>
      <div style={{ display: "grid", gap: 5 }}>
        {history.map(({ d, rec }) => (
          <div key={d} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                                 padding: "8px 12px", background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 3 }}>
            <span style={{ fontFamily: FONT.body, fontSize: 13, color: "#22304A" }}>{fmtDate(d)}</span>
            <span style={{ fontFamily: FONT.mono, fontSize: 11,
                           color: !rec ? "#8A8368" : (rec.status === "late" || rec.outStatus === "early") ? "#B84C3E" : "#3F7A5C" }}>
              {rec
                ? `in ${rec.time}${rec.status === "late" ? " (late)" : ""} · ${rec.outTime ? `out ${rec.outTime}${rec.outStatus === "early" ? " (early)" : ""}` : "not signed out"}`
                : "not signed in"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Admin: approve arrival sign-ins, especially late ones ----------
function CheckInApprovals({ roster, saveRoster }) {
  const [date, setDate] = useState(todayISO());
  const day = roster.checkins?.[date] || {};
  const nameOf = (id) => roster.teachers.find((t) => t.id === id)?.name
    || roster.teachers.find((t) => t.id === id)?.name || id;

  const decide = (teacherId, ok, which = "in") => {
    const rec = day[teacherId];
    if (!rec) return;
    const patch = which === "in" ? { approved: ok } : { outApproved: ok };
    const next = {
      ...roster,
      checkins: { ...roster.checkins, [date]: { ...day, [teacherId]: { ...rec, ...patch } } },
    };
    saveRoster(logAction(next, "Admin",
      `${ok ? "Approved" : "Rejected"} ${nameOf(teacherId)}'s ${which === "in" ? rec.status + " arrival" : "early departure"} on ${fmtDate(date)}`),
      ok ? "Approved" : "Not approved");
  };

  const rows = roster.teachers.map((t) => ({ t, rec: day[t.id] }));
  const pending = rows.filter((r) => r.rec && (r.rec.approved === null || r.rec.outApproved === null)).length;
  const lateCount = rows.filter((r) => r.rec?.status === "late").length;
  const earlyCount = rows.filter((r) => r.rec?.outStatus === "early").length;
  const absent = rows.filter((r) => !r.rec).length;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <SectionTitle>Arrival sign-ins</SectionTitle>
        <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} style={darkInput()} />
      </div>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14 }}>
        Staff sign in on arrival and out at the end of the day. Arriving after <strong>08:00</strong> is recorded
        as late, and leaving before <strong>16:00</strong> is recorded as an early departure — both need your approval.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px,1fr))", gap: 10, marginBottom: 16 }}>
        <StatCard label="Awaiting you" value={pending} tone={pending ? "#3B5998" : "#22304A"} />
        <StatCard label="Late today" value={lateCount} tone={lateCount ? "#B84C3E" : "#3F7A5C"} />
        <StatCard label="Left early" value={earlyCount} tone={earlyCount ? "#B84C3E" : "#3F7A5C"} />
        <StatCard label="Not signed in" value={absent} tone={absent ? "#C98A2C" : "#3F7A5C"} />
      </div>

      {roster.teachers.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No teachers on file.</div>}
      <div style={{ display: "grid", gap: 6 }}>
        {rows.map(({ t, rec }) => (
          <div key={t.id} style={{ padding: "10px 12px", background: "#F5F1E6", borderRadius: 4,
                border: "1px solid #E4DFCF",
                borderLeft: `4px solid ${!rec ? "#D8D2C2" : rec.status === "late" ? "#B84C3E" : "#3F7A5C"}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontFamily: FONT.body, fontSize: 13.5, fontWeight: 600, color: "#22304A" }}>
                {t.name} <span style={{ color: "#8A8368", fontWeight: 400, fontSize: 12 }}>· {classNameOf(roster, t.classId)}</span>
              </span>
              <span style={{ fontFamily: FONT.mono, fontSize: 12,
                             color: !rec ? "#8A8368" : rec.status === "late" ? "#B84C3E" : "#3F7A5C" }}>
                {rec ? `${rec.time} · ${rec.status.toUpperCase()}` : "NOT SIGNED IN"}
              </span>
            </div>
            {rec && (
              <div style={{ fontFamily: FONT.mono, fontSize: 11, color: "#6B6552", marginTop: 4 }}>
                {rec.outTime
                  ? `out ${rec.outTime}${rec.outStatus === "early" ? " · LEFT EARLY" : " · full day"}`
                  : "still on duty — not signed out"}
              </div>
            )}
            {rec?.note && <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", marginTop: 4 }}>Arrival reason: {rec.note}</div>}
            {rec?.outNote && <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", marginTop: 3 }}>Departure reason: {rec.outNote}</div>}

            {rec && (
              <div style={{ marginTop: 8, display: "grid", gap: 7 }}>
                {/* arrival decision */}
                {rec.approved === null ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#6B6552", minWidth: 58 }}>ARRIVAL</span>
                    <button onClick={() => decide(t.id, true, "in")} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Approve</button>
                    <button onClick={() => decide(t.id, false, "in")} style={{ ...primaryBtn(), background: "#B84C3E" }}>Not approved</button>
                  </div>
                ) : (
                  <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: rec.approved ? "#3F7A5C" : "#B84C3E" }}>
                    ARRIVAL {rec.approved ? "APPROVED" : "NOT APPROVED"}
                  </div>
                )}

                {/* early departure decision */}
                {rec.outStatus === "early" && (
                  rec.outApproved === null ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#6B6552", minWidth: 58 }}>DEPARTURE</span>
                      <button onClick={() => decide(t.id, true, "out")} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Approve</button>
                      <button onClick={() => decide(t.id, false, "out")} style={{ ...primaryBtn(), background: "#B84C3E" }}>Not approved</button>
                    </div>
                  ) : (
                    <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: rec.outApproved ? "#3F7A5C" : "#B84C3E" }}>
                      EARLY DEPARTURE {rec.outApproved ? "APPROVED" : "NOT APPROVED"}
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}


// ---------- Admin: system health and automatic snapshots ----------
// Surfaces the quiet problems that break things weeks later, and lists the
// snapshots the database takes on its own.
function SystemHealth({ roster }) {
  const [rows, setRows] = useState(null);
  const [snaps, setSnaps] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = async () => {
    setErr("");
    try { setRows(await healthCheck()); } catch (e) { setErr("Could not run the checks."); setRows([]); }
    try { setSnaps(await backupsList()); } catch (e) { setSnaps([]); }
  };
  useEffect(() => { load(); }, []);

  const takeOne = async () => {
    setBusy(true); setMsg("");
    try { await backupNow("taken by admin"); setMsg("Snapshot saved."); await load(); }
    catch (e) { setErr(String(e.message || e).slice(0, 160)); }
    setBusy(false);
  };

  const restore = async (b) => {
    const when = new Date(b.taken_at).toLocaleString();
    if (!window.confirm(`Restore the snapshot from ${when}?\\n\\nEverything currently in the portal will be replaced. A safety copy of today's data is taken first, so this can be undone.`)) return;
    setBusy(true); setMsg("");
    try {
      await backupRestore(b.id);
      setMsg("Restored. Reload the page to see the restored data.");
      await load();
    } catch (e) { setErr(String(e.message || e).slice(0, 160)); }
    setBusy(false);
  };

  const problems = (rows || []).filter((r) => r.severity === "problem");
  const warnings = (rows || []).filter((r) => r.severity === "warning");
  const TONE = { problem: "#B84C3E", warning: "#C98A2C", ok: "#3F7A5C" };

  return (
    <div>
      <SectionTitle>System health</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14 }}>
        Checks for the quiet problems that cause trouble later — a login with no teacher record,
        a pupil in a deleted class, staff who cannot recover a password.
      </div>

      {err && <div style={{ padding: "9px 12px", borderRadius: 4, background: "#F7E4E1", border: "1px solid #E8C4BD",
                            fontFamily: FONT.body, fontSize: 12.5, color: "#B84C3E", marginBottom: 12 }}>{err}</div>}
      {msg && <div style={{ padding: "9px 12px", borderRadius: 4, background: "#E4F0E8", border: "1px solid #B8D9C4",
                            fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", marginBottom: 12 }}>{msg}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 10, marginBottom: 16 }}>
        <StatCard label="Problems" value={rows ? problems.length : "…"} tone={problems.length ? "#B84C3E" : "#3F7A5C"} />
        <StatCard label="Warnings" value={rows ? warnings.length : "…"} tone={warnings.length ? "#C98A2C" : "#3F7A5C"} />
        <StatCard label="Snapshots" value={snaps ? snaps.length : "…"} />
      </div>

      {rows && rows.length === 0 && (
        <div style={{ padding: "13px 15px", borderRadius: 5, background: "#E4F0E8", border: "1px solid #B8D9C4",
                      fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", marginBottom: 18 }}>
          Everything checks out — nothing needs attention.
        </div>
      )}

      <div style={{ display: "grid", gap: 7, marginBottom: 22 }}>
        {(rows || []).filter((r) => r.severity !== "ok").map((r, i) => (
          <div key={i} style={{ padding: "10px 12px", background: "#F5F1E6", borderRadius: 4,
                border: "1px solid #E4DFCF", borderLeft: `4px solid ${TONE[r.severity]}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: FONT.body, fontSize: 13, color: "#22304A", fontWeight: 600 }}>{r.detail}</span>
              <span style={{ fontFamily: FONT.mono, fontSize: 9.5, color: TONE[r.severity] }}>{r.severity.toUpperCase()}</span>
            </div>
            <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#6B6552", marginTop: 4 }}>
              {r.area} — {r.fix}
            </div>
          </div>
        ))}
      </div>

      <button onClick={load} style={{ ...backBtnStyle(), color: "#22304A", marginBottom: 22 }}>↻ run checks again</button>

      <SectionTitle>Snapshots</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
        The database takes these on its own — hourly while the portal is in use, plus one kept for each
        day and each month. Nothing to remember.
      </div>
      <button onClick={takeOne} disabled={busy} style={{ ...primaryBtn(), marginBottom: 14, opacity: busy ? 0.5 : 1 }}>
        Take a snapshot now
      </button>

      {snaps === null && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Loading…</div>}
      {snaps && snaps.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>None yet — the first save will create one.</div>}

      <div style={{ display: "grid", gap: 5 }}>
        {(snaps || []).map((b) => (
          <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                gap: 10, flexWrap: "wrap", padding: "9px 12px", background: "#F5F1E6",
                border: "1px solid #E4DFCF", borderRadius: 3,
                borderLeft: `4px solid ${b.kind === "monthly" ? "#22304A" : b.kind === "daily" ? "#3F7A5C" : "#D8D2C2"}` }}>
            <span>
              <span style={{ fontFamily: FONT.body, fontSize: 13, color: "#22304A" }}>
                {new Date(b.taken_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </span>
              <span style={{ fontFamily: FONT.mono, fontSize: 10, color: "#8A8368", marginLeft: 8 }}>
                {b.kind} · {b.size_kb}KB
              </span>
              {b.reason && <div style={{ fontFamily: FONT.body, fontSize: 11, color: "#8A8368", marginTop: 2 }}>{b.reason}</div>}
            </span>
            <button onClick={() => restore(b)} disabled={busy}
              style={{ background: "none", border: "none", color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11.5 }}>
              restore
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}


// ---------- Exam timetable, set per CBC level ----------
// Assessments are sat by a whole level at once — every Grade 4, 5 and 6 class
// takes the Upper Primary paper together — so the timetable belongs to the
// level rather than to any single class.
function ExamTimetable({ roster, saveRoster, readOnly = false, onlyLevel = null }) {
  const [level, setLevel] = useState(onlyLevel || "upper");
  const [printing, setPrinting] = useState(false);
  const [entry, setEntry] = useState({ date: todayISO(), start: "08:00", end: "10:00", subject: "", note: "" });

  const sheet = roster.examTimetable?.[level] || { title: "", papers: [] };
  const papers = [...(sheet.papers || [])].sort((a, b) =>
    (a.date + a.start).localeCompare(b.date + b.start));

  // every class sitting this level's papers — each needs its own invigilator
  const levelClasses = roster.classes.filter((c) => levelOfClassName(c.name) === level);

  const levelSubjects = (roster.subjects || []).filter(
    (sub) => (CBC_LEVEL_SUBJECTS[level] || []).includes(sub)
      || !Object.values(CBC_LEVEL_SUBJECTS).flat().includes(sub));

  const write = (next, msg) => saveRoster(
    { ...roster, examTimetable: { ...(roster.examTimetable || {}), [level]: next } }, msg);

  const addPaper = () => {
    if (!entry.subject || !entry.date) return;
    const p = { id: genId("EXM", papers), ...entry, kind: "paper", invigilators: {} };
    write({ ...sheet, papers: [...papers, p] }, `${entry.subject} added`);
    setEntry({ ...entry, subject: "", note: "" });
  };

  // Exam days need rest between papers. A break spans the whole level, so it
  // needs no invigilator and shows as a band.
  const addBreak = (kind) => {
    if (!entry.date) return;
    const p = { id: genId("EXM", papers), date: entry.date, start: entry.start, end: entry.end,
                subject: kind === "lunch" ? "Lunch" : "Break", kind, note: entry.note, invigilators: {} };
    write({ ...sheet, papers: [...papers, p] }, `${p.subject} added`);
    setEntry({ ...entry, note: "" });
  };
  const removePaper = (id) => write({ ...sheet, papers: papers.filter((p) => p.id !== id) }, "Paper removed");
  const setTitle = (title) => write({ ...sheet, title }, "Title updated");

  const setInvigilator = (paperId, classId, teacherId) => {
    write({ ...sheet, papers: papers.map((p) => p.id === paperId
      ? { ...p, invigilators: { ...(p.invigilators || {}), [classId]: teacherId || undefined } }
      : p) }, "Invigilator set");
  };

  // A teacher cannot be in two rooms at once. This flags anyone assigned to
  // more than one class in the same time slot.
  const clashesFor = (paper) => {
    const seen = {}, clashing = new Set();
    Object.entries(paper.invigilators || {}).forEach(([cid, tid]) => {
      if (!tid) return;
      if (seen[tid]) { clashing.add(tid); } else { seen[tid] = cid; }
    });
    // also across other papers at the same date and time
    papers.forEach((other) => {
      if (other.id === paper.id || (other.kind && other.kind !== "paper")) return;
      if (other.date !== paper.date || other.start !== paper.start) return;
      Object.values(other.invigilators || {}).forEach((tid) => {
        if (tid && Object.values(paper.invigilators || {}).includes(tid)) clashing.add(tid);
      });
    });
    return clashing;
  };

  const teacherName = (id) => roster.teachers.find((t) => t.id === id)?.name || "";

  if (printing) return <ExamTimetableDoc roster={roster} level={level} onBack={() => setPrinting(false)} />;

  const byDay = papers.reduce((acc, p) => { (acc[p.date] = acc[p.date] || []).push(p); return acc; }, {});

  return (
    <div>
      <SectionTitle>Exam timetable</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
        A paper is sat by every class at the level at the same time, so each class needs its own
        invigilator in its own room.
      </div>

      {!onlyLevel && (
        <div style={{ display: "flex", gap: 7, marginBottom: 14, flexWrap: "wrap" }}>
          {Object.entries(CBC_LEVELS).map(([k, v]) => (
            <button key={k} onClick={() => setLevel(k)} style={{
              padding: "7px 13px", borderRadius: 16, fontFamily: FONT.body, fontSize: 12.5, fontWeight: 600,
              border: `1px solid ${level === k ? "#22304A" : "#D8D2C2"}`,
              background: level === k ? "#22304A" : "#fff",
              color: level === k ? "#fff" : "#6B6552",
            }}>
              Grades {v.grades[0]}–{v.grades[v.grades.length - 1]}
            </button>
          ))}
        </div>
      )}

      <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368", marginBottom: 4 }}>
        {CBC_LEVELS[level].label.toUpperCase()}
      </div>
      <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", marginBottom: 12 }}>
        {levelClasses.length === 0
          ? "No classes at this level yet."
          : `${levelClasses.length} class${levelClasses.length === 1 ? "" : "es"} sitting: ${levelClasses.map((c) => c.name).join(", ")} — ${levelClasses.length} invigilator${levelClasses.length === 1 ? "" : "s"} needed per paper.`}
      </div>

      {!readOnly && (
        <>
          <input defaultValue={sheet.title} key={level + (sheet.title || "")}
            onBlur={(e) => setTitle(e.target.value)}
            placeholder="Title, e.g. End of Term 1 Assessment"
            style={{ ...darkInput(), width: "100%", marginBottom: 12 }} />

          <div style={{ background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 5, padding: 12, marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <input type="date" value={entry.date} onChange={(e) => setEntry({ ...entry, date: e.target.value })}
                style={{ ...darkInput(), minWidth: 140 }} />
              <input type="time" value={entry.start} onChange={(e) => setEntry({ ...entry, start: e.target.value })}
                style={{ ...darkInput(), width: 110 }} />
              <input type="time" value={entry.end} onChange={(e) => setEntry({ ...entry, end: e.target.value })}
                style={{ ...darkInput(), width: 110 }} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select value={entry.subject} onChange={(e) => setEntry({ ...entry, subject: e.target.value })}
                style={{ ...darkInput(), flex: 1, minWidth: 150 }}>
                <option value="">Learning area…</option>
                {levelSubjects.map((sub) => <option key={sub} value={sub}>{sub}</option>)}
              </select>
              <input value={entry.note} onChange={(e) => setEntry({ ...entry, note: e.target.value })}
                placeholder="Note (optional)" style={{ ...darkInput(), flex: 1, minWidth: 130 }} />
              <button onClick={addPaper} disabled={!entry.subject} style={{ ...primaryBtn(), opacity: entry.subject ? 1 : 0.5 }}>
                Add paper
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button onClick={() => addBreak("break")} style={{ ...primaryBtn(), background: "#C98A2C" }}>Add break</button>
              <button onClick={() => addBreak("lunch")} style={{ ...primaryBtn(), background: "#3F7A5C" }}>Add lunch</button>
            </div>
            <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#6B6552", marginTop: 8 }}>
              Invigilators are chosen per class once a paper is added. Breaks need none.
            </div>
          </div>
        </>
      )}

      {papers.length === 0 && (
        <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No papers set for this level yet.</div>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {Object.keys(byDay).sort().map((date) => (
          <div key={date} style={{ border: "1px solid #E4DFCF", borderRadius: 5, overflow: "hidden" }}>
            <div style={{ background: "#22304A", color: "#fff", padding: "8px 12px",
                          fontFamily: FONT.display, fontSize: 13.5, fontWeight: 600 }}>
              {new Date(date + "T00:00:00").toLocaleDateString(undefined,
                { weekday: "long", day: "numeric", month: "long" })}
            </div>
            <div style={{ padding: "8px 10px", display: "grid", gap: 8, background: "#FBF9F3" }}>
              {byDay[date].map((p) => {
                const kind = p.kind || "paper";
                if (kind !== "paper") {
                  const tone = PERIOD_TYPES[kind] || PERIOD_TYPES.break;
                  return (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                          padding: "8px 12px", borderRadius: 4, background: tone.band, color: tone.fg }}>
                      <span style={{ fontFamily: FONT.mono, fontSize: 11.5, fontWeight: 600 }}>{p.start}–{p.end}</span>
                      <span style={{ fontFamily: FONT.body, fontSize: 13, fontWeight: 700, letterSpacing: 1, flex: 1 }}>
                        {p.subject.toUpperCase()}
                      </span>
                      {!readOnly && (
                        <button onClick={() => removePaper(p.id)} style={{ background: "none", border: "none",
                                color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11 }}>remove</button>
                      )}
                    </div>
                  );
                }
                const clash = clashesFor(p);
                const assigned = levelClasses.filter((c) => p.invigilators?.[c.id]).length;
                return (
                  <div key={p.id} style={{ padding: "10px 12px", background: "#F5F1E6",
                        border: "1px solid #E4DFCF", borderRadius: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: FONT.mono, fontSize: 11.5, color: "#22304A", fontWeight: 600 }}>
                        {p.start}–{p.end}
                      </span>
                      <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", fontWeight: 600, flex: 1 }}>
                        {p.subject}
                      </span>
                      <span style={{ fontFamily: FONT.mono, fontSize: 10,
                                     color: assigned === levelClasses.length ? "#3F7A5C" : "#C98A2C" }}>
                        {assigned}/{levelClasses.length} invigilators
                      </span>
                      {!readOnly && (
                        <button onClick={() => removePaper(p.id)} style={{ background: "none", border: "none",
                                color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11 }}>remove</button>
                      )}
                    </div>
                    {p.note && <div style={{ fontFamily: FONT.body, fontSize: 11, color: "#6B6552", marginTop: 3 }}>{p.note}</div>}

                    {/* one invigilator per class */}
                    <div style={{ display: "grid", gap: 5, marginTop: 8, paddingTop: 8, borderTop: "1px dashed #D8D2C2" }}>
                      {levelClasses.map((c) => {
                        const tid = p.invigilators?.[c.id] || "";
                        const isClash = tid && clash.has(tid);
                        return (
                          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                            <span style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", minWidth: 66, fontWeight: 600 }}>
                              {c.name}
                            </span>
                            {readOnly ? (
                              <span style={{ fontFamily: FONT.body, fontSize: 12.5, color: tid ? "#22304A" : "#B84C3E" }}>
                                {tid ? teacherName(tid) : "not assigned"}
                              </span>
                            ) : (
                              <select value={tid} onChange={(e) => setInvigilator(p.id, c.id, e.target.value)}
                                style={{ ...darkInput(), flex: 1, minWidth: 130, padding: "4px 8px", fontSize: 12,
                                         borderColor: isClash ? "#B84C3E" : (tid ? "#3F7A5C" : "#D8D2C2") }}>
                                <option value="">choose invigilator…</option>
                                {roster.teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                              </select>
                            )}
                            {isClash && (
                              <span style={{ fontFamily: FONT.mono, fontSize: 9.5, color: "#B84C3E" }}>
                                ALREADY IN ANOTHER ROOM
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {papers.length > 0 && (
        <button onClick={() => setPrinting(true)} style={{ ...primaryBtn(), marginTop: 16 }}>
          Open printable timetable
        </button>
      )}
    </div>
  );
}

// Printable version, one sheet per level.
function ExamTimetableDoc({ roster, level, onBack }) {
  const sheet = roster.examTimetable?.[level] || { title: "", papers: [] };
  const papers = [...(sheet.papers || [])].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const classes = roster.classes.filter((c) => levelOfClassName(c.name) === level);
  const teacherName = (id) => roster.teachers.find((t) => t.id === id)?.name || "—";

  return (
    <DocShell title="Exam timetable" onBack={onBack}>
      <DocHeader subtitle={sheet.title || "Examination Timetable"} />

      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 16, fontSize: 12 }}>
        <div><strong>Level:</strong> {CBC_LEVELS[level].label}</div>
        <div><strong>Classes sitting:</strong> {classes.map((c) => c.name).join(", ") || "—"}</div>
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 18 }}>
        <thead>
          <tr>
            <th style={{ ...docTh, fontSize: 8.5 }}>Date</th>
            <th style={{ ...docTh, fontSize: 8.5 }}>Time</th>
            <th style={{ ...docTh, fontSize: 8.5 }}>Learning area</th>
            {classes.map((c) => (
              <th key={c.id} style={{ ...docTh, fontSize: 8.5, textAlign: "center" }}>
                {c.name}<div style={{ fontWeight: 400, color: "#8A8368" }}>invigilator</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {papers.map((p, i) => {
            const firstOfDay = i === 0 || papers[i - 1].date !== p.date;
            const top = firstOfDay && i > 0 ? "2px solid #B8B2A0" : undefined;
            const kind = p.kind || "paper";

            // breaks span every class, so they print as one band
            if (kind !== "paper") {
              const tone = PERIOD_TYPES[kind] || PERIOD_TYPES.break;
              return (
                <tr key={p.id}>
                  <td style={{ ...docTd, fontSize: 10.5, borderTop: top, background: tone.band, color: tone.fg }}>
                    {firstOfDay ? new Date(p.date + "T00:00:00").toLocaleDateString(undefined,
                      { weekday: "short", day: "numeric", month: "short" }) : ""}
                  </td>
                  <td style={{ ...docTd, fontFamily: FONT.mono, fontSize: 10.5, whiteSpace: "nowrap",
                               borderTop: top, background: tone.band, color: tone.fg }}>
                    {p.start}–{p.end}
                  </td>
                  <td colSpan={1 + classes.length} style={{ ...docTd, textAlign: "center", fontSize: 10.5,
                        fontWeight: "bold", letterSpacing: 1.5, textTransform: "uppercase",
                        borderTop: top, background: tone.band, color: tone.fg }}>
                    {p.subject}
                  </td>
                </tr>
              );
            }
            return (
              <tr key={p.id}>
                <td style={{ ...docTd, fontSize: 10.5, whiteSpace: "nowrap", borderTop: top }}>
                  {firstOfDay ? new Date(p.date + "T00:00:00").toLocaleDateString(undefined,
                    { weekday: "short", day: "numeric", month: "short" }) : ""}
                </td>
                <td style={{ ...docTd, fontFamily: FONT.mono, fontSize: 10.5, whiteSpace: "nowrap", borderTop: top }}>
                  {p.start}–{p.end}
                </td>
                <td style={{ ...docTd, fontWeight: 600, fontSize: 11, borderTop: top }}>
                  {p.subject}
                  {p.note && <div style={{ fontWeight: 400, fontSize: 9.5, color: "#6B6552" }}>{p.note}</div>}
                </td>
                {classes.map((c) => (
                  <td key={c.id} style={{ ...docTd, fontSize: 10, textAlign: "center", borderTop: top,
                        color: p.invigilators?.[c.id] ? "#22304A" : "#B84C3E" }}>
                    {p.invigilators?.[c.id] ? teacherName(p.invigilators[c.id]) : "—"}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ borderTop: "1px solid #E4DFCF", paddingTop: 10, fontSize: 10.5, color: "#6B6552", fontFamily: FONT.mono, lineHeight: 1.5 }}>
        Each class sits its paper in its own room with the invigilator named above.
        Pupils should be seated ten minutes before each paper begins.
        No mobile phones or unauthorised material in the examination room.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 34 }}>
        <div style={docSig}>Examinations Officer</div>
        <div style={docSig}>Head Teacher's Signature</div>
      </div>
    </DocShell>
  );
}


// ---------- Staff memos ----------
// A principal needs to reach every teacher without chasing them one by one.
// Memos are posted once and each teacher acknowledges, so the office can see
// who has actually read a notice rather than assuming.
const MEMO_PRIORITY = {
  normal:  { label: "Notice",    ink: "#3F7A5C", bg: "#E4F0E8", edge: "#B8D9C4" },
  action:  { label: "Action needed", ink: "#C98A2C", bg: "#F5E8DC", edge: "#E8CBA0" },
  urgent:  { label: "Urgent",    ink: "#B84C3E", bg: "#F7E4E1", edge: "#E8C4BD" },
};

// Memos a given teacher still needs to read.
const unreadMemos = (roster, teacherId) =>
  (roster.memos || []).filter((m) => !(m.readBy || []).includes(teacherId));

function MemoBoard({ roster, saveRoster, who, teacherId = null }) {
  const isAdmin = !teacherId;
  const [form, setForm] = useState({ title: "", body: "", priority: "normal" });
  const [expanded, setExpanded] = useState({});

  const memos = [...(roster.memos || [])].sort((a, b) => b.ts.localeCompare(a.ts));
  const activeTeachers = roster.teachers || [];

  const post = () => {
    if (!form.title.trim() || !form.body.trim()) return;
    const m = {
      id: genId("MEM", roster.memos || []),
      ts: new Date().toISOString(),
      by: who?.name || "Administration",
      title: form.title.trim(), body: form.body.trim(),
      priority: form.priority, readBy: [],
    };
    saveRoster(logAction({ ...roster, memos: [...(roster.memos || []), m] },
      who?.name || "Admin", `Memo posted: ${m.title}`), "Memo sent to all teachers");
    setForm({ title: "", body: "", priority: "normal" });
  };

  const remove = (id) => {
    if (!window.confirm("Withdraw this memo? Teachers will no longer see it.")) return;
    saveRoster({ ...roster, memos: (roster.memos || []).filter((m) => m.id !== id) }, "Memo withdrawn");
  };

  const acknowledge = (id) => {
    saveRoster({ ...roster, memos: (roster.memos || []).map((m) =>
      m.id === id ? { ...m, readBy: [...new Set([...(m.readBy || []), teacherId])] } : m) },
      "Marked as read");
  };

  return (
    <div>
      <SectionTitle>{isAdmin ? "Memos to staff" : "Memos from the office"}</SectionTitle>

      {isAdmin ? (
        <>
          <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
            Every teacher sees the memo when they next sign in, and confirms they have read it —
            so you can tell who has seen a notice rather than assuming.
          </div>

          <div style={{ background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 5, padding: 12, marginBottom: 18 }}>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Subject, e.g. Staff meeting on Friday"
              style={{ ...darkInput(), width: "100%", marginBottom: 8 }} />
            <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })}
              placeholder="Write the memo here…"
              style={{ ...darkInput(), width: "100%", height: 96, marginBottom: 8, resize: "vertical" }} />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {Object.entries(MEMO_PRIORITY).map(([k, v]) => (
                <button key={k} onClick={() => setForm({ ...form, priority: k })} style={{
                  padding: "6px 13px", borderRadius: 16, fontFamily: FONT.body, fontSize: 12, fontWeight: 600,
                  border: `1px solid ${form.priority === k ? v.ink : "#D8D2C2"}`,
                  background: form.priority === k ? v.bg : "#fff",
                  color: form.priority === k ? v.ink : "#6B6552",
                }}>{v.label}</button>
              ))}
              <button onClick={post} disabled={!form.title.trim() || !form.body.trim()}
                style={{ ...primaryBtn(), marginLeft: "auto",
                         opacity: form.title.trim() && form.body.trim() ? 1 : 0.5 }}>
                Send to all teachers
              </button>
            </div>
          </div>
        </>
      ) : (
        <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
          Notices from the head teacher's office. Tap <strong>I have read this</strong> so the office knows it reached you.
        </div>
      )}

      {memos.length === 0 && (
        <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>
          {isAdmin ? "No memos posted yet." : "No memos at the moment."}
        </div>
      )}

      <div style={{ display: "grid", gap: 9 }}>
        {memos.map((m) => {
          const tone = MEMO_PRIORITY[m.priority] || MEMO_PRIORITY.normal;
          const read = (m.readBy || []).length;
          const iHaveRead = teacherId && (m.readBy || []).includes(teacherId);
          const open = expanded[m.id];
          return (
            <div key={m.id} style={{
              background: iHaveRead === false ? "#fff" : "#F5F1E6",
              border: `1px solid ${iHaveRead === false ? tone.edge : "#E4DFCF"}`,
              borderLeft: `4px solid ${tone.ink}`, borderRadius: 5, padding: "12px 14px",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 700, color: "#22304A" }}>
                  {m.title}
                </span>
                <span style={{ fontFamily: FONT.mono, fontSize: 9, fontWeight: 700, color: tone.ink,
                               background: tone.bg, border: `1px solid ${tone.edge}`,
                               borderRadius: 10, padding: "2px 9px", alignSelf: "flex-start" }}>
                  {tone.label.toUpperCase()}
                </span>
              </div>

              <div style={{ fontFamily: FONT.mono, fontSize: 10, color: "#8A8368", marginTop: 3 }}>
                {m.by} · {new Date(m.ts).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                {" · "}{new Date(m.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </div>

              <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#22304A", marginTop: 8,
                            lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {m.body}
              </div>

              {isAdmin ? (
                <div style={{ marginTop: 10, paddingTop: 9, borderTop: "1px dashed #D8D2C2" }}>
                  <button onClick={() => setExpanded({ ...expanded, [m.id]: !open })}
                    style={{ background: "none", border: "none", padding: 0, textAlign: "left",
                             fontFamily: FONT.mono, fontSize: 11,
                             color: read === activeTeachers.length && read > 0 ? "#3F7A5C" : "#C98A2C" }}>
                    Read by {read} of {activeTeachers.length} {open ? "▾" : "▸"}
                  </button>
                  {open && (
                    <div style={{ display: "grid", gap: 3, marginTop: 7 }}>
                      {activeTeachers.map((t) => {
                        const seen = (m.readBy || []).includes(t.id);
                        return (
                          <div key={t.id} style={{ display: "flex", justifyContent: "space-between",
                                fontFamily: FONT.body, fontSize: 12,
                                color: seen ? "#3F7A5C" : "#B84C3E" }}>
                            <span>{t.name}</span>
                            <span style={{ fontFamily: FONT.mono, fontSize: 10 }}>{seen ? "read" : "not yet"}</span>
                          </div>
                        );
                      })}
                      {activeTeachers.length === 0 && (
                        <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#8A8368" }}>No teachers on file.</div>
                      )}
                    </div>
                  )}
                  <button onClick={() => remove(m.id)} style={{ background: "none", border: "none",
                          color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11, marginTop: 7 }}>withdraw</button>
                </div>
              ) : (
                <div style={{ marginTop: 10 }}>
                  {iHaveRead ? (
                    <span style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#3F7A5C" }}>✓ YOU HAVE READ THIS</span>
                  ) : (
                    <button onClick={() => acknowledge(m.id)} style={{ ...primaryBtn(), background: tone.ink }}>
                      I have read this
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ---------- Geofence ----------
// Guards actions that should only happen at school. Position is checked on the
// device and the result is written to an audit trail either way.
//
// An honest limit: a determined person can fake their position. This raises the
// effort of marking attendance from home; it does not make it impossible. The
// audit trail is what makes misuse visible afterwards, which is the real
// deterrent.
function GeoGate({ action, label, children, onBlocked }) {
  const [state, setState] = useState("idle");   // idle | checking | inside | outside | error | off
  const [info, setInfo] = useState(null);
  const [msg, setMsg] = useState("");

  const check = async () => {
    setState("checking"); setMsg("");
    let fence = null;
    try { fence = await geofenceGet(); } catch (e) { /* treat as off */ }

    if (!fence?.enabled || fence.lat == null || fence.lng == null
        || !(fence.enforce || []).includes(action)) {
      setState("off"); return true;
    }

    try {
      const pos = await currentPosition();
      const d = metresBetween(pos, { lat: fence.lat, lng: fence.lng });
      const radius = fence.radius_m || 300;
      // A weak fix should not fail an honest person, so the reading's own
      // margin of error is allowed for.
      const inside = d - (pos.accuracy || 0) <= radius;
      setInfo({ ...pos, distance: d, radius });
      try { await locationRecord(action, pos, d, inside, label); } catch (e) {}
      if (inside) { setState("inside"); return true; }
      setState("outside");
      onBlocked?.(d);
      return false;
    } catch (e) {
      setMsg(String(e.message || e));
      try { await locationRecord(action, null, null, false, "check failed: " + String(e.message || e)); } catch (_) {}
      setState("error");
      return false;
    }
  };

  useEffect(() => { check(); /* eslint-disable-next-line */ }, [action]);

  if (state === "off" || state === "inside") {
    return (
      <>
        {state === "inside" && (
          <div className="enter" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
                padding: "7px 11px", borderRadius: 20, background: "#E4F0E8", border: "1px solid #B8D9C4",
                fontFamily: FONT.mono, fontSize: 10.5, color: "#2E6B4F", width: "fit-content" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#3F7A5C" }} />
            AT SCHOOL · {info?.distance}m from the centre
          </div>
        )}
        {children}
      </>
    );
  }

  if (state === "checking") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 14px",
            background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 5 }}>
        <svg className="spin" width="17" height="17" viewBox="0 0 24 24" fill="none"
             stroke="#C98A2C" strokeWidth="2.4" strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-6.2-8.6" />
        </svg>
        <span style={{ fontFamily: FONT.body, fontSize: 13, color: "#6B6552" }}>
          Checking that you are at school…
        </span>
      </div>
    );
  }

  return (
    <div className="enter" style={{ padding: "14px 15px", borderRadius: 5,
          background: "#F7E4E1", border: "1px solid #E8C4BD", borderLeft: "4px solid #B84C3E" }}>
      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 700, color: "#22304A" }}>
        {state === "outside" ? "You are not at school" : "Location could not be confirmed"}
      </div>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginTop: 5, lineHeight: 1.55 }}>
        {state === "outside"
          ? <>{label} may only be done on the school grounds. You appear to be{" "}
              <strong>{info?.distance}m</strong> away; the boundary is {info?.radius}m.</>
          : msg}
      </div>
      <button onClick={check} style={{ ...primaryBtn(), marginTop: 11 }}>Check again</button>
      <div style={{ fontFamily: FONT.body, fontSize: 11, color: "#8A8368", marginTop: 9, lineHeight: 1.5 }}>
        If you are at school and this keeps failing, move outside or near a window — walls and
        metal roofing weaken the signal. The administrator can record it for you instead.
      </div>
    </div>
  );
}

// ---------- Admin: set the school's boundary ----------
function GeofenceSettings({ who }) {
  const [fence, setFence] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [log, setLog] = useState(null);

  const load = async () => {
    try { setFence(await geofenceGet() || { enabled: false, radius_m: 300, enforce: ["signin","attendance"] }); }
    catch (e) { setErr("Could not read the current setting."); }
    try { setLog(await locationRecent(14)); } catch (e) { setLog([]); }
  };
  useEffect(() => { load(); }, []);

  const save = async (next) => {
    setBusy(true); setErr(""); setMsg("");
    try { await geofenceSet(next); setFence(next); setMsg("Saved."); await load(); }
    catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const useMyPosition = async () => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const p = await currentPosition();
      await save({ ...fence, lat: p.lat, lng: p.lng });
      setMsg(`Centre set to where you are now (accurate to about ${p.accuracy}m).`);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  if (!fence) return <div style={{ height: 90 }} className="skeleton" />;

  const ACTIONS = [
    ["signin", "Arrival sign-in", "Stops a teacher signing in from home"],
    ["attendance", "Marking pupil attendance", "Registers must be taken in the classroom"],
    ["marks", "Entering exam marks", "Optional — often done at home legitimately"],
    ["fees", "Recording fee payments", "Money should be handled at the office"],
  ];
  const toggle = (k) => {
    const on = (fence.enforce || []).includes(k);
    save({ ...fence, enforce: on ? fence.enforce.filter((x) => x !== k) : [...(fence.enforce || []), k] });
  };

  return (
    <div>
      <SectionTitle>School boundary</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14, lineHeight: 1.6 }}>
        Some actions can be limited to the school grounds. Every check is recorded whether it passes
        or fails, so you can see who tried from where.
      </div>

      <div style={{ padding: "11px 13px", background: "#F5E8DC", border: "1px solid #E8CBA0",
            borderRadius: 4, fontFamily: FONT.body, fontSize: 12, color: "#22304A",
            marginBottom: 16, lineHeight: 1.55 }}>
        <strong>What this can and cannot do.</strong> A phone's reported position can be faked by
        someone determined. Treat this as a deterrent against convenience, not a lock — the record
        below is what makes misuse visible.
      </div>

      {err && <div style={{ padding: "9px 12px", borderRadius: 4, background: "#F7E4E1",
            border: "1px solid #E8C4BD", fontFamily: FONT.body, fontSize: 12.5, color: "#B84C3E", marginBottom: 12 }}>{err}</div>}
      {msg && <div style={{ padding: "9px 12px", borderRadius: 4, background: "#E4F0E8",
            border: "1px solid #B8D9C4", fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", marginBottom: 12 }}>{msg}</div>}

      <button onClick={() => save({ ...fence, enabled: !fence.enabled })} disabled={busy}
        style={{ ...primaryBtn(), background: fence.enabled ? "#3F7A5C" : "#8A8368", marginBottom: 16 }}>
        {fence.enabled ? "✓ Boundary is on" : "Boundary is off — turn it on"}
      </button>

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>
        Where the school is
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <input type="number" step="0.000001" placeholder="Latitude" value={fence.lat ?? ""}
          onChange={(e) => setFence({ ...fence, lat: e.target.value === "" ? null : +e.target.value })}
          style={{ ...darkInput(), width: 150 }} />
        <input type="number" step="0.000001" placeholder="Longitude" value={fence.lng ?? ""}
          onChange={(e) => setFence({ ...fence, lng: e.target.value === "" ? null : +e.target.value })}
          style={{ ...darkInput(), width: 150 }} />
        <button onClick={() => save(fence)} disabled={busy} style={primaryBtn()}>Save</button>
      </div>
      <button onClick={useMyPosition} disabled={busy}
        style={{ ...primaryBtn(), background: "#22304A", marginBottom: 16 }}>
        {busy ? "Reading…" : "Use where I am standing now"}
      </button>
      <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#8A8368", marginBottom: 18 }}>
        Stand in the middle of the compound and tap the button. That is more accurate than typing
        coordinates from a map.
      </div>

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 6 }}>
        How far the boundary reaches
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18, flexWrap: "wrap" }}>
        <input type="range" min="100" max="1000" step="50" value={fence.radius_m || 300}
          onChange={(e) => setFence({ ...fence, radius_m: +e.target.value })}
          onMouseUp={() => save(fence)} onTouchEnd={() => save(fence)}
          style={{ flex: 1, minWidth: 170, accentColor: "#E8B23D" }} />
        <span style={{ fontFamily: FONT.mono, fontSize: 14, fontWeight: 700, color: "#22304A", minWidth: 62 }}>
          {fence.radius_m || 300} m
        </span>
      </div>
      <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#8A8368", marginTop: -12, marginBottom: 20 }}>
        Allow generously. A phone under an iron roof can be 50–100m out, and a boundary set too
        tightly will lock out honest staff.
      </div>

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>
        What the boundary applies to
      </div>
      <div style={{ display: "grid", gap: 6, marginBottom: 22 }}>
        {ACTIONS.map(([k, label, why]) => {
          const on = (fence.enforce || []).includes(k);
          return (
            <button key={k} onClick={() => toggle(k)} disabled={busy} className="lift"
              style={{ display: "flex", alignItems: "center", gap: 11, textAlign: "left",
                padding: "10px 12px", borderRadius: 4, cursor: "pointer",
                background: on ? "#E4F0E8" : "#F5F1E6",
                border: `1px solid ${on ? "#3F7A5C" : "#E4DFCF"}` }}>
              <span style={{ width: 17, height: 17, borderRadius: 3, flex: "0 0 17px",
                border: `1.5px solid ${on ? "#3F7A5C" : "#B8B2A0"}`,
                background: on ? "#3F7A5C" : "transparent", color: "#fff",
                fontSize: 12, lineHeight: "15px", textAlign: "center" }}>{on ? "✓" : ""}</span>
              <span>
                <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", fontWeight: 600 }}>{label}</span>
                <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#6B6552", marginTop: 2 }}>{why}</div>
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>
        Recent location checks
      </div>
      {log === null && <div className="skeleton" style={{ height: 60 }} />}
      {log && log.length === 0 && (
        <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Nothing recorded yet.</div>
      )}
      <div style={{ display: "grid", gap: 4 }}>
        {(log || []).slice(0, 40).map((r, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap",
                padding: "7px 11px", borderRadius: 3, background: "#F5F1E6",
                border: "1px solid #E4DFCF",
                borderLeft: `3px solid ${r.inside ? "#3F7A5C" : "#B84C3E"}` }}>
            <span style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#22304A" }}>
              {r.staff_name} <span style={{ color: "#8A8368" }}>· {r.action}</span>
            </span>
            <span style={{ fontFamily: FONT.mono, fontSize: 10.5, color: r.inside ? "#3F7A5C" : "#B84C3E" }}>
              {r.distance_m === null ? "no fix" : `${Math.round(r.distance_m)}m`}
              {r.accuracy_m ? ` ±${Math.round(r.accuracy_m)}` : ""} ·{" "}
              {new Date(r.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


// ---------- Fee statement: the full record, paid or not ----------
// A parent who has paid nothing still needs a statement — it is how they learn
// what is owed. A blank screen for the unpaid is the commonest failing in fee
// software, so this always renders.
function FeeStatement({ roster, student, term, onBack }) {
  const cur = roster.settings.currency || "KSh";
  const due = student.feeDue || 0;
  const paid = student.feePaid || 0;
  const balance = due - paid;
  const pays = [...(student.payments || [])].sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  let running = 0;
  const rows = pays.map((p) => { running += p.amount || 0; return { ...p, balanceAfter: due - running }; });
  const share = due ? Math.min(100, Math.round((paid / due) * 100)) : 0;

  return (
    <DocShell title="Fee statement" onBack={onBack}>
      <DocHeader subtitle={`Fee Statement — ${term}`} />
      <DocInfo roster={roster} student={student} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, margin: "6px 0 18px" }}>
        {[["TOTAL FEE DUE", `${cur}${money(due)}`, "#22304A"],
          ["PAID TO DATE", `${cur}${money(paid)}`, "#3F7A5C"],
          ["BALANCE", `${cur}${money(balance)}`, balance > 0 ? "#B84C3E" : "#3F7A5C"]].map(([l, v, ink]) => (
          <div key={l} style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "10px 11px",
                background: "#F5F1E6", textAlign: "center" }}>
            <div style={{ fontFamily: FONT.mono, fontSize: 8, color: "#8A8368", letterSpacing: 1 }}>{l}</div>
            <div style={{ fontSize: 16, fontWeight: "bold", marginTop: 3, color: ink }}>{v}</div>
          </div>
        ))}
      </div>

      {/* a bar reads faster than three figures */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ height: 9, background: "#EFEADC", borderRadius: 5, overflow: "hidden", border: "1px solid #E4DFCF" }}>
          <div style={{ height: "100%", width: `${share}%`,
                background: share >= 100 ? "#3F7A5C" : share >= 50 ? "#C98A2C" : "#B84C3E" }} />
        </div>
        <div style={{ fontSize: 10.5, color: "#6B6552", marginTop: 4, fontFamily: FONT.mono }}>
          {share}% of the term's fee has been paid
        </div>
      </div>

      <div style={{ fontWeight: "bold", marginBottom: 7 }}>Payments received</div>
      {rows.length === 0 ? (
        <div style={{ padding: "16px 14px", border: "1px dashed #B8B2A0", borderRadius: 4,
              background: "#F5F1E6", marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: "bold", color: "#B84C3E" }}>
            No payment has been received for {term}.
          </div>
          <div style={{ fontSize: 11.5, color: "#6B6552", marginTop: 5, lineHeight: 1.55 }}>
            The full amount of {cur}{money(due)} is outstanding. This statement is issued so the
            position is clear; it is not a receipt. A receipt is given for each payment made.
          </div>
        </div>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 18 }}>
          <thead>
            <tr>
              <th style={docTh}>Date</th>
              <th style={docTh}>Receipt</th>
              <th style={docTh}>Method</th>
              <th style={{ ...docTh, textAlign: "right" }}>Amount</th>
              <th style={{ ...docTh, textAlign: "right" }}>Balance after</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={i}>
                <td style={{ ...docTd, fontSize: 11 }}>{fmtDate(p.date)}</td>
                <td style={{ ...docTd, fontFamily: FONT.mono, fontSize: 10.5 }}>
                  {p.receiptNo || "—"}
                  {p.mpesaCode && <div style={{ color: "#3F7A5C", fontSize: 9 }}>{p.mpesaCode}</div>}
                </td>
                <td style={{ ...docTd, fontSize: 11, textTransform: "capitalize" }}>{p.method || "cash"}</td>
                <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontSize: 11.5, fontWeight: 700 }}>
                  {cur}{money(p.amount)}
                </td>
                <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontSize: 11,
                      color: p.balanceAfter > 0 ? "#B84C3E" : "#3F7A5C" }}>
                  {cur}{money(p.balanceAfter)}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} style={{ ...docTd, borderTop: "2px solid #22304A", fontWeight: "bold" }}>Total received</td>
              <td style={{ ...docTd, borderTop: "2px solid #22304A", textAlign: "right",
                    fontFamily: FONT.mono, fontWeight: 700 }}>{cur}{money(paid)}</td>
              <td style={{ ...docTd, borderTop: "2px solid #22304A", textAlign: "right",
                    fontFamily: FONT.mono, fontWeight: 700,
                    color: balance > 0 ? "#B84C3E" : "#3F7A5C" }}>{cur}{money(balance)}</td>
            </tr>
          </tbody>
        </table>
      )}

      <div style={{ fontSize: 10.5, color: "#6B6552", lineHeight: 1.55, marginBottom: 26 }}>
        {balance > 0
          ? `An amount of ${cur}${money(balance)} remains outstanding. Please settle it at the school office, or speak to the head teacher if payment in instalments would help.`
          : "The fee for this term has been paid in full. Thank you."}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 18 }}>
        <div style={docSig}>Bursar</div>
        <div style={docSig}>Official School Stamp</div>
      </div>
    </DocShell>
  );
}


// ---------- Taking a payment ----------
// The bursar's main screen. Choosing a pupil shows what they owe before any
// figure is typed, because the commonest error is receipting the wrong child.
function FeeCollect({ roster, saveRoster, who, onReceipt }) {
  const cur = roster.settings.currency || "KSh";
  const [studentId, setStudentId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [code, setCode] = useState("");
  const [sender, setSender] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const student = roster.students.find((s) => s.id === studentId);
  const due = student?.feeDue || 0;
  const paid = student?.feePaid || 0;
  const balance = due - paid;

  const matches = q.trim()
    ? roster.students.filter((s) =>
        s.name.toLowerCase().includes(q.toLowerCase()) || s.id.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
    : [];

  const take = async () => {
    const amt = Number(amount);
    if (!student || !amt || amt <= 0) return setErr("Choose a pupil and enter an amount.");
    if (method === "mpesa" && !code.trim()) return setErr("Enter the M-Pesa confirmation code from the SMS.");
    setBusy(true); setErr("");

    let claimed = "";
    if (method === "mpesa") {
      try {
        claimed = await mpesaClaim(code, student.id, amt, todayISO(), sender);
      } catch (e) {
        setErr(String(e.message || e).replace(/^mpesa_claim \d+: /, "").slice(0, 200));
        setBusy(false); return;
      }
    }

    const receiptNo = nextReceiptNo(roster);
    const entry = { date: todayISO(), amount: amt, receiptNo, method };
    if (claimed) { entry.mpesaCode = claimed; if (sender.trim()) entry.sender = sender.trim(); }

    const next = {
      ...roster,
      students: roster.students.map((s) => s.id === student.id
        ? { ...s, feePaid: (s.feePaid || 0) + amt, payments: [...(s.payments || []), entry] } : s),
    };
    saveRoster(logAction(next, who?.name || "Bursar",
      `Receipt ${receiptNo} — ${cur}${money(amt)} from ${student.name}${claimed ? " (M-Pesa " + claimed + ")" : ""}`),
      `${receiptNo} · ${cur}${money(amt)} received`);

    onReceipt?.({ student: { ...student, feePaid: paid + amt }, payment: entry });
    setAmount(""); setCode(""); setSender(""); setStudentId(""); setQ("");
    setBusy(false);
  };

  return (
    <div>
      <SectionTitle>Record a payment</SectionTitle>

      {/* find the pupil */}
      {!student ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            placeholder="Type the pupil's name or admission number"
            style={{ ...darkInput(), width: "100%", marginBottom: 9 }} />
          {q.trim() && matches.length === 0 && (
            <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No pupil matches that.</div>
          )}
          <div style={{ display: "grid", gap: 5 }}>
            {matches.map((s) => {
              const b = (s.feeDue || 0) - (s.feePaid || 0);
              return (
                <button key={s.id} onClick={() => { setStudentId(s.id); setErr(""); }} className="lift enter"
                  style={{ display: "flex", justifyContent: "space-between", gap: 9, textAlign: "left",
                    padding: "10px 12px", borderRadius: 4, cursor: "pointer",
                    background: "#F5F1E6", border: "1px solid #E4DFCF" }}>
                  <span>
                    <span style={{ fontFamily: FONT.body, fontSize: 13.5, fontWeight: 600, color: "#22304A" }}>{s.name}</span>
                    <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#8A8368" }}>
                      {s.id} · {classNameOf(roster, s.classId)}
                    </div>
                  </span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 11.5, alignSelf: "center",
                        color: b > 0 ? "#B84C3E" : "#3F7A5C" }}>
                    {b > 0 ? `owes ${cur}${money(b)}` : "cleared"}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="enter">
          {/* what this pupil owes, before any figure is typed */}
          <div style={{ background: "#22304A", color: "#fff", borderRadius: 5, padding: "13px 15px", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <span>
                <span style={{ fontFamily: FONT.display, fontSize: 17, fontWeight: 700 }}>{student.name}</span>
                <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "rgba(255,255,255,.65)", marginTop: 2 }}>
                  {student.id} · {classNameOf(roster, student.classId)}
                </div>
              </span>
              <button onClick={() => { setStudentId(""); setQ(""); }}
                style={{ background: "none", border: "1px solid rgba(255,255,255,.3)", color: "#fff",
                  borderRadius: 3, padding: "5px 11px", fontFamily: FONT.mono, fontSize: 11, cursor: "pointer" }}>
                change
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9, marginTop: 12 }}>
              {[["FEE DUE", due, "rgba(255,255,255,.9)"], ["PAID", paid, "#8FD3A8"],
                ["BALANCE", balance, balance > 0 ? "#F0A08F" : "#8FD3A8"]].map(([l, v, ink]) => (
                <div key={l}>
                  <div style={{ fontFamily: FONT.mono, fontSize: 8.5, letterSpacing: 1,
                        color: "rgba(255,255,255,.5)" }}>{l}</div>
                  <div style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 700, color: ink, marginTop: 2 }}>
                    {cur}{money(v)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 7, marginBottom: 11, flexWrap: "wrap" }}>
            {[["cash", "Cash"], ["mpesa", "M-Pesa"], ["bank", "Bank"]].map(([k, l]) => (
              <button key={k} onClick={() => { setMethod(k); setErr(""); }}
                style={{ padding: "7px 16px", borderRadius: 18, fontFamily: FONT.body, fontSize: 13, fontWeight: 600,
                  cursor: "pointer",
                  border: `1px solid ${method === k ? "#22304A" : "#D8D2C2"}`,
                  background: method === k ? "#22304A" : "#fff",
                  color: method === k ? "#fff" : "#6B6552" }}>{l}</button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 9, flexWrap: "wrap", alignItems: "center" }}>
            <input type="number" inputMode="numeric" value={amount} min="1"
              onChange={(e) => { setAmount(e.target.value); setErr(""); }}
              placeholder={`Amount in ${cur}`} autoFocus
              style={{ ...darkInput(), flex: 1, minWidth: 130, fontFamily: FONT.mono, fontSize: 16 }} />
            {balance > 0 && (
              <button onClick={() => setAmount(String(balance))}
                style={{ ...backBtnStyle(), color: "#22304A", whiteSpace: "nowrap" }}>
                pay the balance
              </button>
            )}
          </div>

          {method === "mpesa" && (
            <div style={{ display: "flex", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
              <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setErr(""); }}
                placeholder="M-Pesa code, e.g. TFH5XY9Z12" autoCapitalize="characters"
                style={{ ...darkInput(), flex: 1, minWidth: 170, fontFamily: FONT.mono, letterSpacing: 1 }} />
              <input value={sender} onChange={(e) => setSender(e.target.value)}
                placeholder="Sent from (phone)" inputMode="tel"
                style={{ ...darkInput(), flex: 1, minWidth: 140 }} />
            </div>
          )}

          {err && (
            <div className="enter" style={{ padding: "9px 12px", borderRadius: 4, background: "#F7E4E1",
                  border: "1px solid #E8C4BD", fontFamily: FONT.body, fontSize: 12.5,
                  color: "#B84C3E", marginBottom: 9, lineHeight: 1.5 }}>{err}</div>
          )}

          <button onClick={take} disabled={busy || !amount}
            style={{ ...primaryBtn(), opacity: busy || !amount ? 0.5 : 1, fontSize: 15, padding: "11px 20px" }}>
            {busy ? "Recording…" : `Take ${amount ? cur + money(Number(amount)) : "payment"} and print receipt`}
          </button>

          {method === "mpesa" && (
            <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#6B6552", marginTop: 9, lineHeight: 1.5 }}>
              Each M-Pesa code can only be recorded once. If it has been used before the payment is
              refused and nothing is written, so the same SMS cannot be counted twice.
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ---------- History: previous years and terms ----------
// Once a year is archived its marks and attendance are cleared from the live
// roster, so without this the record is stored but unreachable. This reads an
// archived snapshot without restoring it — looking back should never risk the
// current year.
function History({ roster }) {
  const [yearIdx, setYearIdx] = useState(null);
  const [classId, setClassId] = useState("");
  const [term, setTerm] = useState("");
  const cur = roster.settings.currency || "KSh";

  const archives = [...(roster.archives || [])].sort((a, b) => String(b.year).localeCompare(String(a.year)));

  if (archives.length === 0) {
    return (
      <div>
        <SectionTitle>History</SectionTitle>
        <div style={{ padding: "14px 15px", background: "#F5F1E6", border: "1px solid #E4DFCF",
              borderRadius: 5, fontFamily: FONT.body, fontSize: 13, color: "#22304A", lineHeight: 1.6 }}>
          No year has been archived yet.
          <div style={{ marginTop: 7, color: "#6B6552" }}>
            At the close of a school year, use <strong>End of year → Archive year</strong>. A full copy is
            kept and appears here, so past results and attendance stay readable even after the live
            roster is cleared for the new year.
          </div>
        </div>
      </div>
    );
  }

  const snap = yearIdx !== null ? archives[yearIdx]?.snapshot : null;

  // reading an archived snapshot uses the same shapes as the live roster
  const archClassName = (id) => snap?.classes?.find((c) => c.id === id)?.name || "Unknown class";
  const termsFor = (cid) => Object.keys(snap?.marks?.[cid] || {});

  return (
    <div>
      <SectionTitle>History</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14, lineHeight: 1.6 }}>
        Closed years, kept whole. Looking at one does not touch the current year.
      </div>

      {/* pick a year */}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 16 }}>
        {archives.map((a, i) => (
          <button key={i} onClick={() => { setYearIdx(i === yearIdx ? null : i); setClassId(""); setTerm(""); }}
            style={{ padding: "8px 15px", borderRadius: 18, fontFamily: FONT.body, fontSize: 13.5,
              fontWeight: 700, cursor: "pointer",
              border: `1px solid ${yearIdx === i ? "#22304A" : "#D8D2C2"}`,
              background: yearIdx === i ? "#22304A" : "#fff",
              color: yearIdx === i ? "#fff" : "#6B6552" }}>
            {a.year}
          </button>
        ))}
      </div>

      {yearIdx === null && (
        <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>Choose a year to look at.</div>
      )}

      {snap && (
        <div className="enter">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))",
                gap: 10, marginBottom: 18 }}>
            <StatCard label="Pupils" value={(snap.students || []).length} />
            <StatCard label="Classes" value={(snap.classes || []).length} />
            <StatCard label="Teachers" value={(snap.teachers || []).length} />
            <StatCard label="Archived" value={new Date(archives[yearIdx].savedAt)
              .toLocaleDateString(undefined, { day: "numeric", month: "short" })} />
          </div>

          <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>
            Results by class
          </div>
          <select value={classId} onChange={(e) => { setClassId(e.target.value); setTerm(""); }}
            style={{ ...darkInput(), width: "100%", maxWidth: 320, marginBottom: 10 }}>
            <option value="">Choose a class…</option>
            {(snap.classes || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({termsFor(c.id).length} term{termsFor(c.id).length === 1 ? "" : "s"} recorded)
              </option>
            ))}
          </select>

          {classId && (
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>
              {termsFor(classId).length === 0 && (
                <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>
                  No results were recorded for this class.
                </div>
              )}
              {termsFor(classId).map((t) => (
                <button key={t} onClick={() => setTerm(t === term ? "" : t)}
                  style={{ padding: "6px 13px", borderRadius: 16, fontFamily: FONT.body, fontSize: 12.5,
                    cursor: "pointer",
                    border: `1px solid ${term === t ? "#3F7A5C" : "#D8D2C2"}`,
                    background: term === t ? "#E4F0E8" : "#fff",
                    color: term === t ? "#2E6B4F" : "#6B6552", fontWeight: 600 }}>
                  {t.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          )}

          {classId && term && <HistoryMarks snap={snap} classId={classId} term={term} />}

          {/* fee position as it stood at the close of that year */}
          <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A",
                margin: "22px 0 8px" }}>
            Fee position at the close of {archives[yearIdx].year}
          </div>
          {(() => {
            const st = snap.students || [];
            const due = st.reduce((a, s) => a + (s.feeDue || 0), 0);
            const paid = st.reduce((a, s) => a + (s.feePaid || 0), 0);
            const unpaid = st.filter((s) => (s.feePaid || 0) < (s.feeDue || 0)).length;
            return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 10 }}>
                <StatCard label="Expected" value={`${cur}${money(due)}`} />
                <StatCard label="Collected" value={`${cur}${money(paid)}`} tone="#3F7A5C" />
                <StatCard label="Uncollected" value={`${cur}${money(due - paid)}`}
                  tone={due - paid > 0 ? "#B84C3E" : "#3F7A5C"} />
                <StatCard label="Left owing" value={unpaid} tone={unpaid ? "#C98A2C" : "#3F7A5C"} />
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// One archived class-term, ranked as it was.
function HistoryMarks({ snap, classId, term }) {
  const rec = snap.marks?.[classId]?.[term];
  const grid = rec?.grid || {};
  const students = (snap.students || []).filter((s) => s.classId === classId);
  const weights = snap.settings?.weights || DEFAULT_WEIGHTS;

  const ranked = students.map((st) => {
    const subs = grid[st.id] || {};
    const marks = Object.entries(subs).map(([sub, v]) => {
      const final = Math.round(((v.cat1 || 0) * weights.cat1 + (v.cat2 || 0) * weights.cat2
        + (v.exam || 0) * weights.exam) / 100);
      return { sub, final };
    });
    const avg = marks.length ? Math.round(marks.reduce((a, m) => a + m.final, 0) / marks.length) : 0;
    return { st, marks, avg };
  }).filter((r) => r.marks.length > 0)
    .sort((a, b) => b.avg - a.avg)
    .map((r, i) => ({ ...r, position: i + 1 }));

  if (ranked.length === 0) {
    return <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>
      No marks were entered for this term.
    </div>;
  }

  return (
    <div style={{ display: "grid", gap: 5 }} className="enter">
      {ranked.map((r) => (
        <div key={r.st.id} style={{ padding: "9px 12px", background: "#F5F1E6",
              border: "1px solid #E4DFCF", borderRadius: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
            <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", fontWeight: 600 }}>
              <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#8A8368", marginRight: 7 }}>
                #{r.position}
              </span>{r.st.name}
            </span>
            <span style={{ fontFamily: FONT.mono, fontSize: 12, color: gradeInk(r.avg) }}>
              avg {r.avg} · {gradeOf(r.avg)}
            </span>
          </div>
          <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#6B6552", marginTop: 4 }}>
            {r.marks.map((m) => `${m.sub} ${m.final}`).join(" · ")}
          </div>
        </div>
      ))}
    </div>
  );
}


// ---------- Printable fee roll ----------
// The sheet the office actually needs: every pupil, what they owe, what they
// have paid, and where they stand — on paper, so it can be worked through at a
// desk or pinned up for the bursar to tick off.
function FeeRoll({ roster, filter, classId, onBack }) {
  const cur = roster.settings.currency || "KSh";

  const all = roster.students
    .filter((s) => !classId || s.classId === classId)
    .map((s) => {
      const due = s.feeDue || 0, paid = s.feePaid || 0;
      return { s, due, paid, bal: due - paid,
               state: paid <= 0 ? "none" : paid < due ? "part" : "full" };
    });

  const rows = all
    .filter((r) => filter === "all" ? true
                 : filter === "cleared" ? r.state === "full"
                 : filter === "owing" ? r.state !== "full"
                 : r.state === "none")
    .sort((a, b) => {
      // worst first when listing debtors; alphabetical when listing the cleared
      if (filter === "cleared") return a.s.name.localeCompare(b.s.name);
      if (b.bal !== a.bal) return b.bal - a.bal;
      return a.s.name.localeCompare(b.s.name);
    });

  const t = rows.reduce((a, r) => ({ due: a.due + r.due, paid: a.paid + r.paid, bal: a.bal + r.bal }),
                        { due: 0, paid: 0, bal: 0 });

  const TITLE = {
    all: "Fee Roll — all pupils",
    owing: "Fee Roll — pupils with a balance",
    none: "Fee Roll — pupils who have paid nothing",
    cleared: "Fee Roll — pupils paid in full",
  }[filter];

  return (
    <DocShell title="Fee roll" onBack={onBack}>
      <DocHeader subtitle={TITLE} />

      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap",
            gap: 8, marginBottom: 14, fontSize: 12 }}>
        <div><strong>Class:</strong> {classId ? classNameOf(roster, classId) : "All classes"}</div>
        <div><strong>Term:</strong> {DEFAULT_TERM}</div>
        <div><strong>Printed:</strong> {fmtDate(todayISO())}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 9, marginBottom: 16 }}>
        {[["PUPILS", rows.length, "#22304A"],
          ["EXPECTED", `${cur}${money(t.due)}`, "#22304A"],
          ["COLLECTED", `${cur}${money(t.paid)}`, "#3F7A5C"],
          ["OUTSTANDING", `${cur}${money(t.bal)}`, t.bal > 0 ? "#B84C3E" : "#3F7A5C"]].map(([l, v, ink]) => (
          <div key={l} style={{ border: "1px solid #E4DFCF", borderRadius: 4,
                padding: "8px 9px", background: "#F5F1E6", textAlign: "center" }}>
            <div style={{ fontFamily: FONT.mono, fontSize: 7.5, color: "#8A8368", letterSpacing: 1 }}>{l}</div>
            <div style={{ fontSize: 13.5, fontWeight: "bold", marginTop: 2, color: ink }}>{v}</div>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: "18px 14px", border: "1px dashed #B8B2A0", borderRadius: 4,
              background: "#F5F1E6", textAlign: "center", fontSize: 13, color: "#6B6552" }}>
          {filter === "owing" || filter === "none"
            ? "No pupil is in arrears. Every fee has been settled."
            : "No pupils to list."}
        </div>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 16 }}>
          <thead>
            <tr>
              <th style={{ ...docTh, width: 26 }}>#</th>
              <th style={docTh}>Pupil</th>
              <th style={docTh}>Adm No</th>
              {!classId && <th style={docTh}>Class</th>}
              <th style={{ ...docTh, textAlign: "right" }}>Fee due</th>
              <th style={{ ...docTh, textAlign: "right" }}>Paid</th>
              <th style={{ ...docTh, textAlign: "right" }}>Balance</th>
              <th style={{ ...docTh, textAlign: "center", width: 46 }}>Status</th>
              <th style={{ ...docTh, textAlign: "center", width: 62 }}>Signature</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.s.id}>
                <td style={{ ...docTd, fontFamily: FONT.mono, fontSize: 9.5, color: "#8A8368" }}>{i + 1}</td>
                <td style={{ ...docTd, fontSize: 11.5, fontWeight: 600 }}>{r.s.name}</td>
                <td style={{ ...docTd, fontFamily: FONT.mono, fontSize: 10 }}>{r.s.id}</td>
                {!classId && <td style={{ ...docTd, fontSize: 10.5 }}>{classNameOf(roster, r.s.classId)}</td>}
                <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontSize: 10.5 }}>
                  {money(r.due)}
                </td>
                <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontSize: 10.5,
                      color: r.paid > 0 ? "#3F7A5C" : "#B84C3E" }}>
                  {money(r.paid)}
                </td>
                <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontSize: 10.5,
                      fontWeight: 700, color: r.bal > 0 ? "#B84C3E" : "#3F7A5C" }}>
                  {money(r.bal)}
                </td>
                <td style={{ ...docTd, textAlign: "center", fontFamily: FONT.mono, fontSize: 8, fontWeight: 700,
                      color: r.state === "full" ? "#3F7A5C" : r.state === "part" ? "#C98A2C" : "#B84C3E" }}>
                  {r.state === "full" ? "PAID" : r.state === "part" ? "PART" : "NIL"}
                </td>
                {/* left blank on purpose: a parent signs when settling at the desk */}
                <td style={{ ...docTd }}></td>
              </tr>
            ))}
            <tr>
              <td colSpan={classId ? 3 : 4} style={{ ...docTd, borderTop: "2px solid #22304A", fontWeight: "bold" }}>
                Totals — {rows.length} pupil{rows.length === 1 ? "" : "s"}
              </td>
              <td style={{ ...docTd, borderTop: "2px solid #22304A", textAlign: "right",
                    fontFamily: FONT.mono, fontWeight: 700 }}>{money(t.due)}</td>
              <td style={{ ...docTd, borderTop: "2px solid #22304A", textAlign: "right",
                    fontFamily: FONT.mono, fontWeight: 700, color: "#3F7A5C" }}>{money(t.paid)}</td>
              <td style={{ ...docTd, borderTop: "2px solid #22304A", textAlign: "right",
                    fontFamily: FONT.mono, fontWeight: 700,
                    color: t.bal > 0 ? "#B84C3E" : "#3F7A5C" }}>{money(t.bal)}</td>
              <td colSpan={2} style={{ ...docTd, borderTop: "2px solid #22304A" }}></td>
            </tr>
          </tbody>
        </table>
      )}

      <div style={{ fontSize: 10, color: "#6B6552", lineHeight: 1.5, marginBottom: 20 }}>
        <strong>PAID</strong> — settled in full &nbsp;·&nbsp; <strong>PART</strong> — some paid, balance
        outstanding &nbsp;·&nbsp; <strong>NIL</strong> — nothing received.
        <div style={{ marginTop: 5 }}>
          This sheet lists pupils' fee balances. Keep it in the office rather than displaying it where
          pupils can read it — no child should learn of a family's debt from a notice board.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 24 }}>
        <div style={docSig}>Bursar</div>
        <div style={docSig}>Head Teacher</div>
      </div>
    </DocShell>
  );
}

// Choosing which roll to print.
function FeeRollPicker({ roster, onPrint }) {
  const [filter, setFilter] = useState("owing");
  const [classId, setClassId] = useState("");
  const cur = roster.settings.currency || "KSh";

  const pool = roster.students.filter((s) => !classId || s.classId === classId);
  const count = (f) => pool.filter((s) => {
    const due = s.feeDue || 0, paid = s.feePaid || 0;
    return f === "all" ? true
         : f === "cleared" ? paid >= due && due > 0
         : f === "owing" ? paid < due
         : paid <= 0;
  }).length;

  const OPTIONS = [
    ["owing", "Still owing", "Everyone with a balance, largest first"],
    ["none", "Paid nothing", "Those who have not paid at all"],
    ["cleared", "Paid in full", "For confirming who is settled"],
    ["all", "Everyone", "The complete roll, paid and unpaid"],
  ];

  return (
    <div>
      <SectionTitle>Printable fee list</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14, lineHeight: 1.6 }}>
        A sheet for the desk: every pupil with what they owe, what they have paid, and a column to
        sign as each settles.
      </div>

      <select value={classId} onChange={(e) => setClassId(e.target.value)}
        style={{ ...darkInput(), width: "100%", maxWidth: 320, marginBottom: 14 }}>
        <option value="">All classes ({roster.students.length} pupils)</option>
        {roster.classes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({roster.students.filter((s) => s.classId === c.id).length})
          </option>
        ))}
      </select>

      <div style={{ display: "grid", gap: 7, marginBottom: 18 }}>
        {OPTIONS.map(([k, label, why]) => {
          const n = count(k);
          const on = filter === k;
          return (
            <button key={k} onClick={() => setFilter(k)} className="lift"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                gap: 10, textAlign: "left", padding: "11px 13px", borderRadius: 4, cursor: "pointer",
                background: on ? "#E4F0E8" : "#F5F1E6",
                border: `1px solid ${on ? "#3F7A5C" : "#E4DFCF"}` }}>
              <span>
                <span style={{ fontFamily: FONT.body, fontSize: 14, fontWeight: 700, color: "#22304A" }}>{label}</span>
                <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#6B6552", marginTop: 2 }}>{why}</div>
              </span>
              <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700,
                    color: n === 0 ? "#8A8368" : on ? "#2E6B4F" : "#22304A" }}>{n}</span>
            </button>
          );
        })}
      </div>

      <button onClick={() => onPrint({ filter, classId })} style={{ ...primaryBtn(), fontSize: 14.5, padding: "11px 20px" }}>
        Open printable list
      </button>
    </div>
  );
}


// Admin gets the same printable roll as the bursar — the head teacher is the
// one who has to answer for arrears at a management meeting.
function AdminFeeRoll({ roster }) {
  const [roll, setRoll] = useState(null);
  if (roll) return <FeeRoll roster={roster} filter={roll.filter} classId={roll.classId} onBack={() => setRoll(null)} />;
  return <FeeRollPicker roster={roster} onPrint={setRoll} />;
}


// Any clash already sitting in the timetable. Useful once, after this check
// was added, and thereafter as reassurance that there are none.
function ClashReport({ roster, periods }) {
  const clashes = allTimetableClashes(roster);
  if (clashes.length === 0) return null;

  const periodLabel = (pid) => {
    const p = periods.find((x) => x.id === pid);
    return p ? `Period ${p.label}${p.time ? " (" + p.time + ")" : ""}` : pid;
  };

  return (
    <div style={{ padding: "12px 14px", borderRadius: 5, marginBottom: 16,
          background: "#F7E4E1", border: "1px solid #E8C4BD", borderLeft: "4px solid #B84C3E" }}>
      <div style={{ fontFamily: FONT.display, fontSize: 14.5, fontWeight: 700, color: "#22304A" }}>
        {clashes.length} clash{clashes.length === 1 ? "" : "es"} in the timetable
      </div>
      <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#6B6552", margin: "4px 0 9px" }}>
        These teachers are timetabled in two places at once. Remove one of each pair.
      </div>
      <div style={{ display: "grid", gap: 5 }}>
        {clashes.map((c, i) => {
          const who = roster.teachers.find((t) => t.id === c.teacherId)?.name || "Unknown teacher";
          return (
            <div key={i} style={{ padding: "8px 11px", background: "#fff", borderRadius: 3,
                  border: "1px solid #E8C4BD" }}>
              <div style={{ fontFamily: FONT.body, fontSize: 13, fontWeight: 600, color: "#22304A" }}>
                {who} — {DAY_FULL[c.day] || c.day}, {periodLabel(c.periodId)}
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#B84C3E", marginTop: 3 }}>
                {c.where.map((w) => `${classNameOf(roster, w.classId)} (${w.subject})`).join("  vs  ")}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ---------- Leave ----------
const LEAVE_KINDS = {
  annual:        { label: "Annual leave",        ink: "#3F7A5C", note: "Planned time off" },
  sick:          { label: "Sick leave",          ink: "#B84C3E", note: "Illness or medical appointment" },
  emergency:     { label: "Emergency",           ink: "#C98A2C", note: "Something urgent and unforeseen" },
  compassionate: { label: "Compassionate",       ink: "#6B5B95", note: "Bereavement or family crisis" },
  maternity:     { label: "Maternity",           ink: "#3B6E8F", note: "" },
  paternity:     { label: "Paternity",           ink: "#3B6E8F", note: "" },
  study:         { label: "Study leave",         ink: "#22304A", note: "Course or examinations" },
  unpaid:        { label: "Unpaid leave",        ink: "#8A8368", note: "" },
};
const LEAVE_TONE = {
  pending:   { bg: "#F5E8DC", edge: "#E8CBA0", ink: "#C98A2C", label: "Awaiting decision" },
  approved:  { bg: "#E4F0E8", edge: "#B8D9C4", ink: "#3F7A5C", label: "Approved" },
  declined:  { bg: "#F7E4E1", edge: "#E8C4BD", ink: "#B84C3E", label: "Declined" },
  cancelled: { bg: "#F5F1E6", edge: "#E4DFCF", ink: "#8A8368", label: "Withdrawn" },
};

// A member of staff applying for, and tracking, their own leave.
function MyLeave({ who, roster }) {
  const [rows, setRows] = useState(null);
  const [printing, setPrinting] = useState(null);
  const [form, setForm] = useState({ kind: "annual", starts: todayISO(), ends: todayISO(), reason: "", cover: "" });
  const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setRows(await leaveList(false) || []); } catch (e) { setRows([]); }
  };
  useEffect(() => { load(); }, []);

  const days = (() => {
    const a = new Date(form.starts), b = new Date(form.ends);
    if (isNaN(a) || isNaN(b) || b < a) return 0;
    return Math.round((b - a) / 86400000) + 1;
  })();

  const apply = async () => {
    if (days < 1) return setErr("Check the dates — the end cannot be before the start.");
    if (!form.reason.trim()) return setErr("Give a brief reason. The head teacher needs it to decide.");
    setBusy(true); setErr(""); setMsg("");
    try {
      await leaveApply(form.kind, form.starts, form.ends, form.reason, form.cover);
      setMsg("Your application has been sent to the head teacher.");
      setForm({ ...form, reason: "", cover: "" });
      await load();
    } catch (e) { setErr(String(e.message || e).replace(/^leave_apply \d+: /, "")); }
    setBusy(false);
  };

  const withdraw = async (id) => {
    if (!window.confirm("Withdraw this application?")) return;
    try { await leaveCancel(id); await load(); } catch (e) { setErr(String(e.message || e)); }
  };

  if (printing) {
    return <LeaveFormDoc roster={roster} application={printing} onBack={() => setPrinting(null)} />;
  }

  return (
    <div>
      <SectionTitle>Leave</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14 }}>
        Apply here and the head teacher decides. You will see the answer on this screen, and can
        print the form for your own records.
      </div>

      {err && <div className="enter" style={{ padding: "9px 12px", borderRadius: 4, background: "#F7E4E1",
            border: "1px solid #E8C4BD", fontFamily: FONT.body, fontSize: 12.5, color: "#B84C3E", marginBottom: 12 }}>{err}</div>}
      {msg && <div className="enter" style={{ padding: "9px 12px", borderRadius: 4, background: "#E4F0E8",
            border: "1px solid #B8D9C4", fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", marginBottom: 12 }}>{msg}</div>}

      <div style={{ background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 5, padding: 13, marginBottom: 20 }}>
        <div style={{ fontFamily: FONT.mono, fontSize: 9.5, letterSpacing: 1.3, color: "#8A8368",
              textTransform: "uppercase", marginBottom: 7 }}>Kind of leave</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {Object.entries(LEAVE_KINDS).map(([k, v]) => (
            <button key={k} onClick={() => { setForm({ ...form, kind: k }); setErr(""); }}
              style={{ padding: "6px 12px", borderRadius: 16, fontFamily: FONT.body, fontSize: 12, fontWeight: 600,
                cursor: "pointer",
                border: `1px solid ${form.kind === k ? v.ink : "#D8D2C2"}`,
                background: form.kind === k ? v.ink : "#fff",
                color: form.kind === k ? "#fff" : "#6B6552" }}>{v.label}</button>
          ))}
        </div>
        {LEAVE_KINDS[form.kind].note && (
          <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#8A8368", marginTop: -6, marginBottom: 10 }}>
            {LEAVE_KINDS[form.kind].note}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 9 }}>
          <span style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552" }}>From</span>
          <input type="date" value={form.starts}
            onChange={(e) => setForm({ ...form, starts: e.target.value,
              ends: e.target.value > form.ends ? e.target.value : form.ends })}
            style={{ ...darkInput(), minWidth: 140 }} />
          <span style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552" }}>to</span>
          <input type="date" value={form.ends} min={form.starts}
            onChange={(e) => setForm({ ...form, ends: e.target.value })}
            style={{ ...darkInput(), minWidth: 140 }} />
          <span style={{ fontFamily: FONT.mono, fontSize: 12, fontWeight: 700,
                color: days > 0 ? "#22304A" : "#B84C3E" }}>
            {days > 0 ? `${days} day${days === 1 ? "" : "s"}` : "check dates"}
          </span>
        </div>

        <textarea value={form.reason} onChange={(e) => { setForm({ ...form, reason: e.target.value }); setErr(""); }}
          placeholder="Reason — a sentence is enough"
          style={{ ...darkInput(), width: "100%", height: 62, resize: "vertical", marginBottom: 9 }} />

        <input value={form.cover} onChange={(e) => setForm({ ...form, cover: e.target.value })}
          placeholder="Who will take your classes? (optional but helps)"
          style={{ ...darkInput(), width: "100%", marginBottom: 11 }} />

        <button onClick={apply} disabled={busy || days < 1}
          style={{ ...primaryBtn(), opacity: busy || days < 1 ? 0.5 : 1 }}>
          {busy ? "Sending…" : "Apply for leave"}
        </button>
      </div>

      <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>
        Your applications
      </div>
      {rows === null && <div className="skeleton" style={{ height: 56 }} />}
      {rows && rows.length === 0 && (
        <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>You have not applied for any leave.</div>
      )}
      <div style={{ display: "grid", gap: 6 }}>
        {(rows || []).map((r) => {
          const tone = LEAVE_TONE[r.status] || LEAVE_TONE.pending;
          const kind = LEAVE_KINDS[r.kind] || { label: r.kind };
          return (
            <div key={r.id} style={{ padding: "11px 13px", borderRadius: 4, background: tone.bg,
                  border: `1px solid ${tone.edge}`, borderLeft: `4px solid ${tone.ink}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
                <span style={{ fontFamily: FONT.body, fontSize: 13.5, fontWeight: 700, color: "#22304A" }}>
                  {kind.label} · {r.days} day{r.days === 1 ? "" : "s"}
                </span>
                <span style={{ fontFamily: FONT.mono, fontSize: 9.5, fontWeight: 700, color: tone.ink }}>
                  {tone.label.toUpperCase()}
                </span>
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#6B6552", marginTop: 3 }}>
                {fmtDate(r.starts_on)} — {fmtDate(r.ends_on)}
              </div>
              {r.reason && <div style={{ fontFamily: FONT.body, fontSize: 12, color: "#22304A", marginTop: 5 }}>{r.reason}</div>}
              {r.decision_note && (
                <div style={{ fontFamily: FONT.body, fontSize: 12, color: tone.ink, marginTop: 5, fontStyle: "italic" }}>
                  {r.decided_by}: {r.decision_note}
                </div>
              )}
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                <button onClick={() => setPrinting(r)} style={{ ...primaryBtn(), padding: "6px 13px", fontSize: 12 }}>
                  Print this form
                </button>
                {r.status === "pending" && (
                  <button onClick={() => withdraw(r.id)} style={{ background: "none", border: "none",
                        color: "#B84C3E", fontFamily: FONT.mono, fontSize: 11, cursor: "pointer" }}>
                    withdraw
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The head teacher's queue.
function LeaveApprovals({ roster }) {
  const [rows, setRows] = useState(null);
  const [printing, setPrinting] = useState(null);     // one application
  const [register, setRegister] = useState(false);    // the whole register
  const [notes, setNotes] = useState({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(null);

  const load = async () => { try { setRows(await leaveList(true) || []); } catch (e) { setRows([]); } };
  useEffect(() => { load(); }, []);

  const decide = async (id, status) => {
    setBusy(id); setErr("");
    try { await leaveDecide(id, status, notes[id] || ""); await load(); }
    catch (e) { setErr(String(e.message || e)); }
    setBusy(null);
  };

  const pending = (rows || []).filter((r) => r.status === "pending");
  const decided = (rows || []).filter((r) => r.status !== "pending");
  const away = (rows || []).filter((r) => r.status === "approved"
    && todayISO() >= r.starts_on && todayISO() <= r.ends_on);

  if (printing) {
    return <LeaveFormDoc roster={roster} application={printing} onBack={() => setPrinting(null)} />;
  }
  if (register) {
    return <LeaveRegisterDoc roster={roster} rows={rows || []} from={null} to={null}
             onBack={() => setRegister(false)} />;
  }

  return (
    <div>
      <SectionTitle>Leave applications</SectionTitle>

      {away.length > 0 && (
        <div style={{ padding: "11px 13px", borderRadius: 4, background: "#E3E9F5",
              border: "1px solid #BCCAE6", borderLeft: "4px solid #3B6E8F", marginBottom: 14 }}>
          <div style={{ fontFamily: FONT.body, fontSize: 13, fontWeight: 700, color: "#22304A" }}>
            Away today
          </div>
          {away.map((r) => (
            <div key={r.id} style={{ fontFamily: FONT.body, fontSize: 12, color: "#22304A", marginTop: 3 }}>
              {r.staff_name} — {(LEAVE_KINDS[r.kind] || {}).label || r.kind}, back {fmtDate(
                new Date(new Date(r.ends_on).getTime() + 86400000).toISOString().slice(0, 10))}
              {r.cover_by ? ` · covered by ${r.cover_by}` : " · no cover arranged"}
            </div>
          ))}
        </div>
      )}

      {err && <div style={{ padding: "9px 12px", borderRadius: 4, background: "#F7E4E1",
            border: "1px solid #E8C4BD", fontFamily: FONT.body, fontSize: 12.5, color: "#B84C3E", marginBottom: 12 }}>{err}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 10, marginBottom: 14 }}>
        <StatCard label="Waiting" value={pending.length} tone={pending.length ? "#C98A2C" : "#3F7A5C"} />
        <StatCard label="Away today" value={away.length} tone={away.length ? "#3B6E8F" : "#3F7A5C"} />
        <StatCard label="Decided" value={decided.length} />
      </div>

      {(rows || []).length > 0 && (
        <button onClick={() => setRegister(true)} style={{ ...primaryBtn(), marginBottom: 18 }}>
          Print the leave register
        </button>
      )}

      {rows === null && <div className="skeleton" style={{ height: 70 }} />}
      {rows && pending.length === 0 && (
        <div style={{ padding: "12px 14px", background: "#E4F0E8", border: "1px solid #B8D9C4",
              borderRadius: 5, fontFamily: FONT.body, fontSize: 13, color: "#22304A", marginBottom: 16 }}>
          Nothing waiting for a decision.
        </div>
      )}

      <div style={{ display: "grid", gap: 8, marginBottom: 22 }}>
        {pending.map((r) => {
          const kind = LEAVE_KINDS[r.kind] || { label: r.kind, ink: "#8A8368" };
          return (
            <div key={r.id} className="enter" style={{ padding: "12px 14px", borderRadius: 5,
                  background: "#F5E8DC", border: "1px solid #E8CBA0", borderLeft: `4px solid ${kind.ink}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
                <span style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 700, color: "#22304A" }}>
                  {r.staff_name}
                </span>
                <span style={{ fontFamily: FONT.mono, fontSize: 10, fontWeight: 700, color: kind.ink }}>
                  {kind.label.toUpperCase()}
                </span>
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 11, color: "#6B6552", marginTop: 3 }}>
                {fmtDate(r.starts_on)} — {fmtDate(r.ends_on)} · {r.days} day{r.days === 1 ? "" : "s"}
              </div>
              {r.reason && <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", marginTop: 6 }}>{r.reason}</div>}
              <div style={{ fontFamily: FONT.body, fontSize: 11.5, marginTop: 5,
                    color: r.cover_by ? "#3F7A5C" : "#B84C3E" }}>
                {r.cover_by ? `Cover: ${r.cover_by}` : "No cover arranged — ask before approving"}
              </div>

              <input value={notes[r.id] || ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                placeholder="A word back to them (optional)"
                style={{ ...darkInput(), width: "100%", marginTop: 9, marginBottom: 8, fontSize: 12.5 }} />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button onClick={() => decide(r.id, "approved")} disabled={busy === r.id}
                  style={{ ...primaryBtn(), background: "#3F7A5C" }}>Approve</button>
                <button onClick={() => decide(r.id, "declined")} disabled={busy === r.id}
                  style={{ ...primaryBtn(), background: "#B84C3E" }}>Decline</button>
                <button onClick={() => setPrinting(r)} style={{ ...backBtnStyle(), color: "#22304A" }}>
                  print form
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {decided.length > 0 && (
        <>
          <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>
            Decided
          </div>
          <div style={{ display: "grid", gap: 5 }}>
            {decided.slice(0, 40).map((r) => {
              const tone = LEAVE_TONE[r.status] || LEAVE_TONE.cancelled;
              return (
                <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 9,
                      flexWrap: "wrap", padding: "8px 12px", borderRadius: 3, background: "#F5F1E6",
                      border: "1px solid #E4DFCF", borderLeft: `3px solid ${tone.ink}` }}>
                  <span style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#22304A" }}>
                    {r.staff_name} <span style={{ color: "#8A8368" }}>
                      · {(LEAVE_KINDS[r.kind] || {}).label || r.kind}</span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontFamily: FONT.mono, fontSize: 10, color: tone.ink }}>
                      {fmtDate(r.starts_on)}–{fmtDate(r.ends_on)} · {tone.label}
                    </span>
                    <button onClick={() => setPrinting(r)} style={{ background: "none", border: "none",
                          color: "#22304A", fontFamily: FONT.mono, fontSize: 10, cursor: "pointer",
                          textDecoration: "underline" }}>print</button>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}


// ---------- Expenditure ----------
// Recording where the money went. Every entry gets a voucher number, because
// "we spent it on cement" without a voucher is not an account.
function SpendRecord({ roster, who, onVoucher }) {
  const cur = roster.settings.currency || "KSh";
  const [cats, setCats] = useState([]);
  const [f, setF] = useState({ date: todayISO(), category: "", description: "", amount: "",
                               paidTo: "", method: "cash", reference: "", approvedBy: "", note: "" });
  const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);

  useEffect(() => { expenseCategories().then((c) => setCats(c || [])).catch(() => setCats([])); }, []);

  const save = async () => {
    if (!f.category) return setErr("Choose what kind of spending this is.");
    if (!f.description.trim()) return setErr("Say what the money was spent on.");
    const amt = Number(f.amount);
    if (!amt || amt <= 0) return setErr("Enter an amount.");
    setBusy(true); setErr(""); setMsg("");
    try {
      const v = await expenseAdd({ ...f, amount: amt });
      setMsg(`Recorded as voucher ${v}.`);
      setF({ ...f, description: "", amount: "", paidTo: "", reference: "", note: "" });
      onVoucher?.();
    } catch (e) { setErr(String(e.message || e).replace(/^expense_add \d+: /, "")); }
    setBusy(false);
  };

  return (
    <div>
      <SectionTitle>Record spending</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14, lineHeight: 1.6 }}>
        Every payment out gets a voucher number. Record it when it happens, not from memory at
        month end.
      </div>

      {err && <div className="enter" style={{ padding: "9px 12px", borderRadius: 4, background: "#F7E4E1",
            border: "1px solid #E8C4BD", fontFamily: FONT.body, fontSize: 12.5, color: "#B84C3E", marginBottom: 12 }}>{err}</div>}
      {msg && <div className="enter" style={{ padding: "9px 12px", borderRadius: 4, background: "#E4F0E8",
            border: "1px solid #B8D9C4", fontFamily: FONT.body, fontSize: 13, color: "#22304A",
            marginBottom: 12, fontWeight: 600 }}>{msg}</div>}

      <div style={{ background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 5, padding: 13 }}>
        <div style={{ fontFamily: FONT.mono, fontSize: 9.5, letterSpacing: 1.3, color: "#8A8368",
              textTransform: "uppercase", marginBottom: 7 }}>What kind of spending</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 13 }}>
          {cats.map((c) => (
            <button key={c.key} onClick={() => { setF({ ...f, category: c.key }); setErr(""); }}
              style={{ padding: "6px 12px", borderRadius: 16, fontFamily: FONT.body, fontSize: 12,
                fontWeight: 600, cursor: "pointer",
                border: `1px solid ${f.category === c.key ? "#22304A" : "#D8D2C2"}`,
                background: f.category === c.key ? "#22304A" : "#fff",
                color: f.category === c.key ? "#fff" : "#6B6552" }}>{c.label}</button>
          ))}
        </div>

        <input value={f.description} onChange={(e) => { setF({ ...f, description: e.target.value }); setErr(""); }}
          placeholder="What was it for? e.g. Cement for the Grade 3 classroom floor"
          style={{ ...darkInput(), width: "100%", marginBottom: 9 }} />

        <div style={{ display: "flex", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
          <input type="number" inputMode="numeric" value={f.amount} min="1"
            onChange={(e) => { setF({ ...f, amount: e.target.value }); setErr(""); }}
            placeholder={`Amount in ${cur}`}
            style={{ ...darkInput(), flex: 1, minWidth: 120, fontFamily: FONT.mono, fontSize: 15 }} />
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })}
            style={{ ...darkInput(), minWidth: 140 }} />
        </div>

        <input value={f.paidTo} onChange={(e) => setF({ ...f, paidTo: e.target.value })}
          placeholder="Paid to — supplier, contractor or member of staff"
          style={{ ...darkInput(), width: "100%", marginBottom: 9 }} />

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
          {[["cash","Cash"],["mpesa","M-Pesa"],["bank","Bank"],["cheque","Cheque"]].map(([k,l]) => (
            <button key={k} onClick={() => setF({ ...f, method: k })}
              style={{ padding: "6px 13px", borderRadius: 16, fontFamily: FONT.body, fontSize: 12,
                fontWeight: 600, cursor: "pointer",
                border: `1px solid ${f.method === k ? "#22304A" : "#D8D2C2"}`,
                background: f.method === k ? "#22304A" : "#fff",
                color: f.method === k ? "#fff" : "#6B6552" }}>{l}</button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
          <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })}
            placeholder={f.method === "mpesa" ? "M-Pesa code" : f.method === "cheque" ? "Cheque number" : "Receipt or invoice number"}
            style={{ ...darkInput(), flex: 1, minWidth: 140, fontFamily: FONT.mono }} />
          <input value={f.approvedBy} onChange={(e) => setF({ ...f, approvedBy: e.target.value })}
            placeholder="Authorised by"
            style={{ ...darkInput(), flex: 1, minWidth: 130 }} />
        </div>

        <button onClick={save} disabled={busy} style={{ ...primaryBtn(), opacity: busy ? 0.5 : 1 }}>
          {busy ? "Recording…" : "Record this payment"}
        </button>

        <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#6B6552", marginTop: 9, lineHeight: 1.5 }}>
          Keep the receipt or invoice. The voucher number written on it is what ties the paper to
          this record.
        </div>
      </div>
    </div>
  );
}

// Where the money went — the report the committee asks for.
function SpendReport({ roster, refreshKey }) {
  const cur = roster.settings.currency || "KSh";
  const [range, setRange] = useState("term");
  const [sum, setSum] = useState(null);
  const [rows, setRows] = useState(null);
  const [printing, setPrinting] = useState(false);
  const [err, setErr] = useState("");

  const bounds = () => {
    const now = new Date(), y = now.getFullYear();
    if (range === "month") return [new Date(y, now.getMonth(), 1).toISOString().slice(0,10), todayISO()];
    if (range === "year")  return [`${y}-01-01`, todayISO()];
    if (range === "all")   return [null, null];
    const m = now.getMonth();                       // rough Kenyan terms
    const t = m < 4 ? [`${y}-01-01`, `${y}-04-30`] : m < 8 ? [`${y}-05-01`, `${y}-08-31`] : [`${y}-09-01`, `${y}-12-31`];
    return t;
  };

  const load = async () => {
    const [a, b] = bounds();
    setErr("");
    try { setSum(await expenseSummary(a, b) || []); setRows(await expenseList(a, b) || []); }
    catch (e) { setErr(String(e.message || e)); setSum([]); setRows([]); }
  };
  useEffect(() => { load(); }, [range, refreshKey]);

  const total = (sum || []).reduce((a, r) => a + Number(r.total), 0);
  const collected = roster.students.reduce((a, s) => a + (s.feePaid || 0), 0);

  if (printing) {
    const [a, b] = bounds();
    return <SpendReportDoc roster={roster} sum={sum || []} rows={rows || []}
             from={a} to={b} collected={collected} onBack={() => setPrinting(false)} />;
  }

  const RANGES = [["month","This month"],["term","This term"],["year","This year"],["all","Everything"]];
  const PALETTE = ["#3F7A5C","#C98A2C","#3B6E8F","#B84C3E","#6B5B95","#2E6B4F","#8A6A2C","#22304A"];

  return (
    <div>
      <SectionTitle>Where the money went</SectionTitle>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {RANGES.map(([k, l]) => (
          <button key={k} onClick={() => setRange(k)}
            style={{ padding: "6px 13px", borderRadius: 16, fontFamily: FONT.body, fontSize: 12.5,
              fontWeight: 600, cursor: "pointer",
              border: `1px solid ${range === k ? "#22304A" : "#D8D2C2"}`,
              background: range === k ? "#22304A" : "#fff",
              color: range === k ? "#fff" : "#6B6552" }}>{l}</button>
        ))}
      </div>

      {err && <div style={{ padding: "9px 12px", borderRadius: 4, background: "#F7E4E1",
            border: "1px solid #E8C4BD", fontFamily: FONT.body, fontSize: 12.5, color: "#B84C3E", marginBottom: 12 }}>{err}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10, marginBottom: 18 }}>
        <StatCard label="Fees collected" value={`${cur}${money(collected)}`} tone="#3F7A5C" />
        <StatCard label="Spent" value={`${cur}${money(total)}`} tone="#B84C3E" />
        <StatCard label="Difference" value={`${cur}${money(collected - total)}`}
          tone={collected - total >= 0 ? "#3F7A5C" : "#B84C3E"} />
        <StatCard label="Vouchers" value={(rows || []).length} />
      </div>

      {sum === null && <div className="skeleton" style={{ height: 90 }} />}
      {sum && sum.length === 0 && (
        <div style={{ padding: "13px 15px", background: "#F5F1E6", border: "1px solid #E4DFCF",
              borderRadius: 5, fontFamily: FONT.body, fontSize: 13, color: "#6B6552" }}>
          No spending recorded for this period.
        </div>
      )}

      {sum && sum.length > 0 && (
        <>
          <div style={{ display: "grid", gap: 7, marginBottom: 18 }}>
            {sum.map((r, i) => {
              const share = total ? Math.round((Number(r.total) / total) * 100) : 0;
              const ink = PALETTE[i % PALETTE.length];
              return (
                <div key={r.category} style={{ padding: "10px 12px", background: "#F5F1E6",
                      border: "1px solid #E4DFCF", borderRadius: 4, borderLeft: `4px solid ${ink}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: FONT.body, fontSize: 13.5, fontWeight: 600, color: "#22304A" }}>
                      {r.label}
                    </span>
                    <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: ink }}>
                      {cur}{money(Number(r.total))}
                    </span>
                  </div>
                  <div style={{ height: 6, background: "#EFEADC", borderRadius: 3, marginTop: 7, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${share}%`, background: ink }} />
                  </div>
                  <div style={{ fontFamily: FONT.mono, fontSize: 10, color: "#8A8368", marginTop: 4 }}>
                    {share}% of spending · {r.items} voucher{r.items === 1 ? "" : "s"}
                  </div>
                </div>
              );
            })}
          </div>
          <button onClick={() => setPrinting(true)} style={{ ...primaryBtn(), marginBottom: 20 }}>
            Open printable report
          </button>
        </>
      )}

      {rows && rows.length > 0 && (
        <>
          <div style={{ fontFamily: FONT.display, fontSize: 15, fontWeight: 600, color: "#22304A", marginBottom: 8 }}>
            Every voucher
          </div>
          <div style={{ display: "grid", gap: 5 }}>
            {rows.map((r) => (
              <div key={r.id} style={{ padding: "9px 12px", background: "#F5F1E6",
                    border: "1px solid #E4DFCF", borderRadius: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: FONT.body, fontSize: 13, fontWeight: 600, color: "#22304A" }}>
                    {r.description}
                  </span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 12.5, fontWeight: 700, color: "#B84C3E" }}>
                    {cur}{money(Number(r.amount))}
                  </span>
                </div>
                <div style={{ fontFamily: FONT.mono, fontSize: 10, color: "#8A8368", marginTop: 3 }}>
                  {r.voucher_no} · {fmtDate(r.spent_on)} · {r.method}
                  {r.paid_to ? ` · to ${r.paid_to}` : ""}
                  {r.reference ? ` · ${r.reference}` : ""}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// The printable account: money in, money out, and what remains.
function SpendReportDoc({ roster, sum, rows, from, to, collected, onBack }) {
  const cur = roster.settings.currency || "KSh";
  const total = sum.reduce((a, r) => a + Number(r.total), 0);

  return (
    <DocShell title="Expenditure report" onBack={onBack}>
      <DocHeader subtitle="Statement of Income and Expenditure" />

      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap",
            gap: 8, marginBottom: 16, fontSize: 12 }}>
        <div><strong>Period:</strong> {from ? fmtDate(from) : "from the beginning"} — {to ? fmtDate(to) : "today"}</div>
        <div><strong>Printed:</strong> {fmtDate(todayISO())}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 11, marginBottom: 20 }}>
        {[["FEES COLLECTED", collected, "#3F7A5C"],
          ["TOTAL SPENT", total, "#B84C3E"],
          ["BALANCE", collected - total, collected - total >= 0 ? "#3F7A5C" : "#B84C3E"]].map(([l, v, ink]) => (
          <div key={l} style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "10px 11px",
                background: "#F5F1E6", textAlign: "center" }}>
            <div style={{ fontFamily: FONT.mono, fontSize: 8, color: "#8A8368", letterSpacing: 1 }}>{l}</div>
            <div style={{ fontSize: 15, fontWeight: "bold", marginTop: 3, color: ink }}>{cur}{money(v)}</div>
          </div>
        ))}
      </div>

      <div style={{ fontWeight: "bold", marginBottom: 7 }}>Spending by category</div>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 20 }}>
        <thead>
          <tr>
            <th style={docTh}>Category</th>
            <th style={{ ...docTh, textAlign: "center", width: 60 }}>Vouchers</th>
            <th style={{ ...docTh, textAlign: "right" }}>Amount</th>
            <th style={{ ...docTh, textAlign: "right", width: 60 }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {sum.map((r) => (
            <tr key={r.category}>
              <td style={{ ...docTd, fontSize: 11.5, fontWeight: 600 }}>{r.label}</td>
              <td style={{ ...docTd, textAlign: "center", fontFamily: FONT.mono, fontSize: 10.5 }}>{r.items}</td>
              <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontSize: 11.5 }}>
                {money(Number(r.total))}
              </td>
              <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontSize: 10.5, color: "#6B6552" }}>
                {total ? Math.round((Number(r.total) / total) * 100) : 0}%
              </td>
            </tr>
          ))}
          <tr>
            <td style={{ ...docTd, borderTop: "2px solid #22304A", fontWeight: "bold" }}>Total spent</td>
            <td style={{ ...docTd, borderTop: "2px solid #22304A", textAlign: "center",
                  fontFamily: FONT.mono }}>{rows.length}</td>
            <td style={{ ...docTd, borderTop: "2px solid #22304A", textAlign: "right",
                  fontFamily: FONT.mono, fontWeight: 700 }}>{money(total)}</td>
            <td style={{ ...docTd, borderTop: "2px solid #22304A" }}></td>
          </tr>
        </tbody>
      </table>

      <div style={{ fontWeight: "bold", marginBottom: 7 }}>Vouchers in detail</div>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 18 }}>
        <thead>
          <tr>
            <th style={{ ...docTh, width: 62 }}>Voucher</th>
            <th style={{ ...docTh, width: 54 }}>Date</th>
            <th style={docTh}>Description</th>
            <th style={docTh}>Paid to</th>
            <th style={{ ...docTh, width: 44 }}>Method</th>
            <th style={{ ...docTh, textAlign: "right", width: 58 }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ ...docTd, fontFamily: FONT.mono, fontSize: 9 }}>{r.voucher_no}</td>
              <td style={{ ...docTd, fontSize: 9.5 }}>{fmtDate(r.spent_on)}</td>
              <td style={{ ...docTd, fontSize: 10.5 }}>
                {r.description}
                {r.reference && <div style={{ fontFamily: FONT.mono, fontSize: 8.5, color: "#6B6552" }}>{r.reference}</div>}
              </td>
              <td style={{ ...docTd, fontSize: 10 }}>{r.paid_to || "—"}</td>
              <td style={{ ...docTd, fontSize: 9.5, textTransform: "capitalize" }}>{r.method}</td>
              <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontSize: 10.5 }}>
                {money(Number(r.amount))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ fontSize: 10, color: "#6B6552", lineHeight: 1.55, marginBottom: 24 }}>
        Prepared from the school's own records. Each voucher number corresponds to a receipt or
        invoice held in the office. Fees collected covers the current roll; balances brought forward
        from earlier years are not included.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 26, marginTop: 26 }}>
        <div style={docSig}>Bursar</div>
        <div style={docSig}>Head Teacher</div>
        <div style={docSig}>Chair, Management Committee</div>
      </div>
    </DocShell>
  );
}


// ---------- Printable leave form ----------
// The document that goes in the staff file. Written so it stands on its own:
// someone reading it in two years should not need the portal to understand
// what was asked for, what was decided, and by whom.
function LeaveFormDoc({ roster, application, onBack }) {
  const r = application;
  const kind = LEAVE_KINDS[r.kind] || { label: r.kind };
  const tone = LEAVE_TONE[r.status] || LEAVE_TONE.pending;
  const backOn = (() => {
    const d = new Date(r.ends_on);
    if (isNaN(d)) return "";
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  return (
    <DocShell title="Leave form" onBack={onBack}>
      <DocHeader subtitle="Application for Leave of Absence" />

      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap",
            gap: 8, marginBottom: 18, fontSize: 12 }}>
        <div><strong>Reference:</strong> <span style={{ fontFamily: FONT.mono }}>LV/{String(r.id).padStart(4, "0")}</span></div>
        <div><strong>Applied:</strong> {fmtDate(String(r.applied_at).slice(0, 10))}</div>
        <div><strong>Printed:</strong> {fmtDate(todayISO())}</div>
      </div>

      {/* the decision, stated plainly at the top where it will be looked for */}
      <div style={{ border: `2px solid ${tone.ink}`, borderRadius: 4, padding: "11px 14px",
            background: tone.bg, marginBottom: 20, textAlign: "center" }}>
        <div style={{ fontFamily: FONT.mono, fontSize: 8.5, letterSpacing: 1.6, color: "#6B6552" }}>
          STATUS OF THIS APPLICATION
        </div>
        <div style={{ fontSize: 17, fontWeight: "bold", color: tone.ink, marginTop: 3,
              letterSpacing: 0.5, textTransform: "uppercase" }}>
          {tone.label}
        </div>
        {r.decided_by && (
          <div style={{ fontSize: 10.5, color: "#6B6552", marginTop: 3 }}>
            by {r.decided_by}{r.decided_at ? ` on ${fmtDate(String(r.decided_at).slice(0, 10))}` : ""}
          </div>
        )}
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 18 }}>
        <tbody>
          {[
            ["Name of applicant", r.staff_name],
            ["Kind of leave", kind.label],
            ["First day of absence", fmtDate(r.starts_on)],
            ["Last day of absence", fmtDate(r.ends_on)],
            ["Number of days", `${r.days} day${r.days === 1 ? "" : "s"}`],
            ["Expected back at work", backOn ? fmtDate(backOn) : "—"],
            ["Cover arranged with", r.cover_by || "— none recorded —"],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={{ ...docTd, width: "42%", background: "#F5F1E6", fontWeight: 600, fontSize: 11 }}>{k}</td>
              <td style={{ ...docTd, fontSize: 11.5,
                    color: v && String(v).startsWith("—") ? "#B84C3E" : "#22304A" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ fontWeight: "bold", marginBottom: 6, fontSize: 12 }}>Reason given</div>
      <div style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "11px 13px",
            background: "#FBF9F3", minHeight: 52, fontSize: 11.5, lineHeight: 1.6, marginBottom: 18 }}>
        {r.reason || "— no reason recorded —"}
      </div>

      {r.decision_note && (
        <>
          <div style={{ fontWeight: "bold", marginBottom: 6, fontSize: 12 }}>Note from the head teacher</div>
          <div style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "11px 13px",
                background: "#FBF9F3", fontSize: 11.5, lineHeight: 1.6, marginBottom: 18 }}>
            {r.decision_note}
          </div>
        </>
      )}

      <div style={{ fontSize: 10, color: "#6B6552", lineHeight: 1.55, marginBottom: 26,
            borderTop: "1px solid #E4DFCF", paddingTop: 10 }}>
        This form records an application made through the school portal and the decision taken on it.
        {r.status === "approved" && " The applicant is authorised to be absent for the days shown above."}
        {r.status === "pending" && " No decision has yet been taken. The applicant should not be absent until it has."}
        {r.status === "declined" && " The application was not granted. The applicant is expected at work as normal."}
        {" "}File a copy in the staff record.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 20 }}>
        <div style={docSig}>Applicant</div>
        <div style={docSig}>Head Teacher</div>
      </div>
    </DocShell>
  );
}

// ---------- Printable leave register ----------
// Every application over a period, for the school file and for TSC returns.
function LeaveRegisterDoc({ roster, rows, from, to, onBack }) {
  const total = rows.reduce((a, r) => a + (r.status === "approved" ? r.days : 0), 0);
  const byKind = rows.filter((r) => r.status === "approved")
    .reduce((acc, r) => { acc[r.kind] = (acc[r.kind] || 0) + r.days; return acc; }, {});

  return (
    <DocShell title="Leave register" onBack={onBack}>
      <DocHeader subtitle="Register of Staff Leave" />

      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap",
            gap: 8, marginBottom: 16, fontSize: 12 }}>
        <div><strong>Period:</strong> {from ? fmtDate(from) : "from the beginning"} — {to ? fmtDate(to) : "today"}</div>
        <div><strong>Applications:</strong> {rows.length}</div>
        <div><strong>Printed:</strong> {fmtDate(todayISO())}</div>
      </div>

      {Object.keys(byKind).length > 0 && (
        <>
          <div style={{ fontWeight: "bold", marginBottom: 6, fontSize: 12 }}>Days approved, by kind</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(92px,1fr))",
                gap: 8, marginBottom: 18 }}>
            {Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, d]) => (
              <div key={k} style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "8px 9px",
                    background: "#F5F1E6", textAlign: "center" }}>
                <div style={{ fontFamily: FONT.mono, fontSize: 7.5, color: "#8A8368", letterSpacing: 0.8 }}>
                  {((LEAVE_KINDS[k] || {}).label || k).toUpperCase()}
                </div>
                <div style={{ fontSize: 14, fontWeight: "bold", marginTop: 2,
                      color: (LEAVE_KINDS[k] || {}).ink || "#22304A" }}>{d}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {rows.length === 0 ? (
        <div style={{ padding: "18px 14px", border: "1px dashed #B8B2A0", borderRadius: 4,
              background: "#F5F1E6", textAlign: "center", fontSize: 12.5, color: "#6B6552" }}>
          No leave was applied for in this period.
        </div>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 18 }}>
          <thead>
            <tr>
              <th style={{ ...docTh, width: 24 }}>#</th>
              <th style={docTh}>Name</th>
              <th style={docTh}>Kind</th>
              <th style={{ ...docTh, width: 56 }}>From</th>
              <th style={{ ...docTh, width: 56 }}>To</th>
              <th style={{ ...docTh, textAlign: "center", width: 34 }}>Days</th>
              <th style={docTh}>Cover</th>
              <th style={{ ...docTh, textAlign: "center", width: 54 }}>Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const tone = LEAVE_TONE[r.status] || LEAVE_TONE.pending;
              return (
                <tr key={r.id}>
                  <td style={{ ...docTd, fontFamily: FONT.mono, fontSize: 9, color: "#8A8368" }}>{i + 1}</td>
                  <td style={{ ...docTd, fontSize: 11, fontWeight: 600 }}>{r.staff_name}</td>
                  <td style={{ ...docTd, fontSize: 10 }}>{(LEAVE_KINDS[r.kind] || {}).label || r.kind}</td>
                  <td style={{ ...docTd, fontSize: 9.5 }}>{fmtDate(r.starts_on)}</td>
                  <td style={{ ...docTd, fontSize: 9.5 }}>{fmtDate(r.ends_on)}</td>
                  <td style={{ ...docTd, textAlign: "center", fontFamily: FONT.mono, fontSize: 10.5 }}>{r.days}</td>
                  <td style={{ ...docTd, fontSize: 9.5, color: r.cover_by ? "#22304A" : "#B84C3E" }}>
                    {r.cover_by || "none"}
                  </td>
                  <td style={{ ...docTd, textAlign: "center", fontFamily: FONT.mono, fontSize: 8,
                        fontWeight: 700, color: tone.ink }}>
                    {r.status.toUpperCase()}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td colSpan={5} style={{ ...docTd, borderTop: "2px solid #22304A", fontWeight: "bold", fontSize: 11 }}>
                Total days approved
              </td>
              <td style={{ ...docTd, borderTop: "2px solid #22304A", textAlign: "center",
                    fontFamily: FONT.mono, fontWeight: 700 }}>{total}</td>
              <td colSpan={2} style={{ ...docTd, borderTop: "2px solid #22304A" }}></td>
            </tr>
          </tbody>
        </table>
      )}

      <div style={{ fontSize: 10, color: "#6B6552", lineHeight: 1.55, marginBottom: 24 }}>
        A record of leave applied for and decided through the school portal. Where no cover is shown,
        none was recorded at the time of application.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 20 }}>
        <div style={docSig}>Head Teacher</div>
        <div style={docSig}>Official School Stamp</div>
      </div>
    </DocShell>
  );
}

// ---------- Finance portal ----------
function FinanceView({ roster, saveRoster, who, onExit, syncState, onForceSave }) {
  const [tab, setTab] = useState("collect");
  const [menuOpen, setMenuOpen] = useState(false);
  const [statementFor, setStatementFor] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [roll, setRoll] = useState(null);
  const [spendKey, setSpendKey] = useState(0);
  const cur = roster.settings.currency || "KSh";

  if (roll) {
    return <FeeRoll roster={roster} filter={roll.filter} classId={roll.classId}
             onBack={() => setRoll(null)} />;
  }

  if (statementFor) {
    return <FeeStatement roster={roster} student={statementFor} term={DEFAULT_TERM}
             onBack={() => setStatementFor(null)} />;
  }
  if (receipt) {
    return <ReceiptDoc roster={roster} student={receipt.student} payment={receipt.payment}
             onBack={() => setReceipt(null)} />;
  }

  const NAV = [
    { title: "DAILY", items: [
      { key: "collect", label: "Record a payment", icon: "fees" },
      { key: "statements", label: "Fee statements", icon: "reports" },
    ]},
    { title: "MONEY IN", items: [
      { key: "arrears", label: "Who owes what", icon: "approvals" },
      { key: "roll", label: "Printable fee list", icon: "reports" },
      { key: "daybook", label: "Day book", icon: "backup" },
    ]},
    { title: "MONEY OUT", items: [
      { key: "spend", label: "Record spending", icon: "fees" },
      { key: "spendreport", label: "Where money went", icon: "reports" },
    ]},
  ];

  const totals = roster.students.reduce((a, s) => {
    const due = s.feeDue || 0, paid = s.feePaid || 0;
    a.due += due; a.paid += paid;
    if (paid <= 0) a.none++; else if (paid < due) a.part++; else a.full++;
    return a;
  }, { due: 0, paid: 0, none: 0, part: 0, full: 0 });

  return (
    <div>
      <PortalHeader title={SCHOOL_NAME.toUpperCase()}
        section={NAV.flatMap((g) => g.items).find((i) => i.key === tab)?.label || tab}
        onMenu={() => setMenuOpen(true)} onExit={onExit} />
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} groups={NAV} active={tab} onPick={setTab}
        heading="Finance" subheading={who?.name || "Bursar"} />

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "14px 6px 60px" }}>
        <div style={{ ...paperPanel(), padding: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))",
                gap: 10, marginBottom: 20 }}>
            <StatCard label="Expected" value={`${cur}${money(totals.due)}`} />
            <StatCard label="Collected" value={`${cur}${money(totals.paid)}`} tone="#3F7A5C" />
            <StatCard label="Outstanding" value={`${cur}${money(totals.due - totals.paid)}`}
              tone={totals.due - totals.paid > 0 ? "#B84C3E" : "#3F7A5C"} />
            <StatCard label="Nothing paid" value={totals.none} tone={totals.none ? "#B84C3E" : "#3F7A5C"} />
          </div>

          {tab === "collect" && (
            <GeoGate action="fees" label="Recording a payment">
              <FeeCollect roster={roster} saveRoster={saveRoster} who={who} onReceipt={setReceipt} />
            </GeoGate>
          )}

          {tab === "statements" && (
            <div>
              <SectionTitle>Fee statements</SectionTitle>
              <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14 }}>
                Every pupil has a statement, whether they have paid or not — it is how a family
                learns what is owed.
              </div>
              <StudentPicker roster={roster} onPick={setStatementFor} label="statement" />
            </div>
          )}

          {tab === "arrears" && <Arrears roster={roster} onStatement={setStatementFor} />}

          {tab === "roll" && <FeeRollPicker roster={roster} onPrint={setRoll} />}

          {tab === "spend" && <SpendRecord roster={roster} who={who} onVoucher={() => setSpendKey((k) => k + 1)} />}

          {tab === "spendreport" && <SpendReport roster={roster} refreshKey={spendKey} />}
          {tab === "daybook" && <DayBook roster={roster} onReceipt={setReceipt} />}
        </div>
      </div>
      <SyncBadge state={syncState} onRetry={onForceSave} />
    </div>
  );
}

// pick a pupil, grouped by class
function StudentPicker({ roster, onPick, label }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState({});
  const match = (s) => !q.trim() || s.name.toLowerCase().includes(q.toLowerCase())
    || s.id.toLowerCase().includes(q.toLowerCase());

  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name or admission number"
        style={{ ...darkInput(), width: "100%", marginBottom: 10 }} />
      <div style={{ display: "grid", gap: 6 }}>
        {roster.classes.map((c) => {
          const pupils = roster.students.filter((s) => s.classId === c.id && match(s));
          if (q.trim() && pupils.length === 0) return null;
          const isOpen = q.trim() ? true : !!open[c.id];
          return (
            <div key={c.id} style={{ border: "1px solid #E4DFCF", borderRadius: 5, overflow: "hidden" }}>
              <button onClick={() => setOpen({ ...open, [c.id]: !open[c.id] })}
                style={{ width: "100%", display: "flex", justifyContent: "space-between",
                  padding: "10px 13px", border: "none", textAlign: "left",
                  background: isOpen ? "#22304A" : "#F5F1E6", color: isOpen ? "#fff" : "#22304A",
                  fontFamily: FONT.display, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                <span>{c.name}</span>
                <span style={{ fontFamily: FONT.mono, fontSize: 11 }}>{pupils.length} {isOpen ? "▾" : "▸"}</span>
              </button>
              {isOpen && (
                <div style={{ padding: "7px 9px", display: "grid", gap: 4, background: "#FBF9F3" }}>
                  {pupils.map((s) => {
                    const bal = (s.feeDue || 0) - (s.feePaid || 0);
                    return (
                      <button key={s.id} onClick={() => onPick(s)} className="lift"
                        style={{ display: "flex", justifyContent: "space-between", gap: 9, textAlign: "left",
                          padding: "9px 11px", borderRadius: 4, cursor: "pointer",
                          background: "#F5F1E6", border: "1px solid #E4DFCF" }}>
                        <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name}</span>
                        <span style={{ fontFamily: FONT.mono, fontSize: 11,
                              color: bal > 0 ? "#B84C3E" : "#3F7A5C" }}>
                          {bal > 0 ? `owes ${money(bal)}` : "cleared"} →
                        </span>
                      </button>
                    );
                  })}
                  {pupils.length === 0 && (
                    <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#8A8368", padding: 4 }}>
                      No pupils in this class.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// who owes what, worst first
function Arrears({ roster, onStatement }) {
  const cur = roster.settings.currency || "KSh";
  const rows = roster.students
    .map((s) => ({ s, due: s.feeDue || 0, paid: s.feePaid || 0, bal: (s.feeDue || 0) - (s.feePaid || 0) }))
    .filter((r) => r.bal > 0)
    .sort((a, b) => b.bal - a.bal);

  return (
    <div>
      <SectionTitle>Who owes what</SectionTitle>
      {rows.length === 0 && (
        <div style={{ padding: "13px 15px", background: "#E4F0E8", border: "1px solid #B8D9C4",
              borderRadius: 5, fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>
          Every pupil has paid in full.
        </div>
      )}
      <div style={{ display: "grid", gap: 5 }}>
        {rows.map(({ s, due, paid, bal }) => {
          const share = due ? Math.round((paid / due) * 100) : 0;
          return (
            <button key={s.id} onClick={() => onStatement(s)} className="lift"
              style={{ textAlign: "left", padding: "10px 12px", borderRadius: 4, cursor: "pointer",
                background: "#F5F1E6", border: "1px solid #E4DFCF",
                borderLeft: `4px solid ${paid === 0 ? "#B84C3E" : "#C98A2C"}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
                <span style={{ fontFamily: FONT.body, fontSize: 13.5, fontWeight: 600, color: "#22304A" }}>
                  {s.name} <span style={{ color: "#8A8368", fontWeight: 400, fontSize: 12 }}>
                    · {classNameOf(roster, s.classId)}</span>
                </span>
                <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: "#B84C3E" }}>
                  {cur}{money(bal)}
                </span>
              </div>
              <div style={{ height: 5, background: "#EFEADC", borderRadius: 3, marginTop: 7, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${share}%`, background: share ? "#C98A2C" : "transparent" }} />
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 10, color: "#8A8368", marginTop: 4 }}>
                {paid === 0 ? "nothing paid" : `${share}% paid · ${cur}${money(paid)} of ${cur}${money(due)}`}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// every payment taken, newest first
function DayBook({ roster, onReceipt }) {
  const cur = roster.settings.currency || "KSh";
  const all = [];
  roster.students.forEach((s) => (s.payments || []).forEach((p) => all.push({ s, p })));
  all.sort((a, b) => (b.p.date || "").localeCompare(a.p.date || ""));

  const byDay = all.reduce((acc, r) => { (acc[r.p.date] = acc[r.p.date] || []).push(r); return acc; }, {});

  return (
    <div>
      <SectionTitle>Day book</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14 }}>
        Every payment taken, most recent first. Tap one to reprint its receipt.
      </div>
      {all.length === 0 && (
        <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No payments recorded yet.</div>
      )}
      <div style={{ display: "grid", gap: 11 }}>
        {Object.keys(byDay).sort().reverse().map((date) => {
          const dayTotal = byDay[date].reduce((a, r) => a + (r.p.amount || 0), 0);
          return (
            <div key={date} style={{ border: "1px solid #E4DFCF", borderRadius: 5, overflow: "hidden" }}>
              <div style={{ background: "#22304A", color: "#fff", padding: "8px 12px",
                    display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <span style={{ fontFamily: FONT.display, fontSize: 13.5, fontWeight: 600 }}>{fmtDate(date)}</span>
                <span style={{ fontFamily: FONT.mono, fontSize: 12, color: "#E8B23D" }}>
                  {cur}{money(dayTotal)}
                </span>
              </div>
              <div style={{ padding: "7px 9px", display: "grid", gap: 4, background: "#FBF9F3" }}>
                {byDay[date].map((r, i) => (
                  <button key={i} onClick={() => onReceipt({ student: r.s, payment: r.p })} className="lift"
                    style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap",
                      textAlign: "left", padding: "8px 11px", borderRadius: 3, cursor: "pointer",
                      background: "#F5F1E6", border: "1px solid #E4DFCF" }}>
                    <span style={{ fontFamily: FONT.body, fontSize: 13, color: "#22304A" }}>{r.s.name}</span>
                    <span style={{ fontFamily: FONT.mono, fontSize: 11, color: "#6B6552" }}>
                      {r.p.receiptNo || "—"} · {r.p.method || "cash"}
                      {r.p.mpesaCode ? ` · ${r.p.mpesaCode}` : ""} ·{" "}
                      <strong style={{ color: "#3F7A5C" }}>{cur}{money(r.p.amount)}</strong>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ================= PRINTABLE DOCUMENTS (inline, no pop-up) =================

// ---------- Capture or upload a pupil's photo ----------
// The image is cropped square and shrunk before upload: a passport-style
// thumbnail is all a card needs, and it keeps the database small enough that
// a whole class of photos loads quickly over mobile data.
async function shrinkToSquare(file, side = 300, quality = 0.72) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("Could not read that image"));
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("That file is not a usable image"));
    i.src = dataUrl;
  });
  const s = Math.min(img.width, img.height);
  const sx = (img.width - s) / 2, sy = (img.height - s) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = side; canvas.height = side;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, s, s, 0, 0, side, side);
  return canvas.toDataURL("image/jpeg", quality);
}

function PhotoManager({ roster, classId, actorLabel }) {
  const [selectedClass, setSelectedClass] = useState(classId || "");
  const [photos, setPhotos] = useState({});      // studentId -> dataUrl
  const [have, setHave] = useState(null);        // set of ids that have a photo
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const fileRefs = useRef({});

  const pool = selectedClass
    ? roster.students.filter((s) => s.classId === selectedClass)
    : roster.students;

  const refresh = async () => {
    try {
      const rows = await photosWhich();
      setHave(new Set((rows || []).map((r) => r.student_id)));
      setErr("");
    } catch (e) { setErr("Could not check which pupils have photos."); setHave(new Set()); }
  };
  useEffect(() => { refresh(); }, []);

  // load the actual images for whoever is on screen
  useEffect(() => {
    let cancelled = false;
    const missing = pool.filter((s) => have?.has(s.id) && !photos[s.id]).map((s) => s.id);
    if (!missing.length) return;
    photosGet(missing).then((got) => { if (!cancelled) setPhotos((p) => ({ ...p, ...got })); }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedClass, have]);

  const onPick = async (student, file) => {
    if (!file) return;
    setBusy(student.id); setErr("");
    try {
      const small = await shrinkToSquare(file);
      await photoSet(student.id, small);
      setPhotos((p) => ({ ...p, [student.id]: small }));
      setHave((h) => new Set([...(h || []), student.id]));
    } catch (e) {
      setErr(String(e.message || e).slice(0, 160));
    }
    setBusy("");
  };

  const remove = async (student) => {
    if (!window.confirm(`Remove ${student.name}'s photo?`)) return;
    setBusy(student.id);
    try {
      await photoDelete(student.id);
      setPhotos((p) => { const n = { ...p }; delete n[student.id]; return n; });
      setHave((h) => { const n = new Set(h); n.delete(student.id); return n; });
    } catch (e) { setErr(String(e.message || e).slice(0, 160)); }
    setBusy("");
  };

  const withPhoto = pool.filter((s) => have?.has(s.id)).length;

  return (
    <div>
      <SectionTitle>Pupil photos</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
        Take a photo with the camera or choose one from the phone. Each is cropped square and
        shrunk automatically, so it stays small and prints sharply on the ID card.
      </div>

      {err && (
        <div style={{ padding: "9px 12px", borderRadius: 4, background: "#F7E4E1", border: "1px solid #E8C4BD",
                      fontFamily: FONT.body, fontSize: 12.5, color: "#B84C3E", marginBottom: 12 }}>{err}</div>
      )}

      {!classId && (
        <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}
          style={{ ...darkInput(), width: "100%", maxWidth: 320, marginBottom: 12 }}>
          <option value="">All classes ({roster.students.length})</option>
          {roster.classes.map((c) => (
            <option key={c.id} value={c.id}>{c.name} ({roster.students.filter((s) => s.classId === c.id).length})</option>
          ))}
        </select>
      )}

      <div style={{ fontFamily: FONT.mono, fontSize: 11, color: "#6B6552", marginBottom: 12 }}>
        {have === null ? "checking…" : `${withPhoto} of ${pool.length} have a photo`}
      </div>

      {pool.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No pupils here yet.</div>}

      <div style={{ display: "grid", gap: 8 }}>
        {pool.map((s) => {
          const img = photos[s.id];
          const hasIt = have?.has(s.id);
          return (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px",
                  background: "#F5F1E6", border: "1px solid #E4DFCF", borderRadius: 4 }}>
              <div style={{
                width: 54, height: 54, flex: "0 0 54px", borderRadius: 4, overflow: "hidden",
                background: "#E4DFCF", border: "1px solid #D8D2C2",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {img
                  ? <img src={img} alt={s.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <span style={{ fontFamily: FONT.mono, fontSize: 9, color: "#8A8368" }}>{hasIt ? "…" : "no photo"}</span>}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A", fontWeight: 600 }}>{s.name}</div>
                <div style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#6B6552" }}>
                  {s.id} · {classNameOf(roster, s.classId)}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {/* capture=environment opens the camera straight away on a phone */}
                <input ref={(el) => { fileRefs.current[s.id] = el; }} type="file" accept="image/*" capture="environment"
                  onChange={(e) => { onPick(s, e.target.files?.[0]); e.target.value = ""; }}
                  style={{ display: "none" }} />
                <button onClick={() => fileRefs.current[s.id]?.click()} disabled={busy === s.id}
                  style={{ ...primaryBtn(), padding: "6px 11px", fontSize: 12, opacity: busy === s.id ? 0.5 : 1 }}>
                  {busy === s.id ? "saving…" : hasIt ? "Retake" : "Take photo"}
                </button>
                {hasIt && (
                  <button onClick={() => remove(s)} style={{ background: "none", border: "none", color: "#B84C3E",
                          fontFamily: FONT.mono, fontSize: 10.5 }}>remove</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Printable student ID cards with a scannable QR code ----------
// Cards are laid out two per row at roughly bank-card size, so a sheet of A4
// yields eight. The QR carries the pupil's key details, so a phone camera or
// any scanner at the gate reads them without needing the portal open.
function StudentIdCards({ roster, students, onBack, title }) {
  const [photos, setPhotos] = useState({});

  // Fetch the photos for exactly these pupils, in one request.
  useEffect(() => {
    let cancelled = false;
    photosGet(students.map((s) => s.id))
      .then((got) => { if (!cancelled) setPhotos(got); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [students]);

  // What a scanner reads. Pipe-separated so even a plain text scanner app
  // shows something readable.
  const payload = (s) => [
    SCHOOL_NAME, SCHOOL_LOCATION,
    `ADM:${s.id}`, `NAME:${s.name}`,
    `CLASS:${classNameOf(roster, s.classId)}`,
    s.parentName ? `GUARDIAN:${s.parentName}` : "",
  ].filter(Boolean).join(" | ");

  // Kenyan flag palette: black, red, white, green — with gold for the seal.
  const KE = { black: "#1A1A1A", red: "#BB0A1E", white: "#FFFFFF", green: "#1F6B3B", gold: "#E8B23D" };

  return (
    <div style={{ minHeight: "100vh", background: "#1F3A2E" }}>
      <div className="no-print" style={{ maxWidth: 820, margin: "0 auto", padding: "14px 12px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={onBack} style={{ background: "transparent", border: "1px solid #4A6E58", color: "#F5F3EE", borderRadius: 3, padding: "8px 14px", fontFamily: FONT.body, fontSize: 13 }}>← Back</button>
        <button onClick={() => window.print()} style={{ ...primaryBtn(), background: "#E8B23D", color: "#1F3A2E" }}>Print cards</button>
        <span style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#8AA090" }}>
          {students.length} card{students.length === 1 ? "" : "s"} · {title}
        </span>
      </div>

      {students.length === 0 && (
        <div className="no-print" style={{ maxWidth: 820, margin: "0 auto", padding: "0 12px 40px", fontFamily: FONT.body, fontSize: 13, color: "#B8C4B9" }}>
          No pupils to print.
        </div>
      )}

      <div className="print-doc" style={{
        maxWidth: 820, margin: "0 auto 30px", background: "#fff", padding: 16,
        borderRadius: 4, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(345px, 1fr))",
        gap: 14, alignContent: "start",
      }}>
        {students.map((s) => {
          const m = qrMatrix(payload(s));
          const qsize = m ? m.length : 0;
          const photo = photos[s.id];

          return (
            <div key={s.id} className="id-card" style={{
              breakInside: "avoid", borderRadius: 9, overflow: "hidden",
              // red edge all the way round
              border: `3px solid ${KE.red}`,
              background: KE.white, color: KE.black,
              fontFamily: "Georgia, 'Times New Roman', serif",
              display: "flex", flexDirection: "column", minHeight: 205,
              boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
            }}>
              {/* black header band with the seal and school name */}
              <div style={{ background: KE.black, color: KE.white, padding: "7px 10px", display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: "0 0 auto", background: KE.green, borderRadius: "50%", width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Seal size={21} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 9.5, fontWeight: "bold", lineHeight: 1.15, textTransform: "uppercase", letterSpacing: 0.2 }}>{SCHOOL_NAME}</div>
                  <div style={{ fontSize: 7.5, color: KE.gold, fontFamily: FONT.mono }}>{SCHOOL_LOCATION}</div>
                </div>
              </div>

              {/* flag stripe: white / red / white / green */}
              <div style={{ display: "flex", height: 4 }}>
                <div style={{ flex: 1, background: KE.white }} />
                <div style={{ flex: 1, background: KE.red }} />
                <div style={{ flex: 1, background: KE.white }} />
                <div style={{ flex: 2, background: KE.green }} />
              </div>

              {/* body */}
              <div style={{ display: "flex", gap: 10, padding: "9px 10px", flex: 1 }}>
                {/* photo */}
                <div style={{
                  width: 62, height: 74, flex: "0 0 62px", borderRadius: 4, overflow: "hidden",
                  border: `2px solid ${KE.green}`, background: "#EFEADC",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {photo
                    ? <img src={photo} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <span style={{ fontFamily: FONT.mono, fontSize: 6.5, color: "#8A8368", textAlign: "center", lineHeight: 1.3 }}>NO<br />PHOTO</span>}
                </div>

                {/* details */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: FONT.mono, fontSize: 6.5, letterSpacing: 1.2, color: KE.green, fontWeight: "bold" }}>
                    PUPIL IDENTITY CARD
                  </div>
                  <div style={{ fontSize: 14.5, fontWeight: "bold", lineHeight: 1.15, marginTop: 3 }}>{s.name}</div>
                  <div style={{ marginTop: 5, display: "grid", gap: 2, fontSize: 9 }}>
                    <div><span style={{ color: "#6B6552" }}>Adm No:</span>{" "}
                      <strong style={{ fontFamily: FONT.mono, background: KE.gold, padding: "0 3px", borderRadius: 2 }}>{s.id}</strong>
                    </div>
                    <div><span style={{ color: "#6B6552" }}>Class:</span> <strong>{classNameOf(roster, s.classId)}</strong></div>
                    {s.parentName && <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ color: "#6B6552" }}>Guardian:</span> {s.parentName}
                    </div>}
                  </div>
                </div>

                {/* scannable code */}
                <div style={{ width: 74, flex: "0 0 74px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                  {m ? (
                    <svg viewBox={`-2 -2 ${qsize + 4} ${qsize + 4}`} width="72" height="72"
                         style={{ background: KE.white, border: `1px solid ${KE.black}`, borderRadius: 3 }} shapeRendering="crispEdges">
                      <path d={qrSvgPath(m)} fill={KE.black} />
                    </svg>
                  ) : (
                    <div style={{ fontSize: 7, color: KE.red, textAlign: "center" }}>code too long</div>
                  )}
                  <div style={{ fontFamily: FONT.mono, fontSize: 6, color: KE.green, marginTop: 3, fontWeight: "bold" }}>SCAN TO VERIFY</div>
                </div>
              </div>

              {/* green footer */}
              <div style={{ background: KE.green, color: KE.white, padding: "4px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: FONT.mono, fontSize: 6.5, lineHeight: 1.3 }}>
                  If found, return to the school office
                </span>
                <span style={{ fontFamily: FONT.mono, fontSize: 6.5, color: KE.gold }}>{SCHOOL_MOTTO}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="no-print" style={{ maxWidth: 820, margin: "0 auto", padding: "0 12px 50px", fontFamily: FONT.body, fontSize: 12, color: "#8AA090", lineHeight: 1.5 }}>
        Print on card stock if you have it. Scanning a card shows the school, admission number, pupil's name,
        class and guardian.
        <div style={{ marginTop: 6, color: "#C9A227" }}>
          The parent PIN is deliberately <strong>not</strong> on the card — a lost card would otherwise give a
          stranger access to that child's records. PINs stay on the report card.
        </div>
      </div>
    </div>
  );
}

// ---------- Admin dashboard for issuing ID cards ----------
function IdCardDashboard({ roster }) {
  const [classId, setClassId] = useState("");
  const [picked, setPicked] = useState({});     // studentId -> true
  const [printing, setPrinting] = useState(null);

  const pool = classId ? roster.students.filter((s) => s.classId === classId) : roster.students;
  const chosen = pool.filter((s) => picked[s.id]);

  if (printing) {
    return <StudentIdCards roster={roster} students={printing.students}
             title={printing.title} onBack={() => setPrinting(null)} />;
  }

  return (
    <div>
      <SectionTitle>Student ID cards</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 14 }}>
        Each card carries a scannable code holding the school name, admission number, pupil's name,
        class and guardian — readable with any phone camera.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <select value={classId} onChange={(e) => { setClassId(e.target.value); setPicked({}); }}
          style={{ ...darkInput(), flex: 1, minWidth: 160 }}>
          <option value="">All classes ({roster.students.length} pupils)</option>
          {roster.classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({roster.students.filter((s) => s.classId === c.id).length})
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={() => setPrinting({ students: pool, title: classId ? classNameOf(roster, classId) : "All classes" })}
          disabled={pool.length === 0}
          style={{ ...primaryBtn(), opacity: pool.length ? 1 : 0.5 }}>
          Print all {pool.length} card{pool.length === 1 ? "" : "s"}
        </button>
        <button onClick={() => setPrinting({ students: chosen, title: `${chosen.length} selected` })}
          disabled={chosen.length === 0}
          style={{ ...primaryBtn(), background: "#3F7A5C", opacity: chosen.length ? 1 : 0.45 }}>
          Print {chosen.length} selected
        </button>
        {chosen.length > 0 && (
          <button onClick={() => setPicked({})} style={{ ...backBtnStyle(), color: "#B84C3E" }}>clear selection</button>
        )}
      </div>

      {pool.length === 0 && <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#8A8368" }}>No pupils to show.</div>}

      <div style={{ display: "grid", gap: 5 }}>
        {pool.map((s) => (
          <button key={s.id} onClick={() => setPicked({ ...picked, [s.id]: !picked[s.id] })}
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
              textAlign: "left", padding: "9px 12px", borderRadius: 3,
              background: picked[s.id] ? "#E4F0E8" : "#F5F1E6",
              border: `1px solid ${picked[s.id] ? "#3F7A5C" : "#E4DFCF"}`,
            }}>
            <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
              <span style={{
                width: 17, height: 17, borderRadius: 3, flex: "0 0 17px",
                border: `1.5px solid ${picked[s.id] ? "#3F7A5C" : "#B8B2A0"}`,
                background: picked[s.id] ? "#3F7A5C" : "transparent",
                color: "#fff", fontSize: 12, lineHeight: "15px", textAlign: "center",
              }}>{picked[s.id] ? "✓" : ""}</span>
              <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#22304A" }}>{s.name}</span>
            </span>
            <span style={{ fontFamily: FONT.mono, fontSize: 10.5, color: "#6B6552" }}>
              {s.id} · {classNameOf(roster, s.classId)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}


// Small wrapper: lets a teacher choose a term, then print every pupil's card.
function TeacherReportCards({ roster, classId, teacher }) {
  const [term, setTerm] = useState(DEFAULT_TERM);
  const [printing, setPrinting] = useState(false);

  // Report cards belong to a class as a whole, so only the class teacher
  // prints them — a subject teacher covering one lesson should not.
  const [pick, setPick] = useState(classId || "");
  const mine = teachingAssignments(roster, teacher?.id).filter((a) => a.isHomeClass);
  const useClass = mine.length ? (pick || mine[0].classId) : classId;

  if (printing) return <BulkReportCards roster={roster} classId={useClass} term={term} onBack={() => setPrinting(false)} />;

  if (!useClass) {
    return (
      <div>
        <SectionTitle>Print report cards</SectionTitle>
        <div style={{ padding: "13px 15px", borderRadius: 5, background: "#F5E8DC", border: "1px solid #E8CBA0",
                      fontFamily: FONT.body, fontSize: 13, color: "#22304A", lineHeight: 1.6 }}>
          Report cards are printed by the class teacher. You are not registered as the class teacher
          for any class, so there is nothing to print here — ask the administrator if that is wrong.
        </div>
      </div>
    );
  }

  const record = getMarksFor(roster, useClass, term);
  const approved = statusOf(record) === "approved";
  const count = roster.students.filter((s) => s.classId === useClass).length;

  return (
    <div>
      <SectionTitle>Print report cards</SectionTitle>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#6B6552", marginBottom: 12 }}>
        Prints one report card per pupil in <strong>{classNameOf(roster, useClass)}</strong>, each on its own page,
        with the pupil's admission number and parent PIN printed at the foot.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Term" style={{ ...darkInput(), width: 130 }} />
        <span style={{ fontFamily: FONT.mono, fontSize: 11.5, color: approved ? "#3F7A5C" : "#C98A2C" }}>
          {approved ? "results approved" : "results not yet approved"}
        </span>
      </div>

      {!approved && (
        <div style={{ padding: "10px 12px", borderRadius: 4, background: "#F5E8DC", border: "1px solid #E8CBA0",
                      fontFamily: FONT.body, fontSize: 12.5, color: "#22304A", marginBottom: 14 }}>
          These results have not been approved by admin yet. You can still print for your own checking,
          but do not give them to parents until they are approved.
        </div>
      )}

      <button onClick={() => setPrinting(true)} style={primaryBtn()}>
        Open {count} report card{count === 1 ? "" : "s"}
      </button>
    </div>
  );
}

// ---------- Every pupil's report card in one printable run ----------
// Each card starts on a new page and carries the pupil's admission number and
// PIN, so the printed slip doubles as the parent's portal login.
function BulkReportCards({ roster, classId, term, onBack }) {
  const weights = roster.settings.weights || DEFAULT_WEIGHTS;
  const students = roster.students.filter((s) => s.classId === classId);
  const record = getMarksFor(roster, classId, term);
  const grid = record.grid || {};
  const ranked = classPositions(grid, students, roster.subjects, weights);
  const classLog = getAttendanceFor(roster, classId);
  const cur = roster.settings.currency;

  const attendanceRate = (studentId) => {
    const rows = [...Array(30)].map((_, i) => {
      const d = new Date(); d.setDate(d.getDate() - i);
      return classLog[d.toISOString().slice(0, 10)]?.[studentId];
    }).filter(Boolean);
    if (!rows.length) return null;
    const present = rows.filter((v) => v === "present" || v === "late").length;
    return Math.round((present / rows.length) * 100);
  };

  const withResults = students.filter((s) => studentSummary(grid, s.id, roster.subjects, weights).count > 0);

  return (
    <div style={{ minHeight: "100vh", background: "#1F3A2E" }}>
      <div className="no-print" style={{ maxWidth: 760, margin: "0 auto", padding: "14px 12px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={onBack} style={{ background: "transparent", border: "1px solid #4A6E58", color: "#F5F3EE", borderRadius: 3, padding: "8px 14px", fontFamily: FONT.body, fontSize: 13 }}>← Back</button>
        <button onClick={() => window.print()} style={{ ...primaryBtn(), background: "#E8B23D", color: "#1F3A2E" }}>Print all / Save as PDF</button>
        <span style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#8AA090" }}>
          {withResults.length} report card{withResults.length === 1 ? "" : "s"} · {classNameOf(roster, classId)} · {term}
        </span>
      </div>

      {withResults.length === 0 && (
        <div className="no-print" style={{ maxWidth: 760, margin: "0 auto", padding: "0 12px 40px", fontFamily: FONT.body, fontSize: 13, color: "#B8C4B9" }}>
          No pupil in this class has marks for {term} yet.
        </div>
      )}

      {withResults.map((student, idx) => {
        const sum = studentSummary(grid, student.id, roster.subjects, weights);
        const rank = positionOf(ranked, student.id);
        const avg = sum.average;
        const rate = attendanceRate(student.id);
        const due = student.feeDue || 0, paid = student.feePaid || 0;
        const entries = roster.subjects
          .filter((sub) => grid[student.id]?.[sub])
          .map((sub) => [sub, grid[student.id][sub]]);

        return (
          <div key={student.id} className="print-doc report-page" style={{
            maxWidth: 760, margin: "0 auto 24px", background: "#fff", color: "#22304A",
            border: "1px solid #D8D2C2", borderRadius: 4, padding: "28px 30px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)", fontFamily: "Georgia, 'Times New Roman', serif",
            pageBreakAfter: idx < withResults.length - 1 ? "always" : "auto",
          }}>
            <DocHeader subtitle={`Report Card — ${term}`} />
            <DocInfo roster={roster} student={student} />

            <div style={{ fontWeight: "bold", marginBottom: 8 }}>Learning areas</div>
            <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 14 }}>
              <thead>
                <tr>
                  <th style={docTh}>Learning area</th>
                  <th style={{ ...docTh, textAlign: "right" }}>CAT 1</th>
                  <th style={{ ...docTh, textAlign: "right" }}>CAT 2</th>
                  <th style={{ ...docTh, textAlign: "right" }}>Exam</th>
                  <th style={{ ...docTh, textAlign: "right" }}>Final</th>
                  <th style={{ ...docTh, textAlign: "center" }}>Level</th>
                  <th style={docTh}>Performance</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(([sub, raw]) => {
                  const e = normEntry(raw);
                  const fin = subjectFinal(e, weights);
                  return (
                    <tr key={sub}>
                      <td style={docTd}>{sub}</td>
                      {ASSESSMENTS.map((a) => (
                        <td key={a.key} style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontSize: 11.5 }}>
                          {typeof e[a.key] === "number" ? e[a.key] : "–"}
                        </td>
                      ))}
                      <td style={{ ...docTd, textAlign: "right", fontFamily: FONT.mono, fontWeight: 700 }}>{fin ?? "—"}</td>
                      <td style={{ ...docTd, textAlign: "center", fontFamily: FONT.mono, fontWeight: 700 }}>
                        {fin === null ? "—" : `L${gradeLevel(fin)}`}
                      </td>
                      <td style={{ ...docTd, fontSize: 11 }}>{fin === null ? "—" : gradeLabel(fin)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, margin: "14px 0 18px" }}>
              {[["POSITION", rank ? `${rank.position} / ${rank.outOf}` : "—"],
                ["TOTAL", sum.count ? sum.total : "—"],
                ["MEAN", avg === null ? "—" : `${avg}/100`],
                ["LEVEL", avg === null ? "—" : `L${gradeLevel(avg)}`]].map(([l, v]) => (
                <div key={l} style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "8px 9px", background: "#F5F1E6", textAlign: "center" }}>
                  <div style={{ fontFamily: FONT.mono, fontSize: 8, color: "#8A8368", letterSpacing: 0.8 }}>{l}</div>
                  <div style={{ fontSize: 15, fontWeight: "bold", marginTop: 3 }}>{v}</div>
                </div>
              ))}
            </div>

            {avg !== null && (
              <div style={{ marginBottom: 16, fontSize: 13 }}>
                Overall: <strong>Level {gradeLevel(avg)} — {gradeLabel(avg)}</strong>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
              <div style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "9px 11px", background: "#F5F1E6" }}>
                <div style={{ fontFamily: FONT.mono, fontSize: 8.5, color: "#8A8368", letterSpacing: 1 }}>ATTENDANCE</div>
                <div style={{ fontSize: 15, fontWeight: "bold", marginTop: 3 }}>{rate === null ? "—" : `${rate}%`}</div>
              </div>
              <div style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "9px 11px", background: "#F5F1E6" }}>
                <div style={{ fontFamily: FONT.mono, fontSize: 8.5, color: "#8A8368", letterSpacing: 1 }}>FEES DUE / PAID / BALANCE</div>
                <div style={{ fontSize: 12.5, fontWeight: "bold", marginTop: 3 }}>
                  {cur}{money(due)} / {cur}{money(paid)} / {cur}{money(due - paid)}
                </div>
              </div>
            </div>

            <div style={{ borderTop: "1px solid #E4DFCF", paddingTop: 9, marginBottom: 12, fontSize: 9.5, color: "#6B6552", fontFamily: FONT.mono }}>
              CBC PERFORMANCE LEVELS — 4 Exceeding (76–100) · 3 Meeting (51–75) · 2 Approaching (26–50) · 1 Below (0–25)
            </div>

            <div style={{ border: "1px dashed #B8B2A0", borderRadius: 4, padding: "9px 11px", marginBottom: 18,
                          fontSize: 11, fontFamily: FONT.mono, color: "#22304A" }}>
              PARENT PORTAL — Admission No: <strong>{student.id}</strong> · PIN: <strong>{student.pin || "—"}</strong>
              <div style={{ color: "#8A8368", marginTop: 3 }}>
                Use these at {SCHOOL_NAME} portal to see results any time. Keep them private.
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 24 }}>
              <div style={docSig}>Class Teacher's Signature</div>
              <div style={docSig}>Head Teacher's Signature</div>
            </div>
          </div>
        );
      })}

      <div className="no-print" style={{ maxWidth: 760, margin: "0 auto", padding: "0 12px 50px", fontFamily: FONT.body, fontSize: 12, color: "#8AA090", lineHeight: 1.5 }}>
        Each report card prints on its own page. If the Print button does not respond, use your browser menu (⋮ → Print).
      </div>
    </div>
  );
}


// ---------- Printable class marksheet: whole class, all subjects, one page ----------
function ClassMarksheetDoc({ roster, classId, term, onBack }) {
  const weights = roster.settings.weights || DEFAULT_WEIGHTS;
  const students = roster.students.filter((s) => s.classId === classId);
  const record = getMarksFor(roster, classId, term);
  const grid = record.grid || {};
  const status = statusOf(record);

  // only subjects that actually have marks, to keep the sheet narrow enough to read
  const subjects = roster.subjects.filter((sub) =>
    students.some((s) => subjectFinal(grid[s.id]?.[sub], weights) !== null));

  const ranked = classPositions(grid, students, roster.subjects, weights);
  const posOf = (id) => ranked.find((r) => r.student.id === id)?.position ?? "—";

  const classMean = ranked.length
    ? Math.round(ranked.reduce((a, r) => a + r.average, 0) / ranked.length) : null;

  const subjectMean = (sub) => {
    const vals = students.map((s) => subjectFinal(grid[s.id]?.[sub], weights)).filter((v) => v !== null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  const th = { ...docTh, padding: "5px 4px", fontSize: 8 };
  const td = { ...docTd, padding: "5px 4px", fontSize: 10 };

  return (
    <DocShell title="Class marksheet" onBack={onBack}>
      <DocHeader subtitle={`Class Marksheet — ${classNameOf(roster, classId)} — ${term}`} />

      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 14, fontSize: 12 }}>
        <div><strong>Pupils:</strong> {students.length} &nbsp;·&nbsp; <strong>With results:</strong> {ranked.length}</div>
        <div><strong>Class mean:</strong> {classMean === null ? "—" : `${classMean} (Level ${gradeLevel(classMean)})`}</div>
        <div><strong>Status:</strong> {status === "approved" ? "Approved" : status === "submitted" ? "Awaiting approval" : "Draft"}</div>
      </div>

      {subjects.length === 0 ? (
        <div style={{ fontSize: 12, color: "#6B6552" }}>No marks entered for {term} yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "center" }}>Pos</th>
                <th style={th}>Pupil</th>
                <th style={th}>Adm No</th>
                {subjects.map((sub) => (
                  <th key={sub} style={{ ...th, textAlign: "center" }}>{sub.slice(0, 8)}</th>
                ))}
                <th style={{ ...th, textAlign: "center" }}>Total</th>
                <th style={{ ...th, textAlign: "center" }}>Mean</th>
                <th style={{ ...th, textAlign: "center" }}>Level</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => {
                const sum = studentSummary(grid, s.id, roster.subjects, weights);
                return (
                  <tr key={s.id}>
                    <td style={{ ...td, textAlign: "center", fontFamily: FONT.mono, fontWeight: 700 }}>{posOf(s.id)}</td>
                    <td style={td}>{s.name}</td>
                    <td style={{ ...td, fontFamily: FONT.mono, fontSize: 8.5, color: "#6B6552" }}>{s.id}</td>
                    {subjects.map((sub) => {
                      const fin = subjectFinal(grid[s.id]?.[sub], weights);
                      return (
                        <td key={sub} style={{ ...td, textAlign: "center", fontFamily: FONT.mono, color: fin === null ? "#B8B2A0" : gradeInk(fin) }}>
                          {fin === null ? "–" : fin}
                        </td>
                      );
                    })}
                    <td style={{ ...td, textAlign: "center", fontFamily: FONT.mono, fontWeight: 700 }}>{sum.count ? sum.total : "–"}</td>
                    <td style={{ ...td, textAlign: "center", fontFamily: FONT.mono, fontWeight: 700 }}>{sum.average ?? "–"}</td>
                    <td style={{ ...td, textAlign: "center", fontFamily: FONT.mono, fontWeight: 700, color: gradeInk(sum.average) }}>
                      {sum.average === null ? "–" : `L${gradeLevel(sum.average)}`}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td style={{ ...td, borderTop: "2px solid #22304A" }} colSpan={3}><strong>Subject mean</strong></td>
                {subjects.map((sub) => (
                  <td key={sub} style={{ ...td, borderTop: "2px solid #22304A", textAlign: "center", fontFamily: FONT.mono, fontWeight: 700 }}>
                    {subjectMean(sub) ?? "–"}
                  </td>
                ))}
                <td style={{ ...td, borderTop: "2px solid #22304A" }} colSpan={2}></td>
                <td style={{ ...td, borderTop: "2px solid #22304A", textAlign: "center", fontFamily: FONT.mono, fontWeight: 700 }}>
                  {classMean === null ? "–" : `L${gradeLevel(classMean)}`}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div style={{ borderTop: "1px solid #E4DFCF", paddingTop: 10, marginTop: 16, fontSize: 10, color: "#6B6552", fontFamily: FONT.mono }}>
        CBC PERFORMANCE LEVELS — 4 Exceeding (76–100) · 3 Meeting (51–75) · 2 Approaching (26–50) · 1 Below (0–25)
        <div style={{ marginTop: 3 }}>
          Marks weighted: CAT 1 {weights.cat1}% + CAT 2 {weights.cat2}% + Exam {weights.exam}%
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 34 }}>
        <div style={docSig}>Class Teacher's Signature</div>
        <div style={docSig}>Head Teacher's Signature</div>
      </div>
    </DocShell>
  );
}

// ---------- Printable receipt for a single fee payment ----------
function ReceiptDoc({ roster, student, payment, onBack }) {
  const cur = roster.settings.currency;
  const paidToDate = (student.payments || [])
    .filter((p) => p.date <= payment.date)
    .reduce((a, p) => a + (p.amount || 0), 0);
  const balanceAfter = (student.feeDue || 0) - paidToDate;

  const row = { display: "flex", justifyContent: "space-between", padding: "7px 0", fontSize: 13, borderBottom: "1px solid #EFEADC" };

  return (
    <DocShell title="Fee receipt" onBack={onBack}>
      <DocHeader subtitle="Official Fee Receipt" />

      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 14, fontSize: 12.5 }}>
        <div><strong>Receipt No:</strong> {payment.receiptNo || "—"}</div>
        <div><strong>Date:</strong> {fmtDate(payment.date)}</div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 18, fontSize: 12 }}>
        <div><strong>Paid by:</strong> {payment.mpesaCode ? "M-Pesa" : (payment.method ? payment.method.charAt(0).toUpperCase() + payment.method.slice(1) : "Cash")}</div>
        {payment.mpesaCode && <div><strong>M-Pesa code:</strong> <span style={{ fontFamily: FONT.mono }}>{payment.mpesaCode}</span></div>}
        {payment.sender && <div><strong>From:</strong> {payment.sender}</div>}
      </div>

      <DocInfo roster={roster} student={student} />

      <div style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "14px 16px", background: "#F5F1E6", margin: "10px 0 18px" }}>
        <div style={{ fontFamily: FONT.mono, fontSize: 9.5, color: "#8A8368", letterSpacing: 1 }}>AMOUNT RECEIVED</div>
        <div style={{ fontSize: 30, fontWeight: "bold", marginTop: 4 }}>{cur}{money(payment.amount)}</div>
        <div style={{ fontSize: 11.5, color: "#6B6552", marginTop: 4 }}>
          {amountInWords(payment.amount)} {cur === "KSh" ? "shillings" : ""} only
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <div style={row}><span>Total fee due</span><strong>{cur}{money(student.feeDue || 0)}</strong></div>
        <div style={row}><span>Paid to date (including this payment)</span><strong>{cur}{money(paidToDate)}</strong></div>
        <div style={{ ...row, borderBottom: "none", borderTop: "2px solid #22304A", paddingTop: 10, fontSize: 15 }}>
          <span><strong>Balance outstanding</strong></span>
          <strong style={{ color: balanceAfter > 0 ? "#B84C3E" : "#3F7A5C" }}>{cur}{money(balanceAfter)}</strong>
        </div>
      </div>

      <div style={{ fontSize: 11, color: "#6B6552", marginBottom: 26 }}>
        This receipt confirms the amount stated above has been received by the school.
        Please retain it as proof of payment.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 20 }}>
        <div style={docSig}>Received by (Bursar)</div>
        <div style={docSig}>Official School Stamp</div>
      </div>
    </DocShell>
  );
}

// Writes an amount in words, for the receipt.
function amountInWords(n) {
  n = Math.floor(Number(n) || 0);
  if (n === 0) return "Zero";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const under1000 = (x) => {
    let out = "";
    if (x >= 100) { out += ones[Math.floor(x / 100)] + " Hundred"; x %= 100; if (x) out += " and "; }
    if (x >= 20) { out += tens[Math.floor(x / 10)]; x %= 10; if (x) out += "-"; }
    if (x > 0 && x < 20) out += ones[x];
    return out;
  };
  let out = "";
  if (n >= 1000000) { out += under1000(Math.floor(n / 1000000)) + " Million "; n %= 1000000; }
  if (n >= 1000) { out += under1000(Math.floor(n / 1000)) + " Thousand "; n %= 1000; }
  if (n > 0) out += under1000(n);
  return out.trim();
}

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
              <td style={{ ...docTd, color: "#6B6552" }}>{p.receiptNo ? `Receipt ${p.receiptNo}` : "Fee payment"}</td>
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
  const remark = (sc) => gradeLabel(sc);

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
          ["PERFORMANCE LEVEL", avg === null || avg === undefined ? "—" : "L" + gradeLevel(avg)]].map(([l, v]) => (
          <div key={l} style={{ border: "1px solid #E4DFCF", borderRadius: 4, padding: "9px 10px", background: "#F5F1E6", textAlign: "center" }}>
            <div style={{ fontFamily: FONT.mono, fontSize: 8.5, color: "#8A8368", letterSpacing: 0.8 }}>{l}</div>
            <div style={{ fontSize: 16, fontWeight: "bold", marginTop: 3 }}>{v}</div>
          </div>
        ))}
      </div>

      {avg !== null && avg !== undefined && (
        <div style={{ marginBottom: 18, fontSize: 13.5 }}>
          Overall: <strong>Level {gradeLevel(avg)} — {gradeLabel(avg)}</strong>
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
        CBC PERFORMANCE LEVELS — 4 Exceeding Expectation (76–100) · 3 Meeting Expectation (51–75) · 2 Approaching Expectation (26–50) · 1 Below Expectation (0–25)
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
