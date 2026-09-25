const api = typeof browser !== "undefined" ? browser : chrome;
const i18n = window.MoodleCrawlerI18n;
const t = i18n.t;

/** Setzt alle mit data-i18n ausgezeichneten Texte in der Oberfläche. */
function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
}

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
  language: "auto",
  maxFileMB: 0,
  delay: 150,
};

const MODE_HINT = { background: "ui.hintBackground", tab: "ui.hintTab" };

let tabId = null;
let course = null;
let mode = "idle";

function setStatus(text, kind = "wait") {
  ui.status.removeAttribute("data-i18n");
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
  options.language = el("opt-language").value;
  options.maxFileMB = Math.max(0, parseInt(el("opt-maxsize").value, 10) || 0);
  options.delay = Math.max(0, parseInt(el("opt-delay").value, 10) || 0);
  return options;
}

function applyOptions(stored) {
  const merged = { ...DEFAULTS, ...(stored || {}) };
  for (const [key, id] of Object.entries(CHECKBOXES)) el(id).checked = !!merged[key];
  el("opt-format").value = merged.format;
  el("opt-combine").value = merged.combine;
  el("opt-language").value = merged.language;
  i18n.setLanguage(merged.language);
  applyTranslations();
  el("opt-maxsize").value = merged.maxFileMB;
  el("opt-delay").value = merged.delay;
}

function showRunning(running, runMode) {
  if (runMode) mode = runMode;
  ui.start.hidden = running;
  ui.cancel.hidden = !running;
  ui.cancel.disabled = false;
  ui.progress.hidden = !running;
  ui.modeHint.textContent = running && MODE_HINT[mode] ? t(MODE_HINT[mode]) : "";
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
  ui.courselistCount.textContent = t("ui.coursesFound", { n: discovered.length });
  ui.courselist.hidden = false;
  updateStartLabel();
}

function updateStartLabel() {
  if (scopeValue() === "current") {
    ui.start.textContent = t("ui.download");
    ui.start.disabled = !course;
    ui.rowCombine.hidden = true;
    return;
  }
  if (!discovered) {
    ui.start.textContent = t("ui.searchCourses");
    ui.start.disabled = false;
    ui.rowCombine.hidden = true;
    return;
  }
  const count = selectedCourses().length;
  ui.start.textContent = count === 1 ? t("ui.downloadOne") : t("ui.downloadMany", { n: count });
  ui.start.disabled = count === 0;
  ui.rowCombine.hidden = count < 2;
}

function renderProgress(data) {
  if (!data) return;
  if (data.courseCount > 1) {
    ui.courseProgress.textContent = t("ui.courseProgress", {
      index: data.courseIndex, total: data.courseCount, name: data.courseName || "",
    });
  } else {
    ui.courseProgress.textContent = "";
  }
  const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
  ui.barFill.style.width = pct + "%";
  ui.progressText.textContent = data.total
    ? t("ui.progressLine", { done: data.done, total: data.total, phase: data.phase || "" })
    : data.phase || "";
  if (data.stats) {
    ui.stats.textContent = t("ui.statsLine", {
      files: data.stats.files, pages: data.stats.pages, images: data.stats.images,
      mb: (data.stats.bytes / 1048576).toFixed(1),
    });
  }
}

const language = () => el("opt-language").value;
const toBackground = (msg) =>
  api.runtime.sendMessage({ to: "background", language: language(), ...msg });
const toTab = (msg) =>
  api.tabs.sendMessage(tabId, { to: "tab", language: language(), ...msg });

