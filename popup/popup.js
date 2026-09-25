const api = typeof browser !== "undefined" ? browser : chrome;

const el = (id) => document.getElementById(id);
const ui = {
  status: el("status"),
  course: el("course"),
  courseName: el("course-name"),
  courseMeta: el("course-meta"),
  options: el("options"),
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
  forums: "opt-forums",
  allSections: "opt-allsections",
};

const DEFAULTS = {
  files: true,
  texts: true,
  images: true,
  forums: false,
  allSections: true,
  format: "md",
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
  options.maxFileMB = Math.max(0, parseInt(el("opt-maxsize").value, 10) || 0);
  options.delay = Math.max(0, parseInt(el("opt-delay").value, 10) || 0);
  return options;
}

function applyOptions(stored) {
  const merged = { ...DEFAULTS, ...(stored || {}) };
  for (const [key, id] of Object.entries(CHECKBOXES)) el(id).checked = !!merged[key];
  el("opt-format").value = merged.format;
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
}

function renderProgress(data) {
  if (!data) return;
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

async function runInTab(options) {
  await injectAgent(tabId);
  await toBackground({ cmd: "markTabRun" }).catch(() => {});
  const res = await toTab({ cmd: "start", course, options });
  if (res && !res.ok) {
    showRunning(false);
    return setStatus(res.error || "Start fehlgeschlagen.", "error");
  }
  showRunning(true, "tab");
  setStatus("Download läuft im Tab …", "wait");
}

ui.start.addEventListener("click", async () => {
  // permissions.request muss direkt aus dem Klick heraus aufgerufen werden.
  const origin = new URL(course.url).origin + "/*";
  let granted = false;
  try {
    granted = await api.permissions.request({ origins: [origin] });
  } catch (err) {
    granted = false;
  }

  const options = readOptions();
  await api.storage.local.set({ options });
  ui.log.textContent = "";
  ui.logBox.hidden = true;
  showRunning(true, granted ? "background" : "tab");
  setStatus("Wird gestartet …", "wait");

  if (!granted) {
    addLog("Ohne Zugriffsrecht läuft der Download im Tab. Der Tab muss offen bleiben.", "warn");
    return runInTab(options);
  }

  // Prüfen, ob die Moodle-Sitzung auch im Hintergrund gilt.
  const probe = await toBackground({ cmd: "probe", courseUrl: course.url }).catch(() => null);
  if (!probe || !probe.ok) {
    addLog("Im Hintergrund ist keine Moodle-Anmeldung aktiv – es wird im Tab geladen.", "warn");
    return runInTab(options);
  }

  const res = await toBackground({ cmd: "start", course, options });
  if (res && !res.ok) {
    showRunning(false);
    return setStatus(res.error || "Start fehlgeschlagen.", "error");
  }
  showRunning(true, "background");
  setStatus("Download läuft im Hintergrund …", "wait");
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
    setStatus(
      `Fertig: ${msg.filename} (${(msg.size / 1048576).toFixed(1)} MB)` +
        (msg.warnings ? ` · ${msg.warnings} Hinweise im Protokoll` : ""),
      "ok"
    );
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
