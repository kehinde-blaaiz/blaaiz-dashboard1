const { useState, useRef, useEffect } = React;

// ─── Date helpers ─────────────────────────────────────────────────────────────
const getToday    = () => new Date();
const toISO       = (d) => (d ? d.slice(0, 10) : null);
const daysBetween = (a, b) => (!a || !b) ? null : Math.max(0, Math.floor((new Date(b) - new Date(a)) / 86400000));
const daysSince   = (iso) => iso ? Math.max(0, Math.floor((getToday() - new Date(iso)) / 86400000)) : null;
const fmt         = (n) => (n == null ? "—" : String(n));

function useClock() {
  const [now, setNow] = useState(getToday);
  useEffect(() => {
    let iv;
    const ms = 60000 - (Date.now() % 60000);
    const t  = setTimeout(() => { setNow(getToday()); iv = setInterval(() => setNow(getToday()), 60000); }, ms);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, []);
  return now;
}

const PLATFORM_STAGES = ["Kick Off", "Commercial", "Compliance", "Finance", "Sales", "Operations", "Product", "Tech"];
const BUSINESS_STAGES = ["Kick Off", "Commercial", "Compliance", "Sales"];
const PAY_STAGES      = ["Kick Off", "Commercial", "Compliance", "Finance", "Sales", "Operations", "Tech"];


// ─── Persistent project cache — stored in artifact storage ───────────────────
// First load: fetches from Asana + classifies, caches result.
// Every subsequent load: reads from cache instantly.
// "Sync Projects" button busts the cache and re-fetches.
const CACHE_KEY = "blaaiz-projects-v4"; // bumped — picks up Digitech / Folasade Opaleye

async function loadCachedProjects() {
  try { const v = localStorage.getItem(CACHE_KEY); return v ? JSON.parse(v) : null; } catch (_) { return null; }
}
async function saveProjectCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_) {}
}
async function clearProjectCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
}

// ─── Status history — persisted per project, keyed by date ───────────────────
// Each entry: { date, title, text, color }
// Built up over time as the dashboard loads — each load appends the latest status
const STATUS_HISTORY_KEY = "blaaiz-status-history-v1";

async function loadStatusHistory() {
  try { const v = localStorage.getItem(STATUS_HISTORY_KEY); return v ? JSON.parse(v) : {}; } catch (_) { return {}; }
}
async function appendStatusHistory(history, projectGid, entry) {
  if (!entry.date || !entry.text) return history;
  const existing = history[projectGid] || [];
  const alreadyHas = existing.some(e => e.date === entry.date);
  if (alreadyHas) return history;
  const updated = { ...history, [projectGid]: [...existing, entry] };
  try { localStorage.setItem(STATUS_HISTORY_KEY, JSON.stringify(updated)); } catch (_) {}
  return updated;
}

// ─── Portfolio GIDs — read directly from Asana portfolios ────────────────────
const PORTFOLIO_GIDS = {
  platform: "1213308485003427", // Blaaiz Platform
  business:  "1213308485003431", // Blaaiz Business
  pay:       "1213448111792814", // Blaaiz Pay
};

// ─── Fetch projects from Asana portfolio — direct REST via Netlify proxy ────
async function fetchPortfolio(portfolioGid, portfolioName) {
  const res = await fetch("/api/asana/portfolios/" + portfolioGid + "/items?opt_fields=gid,name,created_at");
  if (!res.ok) throw new Error("HTTP " + res.status + " (" + portfolioName + ")");
  const payload = await res.json();
  if (payload.errors) throw new Error(payload.errors[0]?.message || "Asana error");
  return (payload.data || [])
    .filter(p => p.gid && p.name && !p.name.toLowerCase().includes("template"))
    .map(p => ({
      id: p.gid + "-" + portfolioName[0],
      name: p.name, gid: p.gid, asanaGid: p.gid,
      created: p.created_at?.slice(0,10), createdAt: p.created_at?.slice(0,10),
      portfolio: portfolioName,
      asanaUrl: "https://app.asana.com/1/1206506054877854/project/" + p.gid,
    }));
}

// ─── Fetch all three portfolios in parallel ───────────────────────────────────
async function fetchAllProjects() {
  const [platform, business, pay] = await Promise.all([
    fetchPortfolio(PORTFOLIO_GIDS.platform, "platform"),
    fetchPortfolio(PORTFOLIO_GIDS.business,  "business"),
    fetchPortfolio(PORTFOLIO_GIDS.pay,       "pay"),
  ]);
  const result = { platform, business, pay, cachedAt: new Date().toISOString() };
  await saveProjectCache(result);
  return result;
}



// ─── Fetch project tasks + info — direct Asana REST ─────────────────────────
async function fetchProject(gid, onProgress) {
  const t0 = performance.now();
  let pct = 0;
  const ticker = onProgress ? setInterval(() => {
    pct = Math.min(90, pct + (pct < 30 ? 6 : pct < 60 ? 4 : 2));
    onProgress(pct);
  }, 200) : null;

  try {
    const TASK_FIELDS = "gid,name,completed,completed_at,created_at,memberships.section.name,custom_fields.name,custom_fields.enum_value.name,assignee.name";
    const PROJ_FIELDS = "owner.name,current_status.title,current_status.text,current_status.color,current_status.created_at";

    const [tasksRes, projRes] = await Promise.all([
      fetch("/api/asana/projects/" + gid + "/tasks?opt_fields=" + TASK_FIELDS + "&limit=100"),
      fetch("/api/asana/projects/" + gid + "?opt_fields=" + PROJ_FIELDS),
    ]);

    clearInterval(ticker);
    if (onProgress) onProgress(100);

    if (!tasksRes.ok) throw new Error("Tasks HTTP " + tasksRes.status);
    if (!projRes.ok)  throw new Error("Project HTTP " + projRes.status);

    const tasksPayload = await tasksRes.json();
    const projPayload  = await projRes.json();

    const rawTasks = tasksPayload.data || [];
    const proj     = projPayload.data  || {};
    const status   = proj.current_status || {};

    const tasks = rawTasks.map(t => {
      const section = t.memberships?.[0]?.section?.name || "";
      let priority = null, taskProgress = null;
      (t.custom_fields || []).forEach(cf => {
        if (cf.name === "Priority")      priority     = cf.enum_value?.name || null;
        if (cf.name === "Task Progress") taskProgress = cf.enum_value?.name || null;
      });
      return { gid: t.gid, name: t.name, completed: t.completed, completed_at: t.completed_at,
               created_at: t.created_at, section, priority, taskProgress, assignee: t.assignee?.name || null };
    });

    const data = {
      owner: proj.owner?.name || null,
      statusTitle: status.title      || null,
      statusText:  status.text       || null,
      statusColor: status.color      || null,
      statusDate:  status.created_at || null,
      firstTaskGid: tasks[0]?.gid    || null,
      tasks,
    };

    const durationMs = Math.round(performance.now() - t0);
    return { data, durationMs };
  } catch (e) {
    clearInterval(ticker);
    throw new Error(e.message);
  }
}

// ─── Derive stage state from tasks ───────────────────────────────────────────
function hashTasks(tasks) {
  const str = (tasks || []).map(t => `${t.name}:${t.completed}:${t.taskProgress}`).join("|");
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return h.toString(36);
}

function deriveStages(raw, stageOrder) {
  const tasks  = Array.isArray(raw?.tasks) ? raw.tasks : [];
  const ACTIVE = ["In Progress", "Waiting", "Deferred"];

  const by = {};
  tasks.forEach(t => {
    const s = t.section || "Unknown";
    if (!by[s]) by[s] = [];
    by[s].push(t);
  });

  const sum = {}, entered = {}, compAt = {}, daysAct = {};

  stageOrder.forEach(stage => {
    const sec = by[stage];
    if (!sec || !sec.length) { sum[stage] = { done: 0, total: 0, status: "N/A" }; return; }

    const total = sec.length;
    const progs = sec.map(t => t.taskProgress || "Not Started");
    const done  = sec.filter(t => t.completed || t.taskProgress === "Done").length;

    let status;
    if (done === total)                     status = "Complete";
    else if (progs.includes("In Progress")) status = "In Progress";
    else if (progs.includes("Waiting"))     status = "Waiting";
    else if (progs.includes("Deferred"))    status = "Deferred";
    else if (progs.includes("Done"))        status = "In Progress";
    else                                    status = "Not Started";

    sum[stage] = { done, total, status };
    if (sec.some(t => t.priority === "High"))        sum[stage].priority = "High";
    else if (sec.some(t => t.priority === "Medium")) sum[stage].priority = "Medium";

    if (ACTIVE.includes(status) || status === "Complete") {
      const active = sec.filter(t => (t.taskProgress || "Not Started") !== "Not Started");
      const dates  = active.map(t => t.created_at).filter(Boolean).sort();
      if (dates.length) entered[stage] = toISO(dates[0]);
      if (done === total) {
        const dd = sec.map(t => t.completed_at).filter(Boolean).sort();
        if (dd.length) compAt[stage] = toISO(dd[dd.length - 1]);
      }
      const s2 = entered[stage], e2 = compAt[stage] || toISO(getToday().toISOString());
      daysAct[stage] = s2 ? daysBetween(s2, e2) : null;
    } else {
      daysAct[stage] = null;
    }
  });

  const activeList = stageOrder.map((s, i) => ({ stage: s, idx: i })).filter(x => ACTIVE.includes(sum[x.stage]?.status));
  const last = activeList[activeList.length - 1];

  const owner    = (raw?.owner && typeof raw.owner === "string") ? raw.owner.trim() : null;
  const taskAsgn = tasks.find(t => t.assignee)?.assignee || null;

  return {
    stageSummary:     sum,
    stageEnteredAt:   entered,
    stageCompletedAt: compAt,
    stageDaysActive:  daysAct,
    currentStage:     last ? last.stage : stageOrder[0],
    stageIdx:         last ? last.idx   : 0,
    activeStages:     activeList.map(x => x.stage),
    assignee:         owner || taskAsgn || "Unassigned",
    lastFetchedAt:    new Date().toISOString(),
    lastFetchedHash:  hashTasks(tasks),
    statusTitle:      raw?.statusTitle || null,
    statusText:       raw?.statusText  || null,
    statusColor:      raw?.statusColor || null,
    statusDate:       raw?.statusDate  ? toISO(raw.statusDate) : null,
    firstTaskGid:     raw?.firstTaskGid || tasks[0]?.gid || null,
    taskList:         tasks.filter(t => t.gid && t.name).map(t => ({ gid: t.gid, name: t.name, section: t.section || "" })),
  };
}

