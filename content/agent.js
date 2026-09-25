/*
 * Content-Skript: erkennt den Kurs auf der geöffneten Seite und kann den
 * Download ersatzweise im Tab ausführen, falls die Hintergrundseite keine
 * gültige Moodle-Sitzung hat.
 */
(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;
  if (window.__moodleCrawlerAgent) return;
  window.__moodleCrawlerAgent = true;

  const crawler = window.MoodleCrawler;

  function emit(type, payload) {
    try {
      api.runtime.sendMessage({ type, ...payload, mode: "tab" });
    } catch (e) {
      /* Popup geschlossen – der Lauf geht weiter. */
    }
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 120000);
  }

  function start(course, options) {
    crawler
      .run({
        course,
        options,
        rootDoc: document,
        rootUrl: location.href,
        onEvent: emit,
        download,
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);
        if (message === "__cancelled__") {
          emit("cancelled", {});
          emit("log", { message: "Abgebrochen.", level: "warn" });
        } else {
          emit("failed", { error: message });
          emit("log", { message: "Abbruch wegen Fehler: " + message, level: "error" });
        }
      });
  }

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.to !== "tab") return undefined;

    if (msg.cmd === "inspect") {
      const info = crawler.inspect(document, location.href);
      return Promise.resolve({ ...info, running: crawler.isRunning() });
    }

    if (msg.cmd === "start") {
      if (crawler.isRunning()) return Promise.resolve({ ok: false, error: "Es läuft bereits ein Download." });
      start(msg.course, msg.options);
      return Promise.resolve({ ok: true });
    }

    if (msg.cmd === "cancel") {
      crawler.cancel();
      return Promise.resolve({ ok: true });
    }

    if (msg.cmd === "status") {
      return Promise.resolve({ ...crawler.getStatus(), mode: "tab" });
    }

    return undefined;
  });
})();
