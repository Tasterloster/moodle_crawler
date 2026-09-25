const api = typeof browser !== "undefined" ? browser : chrome;

const el = (id) => document.getElementById(id);
const ui = {
  status: el("status"),
  course: el("course"),
  courseName: el("course-name"),
  courseMeta: el("course-meta"),
  options: el("options"),
  scope: el("scope"),
  courselist: el("courselist"),
  courselistItems: el("courselist-items"),
  courselistCount: el("courselist-count"),
  toggleAll: el("toggle-all"),
  rowCombine: el("row-combine"),
  courseProgress: el("course-progress"),
  start: el("start"),
  cancel: el("cancel"),
  progress: el("progress"),
  modeHint: el("mode-hint"),
  barFill: el("bar-fill"),
  progressText: el("progress-text"),
  stats: el("stats"),
  logBox: el("log-box"),
  log: el("log"),
};

const CHECKBOXES = {
  files: "opt-files",
  texts: "opt-texts",
  images: "opt-images",
  submissions: "opt-submissions",
  forums: "opt-forums",
  allSections: "opt-allsections",
};

const DEFAULTS = {
  files: true,
  texts: true,
  images: true,
  submissions: true,
  forums: false,
  allSections: true,
  format: "md",
  combine: "separate",
  maxFileMB: 0,
  delay: 150,
};

const MODE_HINT = {
  background: "Läuft im Hintergrund – du kannst den Tab wechseln oder schließen.",
  tab: "Läuft in diesem Tab – bitte den Tab geöffnet lassen.",
};

let tabId = null;
let course = null;
let mode = "idle";

function setStatus(text, kind = "wait") {
  ui.status.textContent = text;
  ui.status.className = "status status--" + kind;
}