// ─── Style maps ───────────────────────────────────────────────────────────────
const PLATFORM_COLORS = ["bg-violet-100 text-violet-700","bg-blue-100 text-blue-700","bg-amber-100 text-amber-700","bg-orange-100 text-orange-700","bg-teal-100 text-teal-700","bg-green-100 text-green-700","bg-indigo-100 text-indigo-700","bg-pink-100 text-pink-700"];
const PLATFORM_BARS   = ["bg-violet-400","bg-blue-400","bg-amber-400","bg-orange-400","bg-teal-400","bg-green-400","bg-indigo-400","bg-pink-400"];
const BUSINESS_COLORS = ["bg-violet-100 text-violet-700","bg-blue-100 text-blue-700","bg-amber-100 text-amber-700","bg-teal-100 text-teal-700"];
const BUSINESS_BARS   = ["bg-violet-400","bg-blue-400","bg-amber-400","bg-teal-400"];

const STATUS_CLS = {
  "Complete":    "bg-green-100 text-green-700",
  "In Progress": "bg-blue-100 text-blue-700",
  "Waiting":     "bg-yellow-100 text-yellow-700",
  "Not Started": "bg-gray-100 text-gray-500",
  "Deferred":    "bg-orange-100 text-orange-600",
  "N/A":         "hidden",
};
const PRIORITY_CLS = { High: "bg-red-100 text-red-600", Medium: "bg-orange-100 text-orange-600" };

function pillBg(d, done) {
  if (done)   return "bg-green-50 text-green-600 border-green-200";
  if (d > 10) return "bg-red-50 text-red-600 border-red-200";
  if (d > 5)  return "bg-amber-50 text-amber-600 border-amber-200";
  return "bg-blue-50 text-blue-600 border-blue-200";
}
function daysColor(d) {
  if (d > 14) return "text-red-500 font-bold";
  if (d > 7)  return "text-amber-500 font-semibold";
  return "text-green-600 font-semibold";
}

const BLOCKERS = {
  "Kick Off":   ["Does not meet ICP criteria","Business model misaligned","No credible website","Expected volumes too low"],
  "Commercial": ["Pricing terms not agreed","Reserve requirements not met","Discount approval pending"],
  "Compliance": ["Customer unresponsive to KYB pack","Incomplete document submission","Missing EDD form","Invalid/expired documents","Sanctions / PEP / adverse media hit","Inconsistent UBO information","Business activity mismatch","Missing Source of Funds"],
  "Finance":    ["Rolling reserve not received","Reserve recalibration pending"],
  "Tech":       ["Sandbox access issues","API integration errors","Webhook testing failures","Failed test transactions"],
  "Operations": ["Virtual account setup delays","Transaction limits not configured","Rail-specific setup incomplete","Monitoring rules not configured"],
  "Sales":      ["Chargeback spikes","Suspicious transaction patterns","Failed periodic KYB/KYC re-rating"],
  "Other":      ["Internal approval pending","Client not responsive","Other"],
};

// ─── Small components ─────────────────────────────────────────────────────────
function Skeleton() {
  return <span className="inline-block w-20 h-3 bg-gray-100 rounded-full animate-pulse" />;
}

function DurationPill({ days, completed }) {
  if (days == null) return <span className="text-gray-300 text-xs">—</span>;
  return (
    <span className={"inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold " + pillBg(days, completed)}>
      {completed ? "✓" : "⏱"} {days}d {completed ? "total" : "active"}
    </span>
  );
}

function ProgressCell({ progress, doneMs, error, retrying }) {
  const [elapsed, setElapsed] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    clearInterval(ref.current);
    if (doneMs != null || error || progress == null) return;
    ref.current = setInterval(() => setElapsed(t => t + 100), 100);
    return () => clearInterval(ref.current);
  }, [doneMs, error, progress]);

  if (error) return <span className="text-xs text-red-500">⚠ failed</span>;
  if (retrying) return <span className="text-xs text-amber-500 animate-pulse">↻ retrying…</span>;
  if (doneMs != null) {
    const cls = doneMs > 25000 ? "text-amber-500" : "text-green-600";
    return (
      <div className="flex items-center gap-1.5">
        <div className="w-14 h-1.5 bg-green-100 rounded-full overflow-hidden">
          <div className="h-full w-full bg-green-400 rounded-full" />
        </div>
        <span className={"text-xs font-semibold " + cls}>✓ {(doneMs/1000).toFixed(1)}s</span>
      </div>
    );
  }
  if (progress == null) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <div className="w-14 h-1.5 bg-blue-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-400 rounded-full transition-all duration-500" style={{ width: progress + "%" }} />
        </div>
        <span className="text-xs font-semibold text-blue-600">{progress}%</span>
      </div>
      <span className="text-xs text-gray-400">{(elapsed/1000).toFixed(1)}s</span>
    </div>
  );
}

function BlockerSelect({ value, onChange, currentStage }) {
  const cur  = BLOCKERS[currentStage] || [];
  const rest = Object.keys(BLOCKERS).filter(s => s !== currentStage && s !== "Other");
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-400">
      <option value="">None</option>
      {cur.length > 0 && <optgroup label={"── " + currentStage + " ──"}>{cur.map(b => <option key={b}>{b}</option>)}</optgroup>}
      {rest.map(s => <optgroup key={s} label={"── " + s + " ──"}>{BLOCKERS[s].map(b => <option key={b}>{b}</option>)}</optgroup>)}
      <optgroup label="── Other ──">{BLOCKERS["Other"].map(b => <option key={b}>{b}</option>)}</optgroup>
    </select>
  );
}