async function injectAgent(id) {
  for (const file of ["/lib/zip.js", "/lib/i18n.js", "/lib/crawler.js", "/content/agent.js"]) {
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
    ui.courseMeta.textContent = t("ui.running");
    ui.course.hidden = false;
    ui.options.hidden = false;
    showRunning(true, "background");
    (background.logs || []).forEach((l) => addLog(l.message, l.level));
    renderProgress(background);
    setStatus(t("ui.running"), "wait");
    return;
  }

  // Ergebnis eines Laufs zeigen, der lief, während das Popup zu war.
  if (background && background.last && background.last.type === "done") {
    const last = background.last;
    setStatus(t("ui.lastRun", { file: last.filename, mb: (last.size / 1048576).toFixed(1) }), "ok");
  }

  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return setStatus(t("ui.noTab"), "error");
  tabId = tabs[0].id;

  if (!/^https?:/i.test(tabs[0].url || "")) {
    return setStatus(t("ui.notReadable"), "error");
  }

  try {
    await injectAgent(tabId);
  } catch (err) {
    return setStatus(t("ui.injectFailed", { message: err.message || err }), "error");
  }

  let info;
  try {
    info = await toTab({ cmd: "inspect" });
  } catch (err) {
    return setStatus(t("ui.noConnection"), "error");
  }

  if (!info || !info.ok) {
    return setStatus((info && info.error) || t("err.notACourse"), "error");
  }

  course = info.course;
  ui.courseName.textContent = course.name;
  ui.courseMeta.textContent = t("ui.courseMeta", { sections: info.sections, items: info.activities });
  ui.course.hidden = false;
  ui.scope.hidden = false;
  ui.options.hidden = false;
  ui.start.disabled = false;
  if (!(background && background.last && background.last.type === "done")) {
    setStatus(t("ui.courseDetected"), "ok");
  }

  if (info.running) {
    showRunning(true, "tab");
    renderProgress(await toTab({ cmd: "status" }));
    setStatus(t("ui.runningAlready"), "wait");
  }
}

async function runInTab(payload) {
  await injectAgent(tabId);
  await toBackground({ cmd: "markTabRun" }).catch(() => {});
  const res = await toTab({ cmd: "start", ...payload });
  if (res && !res.ok) {
    showRunning(false);
    return setStatus(res.error || t("ui.startFailed"), "error");
  }
  showRunning(true, "tab");
  setStatus(t("ui.runningTab"), "wait");
}

/** Sucht die Kurse des angemeldeten Nutzers (läuft im Moodle-Tab, ohne Extra-Rechte). */
async function discoverCourses() {
  ui.start.disabled = true;
  setStatus(t("ui.searching"), "wait");

  let res;
  try {
    res = await toTab({ cmd: "discover", baseUrl: course.url });
  } catch (err) {
    res = { ok: false, error: err.message || String(err) };
  }

  if (!res || !res.ok) {
    ui.start.disabled = false;
    const reason = res && res.error === "login"
      ? t("ui.loggedOut")
      : (res && res.error) || t("err.noCourses");
    return setStatus(reason, "error");
  }

  discovered = res.courses;
  renderCourseList();
  setStatus(t("ui.pickCourses", { n: discovered.length }), "ok");
}

async function startDownload(courses, granted) {
  const options = readOptions();
  await api.storage.local.set({ options });
  ui.log.textContent = "";
  ui.logBox.hidden = true;
  showRunning(true, granted ? "background" : "tab");
  setStatus(t("ui.starting"), "wait");

  const payload = courses.length === 1
    ? { course: courses[0], options }
    : { courses, options };

  if (!granted) {
    addLog(t("ui.noPermission"), "warn");
    return runInTab(payload);
  }

  // Prüfen, ob die Moodle-Sitzung auch im Hintergrund gilt.
  const probe = await toBackground({ cmd: "probe", courseUrl: courses[0].url }).catch(() => null);
  if (!probe || !probe.ok) {
    addLog(t("ui.noSession"), "warn");
    return runInTab(payload);
  }

  const res = await toBackground({ cmd: "start", ...payload });
  if (res && !res.ok) {
    showRunning(false);
    return setStatus(res.error || t("ui.startFailed"), "error");
  }
  showRunning(true, "background");
  setStatus(t("ui.runningBackground"), "wait");
}

el("opt-language").addEventListener("change", () => {
  i18n.setLanguage(language());
  applyTranslations();
  if (discovered) ui.courselistCount.textContent = t("ui.coursesFound", { n: discovered.length });
  updateStartLabel();
});

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
  setStatus(t("ui.cancelling"), "wait");
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
    const mb = (msg.size / 1048576).toFixed(1);
    const label = count > 1
      ? t("ui.doneMany", { n: count, mb })
      : t("ui.doneOne", { file: msg.filename, mb });
    setStatus(label + (msg.warnings ? t("ui.doneHints", { n: msg.warnings }) : ""), "ok");
  }
  if (msg.type === "failed") {
    showRunning(false);
    setStatus(t("ui.failed", { message: msg.error }), "error");
  }
  if (msg.type === "cancelled") {
    showRunning(false);
    setStatus(t("ui.cancelled"), "error");
  }
});

init().catch((err) => setStatus(t("ui.error", { message: err.message || err }), "error"));