function addLog(message, level = "info") {
  ui.logBox.hidden = false;
  const line = document.createElement("div");
  line.className = level;
  line.textContent = message;
  ui.log.appendChild(line);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function readOptions() {
  const options = {};
  for (const [key, id] of Object.entries(CHECKBOXES)) options[key] = el(id).checked;
  options.format = el("opt-format").value;
  options.combine = el("opt-combine").value;
  options.maxFileMB = Math.max(0, parseInt(el("opt-maxsize").value, 10) || 0);
  options.delay = Math.max(0, parseInt(el("opt-delay").value, 10) || 0);
  return options;
}

function applyOptions(stored) {
  const merged = { ...DEFAULTS, ...(stored || {}) };
  for (const [key, id] of Object.entries(CHECKBOXES)) el(id).checked = !!merged[key];
  el("opt-format").value = merged.format;
  el("opt-combine").value = merged.combine;
  el("opt-maxsize").value = merged.maxFileMB;
  el("opt-delay").value = merged.delay;
}

function showRunning(running, runMode) {
  if (runMode) mode = runMode;
  ui.start.hidden = running;
  ui.cancel.hidden = !running;
  ui.cancel.disabled = false;
  ui.progress.hidden = !running;
  ui.modeHint.textContent = running ? MODE_HINT[mode] || "" : "";
  ui.options.querySelectorAll("input, select").forEach((i) => (i.disabled = running));
  ui.scope.querySelectorAll("input").forEach((i) => (i.disabled = running));
  ui.courselistItems.querySelectorAll("input").forEach((i) => (i.disabled = running));
  ui.toggleAll.disabled = running;
}

/* ---------------- Kursauswahl ---------------- */

let discovered = null;

function selectedCourses() {
  if (!discovered) return [];
  const checked = [...ui.courselistItems.querySelectorAll("input:checked")].map((i) => i.value);
  return discovered.filter((c) => checked.includes(c.id));
}

function scopeValue() {
  const picked = ui.scope.querySelector('input[name="scope"]:checked');
  return picked ? picked.value : "current";
}

function renderCourseList() {
  ui.courselistItems.textContent = "";
  discovered.forEach((c) => {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = c.id;
    box.checked = true;
    box.addEventListener("change", updateStartLabel);
    const text = document.createElement("span");
    text.textContent = c.name || "Kurs " + c.id;
    label.append(box, text);
    ui.courselistItems.append(label);
  });
  ui.courselistCount.textContent = `${discovered.length} Kurse gefunden`;
  ui.courselist.hidden = false;
  updateStartLabel();
}

function updateStartLabel() {
  if (scopeValue() === "current") {
    ui.start.textContent = "Kurs herunterladen";
    ui.start.disabled = !course;
    ui.rowCombine.hidden = true;
    return;
  }
  if (!discovered) {
    ui.start.textContent = "Kurse suchen";
    ui.start.disabled = false;
    ui.rowCombine.hidden = true;
    return;
  }
  const count = selectedCourses().length;
  ui.start.textContent = count === 1 ? "1 Kurs herunterladen" : `${count} Kurse herunterladen`;
  ui.start.disabled = count === 0;
  ui.rowCombine.hidden = count < 2;
}

function renderProgress(data) {
  if (!data) return;
  if (data.courseCount > 1) {
    ui.courseProgress.textContent =
      `Kurs ${data.courseIndex} von ${data.courseCount}: ${data.courseName || ""}`;
  } else {
    ui.courseProgress.textContent = "";
  }
  const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
  ui.barFill.style.width = pct + "%";
  ui.progressText.textContent = data.total ? `${data.done} / ${data.total} · ${data.phase || ""}` : data.phase || "";
  if (data.stats) {
    ui.stats.textContent =
      `${data.stats.files} Dateien · ${data.stats.pages} Seiten · ${data.stats.images} Bilder · ` +
      `${(data.stats.bytes / 1048576).toFixed(1)} MB`;
  }
}

const toBackground = (msg) => api.runtime.sendMessage({ to: "background", ...msg });
const toTab = (msg) => api.tabs.sendMessage(tabId, { to: "tab", ...msg });

async function injectAgent(id) {
  for (const file of ["/lib/zip.js", "/lib/crawler.js", "/content/agent.js"]) {
    await api.tabs.executeScript(id, { file, runAt: "document_idle" });
  }
}

async function init() {
  const stored = await api.storage.local.get("options");
  applyOptions(stored && stored.options);

  // Läuft im Hintergrund schon etwas? Dann sofort anzeigen.
  const background = await toBackground({ cmd: "status" }).catch(() => null);
  if (background && background.running) {
    course = background.course;
    ui.courseName.textContent = course ? course.name : "";
    ui.courseMeta.textContent = "Download läuft";
    ui.course.hidden = false;
    ui.options.hidden = false;
    showRunning(true, "background");
    (background.logs || []).forEach((l) => addLog(l.message, l.level));
    renderProgress(background);
    setStatus("Download läuft …", "wait");
    return;
  }

  // Ergebnis eines Laufs zeigen, der lief, während das Popup zu war.
  if (background && background.last && background.last.type === "done") {
    const last = background.last;
    setStatus(`Zuletzt gesichert: ${last.filename} (${(last.size / 1048576).toFixed(1)} MB)`, "ok");
  }

  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return setStatus("Kein aktiver Tab gefunden.", "error");
  tabId = tabs[0].id;

  if (!/^https?:/i.test(tabs[0].url || "")) {
    return setStatus("Diese Seite kann nicht gelesen werden. Bitte den Moodle-Kurs im Tab öffnen.", "error");
  }

  try {
    await injectAgent(tabId);
  } catch (err) {
    return setStatus("Skript konnte nicht geladen werden: " + (err.message || err), "error");
  }

  let info;
  try {
    info = await toTab({ cmd: "inspect" });
  } catch (err) {
    return setStatus("Keine Verbindung zur Seite. Bitte die Seite neu laden.", "error");
  }

  if (!info || !info.ok) {
    return setStatus((info && info.error) || "Keine Moodle-Kursseite erkannt.", "error");
  }

  course = info.course;
  ui.courseName.textContent = course.name;
  ui.courseMeta.textContent = `${info.sections} Abschnitte · ${info.activities} Elemente auf dieser Seite`;
  ui.course.hidden = false;
  ui.scope.hidden = false;
  ui.options.hidden = false;
  ui.start.disabled = false;
  if (!(background && background.last && background.last.type === "done")) {
    setStatus("Kurs erkannt. Bereit zum Herunterladen.", "ok");
  }

  if (info.running) {
    showRunning(true, "tab");
    renderProgress(await toTab({ cmd: "status" }));
    setStatus("Download läuft bereits …", "wait");
  }
}

async function runInTab(payload) {
  await injectAgent(tabId);
  await toBackground({ cmd: "markTabRun" }).catch(() => {});
  const res = await toTab({ cmd: "start", ...payload });
  if (res && !res.ok) {
    showRunning(false);
    return setStatus(res.error || "Start fehlgeschlagen.", "error");
  }
  showRunning(true, "tab");
  setStatus("Download läuft im Tab …", "wait");
}

/** Sucht die Kurse des angemeldeten Nutzers (läuft im Moodle-Tab, ohne Extra-Rechte). */
async function discoverCourses() {
  ui.start.disabled = true;
  setStatus("Kurse werden gesucht …", "wait");

  let res;
  try {
    res = await toTab({ cmd: "discover", baseUrl: course.url });
  } catch (err) {
    res = { ok: false, error: err.message || String(err) };
  }

  if (!res || !res.ok) {
    ui.start.disabled = false;
    const reason = res && res.error === "login"
      ? "Moodle meldet dich als abgemeldet. Bitte neu anmelden."
      : (res && res.error) || "Es wurden keine Kurse gefunden.";
    return setStatus(reason, "error");
  }

  discovered = res.courses;
  renderCourseList();
  setStatus(`${discovered.length} Kurse gefunden. Auswahl prüfen und starten.`, "ok");
}

async function startDownload(courses, granted) {
  const options = readOptions();
  await api.storage.local.set({ options });
  ui.log.textContent = "";
  ui.logBox.hidden = true;
  showRunning(true, granted ? "background" : "tab");
  setStatus("Wird gestartet …", "wait");

  const payload = courses.length === 1
    ? { course: courses[0], options }
    : { courses, options };

  if (!granted) {
    addLog("Ohne Zugriffsrecht läuft der Download im Tab. Der Tab muss offen bleiben.", "warn");
    return runInTab(payload);
  }

  // Prüfen, ob die Moodle-Sitzung auch im Hintergrund gilt.
  const probe = await toBackground({ cmd: "probe", courseUrl: courses[0].url }).catch(() => null);
  if (!probe || !probe.ok) {
    addLog("Im Hintergrund ist keine Moodle-Anmeldung aktiv – es wird im Tab geladen.", "warn");
    return runInTab(payload);
  }

  const res = await toBackground({ cmd: "start", ...payload });
  if (res && !res.ok) {
    showRunning(false);
    return setStatus(res.error || "Start fehlgeschlagen.", "error");
  }
  showRunning(true, "background");
  setStatus("Download läuft im Hintergrund …", "wait");
}

ui.scope.addEventListener("change", () => {
  const all = scopeValue() === "all";
  ui.courselist.hidden = !all || !discovered;
  updateStartLabel();
});

ui.toggleAll.addEventListener("click", () => {
  const boxes = [...ui.courselistItems.querySelectorAll("input")];
  const target = !boxes.every((b) => b.checked);
  boxes.forEach((b) => (b.checked = target));
  updateStartLabel();
});

ui.start.addEventListener("click", async () => {
  // Erster Klick im Modus "Alle Kurse": nur suchen, noch nichts laden.
  if (scopeValue() === "all" && !discovered) return discoverCourses();

  const courses = scopeValue() === "all" ? selectedCourses() : [course];
  if (!courses.length) return;

  // permissions.request muss direkt aus dem Klick heraus aufgerufen werden.
  let granted = false;
  try {
    granted = await api.permissions.request({ origins: [new URL(courses[0].url).origin + "/*"] });
  } catch (err) {
    granted = false;
  }

  await startDownload(courses, granted);
});

ui.cancel.addEventListener("click", async () => {
  ui.cancel.disabled = true;
  setStatus("Wird abgebrochen …", "wait");
  if (mode === "background") await toBackground({ cmd: "cancel" }).catch(() => {});
  else await toTab({ cmd: "cancel" }).catch(() => {});
});

api.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.mode) mode = msg.mode;

  if (msg.type === "progress") renderProgress(msg);
  if (msg.type === "log") addLog(msg.message, msg.level);

  if (msg.type === "done") {
    showRunning(false);
    ui.progress.hidden = false;
    ui.barFill.style.width = "100%";
    const count = (msg.archives || []).length;
    const label = count > 1
      ? `Fertig: ${count} Archive (${(msg.size / 1048576).toFixed(1)} MB)`
      : `Fertig: ${msg.filename} (${(msg.size / 1048576).toFixed(1)} MB)`;
    setStatus(label + (msg.warnings ? ` · ${msg.warnings} Hinweise im Protokoll` : ""), "ok");
  }
  if (msg.type === "failed") {
    showRunning(false);
    setStatus("Fehlgeschlagen: " + msg.error, "error");
  }
  if (msg.type === "cancelled") {
    showRunning(false);
    setStatus("Abgebrochen.", "error");
  }
});

init().catch((err) => setStatus("Fehler: " + (err.message || err), "error"));