// ─── Owners Panel ─────────────────────────────────────────────────────────────
function OwnersPanel({ platCusts, bizCusts, payCusts = [] }) {
  const all = [
    ...platCusts.map(c => ({ ...c, portfolio: "Platform" })),
    ...bizCusts.map(c => ({ ...c, portfolio: "Business" })),
    ...payCusts.map(c => ({ ...c, portfolio: "Pay" })),
  ];

  const loaded  = all.filter(c => c.lastFetchedAt);
  const loading = all.filter(c => !c.lastFetchedAt && !c.fetchError);
  const errored = all.filter(c => !!c.fetchError);
  const pct     = all.length ? Math.round(loaded.length / all.length * 100) : 0;

  // Group by assignee
  const map = {};
  loaded.forEach(c => {
    const key = (c.assignee && c.assignee !== "Unassigned") ? c.assignee : "Unassigned";
    if (!map[key]) map[key] = [];
    map[key].push(c);
  });

  const named      = Object.entries(map).filter(([k]) => k !== "Unassigned").sort((a,b) => b[1].length - a[1].length);
  const unassigned = map["Unassigned"] || [];
  const COLORS = ["bg-indigo-100 text-indigo-700","bg-violet-100 text-violet-700","bg-teal-100 text-teal-700","bg-orange-100 text-orange-700","bg-pink-100 text-pink-700"];

  return (
    <div className="space-y-4">
      {loading.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-3 flex items-center gap-4">
          <span className="animate-spin w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full inline-block shrink-0" />
          <div className="flex-1">
            <div className="flex justify-between mb-1">
              <p className="text-xs font-semibold text-blue-700">Loading owners… {loaded.length}/{all.length}</p>
              <span className="text-xs font-bold text-blue-600">{pct}%</span>
            </div>
            <div className="w-full h-1.5 bg-blue-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: pct + "%" }} />
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
          Project Owners
          {!loading.length && <span className="ml-2 font-normal text-gray-400 normal-case">— {loaded.length} projects loaded from Asana</span>}
        </p>

        {/* Named owners */}
        {named.length > 0 && (
          <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))" }}>
            {named.map(([name, projects], i) => {
              const initials = name.split(" ").map(w=>w[0]||"").join("").slice(0,2).toUpperCase();
              return (
                <div key={name} className="border border-gray-100 rounded-xl p-4 bg-gray-50">
                  <div className="flex items-center gap-2 mb-3">
                    <div className={"w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 " + COLORS[i % COLORS.length]}>{initials}</div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{name}</p>
                      <p className="text-xs text-gray-400">{projects.length} project{projects.length !== 1 ? "s" : ""}</p>
                    </div>
                  </div>
                  {projects.map(p => (
                    <div key={p.id} className="mt-1.5 bg-white rounded-lg px-3 py-2 border border-gray-100">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-gray-800 truncate">{p.name}</span>
                        <span className={"text-xs px-1.5 py-0.5 rounded-full font-semibold shrink-0 " + (p.portfolio === "Platform" ? "bg-indigo-100 text-indigo-600" : "bg-emerald-100 text-emerald-600")}>{p.portfolio}</span>
                      </div>
                      {p.currentStage && <p className="text-xs text-gray-400 mt-0.5">{p.activeStages?.length ? "● " : ""}{p.currentStage}</p>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {/* Unassigned */}
        {unassigned.length > 0 && (
          <>
            {named.length > 0 && <div className="border-t border-gray-100 my-4" />}
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">No Owner Assigned</p>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))" }}>
              {unassigned.map(p => (
                <div key={p.id} className="border border-dashed border-gray-200 rounded-xl p-3 bg-gray-50 flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-gray-700">{p.name}</p>
                    {p.currentStage && <p className="text-xs text-gray-400">{p.currentStage}</p>}
                  </div>
                  <span className={"text-xs px-1.5 py-0.5 rounded-full font-semibold shrink-0 " + (p.portfolio === "Platform" ? "bg-indigo-100 text-indigo-600" : "bg-emerald-100 text-emerald-600")}>{p.portfolio}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Loading placeholders */}
        {loading.length > 0 && (
          <>
            {(named.length > 0 || unassigned.length > 0) && <div className="border-t border-gray-100 my-4" />}
            <p className="text-xs font-semibold text-gray-300 uppercase tracking-wide mb-3">Loading…</p>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))" }}>
              {loading.map(p => (
                <div key={p.id} className="border border-dashed border-gray-100 rounded-xl p-3 flex items-center gap-3 animate-pulse">
                  <div className="w-9 h-9 rounded-full bg-gray-100 shrink-0" />
                  <div className="flex-1">
                    <div className="h-3 bg-gray-100 rounded w-3/4 mb-1.5" />
                    <div className="h-2.5 bg-gray-50 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {errored.length > 0 && (
          <>
            <div className="border-t border-gray-100 my-4" />
            <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-3">Failed</p>
            {errored.map(p => (
              <div key={p.id} className="text-xs text-red-500 px-3 py-2 bg-red-50 rounded-lg mb-1">{p.name} — {p.fetchError}</div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Portfolio view ───────────────────────────────────────────────────────────
function PortfolioView({ custs, setCusts, stages, stageColors, stageBars, notes, setNotes, loadMeta, setLoadMeta, statusHistory = {}, jumpToId = null, setJumpToId }) {
  const [filterStage,  setFilterStage]  = useState(null);
  const [filterOwner,  setFilterOwner]  = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [selectedId,   setSelectedId]   = useState(null);
  const [noteForm,     setNoteForm]      = useState({ date: toISO(getToday().toISOString()), blocker: "", note: "" });
  const [saving,       setSaving]        = useState(false);
  const [saved,        setSaved]         = useState(false);
  const [refreshing,   setRefreshing]    = useState(null);
  const [rStatus,      setRStatus]       = useState({});
  const [calDate,      setCalDate]       = useState(null); // selected calendar date for notes
  const [calOpen,      setCalOpen]       = useState(false); // calendar expanded
  const [calViewMonth, setCalViewMonth]  = useState(null);  // {yr, mo} being viewed — null = current month
  const [commentText,  setCommentText]   = useState("");
  const [selectedTaskGid, setSelectedTaskGid] = useState("");
  const [commenting,   setCommenting]    = useState(false);
  const [commentSent,  setCommentSent]   = useState(false);
  const [commentError, setCommentError]  = useState(null);
  const [members,      setMembers]        = useState([]);
  const [mentionQuery, setMentionQuery]   = useState(null); // null = closed, string = active query
  const [mentionPos,   setMentionPos]     = useState(0);    // caret position where @ was typed
  const textareaRef = useRef(null);

  const enriched = custs.map(c => ({
    ...c,
    isLoaded:      !!c.lastFetchedAt,
    daysTotal:     daysSince(c.createdAt || c.created),
    daysInStage:   c.lastFetchedAt && c.currentStage ? (c.stageDaysActive?.[c.currentStage] ?? null) : null,
    // notes[c.id] can be old format {date,blocker,note} or new format [{date,blocker,note},...] — normalise to array
    notesList:     (() => { const n = notes[c.id]; if (!n) return []; if (Array.isArray(n)) return n; return [n]; })(),
    get meeting() { 
      const list = this.notesList;
      if (!list.length) return null;
      return list.slice().sort((a,b) => (b.date||"").localeCompare(a.date||""))[0];
    },
  }));

  const loaded   = enriched.filter(c => c.isLoaded);
  const selected = selectedId ? enriched.find(c => c.id === selectedId) : null;

  // Jump to a customer row when triggered from search
  useEffect(() => {
    if (!jumpToId) return;
    const target = enriched.find(c => c.id === jumpToId);
    if (target) {
      openRow(target);
      // Scroll the row into view after a brief paint delay
      setTimeout(() => {
        const el = document.getElementById("customer-row-" + jumpToId);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    }
    if (setJumpToId) setJumpToId(null);
  }, [jumpToId]);

  // Fetch workspace members once for @mention autocomplete
  useEffect(() => {
    (async () => {
      try {
        const meRes  = await fetch("/api/asana/users/me?opt_fields=workspaces");
        const meData = await meRes.json();
        const wsGid  = meData?.data?.workspaces?.[0]?.gid;
        if (!wsGid) return;
        const res  = await fetch("/api/asana/workspaces/" + wsGid + "/users?opt_fields=gid,name,photo");
        const data = await res.json();
        if (data?.data) setMembers(data.data);
      } catch (_) {}
    })();
  }, []);

  // Owner and status filter options
  const ownerOptions  = [...new Set(loaded.map(c => c.assignee).filter(Boolean))].sort();
  const statusOptions = [...new Set(loaded.map(c => c.statusColor).filter(Boolean))].sort();

  const filtered = enriched.filter(c => {
    if (filterStage  != null && c.isLoaded && !c.activeStages?.includes(stages[filterStage])) return false;
    if (filterOwner  && c.assignee !== filterOwner) return false;
    if (filterStatus && c.statusColor !== filterStatus) return false;
    return true;
  });

  const stageStats = stages.map(s => {
    const inStage  = loaded.filter(c => c.activeStages?.includes(s));
    const withDays = inStage.filter(c => c.stageDaysActive?.[s] != null);
    const avgDays  = withDays.length ? Math.round(withDays.reduce((a,c) => a + c.stageDaysActive[s], 0) / withDays.length) : 0;
    return { name: s, count: inStage.length, pct: enriched.length ? Math.round(inStage.length / enriched.length * 100) : 0, avgDays };
  });

  const furthest   = loaded.slice().sort((a,b) => (b.stageIdx||0) - (a.stageIdx||0))[0];
  const blocked    = enriched.filter(c => c.meeting?.blocker || detectBlocker(c.statusText)).length;

  function doRefresh(c) {
    setRefreshing(c.id);
    setRStatus(p => ({ ...p, [c.id]: null }));
    setLoadMeta(p => ({ ...p, [c.id]: { progress: 0, doneMs: null, error: null } }));
    const stageOrder = custs === custs ? stages : BUSINESS_STAGES; // same ref
    fetchProject(c.asanaGid, pct => setLoadMeta(p => ({ ...p, [c.id]: { ...p[c.id], progress: pct } })))
      .then(({ data, durationMs }) => {
        const derived = deriveStages(data, stages);
        setCusts(prev => prev.map(x => x.id !== c.id ? x : { ...x, ...derived, lastFetchDurationMs: durationMs, fetchError: null }));
        setLoadMeta(p => ({ ...p, [c.id]: { progress: 100, doneMs: durationMs, error: null } }));
        setRStatus(p => ({ ...p, [c.id]: "ok" }));
        setTimeout(() => setRStatus(p => ({ ...p, [c.id]: null })), 3000);
      })
      .catch(err => {
        setLoadMeta(p => ({ ...p, [c.id]: { ...p[c.id], error: err.message } }));
        setRStatus(p => ({ ...p, [c.id]: "error" }));
      })
      .finally(() => setRefreshing(null));
  }

  function openRow(c) {
    setSelectedId(c.id);
    setCommentText(""); setCommentSent(false); setCommentError(null); setSelectedTaskGid("");
    setCalOpen(false); setCalViewMonth(null);
    const list = Array.isArray(notes[c.id]) ? notes[c.id] : notes[c.id] ? [notes[c.id]] : [];
    const latest = list.slice().sort((a,b) => (b.date||"").localeCompare(a.date||""))[0];
    setCalDate(latest?.date || null);
    setNoteForm({ date: toISO(getToday().toISOString()), blocker: "", note: "" });
  }

  function saveNote() {
    setSaving(true);
    setTimeout(() => {
      setNotes(p => {
        const existing = Array.isArray(p[selectedId]) ? p[selectedId] : p[selectedId] ? [p[selectedId]] : [];
        // Replace entry with same date or append new
        const idx = existing.findIndex(e => e.date === noteForm.date);
        const newEntry = { ...noteForm };
        const newList = idx >= 0 ? existing.map((e,i) => i === idx ? newEntry : e) : [...existing, newEntry];
        const updated = { ...p, [selectedId]: newList };
        try { localStorage.setItem("blaaiz-notes", JSON.stringify(updated)); } catch (_) {}
        setCalDate(noteForm.date);
        return updated;
      });
      setSaving(false); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }, 300);
  }

  function deleteBlocker(date) {
    setNotes(p => {
      const existing = Array.isArray(p[selectedId]) ? p[selectedId] : p[selectedId] ? [p[selectedId]] : [];
      const updated = { ...p, [selectedId]: existing.map(e => e.date === date ? { ...e, blocker: "" } : e) };
      try { localStorage.setItem("blaaiz-notes", JSON.stringify(updated)); } catch (_) {}
      return updated;
    });
  }

  function sendComment() {
    if (!commentText.trim() || !selected) return;
    const taskGid = selectedTaskGid || selected.firstTaskGid;
    if (!taskGid) { setCommentError("Select a task to comment on."); return; }
    setCommenting(true); setCommentError(null); setCommentSent(false);
    fetch("/api/asana/tasks/" + taskGid + "/stories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { text: commentText.trim() } }),
    })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(() => { setCommentSent(true); setCommentText(""); setSelectedTaskGid(""); setTimeout(() => setCommentSent(false), 3000); })
    .catch(e => setCommentError(e.message))
    .finally(() => setCommenting(false));
  }

  return (
    <div>
      {/* KPIs */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label: "Customers",      val: enriched.length,                                               big: true },
          { label: "In Kick Off",    val: loaded.filter(c => c.activeStages?.includes("Kick Off")).length, big: true },
          { label: "Furthest Along", val: furthest?.name || "—",         sub: furthest?.currentStage,   big: false },
          { label: "Blockers",       val: blocked, red: blocked > 0,                                    big: true },
        ].map(k => (
          <div key={k.label} className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-xs text-gray-400">{k.label}</p>
            <p className={"font-black mt-1 " + (k.big ? "text-3xl" : "text-sm") + (k.red ? " text-red-500" : " text-gray-900")}>{k.val}</p>
            {k.sub && <p className="text-xs text-gray-400 mt-0.5">{k.sub}</p>}
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Stage Distribution</p>
        <div className="flex items-end gap-3" style={{ height: "80px" }}>
          {stageStats.map((s, i) => {
            const maxCount = Math.max(...stageStats.map(x => x.count), 1);
            const barH = Math.max((s.count / maxCount) * 68, s.count > 0 ? 6 : 2);
            return (
              <div key={s.name} onClick={() => setFilterStage(filterStage === i ? null : i)} className="flex flex-col items-center flex-1 min-w-0 cursor-pointer group">
                <span className="text-xs font-bold text-gray-700 mb-1">{s.count || ""}</span>
                <div className={"w-full rounded-t-lg " + stageBars[i] + (filterStage === i ? " ring-2 ring-offset-1 ring-gray-800" : " opacity-70 group-hover:opacity-100")} style={{ height: barH + "px" }} />
                <span className="text-xs text-gray-400 mt-1 text-center leading-tight truncate w-full">{s.name}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Stage pills */}
      <div className="flex flex-wrap gap-2 mb-4">
        {stageStats.map((s, i) => (
          <div key={s.name} onClick={() => { setFilterStage(filterStage === i ? null : i); setSelectedId(null); }}
            className={"bg-white rounded-xl border p-3 cursor-pointer hover:shadow-sm transition-all flex-1 min-w-24 " + (filterStage === i ? "ring-2 ring-gray-800 border-gray-800" : "border-gray-200")}>
            <span className={"text-xs font-bold px-2 py-0.5 rounded-full " + stageColors[i]}>{s.name}</span>
            <p className="text-2xl font-black text-gray-900 mt-2">{s.count}</p>
            <div className="mt-1 mb-1">
              <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className={"h-full rounded-full " + stageBars[i]} style={{ width: s.pct + "%" }} />
              </div>
            </div>
            <p className="text-xs text-gray-400">avg {s.avgDays}d</p>
          </div>
        ))}
      </div>

      {/* Table + detail */}
      <div className="flex gap-4">
        <div className={"bg-white rounded-xl border border-gray-200 overflow-hidden flex-1"}>
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-3 flex-wrap">
            <p className="text-xs font-semibold text-gray-700 flex-1">
              {filterStage != null ? `"${stages[filterStage]}" customers` : "All Customers"}
              <span className="ml-1 text-gray-400 font-normal">({filtered.length})</span>
            </p>
            {/* Owner filter */}
            <select value={filterOwner} onChange={e => setFilterOwner(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white">
              <option value="">All Owners</option>
              {ownerOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
            {/* Status filter */}
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white">
              <option value="">All Statuses</option>
              <option value="green">On Track</option>
              <option value="yellow">At Risk</option>
              <option value="red">Off Track</option>
              <option value="blue">On Hold / Dropped</option>
            </select>
            {(filterStage != null || filterOwner || filterStatus) && (
              <button onClick={() => { setFilterStage(null); setFilterOwner(""); setFilterStatus(""); setSelectedId(null); }}
                className="text-xs px-2 py-1 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-600 font-medium transition-colors">✕ Clear</button>
            )}
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-400 uppercase tracking-wide text-left sticky top-0 z-10">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Customer</th>
                <th className="px-4 py-2.5 font-semibold">Active Stage</th>
                <th className="px-4 py-2.5 font-semibold">Stage Days</th>
                <th className="px-4 py-2.5 font-semibold">Total Days</th>
                <th className="px-4 py-2.5 font-semibold">Owner</th>
                <th className="px-4 py-2.5 font-semibold">Progress</th>
                <th className="px-4 py-2.5 font-semibold">Blocker</th>
                <th className="px-4 py-2.5 font-semibold">Load</th>
                <th className="px-4 py-2.5 font-semibold"></th>
              </tr>
            </thead>
          </table>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: "336px" }}>
          <table className="w-full text-xs">
            <tbody>
              {filtered.map(c => {
                const meta  = loadMeta[c.id] || {};
                const isSel = c.id === selectedId;
                const sumVals = Object.values(c.stageSummary || {});
                const totalT  = sumVals.reduce((a,s) => a + (s.total||0), 0);
                const doneT   = sumVals.reduce((a,s) => a + (s.done||0),  0);
                const pct     = totalT ? Math.round(doneT / totalT * 100) : 0;
                return (
                  <tr id={"customer-row-" + c.id} key={c.id} onClick={() => openRow(c)}
                    className={"border-t border-gray-50 cursor-pointer hover:bg-blue-50 transition-colors " + (isSel ? "bg-blue-50" : "")}>
                    <td className="px-4 py-3 font-semibold text-gray-900">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {c.name}
                        {c.note && <span className="text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full">2 portfolios</span>}
                        {c.fetchError && <span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full">⚠ error</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {!c.isLoaded ? <Skeleton /> :
                        c.activeStages?.length > 0
                          ? c.activeStages.map(s => <span key={s} className={"text-xs font-semibold px-2 py-0.5 rounded-full mr-1 " + (stageColors[stages.indexOf(s)] || "bg-gray-100 text-gray-500")}>{s}</span>)
                          : <span className="text-xs text-gray-300 italic">none</span>
                      }
                    </td>
                    <td className="px-4 py-3">{!c.isLoaded ? <Skeleton /> : <DurationPill days={c.daysInStage} completed={!!(c.stageCompletedAt?.[c.currentStage])} />}</td>
                    <td className={"px-4 py-3 " + daysColor(c.daysTotal || 0)}>{fmt(c.daysTotal)}d</td>
                    <td className="px-4 py-3 text-gray-600">{!c.isLoaded ? <Skeleton /> : (c.assignee || "—")}</td>
                    <td className="px-4 py-3">
                      {!c.isLoaded ? <Skeleton /> : (
                        <div className="flex items-center gap-2">
                          <div className="w-14 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-400 rounded-full" style={{ width: pct + "%" }} />
                          </div>
                          <span className="text-gray-500">{pct}%</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {c.meeting?.blocker
                        ? <span className="bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-semibold truncate max-w-24 block">{c.meeting.blocker}</span>
                        : <span className="text-gray-200">—</span>}
                    </td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <ProgressCell progress={meta.progress} doneMs={meta.doneMs} error={meta.error} retrying={meta.retrying} />
                    </td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <div className="flex flex-col items-center gap-0.5">
                        <button onClick={() => doRefresh(c)} disabled={refreshing === c.id}
                          className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40">
                          {refreshing === c.id ? "⏳" : "🔄"}
                        </button>
                        {rStatus[c.id] === "ok"    && <span className="text-xs text-green-600">✓</span>}
                        {rStatus[c.id] === "error" && <span className="text-xs text-red-500">✗</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="w-80 bg-white rounded-xl border border-gray-200 flex flex-col shrink-0 overflow-y-auto" style={{ maxHeight: "80vh" }}>
            <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between">
              <div>
                <p className="font-bold text-gray-900">{selected.name}</p>
                <p className="text-xs text-gray-400 mt-0.5">{fmt(selected.daysTotal)}d onboarding · {selected.assignee || "Unassigned"}</p>
                <a href={selected.asanaUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-500 underline mt-0.5 inline-block">Open in Asana ↗</a>
                {selected.lastFetchedAt && (
                  <p className="text-xs text-emerald-600 mt-0.5">
                    ✓ {new Date(selected.lastFetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {selected.lastFetchDurationMs ? ` · ${(selected.lastFetchDurationMs/1000).toFixed(1)}s` : ""}
                  </p>
                )}
              </div>
              <button onClick={() => setSelectedId(null)} className="text-gray-300 hover:text-gray-600 text-xl ml-2">×</button>
            </div>

            <div className="px-5 py-3 border-b border-gray-100">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Stage Breakdown</p>
                <button onClick={() => doRefresh(selected)} disabled={refreshing === selected.id}
                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40">
                  {refreshing === selected.id ? "⏳" : "🔄 Refresh"}
                </button>
              </div>
              {rStatus[selected.id] === "ok"    && <div className="mb-2 text-xs text-green-600 bg-green-50 border border-green-200 rounded-lg px-3 py-1.5">✓ Updated</div>}
              {rStatus[selected.id] === "error" && <div className="mb-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">⚠ Sync failed</div>}
              {!selected.isLoaded
                ? <div className="space-y-2">{stages.map(s => <div key={s} className="h-10 bg-gray-50 rounded-lg animate-pulse" />)}</div>
                : <div className="space-y-1.5">
                    {stages.map(s => {
                      const info = selected.stageSummary?.[s];
                      if (!info || info.status === "N/A") return null;
                      const isAct = selected.activeStages?.includes(s);
                      const dur   = selected.stageDaysActive?.[s];
                      const comp  = selected.stageCompletedAt?.[s];
                      return (
                        <div key={s} className={"rounded-lg px-3 py-2 " + (isAct ? "bg-blue-50 border border-blue-200" : "bg-gray-50")}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              {isAct && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />}
                              <span className={"text-xs font-semibold " + (isAct ? "text-blue-700" : "text-gray-600")}>{s}</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              {info.priority && <span className={"text-xs px-1.5 py-0.5 rounded-full font-semibold " + (PRIORITY_CLS[info.priority] || "")}>{info.priority}</span>}
                              <span className={"text-xs px-2 py-0.5 rounded-full font-semibold " + (STATUS_CLS[info.status] || "")}>{info.status}</span>
                              <span className="text-xs text-gray-400">{info.done}/{info.total}</span>
                            </div>
                          </div>
                          {dur != null && (
                            <div className="mt-1 flex items-center gap-1">
                              <span className="text-xs text-gray-400">{comp ? "Spent:" : "Active:"}</span>
                              <DurationPill days={dur} completed={!!comp} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
              }
            </div>

            {/* Project Status — calendar shows history, clicking date shows that status */}
            {(() => {
              const projHistory = (statusHistory[selected.asanaGid] || []).slice().sort((a,b) => b.date.localeCompare(a.date));
              const historyDates = new Set(projHistory.map(e => e.date));
              // Active entry: calDate if it's in history, else latest
              const activeEntry = calDate && historyDates.has(calDate)
                ? projHistory.find(e => e.date === calDate)
                : projHistory[0] || (selected.statusText ? { date: selected.statusDate, title: selected.statusTitle, text: selected.statusText, color: selected.statusColor } : null);

              if (!activeEntry && projHistory.length === 0) return null;

              function renderStatusEntry(entry) {
                if (!entry) return null;
                const text = entry.text || "";
                const sections = {};
                const lines = text.split("\n");
                let current = null;
                lines.forEach(line => {
                  const trimmed = line.trim();
                  if (!trimmed || trimmed.match(/^-{3,}$/)) return;
                  if (["Summary","Next steps","Blockers","Next Steps"].includes(trimmed)) { current = trimmed; sections[current] = []; }
                  else if (current) sections[current].push(trimmed);
                });
                const hasBlocker = BLOCKER_KEYWORDS.some(k => text.toLowerCase().includes(k));
                return (
                  <div className="space-y-2 mt-2">
                    {entry.title && <p className="text-xs font-semibold text-gray-700">{entry.title}</p>}
                    {Object.entries(sections).map(([heading, ls]) => ls.filter(Boolean).length > 0 && (
                      <div key={heading}>
                        <p className="text-xs font-semibold text-gray-500 mb-0.5">{heading}</p>
                        {ls.filter(Boolean).map((l,i) => <p key={i} className="text-xs text-gray-700 leading-relaxed">{l}</p>)}
                      </div>
                    ))}
                    {Object.keys(sections).length === 0 && <p className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap">{text}</p>}
                    {hasBlocker && (
                      <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-start gap-2">
                        <span className="text-red-500 text-sm mt-0.5">⚠</span>
                        <div>
                          <p className="text-xs font-semibold text-red-700">Blocker Detected</p>
                          <p className="text-xs text-red-600 mt-0.5">Review summary above.</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              const statusColorCls = (c) =>
                c === "green" ? "bg-emerald-100 text-emerald-700" :
                c === "red"   ? "bg-red-100 text-red-700" :
                c === "yellow"? "bg-amber-100 text-amber-700" :
                c === "blue"  ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600";
              const statusLabel = (c) =>
                c === "green" ? "On Track" : c === "red" ? "Off Track" : c === "yellow" ? "At Risk" : c === "blue" ? "On Hold" : "Update";

              return (
                <div className="px-5 py-4 border-b border-gray-100">
                  {/* Header row */}
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-bold text-gray-700 uppercase tracking-wide">Project Status</p>
                    <div className="flex items-center gap-2">
                      {activeEntry && <span className={"text-xs px-2 py-0.5 rounded-full font-semibold " + statusColorCls(activeEntry.color)}>{statusLabel(activeEntry.color)}</span>}
                      <button onClick={() => { setCalOpen(o => !o); setCalViewMonth(null); setCalDate(null); }}
                        title="Status history calendar"
                        className={"text-base px-1.5 py-0.5 rounded-lg border transition-colors " + (calOpen ? "bg-blue-600 text-white border-blue-600" : "border-gray-200 text-gray-400 hover:border-blue-400 hover:text-blue-600")}>
                        📅
                      </button>
                    </div>
                  </div>

                  {/* Calendar — shows status history dates */}
                  {calOpen && (() => {
                    const today = getToday();
                    const baseYr = calViewMonth ? calViewMonth.yr : today.getFullYear();
                    const baseMo = calViewMonth ? calViewMonth.mo : today.getMonth();
                    const firstDay = new Date(baseYr, baseMo, 1).getDay();
                    const daysInMonth = new Date(baseYr, baseMo + 1, 0).getDate();
                    const cells = [];
                    for (let i = 0; i < firstDay; i++) cells.push(null);
                    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
                    const monthLabel = new Date(baseYr, baseMo, 1).toLocaleDateString([], { month: "long", year: "numeric" });
                    return (
                      <div className="bg-gray-50 rounded-xl p-3 mb-2">
                        <div className="flex items-center justify-between mb-2">
                          <button onClick={() => { const nm = baseMo===0?{yr:baseYr-1,mo:11}:{yr:baseYr,mo:baseMo-1}; setCalViewMonth(nm); setCalDate(null); }} className="text-gray-400 hover:text-gray-700 px-1 text-sm font-bold">‹</button>
                          <p className="text-xs font-semibold text-gray-600">{monthLabel}</p>
                          <button onClick={() => { const nm = baseMo===11?{yr:baseYr+1,mo:0}:{yr:baseYr,mo:baseMo+1}; setCalViewMonth(nm); setCalDate(null); }} className="text-gray-400 hover:text-gray-700 px-1 text-sm font-bold">›</button>
                        </div>
                        <div className="grid grid-cols-7 gap-0.5 text-center mb-1">
                          {["S","M","T","W","T","F","S"].map((d,i) => <p key={i} className="text-xs text-gray-300 font-semibold">{d}</p>)}
                          {cells.map((d, i) => {
                            if (!d) return <div key={i} />;
                            const iso = baseYr + "-" + String(baseMo+1).padStart(2,"0") + "-" + String(d).padStart(2,"0");
                            const entry = projHistory.find(e => e.date === iso);
                            const isActive = !!entry;
                            const isSel = calDate === iso;
                            return (
                              <div key={i} onClick={() => isActive && setCalDate(isSel ? null : iso)}
                                className={"flex flex-col items-center py-0.5 rounded " + (isActive ? "cursor-pointer " : "") + (isSel ? "bg-blue-600" : isActive ? "bg-blue-50 hover:bg-blue-100" : "")}>
                                <span className={"text-xs font-semibold " + (isSel ? "text-white" : isActive ? "text-blue-700" : "text-gray-400")}>{d}</span>
                                {isActive && <span className={"w-1.5 h-1.5 rounded-full mt-0.5 " + (isSel ? "bg-white" : statusColorCls(entry.color).split(" ")[0].replace("bg-","bg-"))}
                                  style={{ backgroundColor: entry.color==="green"?"#34d399":entry.color==="red"?"#f87171":entry.color==="yellow"?"#fbbf24":entry.color==="blue"?"#60a5fa":"#9ca3af" }} />}
                              </div>
                            );
                          })}
                        </div>
                        {projHistory.length === 0 && <p className="text-xs text-gray-400 text-center mt-1">No status history yet — loads on each refresh</p>}
                        {projHistory.length > 0 && !calDate && <p className="text-xs text-blue-400 text-center mt-1">{projHistory.length} update{projHistory.length>1?"s":""} — tap a date to view</p>}
                      </div>
                    );
                  })()}

                  {/* Active status entry */}
                  {activeEntry && renderStatusEntry(activeEntry)}
                </div>
              );
            })()}

            {/* ── Meeting Notes ── */}
            <div className="px-5 py-4 space-y-3 border-b border-gray-100">
              <p className="text-xs font-bold text-gray-700 uppercase tracking-wide">Meeting Notes</p>

              {/* Collapsible calendar with month/year navigation */}
              {calOpen && (() => {
                const notesList = selected.notesList || [];
                const noteDates = new Set(notesList.map(n => n.date));
                const today = getToday();
                const baseYr = calViewMonth ? calViewMonth.yr : today.getFullYear();
                const baseMo = calViewMonth ? calViewMonth.mo : today.getMonth();
                const firstDay = new Date(baseYr, baseMo, 1).getDay();
                const daysInMonth = new Date(baseYr, baseMo + 1, 0).getDate();
                const cells = [];
                for (let i = 0; i < firstDay; i++) cells.push(null);
                for (let d = 1; d <= daysInMonth; d++) cells.push(d);
                const monthLabel = new Date(baseYr, baseMo, 1).toLocaleDateString([], { month: "long", year: "numeric" });
                const viewNote = calDate ? notesList.find(n => n.date === calDate) : null;

                function prevMonth() {
                  const nm = baseMo === 0 ? { yr: baseYr - 1, mo: 11 } : { yr: baseYr, mo: baseMo - 1 };
                  setCalViewMonth(nm); setCalDate(null);
                }
                function nextMonth() {
                  const nm = baseMo === 11 ? { yr: baseYr + 1, mo: 0 } : { yr: baseYr, mo: baseMo + 1 };
                  setCalViewMonth(nm); setCalDate(null);
                }

                return (
                  <div className="bg-gray-50 rounded-xl p-3 mb-1">
                    {/* Month/year nav */}
                    <div className="flex items-center justify-between mb-2">
                      <button onClick={prevMonth} className="text-gray-400 hover:text-gray-700 px-1 text-sm font-bold">‹</button>
                      <p className="text-xs font-semibold text-gray-600">{monthLabel}</p>
                      <button onClick={nextMonth} className="text-gray-400 hover:text-gray-700 px-1 text-sm font-bold">›</button>
                    </div>
                    <div className="grid grid-cols-7 gap-0.5 text-center mb-1">
                      {["S","M","T","W","T","F","S"].map((d,i) => <p key={i} className="text-xs text-gray-300 font-semibold">{d}</p>)}
                      {cells.map((d, i) => {
                        if (!d) return <div key={i} />;
                        const iso = baseYr + "-" + String(baseMo+1).padStart(2,"0") + "-" + String(d).padStart(2,"0");
                        const hasDot = noteDates.has(iso);
                        const isSel = calDate === iso;
                        return (
                          <div key={i} onClick={() => hasDot && setCalDate(isSel ? null : iso)}
                            className={"flex flex-col items-center py-0.5 rounded " + (hasDot ? "cursor-pointer " : "") + (isSel ? "bg-blue-600" : hasDot ? "bg-blue-50 hover:bg-blue-100" : "")}>
                            <span className={"text-xs " + (isSel ? "text-white font-bold" : hasDot ? "text-blue-700 font-semibold" : "text-gray-400")}>{d}</span>
                            {hasDot && <span className={"w-1 h-1 rounded-full mt-0.5 " + (isSel ? "bg-white" : "bg-blue-500")} />}
                          </div>
                        );
                      })}
                    </div>
                    {/* Show selected note */}
                    {viewNote && (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs mt-2">
                        <div className="flex items-center justify-between">
                          <p className="font-semibold text-amber-700">{viewNote.date}</p>
                          <button onClick={() => setCalDate(null)} className="text-gray-400 hover:text-gray-600 text-sm">×</button>
                        </div>
                        {viewNote.blocker && (
                          <div className="flex items-center justify-between mt-1">
                            <p className="text-red-600">⚠ {viewNote.blocker}</p>
                            <button onClick={() => deleteBlocker(viewNote.date)}
                              className="text-xs px-2 py-0.5 rounded-full bg-red-100 hover:bg-red-200 text-red-600 font-medium ml-2">
                              Resolve ✓
                            </button>
                          </div>
                        )}
                        {viewNote.note && <p className="text-gray-600 mt-1">{viewNote.note}</p>}
                      </div>
                    )}
                    {!viewNote && noteDates.size > 0 && (
                      <p className="text-xs text-blue-400 text-center mt-1">{noteDates.size} note{noteDates.size > 1 ? "s" : ""} — tap a dot to view</p>
                    )}
                    {noteDates.size === 0 && (
                      <p className="text-xs text-gray-400 text-center mt-1">No notes saved yet</p>
                    )}
                  </div>
                );
              })()}

              {/* Add new note form */}
              <div>
                <label className="text-xs text-gray-500">Date</label>
                <input type="date" value={noteForm.date} onChange={e => setNoteForm(p => ({ ...p, date: e.target.value }))}
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div>
                <label className="text-xs text-gray-500">Blocker</label>
                <BlockerSelect value={noteForm.blocker} onChange={v => setNoteForm(p => ({ ...p, blocker: v }))} currentStage={selected.currentStage || "Kick Off"} />
              </div>
              <div>
                <label className="text-xs text-gray-500">Notes</label>
                <textarea rows={3} value={noteForm.note} onChange={e => setNoteForm(p => ({ ...p, note: e.target.value }))}
                  placeholder="Summary, next steps…"
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none" />
              </div>
              <button onClick={saveNote} disabled={saving}
                className={"w-full py-2.5 rounded-lg text-xs font-bold " + (saved ? "bg-green-500 text-white" : "bg-gray-900 text-white hover:bg-gray-700")}>
                {saving ? "Saving…" : saved ? "✓ Saved!" : "Save Notes"}
              </button>
            </div>

            {/* ── Comment to Asana ── */}
            <div className="px-5 py-4 space-y-2">
              <p className="text-xs font-bold text-gray-700 uppercase tracking-wide">Comment to Asana</p>
              <p className="text-xs text-gray-400">Pick a task, write your comment — it appears in that task's activity feed in Asana</p>
              {selected.taskList?.length > 0 ? (
                <div>
                  <label className="text-xs text-gray-500">Select Task</label>
                  <select value={selectedTaskGid} onChange={e => setSelectedTaskGid(e.target.value)}
                    className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white">
                    <option value="">— pick a task —</option>
                    {(() => {
                      // Group tasks by section
                      const bySection = {};
                      (selected.taskList || []).forEach(t => {
                        const sec = t.section || "Other";
                        if (!bySection[sec]) bySection[sec] = [];
                        bySection[sec].push(t);
                      });
                      return Object.entries(bySection).map(([sec, tasks]) => (
                        <optgroup key={sec} label={sec}>
                          {tasks.map(t => <option key={t.gid} value={t.gid}>{t.name}</option>)}
                        </optgroup>
                      ));
                    })()}
                  </select>
                </div>
              ) : (
                <p className="text-xs text-amber-500">Project must finish loading to select a task</p>
              )}
              <div className="relative">
                <textarea
                  ref={textareaRef}
                  rows={3}
                  value={commentText}
                  onChange={e => {
                    const val = e.target.value;
                    setCommentText(val);
                    // Detect @ trigger
                    const caret = e.target.selectionStart;
                    const before = val.slice(0, caret);
                    const atMatch = before.match(/@(\w*)$/);
                    if (atMatch) {
                      setMentionQuery(atMatch[1].toLowerCase());
                      setMentionPos(caret - atMatch[0].length);
                    } else {
                      setMentionQuery(null);
                    }
                  }}
                  onKeyDown={e => {
                    if (mentionQuery !== null && e.key === "Escape") { setMentionQuery(null); }
                  }}
                  placeholder="Type your comment… use @ to mention a team member"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
                />

                {/* @mention picker */}
                {mentionQuery !== null && (() => {
                  const filtered = members.filter(m =>
                    m.name.toLowerCase().includes(mentionQuery)
                  ).slice(0, 8);
                  if (!filtered.length) return null;
                  return (
                    <div className="absolute bottom-full left-0 mb-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg z-30 overflow-hidden max-h-52 overflow-y-auto">
                      <p className="px-3 pt-2 pb-1 text-xs text-gray-400 font-semibold uppercase tracking-wide">Mention a member</p>
                      {filtered.map(m => (
                        <div key={m.gid}
                          onMouseDown={e => {
                            e.preventDefault(); // prevent textarea blur
                            // Replace the @query with @Name in the text
                            const before = commentText.slice(0, mentionPos);
                            const after  = commentText.slice(mentionPos + 1 + mentionQuery.length);
                            const inserted = before + "@" + m.name + " " + after;
                            setCommentText(inserted);
                            setMentionQuery(null);
                            // Restore focus + place caret after inserted name
                            setTimeout(() => {
                              if (textareaRef.current) {
                                const pos = (before + "@" + m.name + " ").length;
                                textareaRef.current.focus();
                                textareaRef.current.setSelectionRange(pos, pos);
                              }
                            }, 0);
                          }}
                          className="flex items-center gap-2.5 px-3 py-2 hover:bg-blue-50 cursor-pointer transition-colors">
                          {m.photo?.image_36x36
                            ? <img src={m.photo.image_36x36} className="w-6 h-6 rounded-full object-cover shrink-0" alt="" />
                            : <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-500 shrink-0">{m.name[0]}</div>
                          }
                          <span className="text-xs text-gray-800 font-medium">{m.name}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
              <button onClick={sendComment} disabled={commenting || !commentText.trim() || (!selectedTaskGid && !selected.firstTaskGid)}
                className={"w-full py-2.5 rounded-lg text-xs font-bold transition-colors " + (commentSent ? "bg-green-500 text-white" : "bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40")}>
                {commenting ? "Posting…" : commentSent ? "✓ Posted to Asana!" : "Post Comment"}
              </button>
              {commentError && <p className="text-xs text-red-500">⚠ {commentError}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// ─── Blocker detection keywords ───────────────────────────────────────────────
const BLOCKER_KEYWORDS = ["block","blocker","blocked","waiting","awaiting","pending","issue","delay","stuck","risk","escalat","no feedback","approval","no response","follow up","overdue","paused","on hold","not yet","hasn't","have not"];

function detectBlocker(statusText) {
  if (!statusText) return null;
  const lower = statusText.toLowerCase();
  const found = BLOCKER_KEYWORDS.filter(k => lower.includes(k));
  return found.length > 0 ? found : null;
}

const PORTFOLIO_LABEL = { platform: "Platform", business: "Business", pay: "Pay" };
const PORTFOLIO_COLOR = { platform: "bg-indigo-100 text-indigo-700", business: "bg-emerald-100 text-emerald-700", pay: "bg-violet-100 text-violet-700" };

function BlockersPanel({ platCusts, bizCusts, payCusts, notes = {} }) {
  const all = [
    ...platCusts.map(c => ({ ...c, portfolioLabel: "Platform", meeting: notes[c.id] || null })),
    ...bizCusts.map(c  => ({ ...c, portfolioLabel: "Business", meeting: notes[c.id] || null })),
    ...payCusts.map(c  => ({ ...c, portfolioLabel: "Pay",      meeting: notes[c.id] || null })),
  ];

  const withBlockers = all.filter(c => detectBlocker(c.statusText) || c.meeting?.blocker);
  const noStatus     = all.filter(c => c.isLoaded && !c.statusText);
  const notLoaded    = all.filter(c => !c.isLoaded && !c.fetchError);

  return (
    <div className="space-y-5">
      {/* Summary KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs font-semibold text-red-400 uppercase tracking-wide">Flagged Blockers</p>
          <p className="text-3xl font-black text-red-600 mt-1">{withBlockers.length}</p>
          <p className="text-xs text-red-400 mt-0.5">across all portfolios</p>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide">No Status Update</p>
          <p className="text-3xl font-black text-amber-600 mt-1">{noStatus.length}</p>
          <p className="text-xs text-amber-400 mt-0.5">projects without a status</p>
        </div>
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Total Projects</p>
          <p className="text-3xl font-black text-gray-700 mt-1">{all.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">{notLoaded.length > 0 ? notLoaded.length + " still loading…" : "all loaded"}</p>
        </div>
      </div>

      {/* Flagged projects */}
      {withBlockers.length > 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-red-50">
            <p className="text-xs font-bold text-red-700 uppercase tracking-wide">⚠ Flagged — Possible Blockers</p>
            <p className="text-xs text-red-400 mt-0.5">Status updates containing blocking language</p>
          </div>
          <div className="divide-y divide-gray-100">
            {withBlockers.map(c => {
              const keywords = detectBlocker(c.statusText) || [];
              const text = c.statusText || "";
              // Extract just the Summary section
              const summaryMatch = text.match(/Summary\s*\n+([\s\S]*?)(?:\n-{3,}|\n\nNext steps|$)/i);
              const summary = summaryMatch ? summaryMatch[1].trim() : text.split("\n")[0];
              return (
                <div key={c.id} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <p className="font-semibold text-gray-900 text-sm">{c.name}</p>
                        <span className={"text-xs px-2 py-0.5 rounded-full font-medium " + (PORTFOLIO_COLOR[c.portfolio] || "bg-gray-100 text-gray-600")}>{c.portfolioLabel}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">{c.currentStage || "—"}</span>
                      </div>
                      {c.statusTitle && <p className="text-xs text-gray-400 mb-1">{c.statusTitle}</p>}
                      {summary && <p className="text-xs text-gray-600 leading-relaxed mb-2">{summary}</p>}
                      <div className="flex flex-wrap gap-1">
                        {c.meeting?.blocker && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-red-600 text-white font-medium">
                            ⚑ {c.meeting.blocker}
                          </span>
                        )}
                        {keywords.map(k => (
                          <span key={k} className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">
                            {k}
                          </span>
                        ))}
                      </div>
                    </div>
                    <a href={c.asanaUrl} target="_blank" rel="noreferrer"
                      className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-400 hover:text-blue-600 hover:border-blue-300 whitespace-nowrap shrink-0">
                      Open ↗
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 text-center">
          <p className="text-emerald-600 font-semibold text-sm">✓ No blockers detected</p>
          <p className="text-emerald-400 text-xs mt-1">All status updates look clear</p>
        </div>
      )}

      {/* Projects with no status update */}
      {noStatus.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-amber-50">
            <p className="text-xs font-bold text-amber-700 uppercase tracking-wide">⚡ No Status Update</p>
            <p className="text-xs text-amber-400 mt-0.5">These projects have no Asana status — consider adding one</p>
          </div>
          <div className="divide-y divide-gray-100">
            {noStatus.map(c => (
              <div key={c.id} className="px-5 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-gray-800 text-sm">{c.name}</p>
                  <span className={"text-xs px-2 py-0.5 rounded-full font-medium " + (PORTFOLIO_COLOR[c.portfolio] || "bg-gray-100 text-gray-600")}>{c.portfolioLabel}</span>
                  <span className="text-xs text-gray-400">{c.currentStage || "—"}</span>
                </div>
                <a href={c.asanaUrl} target="_blank" rel="noreferrer"
                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-400 hover:text-blue-600 hover:border-blue-300 whitespace-nowrap">
                  Open ↗
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────
// ─── Feature announcements ───────────────────────────────────────────────────
// To announce a new feature: bump FEATURE_ID and update FEATURE_CONTENT.
// Users who dismissed the current ID won't see it again.
const FEATURE_ID = "silent-refresh-v1"; // no modal needed for this fix

const FEATURE_CONTENT = {
  title: "⚡ Auto-refresh + smarter list view",
  bullets: [
    "Dashboard syncs with Asana automatically every 60 seconds — a tiny dot appears in the top-right corner while it refreshes silently in the background",
    "Customer list shows 6 rows at a time with smooth scrolling — detail panel always stays visible beside it",
    "@Mention team members in comments by typing @ — pick from your Asana workspace",
  ],
};

function App() {
  const now = useClock();
  const [tab,      setTab]      = useState("platform");
  const [notes,    setNotes]    = useState({});
  const [statusHistory, setStatusHistory] = useState({}); // { [projectGid]: [{date,title,text,color}] }
  const [platCusts, setPlatCusts] = useState([]);
  const [bizCusts,  setBizCusts]  = useState([]);
  const [payCusts,  setPayCusts]  = useState([]);
  const [loadMeta,  setLoadMeta]  = useState({});
  const [timings,   setTimings]   = useState([]);
  const [discovering,   setDiscovering]   = useState(true);
  const [discoverError, setDiscoverError] = useState(null);

  // Load persisted notes, status history, and feature-seen flag on mount
  useEffect(() => {
    try { const v = localStorage.getItem("blaaiz-notes"); if (v) setNotes(JSON.parse(v)); } catch (_) {}
    loadStatusHistory().then(h => setStatusHistory(h)).catch(() => {});
    try {
      const seen = JSON.parse(localStorage.getItem("blaaiz-seen-features") || "[]");
      if (!seen.includes(FEATURE_ID)) setShowFeature(true);
    } catch (_) { setShowFeature(true); }
  }, []);
  const [discoverPct,   setDiscoverPct]   = useState(0);
  const [silentRefreshing, setSilentRefreshing] = useState(false);
  const [searchQuery,   setSearchQuery]   = useState("");
  const [showFeature,   setShowFeature]   = useState(false);
  const [jumpToId,      setJumpToId]      = useState(null);

  // Step 1: get project list (cache → instant, or Asana → one-time slow). Step 2: fetch tasks.
  const runRef = useRef(null);
  useEffect(() => {
    async function run(forceRefresh = false) {
      setDiscoverError(null);

      let platform, business, pay;

      if (!forceRefresh) {
        // Try cache first — instant, no spinner needed
        const cached = await loadCachedProjects();
        if (cached) {
          ({ platform, business, pay } = cached);
          setDiscovering(false);
        }
      }

      if (!platform) {
        if (forceRefresh) {
          // Silent background refresh — tiny indicator only, no full loading screen
          setSilentRefreshing(true);
          try {
            ({ platform, business, pay } = await fetchAllProjects());
          } catch (e) {
            setSilentRefreshing(false);
            return; // fail silently — don't disrupt the user
          }
          setSilentRefreshing(false);
        } else {
          // First load / cache miss — show full progress bar
          setDiscovering(true);
          setDiscoverPct(0);
          let pct = 0;
          const ticker = setInterval(() => {
            pct = Math.min(90, pct + (pct < 40 ? 5 : pct < 70 ? 3 : 1));
            setDiscoverPct(pct);
          }, 600);
          try {
            ({ platform, business, pay } = await fetchAllProjects());
            clearInterval(ticker);
            setDiscoverPct(100);
          } catch (e) {
            clearInterval(ticker);
            setDiscoverError(e.message);
            setDiscovering(false);
            return;
          }
          setDiscovering(false);
        }
      }

      // On silent refresh: don't wipe existing customer arrays — only patch changed fields
      if (!forceRefresh) {
        setPlatCusts(platform || []);
        setBizCusts(business || []);
        setPayCusts(pay || []);
      } else {
        // Merge new project list without removing existing loaded data
        setPlatCusts(prev => {
          const next = (platform || []);
          if (!prev.length) return next;
          return next.map(n => { const old = prev.find(p => p.id === n.id); return old ? { ...old, ...n } : n; });
        });
        setBizCusts(prev => {
          const next = (business || []);
          if (!prev.length) return next;
          return next.map(n => { const old = prev.find(p => p.id === n.id); return old ? { ...old, ...n } : n; });
        });
        setPayCusts(prev => {
          const next = (pay || []);
          if (!prev.length) return next;
          return next.map(n => { const old = prev.find(p => p.id === n.id); return old ? { ...old, ...n } : n; });
        });
      }

      const allProjects = [...(platform || []), ...(business || []), ...(pay || [])];
      const initMeta = {};
      allProjects.forEach(p => { initMeta[p.id] = { progress: 0, doneMs: null, error: null }; });
      if (!forceRefresh) setLoadMeta(initMeta);

      const byGid = {};
      allProjects.forEach(p => {
        if (!byGid[p.gid]) byGid[p.gid] = [];
        byGid[p.gid].push(p);
      });

      // Fire all project fetches simultaneously
      Object.entries(byGid).forEach(([gid, projs]) => {
        const attempt = (retriesLeft) => {
          fetchProject(gid, pct => {
            projs.forEach(p => setLoadMeta(prev => ({ ...prev, [p.id]: { ...prev[p.id], progress: pct } })));
          }).then(({ data, durationMs }) => {
            setTimings(t => [...t.slice(-19), durationMs]);
            // Append status update to history if it has a date and text
            if (data.statusDate && data.statusText) {
              setStatusHistory(prev => {
                const entry = { date: data.statusDate, title: data.statusTitle, text: data.statusText, color: data.statusColor };
                appendStatusHistory(prev, gid, entry).then(updated => setStatusHistory(updated)).catch(() => {});
                return prev;
              });
            }
            projs.forEach(p => {
              const stageOrder = p.portfolio === "platform" ? PLATFORM_STAGES : p.portfolio === "pay" ? PAY_STAGES : BUSINESS_STAGES;
              try {
                const derived = deriveStages(data, stageOrder);
                const patch = (prev) => prev.map(x => {
                  if (x.id !== p.id) return x;
                  return { ...x, ...derived, lastFetchDurationMs: durationMs, fetchError: null };
                });
                if (p.portfolio === "platform")      setPlatCusts(patch);
                else if (p.portfolio === "pay")      setPayCusts(patch);
                else                                 setBizCusts(patch);
                setLoadMeta(prev => ({ ...prev, [p.id]: { progress: 100, doneMs: durationMs, error: null } }));
              } catch (e) {
                setLoadMeta(prev => ({ ...prev, [p.id]: { progress: null, doneMs: null, error: e.message } }));
              }
            });
          }).catch(err => {
            if (retriesLeft > 0) {
              projs.forEach(p => setLoadMeta(prev => ({ ...prev, [p.id]: { progress: 5, doneMs: null, error: null, retrying: true } })));
              setTimeout(() => attempt(retriesLeft - 1), 3000);
            } else {
              projs.forEach(p => {
                if (p.portfolio === "platform")     setPlatCusts(prev => prev.map(x => x.id !== p.id ? x : { ...x, fetchError: err.message }));
                else if (p.portfolio === "pay")     setPayCusts (prev => prev.map(x => x.id !== p.id ? x : { ...x, fetchError: err.message }));
                else                                setBizCusts (prev => prev.map(x => x.id !== p.id ? x : { ...x, fetchError: err.message }));
                setLoadMeta(prev => ({ ...prev, [p.id]: { progress: null, doneMs: null, error: err.message } }));
              });
            }
          });
        };
        attempt(3);
      });
    }
    runRef.current = run;
    run();
  }, []);

  // Auto-refresh every 60 seconds — silent background sync (no loading state)
  useEffect(() => {
    const iv = setInterval(() => {
      if (runRef.current) runRef.current(true); // true = bust cache → fresh from Asana
    }, 60000);
    return () => clearInterval(iv);
  }, []);

  const allMeta    = Object.values(loadMeta);
  const anyLoading = allMeta.some(m => m.progress != null && m.progress < 100 && !m.error);
  const doneCount  = allMeta.filter(m => m.doneMs != null).length;
  const totalCount = allMeta.length;
  const lastMs     = timings[timings.length - 1];
  const avgMs      = timings.length ? Math.round(timings.reduce((a,b) => a+b, 0) / timings.length) : null;

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-sm">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Blaaiz Onboarding Dashboard</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            {now.toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" })}
            {" · "}{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {avgMs != null && (
            <div className="text-xs bg-gray-50 border border-gray-200 px-3 py-1 rounded-full flex items-center gap-1.5">
              <span className="text-gray-400">avg</span>
              <span className={"font-bold " + (avgMs > 25000 ? "text-red-500" : avgMs > 15000 ? "text-amber-500" : "text-green-600")}>{(avgMs/1000).toFixed(1)}s</span>
              {lastMs && <><span className="text-gray-300">·</span><span className="text-gray-400">last</span><span className={"font-bold " + (lastMs > 25000 ? "text-red-500" : lastMs > 15000 ? "text-amber-500" : "text-green-600")}>{(lastMs/1000).toFixed(1)}s</span></>}
            </div>
          )}
          <div className={"text-xs font-semibold px-3 py-1 rounded-full flex items-center gap-1.5 " + (discoverError ? "bg-red-50 text-red-600" : discovering ? "bg-purple-50 text-purple-600" : anyLoading ? "bg-blue-50 text-blue-600" : "bg-emerald-50 text-emerald-600")}>
            {discoverError
              ? <span>⚠ {discoverError}</span>
              : discovering
                ? <><span className="animate-spin w-2 h-2 border-2 border-purple-400 border-t-transparent rounded-full inline-block" />Discovering projects…</>
                : anyLoading
                  ? <><span className="animate-spin w-2 h-2 border-2 border-blue-400 border-t-transparent rounded-full inline-block" />{doneCount}/{totalCount} loaded</>
                  : <><span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse inline-block" />Live · Asana — {platCusts.length + bizCusts.length + payCusts.length} projects</>
            }
          </div>
          <button
            onClick={async () => { await clearProjectCache(); runRef.current(true); }}
            title="Sync new projects from Asana"
            className="text-xs px-3 py-1.5 rounded-full border border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center gap-1.5">
            🔄 Sync Projects
          </button>
          {/* Silent background sync indicator */}
          {silentRefreshing && (
            <div className="flex items-center gap-1.5 px-2" title="Syncing with Asana…">
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse inline-block" />
              <span className="text-xs text-gray-400">Syncing…</span>
            </div>
          )}
          <button
            onClick={() => { document.cookie = "asana_token=; Path=/; Max-Age=0"; window.location.href = "/login.html"; }}
            className="text-xs px-3 py-1.5 rounded-full border border-gray-200 text-gray-500 hover:border-red-400 hover:text-red-600 transition-colors">
            Sign Out
          </button>
        </div>
      </div>

      {/* Search bar — above tabs */}
      <div className="px-6 pt-5 pb-3">
        <div className="relative max-w-lg">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search customers across all portfolios…"
            className="w-full pl-9 pr-8 py-2.5 text-xs border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white shadow-sm"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-base leading-none">×</button>
          )}
        </div>

        {/* Search results dropdown */}
        {searchQuery.trim() && (() => {
          const q = searchQuery.trim().toLowerCase();
          const PCOL = { platform: "bg-indigo-100 text-indigo-700", business: "bg-emerald-100 text-emerald-700", pay: "bg-violet-100 text-violet-700" };
          const PLBL = { platform: "Platform", business: "Business", pay: "Pay" };
          const all = [
            ...platCusts.map(c => ({ ...c, _pk: "platform" })),
            ...bizCusts.map(c  => ({ ...c, _pk: "business" })),
            ...payCusts.map(c  => ({ ...c, _pk: "pay" })),
          ];
          const results = all.filter(c => c.name.toLowerCase().includes(q));
          return (
            <div className="absolute z-20 mt-1 max-w-lg w-full bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden">
              {results.length === 0 ? (
                <div className="px-4 py-4 text-xs text-gray-400 text-center">No customers found for "{searchQuery}"</div>
              ) : (
                <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
                  {results.slice(0, 12).map(c => (
                    <div key={c.id} onClick={() => { setTab(c._pk); setSearchQuery(""); setJumpToId(c.id); }}
                      className="px-4 py-2.5 flex items-center gap-3 hover:bg-blue-50 cursor-pointer transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-gray-900 text-xs truncate">{c.name}</p>
                        {c.currentStage && <p className="text-xs text-gray-400 mt-0.5">{c.currentStage}{c.assignee ? " · " + c.assignee : ""}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={"text-xs px-2 py-0.5 rounded-full font-medium " + (PCOL[c._pk] || "bg-gray-100 text-gray-600")}>{PLBL[c._pk]}</span>
                        {c.statusColor && (
                          <span className={"w-2 h-2 rounded-full inline-block " + (c.statusColor === "green" ? "bg-emerald-400" : c.statusColor === "red" ? "bg-red-400" : c.statusColor === "yellow" ? "bg-amber-400" : "bg-blue-400")} />
                        )}
                      </div>
                    </div>
                  ))}
                  {results.length > 12 && (
                    <div className="px-4 py-2 text-xs text-gray-400 text-center bg-gray-50">{results.length - 12} more — type more to narrow down</div>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Tabs */}
      <div className="px-6 flex gap-3 mb-5">
        {[
          { id: "platform", label: "Blaaiz Platform", color: "bg-indigo-600",  sub: platCusts.length + " customers · " + PLATFORM_STAGES.length + " stages" },
          { id: "business", label: "Blaaiz Business",  color: "bg-emerald-600", sub: bizCusts.length  + " customers · " + BUSINESS_STAGES.length + " stages" },
          { id: "pay",      label: "Blaaiz Pay",        color: "bg-violet-600",  sub: payCusts.length  + " customers · " + PAY_STAGES.length + " stages" },
          { id: "blockers", label: "🚧 Blockers",        color: "bg-red-500",     sub: "All portfolios" },
          { id: "owners",   label: "Project Owners",   color: "bg-orange-500",  sub: "All portfolios" },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={"flex flex-col items-start px-5 py-3 rounded-xl border-2 transition-all " + (tab === t.id ? t.color + " text-white border-transparent shadow-lg" : "bg-white text-gray-600 border-gray-200 hover:border-gray-300")}>
            <span className="font-bold text-sm">{t.label}</span>
            <span className={"text-xs mt-0.5 " + (tab === t.id ? "text-white/70" : "text-gray-400")}>{t.sub}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="px-6 pb-10">
        {discoverError ? (
          <div className="bg-red-50 border border-red-200 rounded-xl p-8 text-center">
            <p className="text-red-600 font-semibold text-sm">Failed to load projects from Asana</p>
            <p className="text-red-400 text-xs mt-1">{discoverError}</p>
          </div>
        ) : discovering ? (
          <div className="bg-white border border-gray-200 rounded-xl p-12 flex flex-col items-center gap-4">
            <span className="animate-spin w-8 h-8 border-gray-200 border-t-purple-500 rounded-full inline-block" style={{ borderWidth: 3 }} />
            <div className="w-64 text-center">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-sm font-semibold text-gray-600">Discovering projects…</p>
                <span className="text-sm font-bold text-purple-600">{discoverPct}%</span>
              </div>
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-purple-400 rounded-full transition-all duration-500" style={{ width: discoverPct + "%" }} />
              </div>
              <p className="text-xs text-gray-400 mt-2">Fetching your team's project list from Asana</p>
            </div>
          </div>
        ) : tab === "owners"
          ? <OwnersPanel platCusts={platCusts} bizCusts={bizCusts} payCusts={payCusts} />
          : tab === "blockers"
          ? <BlockersPanel platCusts={platCusts} bizCusts={bizCusts} payCusts={payCusts} notes={notes} />
          : tab === "platform"
            ? <PortfolioView custs={platCusts} setCusts={setPlatCusts} stages={PLATFORM_STAGES} stageColors={PLATFORM_COLORS} stageBars={PLATFORM_BARS} notes={notes} setNotes={setNotes} loadMeta={loadMeta} setLoadMeta={setLoadMeta} statusHistory={statusHistory} jumpToId={jumpToId} setJumpToId={setJumpToId} />
            : tab === "pay"
              ? <PortfolioView custs={payCusts} setCusts={setPayCusts} stages={PAY_STAGES} stageColors={PLATFORM_COLORS} stageBars={PLATFORM_BARS} notes={notes} setNotes={setNotes} loadMeta={loadMeta} setLoadMeta={setLoadMeta} statusHistory={statusHistory} jumpToId={jumpToId} setJumpToId={setJumpToId} />
              : <PortfolioView custs={bizCusts}  setCusts={setBizCusts}  stages={BUSINESS_STAGES} stageColors={BUSINESS_COLORS} stageBars={BUSINESS_BARS}  notes={notes} setNotes={setNotes} loadMeta={loadMeta} setLoadMeta={setLoadMeta} statusHistory={statusHistory} jumpToId={jumpToId} setJumpToId={setJumpToId} />
        }
      </div>
      {/* ── Feature announcement modal ── */}
      {showFeature && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => {
          try {
            const seen = JSON.parse(localStorage.getItem("blaaiz-seen-features") || "[]");
            if (!seen.includes(FEATURE_ID)) { seen.push(FEATURE_ID); localStorage.setItem("blaaiz-seen-features", JSON.stringify(seen)); }
          } catch (_) {}
          setShowFeature(false);
        }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="bg-gray-900 px-6 py-5">
              <p className="text-white font-bold text-base">{FEATURE_CONTENT.title}</p>
              <p className="text-gray-400 text-xs mt-1">Here's what's new in this update</p>
            </div>
            <div className="px-6 py-5 space-y-3">
              {FEATURE_CONTENT.bullets.map((b, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-gray-900 text-white text-xs flex items-center justify-center shrink-0 mt-0.5 font-bold">{i + 1}</span>
                  <p className="text-sm text-gray-600 leading-relaxed">{b}</p>
                </div>
              ))}
            </div>
            <div className="px-6 pb-5">
              <button onClick={() => {
                try {
                  const seen = JSON.parse(localStorage.getItem("blaaiz-seen-features") || "[]");
                  if (!seen.includes(FEATURE_ID)) { seen.push(FEATURE_ID); localStorage.setItem("blaaiz-seen-features", JSON.stringify(seen)); }
                } catch (_) {}
                setShowFeature(false);
              }} className="w-full py-3 bg-gray-900 text-white text-sm font-bold rounded-xl hover:bg-gray-700 transition-colors">
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
