/*
 * Hintergrundseite: führt den Kurs-Download unabhängig vom Tab aus.
 * Dadurch darf der Nutzer den Tab wechseln, ihn weiterverwenden oder schließen.
 */
const api = typeof browser !== "undefined" ? browser : chrome;

const session = {
  mode: "idle", // idle | background | tab
  course: null,
  courses: null,
  logs: [],
  last: null,
};

function broadcast(message) {
  // Schlägt fehl, wenn kein Popup offen ist – das ist der Normalfall.
  api.runtime.sendMessage(message).catch(() => {});
}

function onEvent(type, payload) {
  if (type === "log") {
    session.logs.push(payload);
    if (session.logs.length > 300) session.logs.shift();
  }
  if (type === "done" || type === "failed" || type === "cancelled") {
    session.mode = "idle";
    session.last = { type, ...payload };
  }
  broadcast({ type, ...payload, mode: "background" });
}

/** Speichert das fertige Archiv über die Download-Verwaltung von Firefox. */
async function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await api.downloads.download({ url, filename, saveAs: false });
    await new Promise((resolve) => {
      const done = () => {
        api.downloads.onChanged.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      const listener = (delta) => {
        if (delta.id === id && delta.state && delta.state.current !== "in_progress") done();
      };
      const timer = setTimeout(done, 120000);
      api.downloads.onChanged.addListener(listener);
      // Falls der Download schon fertig war, bevor der Listener stand.
      api.downloads.search({ id }).then((items) => {
        if (items && items[0] && items[0].state !== "in_progress") done();
      }).catch(() => {});
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function startRun({ course, courses, options }) {
  session.mode = "background";
  session.course = course || (courses && courses[0]) || null;
  session.courses = courses || null;
  session.logs = [];
  session.last = null;

  window.MoodleCrawler.run({ course, courses, options, onEvent, download }).catch((err) => {
    session.mode = "idle";
    const message = err && err.message ? err.message : String(err);
    if (message === "__cancelled__") {
      onEvent("cancelled", {});
      onEvent("log", { message: "Abgebrochen.", level: "warn" });
    } else {
      onEvent("failed", { error: message });
      onEvent("log", { message: "Abbruch wegen Fehler: " + message, level: "error" });
    }
  });
}

api.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.to || msg.to !== "background") return undefined;

  if (msg.cmd === "probe") {
    return window.MoodleCrawler.probe(msg.courseUrl);
  }

  if (msg.cmd === "discover") {
    return window.MoodleCrawler.discoverCourses(msg.baseUrl);
  }

  if (msg.cmd === "start") {
    if (window.MoodleCrawler.isRunning()) {
      return Promise.resolve({ ok: false, error: "Es läuft bereits ein Download." });
    }
    startRun(msg);
    return Promise.resolve({ ok: true });
  }

  if (msg.cmd === "cancel") {
    window.MoodleCrawler.cancel();
    return Promise.resolve({ ok: true });
  }

  if (msg.cmd === "status") {
    return Promise.resolve({
      ...window.MoodleCrawler.getStatus(),
      mode: session.mode,
      course: session.course,
      courses: session.courses,
      logs: session.logs,
      last: session.last,
    });
  }

  if (msg.cmd === "markTabRun") {
    session.mode = "tab";
    return Promise.resolve({ ok: true });
  }

  return undefined;
});
