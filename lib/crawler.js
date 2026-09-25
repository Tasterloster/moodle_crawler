/*
 * Moodle Crawler – Content-Skript.
 * Läuft im Kontext der Moodle-Seite, damit alle Anfragen mit der bestehenden
 * Session laufen (same-origin, Cookies inklusive) – kein zweiter Login nötig.
 */
(function () {
  if (window.MoodleCrawler) return;

  const { ZipWriter } = window.__moodleCrawlerZip;

  /**
   * Die Herkunft des Kurses. Der Crawler läuft sowohl in der Moodle-Seite als
   * auch in der Hintergrundseite der Erweiterung – dort gibt es kein
   * `location` der Moodle-Seite, deshalb wird alles hierüber aufgelöst.
   */
  const session = { origin: "", host: "", base: "" };

  /** Rückmeldungen an die aufrufende Umgebung (Popup, Hintergrundseite). */
  let hooks = { onEvent: () => {}, download: null };

  /* ------------------------------------------------------------------ *
   * Zustand
   * ------------------------------------------------------------------ */

  const state = {
    running: false,
    cancelled: false,
    done: 0,
    total: 0,
    phase: "idle",
    courseIndex: 0,
    courseCount: 0,
    courseName: "",
    warnings: [],
    stats: { files: 0, pages: 0, images: 0, bytes: 0, skipped: 0 },
  };

  function emit(type, payload = {}) {
    try {
      hooks.onEvent(type, payload);
    } catch (e) {
      /* Empfänger weg (z.B. Popup geschlossen) – der Lauf geht weiter. */
    }
  }

  function log(message, level = "info") {
    if (level === "warn" || level === "error") state.warnings.push(message);
    emit("log", { message, level });
  }

  function progress(phase) {
    if (phase) state.phase = phase;
    emit("progress", {
      phase: state.phase,
      done: state.done,
      total: state.total,
      stats: state.stats,
      courseIndex: state.courseIndex,
      courseCount: state.courseCount,
      courseName: state.courseName,
    });
  }

  function checkCancelled() {
    if (state.cancelled) throw new Error("__cancelled__");
  }

  /* ------------------------------------------------------------------ *
   * Allgemeine Helfer
   * ------------------------------------------------------------------ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function abs(url, base) {
    if (!url) return null;
    try {
      return new URL(url, base || session.base || undefined).href;
    } catch (e) {
      return null;
    }
  }

  function sameOrigin(url) {
    try {
      return new URL(url, session.base || undefined).origin === session.origin;
    } catch (e) {
      return false;
    }
  }

  /** Macht aus beliebigem Text einen dateisystemtauglichen Namen. */
  function sanitize(name, fallback = "unbenannt") {
    let s = String(name == null ? "" : name)
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\\/:*?"<>|]/g, "-")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/^\.+/, "")
      .replace(/[. ]+$/, "");
    if (!s) s = fallback;
    if (s.length > 110) {
      const dot = s.lastIndexOf(".");
      const ext = dot > s.length - 12 && dot > 0 ? s.slice(dot) : "";
      s = s.slice(0, 110 - ext.length).trim() + ext;
    }
    return s;
  }

  function pad(n, width = 2) {
    return String(n).padStart(width, "0");
  }

  /** Relativer Pfad von einer Datei im Archiv zu einer anderen. */
  function relPath(fromPath, toPath) {
    const from = fromPath.split("/").slice(0, -1);
    const to = toPath.split("/");
    let i = 0;
    while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
    const up = new Array(from.length - i).fill("..");
    return up.concat(to.slice(i)).join("/") || to[to.length - 1];
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  /** Grobe, aber brauchbare HTML→Text-Umwandlung für die Textsammlung. */
  function htmlToText(root) {
    if (!root) return "";
    const clone = root.cloneNode(true);
    clone.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
    clone.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
    clone.querySelectorAll("li").forEach((n) => {
      n.prepend("• ");
      n.append("\n");
    });
    clone
      .querySelectorAll("p,div,tr,h1,h2,h3,h4,h5,h6,blockquote,pre,section,article,table,figcaption")
      .forEach((n) => n.append("\n"));
    clone.querySelectorAll("td,th").forEach((n) => n.append("\t"));
    return clone.textContent
      .replace(/ /g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** Dateiname aus Content-Disposition oder URL ableiten. */
  function filenameFrom(response, url) {
    const cd = response.headers.get("content-disposition") || "";
    let m = /filename\*\s*=\s*UTF-8''([^;\r\n]+)/i.exec(cd);
    if (m) {
      try {
        return decodeURIComponent(m[1].trim().replace(/^"|"$/g, ""));
      } catch (e) { /* weiter unten */ }
    }
    m = /filename\s*=\s*"([^"]+)"/i.exec(cd) || /filename\s*=\s*([^;\r\n]+)/i.exec(cd);
    if (m) return m[1].trim();
    try {
      const path = new URL(url).pathname;
      const base = decodeURIComponent(path.split("/").filter(Boolean).pop() || "");
      if (base && base !== "view.php" && base !== "index.php") return base;
    } catch (e) { /* ignorieren */ }
    return "";
  }

  const EXT_BY_MIME = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt",
    "text/html": ".html",
    "text/csv": ".csv",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
  };

  function ensureExtension(name, contentType) {
    if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return name;
    const mime = (contentType || "").split(";")[0].trim().toLowerCase();
    return name + (EXT_BY_MIME[mime] || "");
  }

  /* ------------------------------------------------------------------ *
   * Netzwerk
   * ------------------------------------------------------------------ */

  let lastRequest = 0;

  async function throttle(delayMs) {
    const wait = lastRequest + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
  }

  async function request(url, options = {}) {
    checkCancelled();
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      checkCancelled();
      await throttle(options.delay || 0);
      try {
        const res = await fetch(url, {
          credentials: "include",
          redirect: "follow",
          headers: { "X-Requested-With": "MoodleCrawler" },
        });
        if (res.status === 429 || res.status >= 500) throw new Error("HTTP " + res.status);
        return res;
      } catch (err) {
        if (err.message === "__cancelled__") throw err;
        lastError = err;
        await sleep(500 * (attempt + 1));
      }
    }
    throw lastError || new Error("Anfrage fehlgeschlagen: " + url);
  }

  const parser = new DOMParser();

  async function fetchDocument(url) {
    const res = await request(url);
    if (!res.ok) throw new Error("HTTP " + res.status + " bei " + url);
    const type = res.headers.get("content-type") || "";
    if (!/html|xml/i.test(type)) return { doc: null, response: res, finalUrl: res.url || url };
    const html = await res.text();
    return { doc: parser.parseFromString(html, "text/html"), response: res, finalUrl: res.url || url };
  }

  /* ------------------------------------------------------------------ *
   * Kurs- und Seitenerkennung
   * ------------------------------------------------------------------ */

  function courseIdFromUrl(url, base) {
    try {
      const u = new URL(url, base || undefined);
      if (/\/course\/view\.php$/.test(u.pathname)) return u.searchParams.get("id");
    } catch (e) { /* ignorieren */ }
    return null;
  }

  /** Ermittelt Kurs-ID, -Name und -Adresse aus einer beliebigen Moodle-Seite. */
  function detectCourse(doc, pageUrl) {
    let id = courseIdFromUrl(pageUrl, pageUrl);
    let url = pageUrl;

    if (!id) {
      // Auf Aktivitätsseiten führt die Brotkrumen-Navigation zum Kurs.
      const crumb = doc.querySelector(
        '.breadcrumb a[href*="/course/view.php?id="], nav a[href*="/course/view.php?id="], #page-header a[href*="/course/view.php?id="]'
      );
      if (crumb) {
        const href = abs(crumb.getAttribute("href"), pageUrl);
        id = courseIdFromUrl(href, pageUrl);
        url = href;
      }
    }
    if (!id && doc.body) {
      const bodyClass = /(?:^|\s)course-(\d+)(?:\s|$)/.exec(doc.body.className || "");
      if (bodyClass && bodyClass[1] !== "0") {
        id = bodyClass[1];
        url = new URL("/course/view.php?id=" + id, pageUrl).href;
      }
    }
    if (!id) return null;

    const heading =
      doc.querySelector(".page-context-header .page-header-headings h1") ||
      doc.querySelector("#page-header h1") ||
      doc.querySelector(".page-header-headings h1") ||
      doc.querySelector("header h1");

    let name = heading ? heading.textContent.trim() : "";
    if (!name) name = (doc.title || "").split("|")[0].trim();
    if (!name) name = "Moodle-Kurs " + id;

    return { id, url, name };
  }

  function mainRegion(doc) {
    return (
      doc.querySelector("#region-main .course-content") ||
      doc.querySelector("#region-main") ||
      doc.querySelector('[role="main"]') ||
      doc.querySelector("#page-content") ||
      doc.body
    );
  }

  function cleanText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".accesshide, .visually-hidden, .sr-only").forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, " ").trim();
  }

  /** Liest Abschnitte + Aktivitäten aus einer Kursseite (Moodle 3.x bis 4.x). */
  function parseCoursePage(doc, baseUrl) {
    const root = mainRegion(doc);
    if (!root) return [];

    const sectionNodes = new Set();
    root
      .querySelectorAll(
        'li.section, div.section.main, li.course-section, div.course-section, [data-for="section"]'
      )
      .forEach((n) => {
        // Verschachtelte Treffer (z.B. Section in Section) überspringen.
        if (![...sectionNodes].some((s) => s.contains(n))) sectionNodes.add(n);
      });

    const sections = [];
    let index = 0;

    const collect = (node) => {
      const sectionId =
        node.id ||
        node.getAttribute("data-id") ||
        node.getAttribute("data-number") ||
        "section-" + index;

      const nameEl =
        node.querySelector("h3.sectionname, .sectionname, .section-title, .course-section-header h3, h3.section-title") ||
        null;
      let name = cleanText(nameEl);
      const numberAttr = node.getAttribute("data-number") || node.getAttribute("data-sectionid");
      if (!name) name = numberAttr ? "Abschnitt " + numberAttr : "Abschnitt " + index;

      const summaryEl =
        node.querySelector(":scope > .content > .summary, :scope > .content .summarytext, :scope > .course-section-header ~ .summarytext, :scope > .summary") ||
        null;

      const activities = [];
      node
        .querySelectorAll('li.activity, div.activity[data-id], [data-for="cmitem"], li[id^="module-"], div[id^="module-"]')
        .forEach((act) => {
          const parsed = parseActivity(act, baseUrl);
          if (parsed) activities.push(parsed);
        });

      sections.push({
        key: sectionId,
        index: index++,
        name,
        summaryHtml: summaryEl ? summaryEl.innerHTML : "",
        summaryEl,
        activities,
      });
    };

    if (sectionNodes.size === 0) {
      // Sehr alte oder stark angepasste Themes: alles in einen Abschnitt.
      const activities = [];
      root
        .querySelectorAll('li.activity, [data-for="cmitem"], li[id^="module-"]')
        .forEach((act) => {
          const parsed = parseActivity(act, baseUrl);
          if (parsed) activities.push(parsed);
        });
      if (activities.length) {
        sections.push({ key: "flat", index: 0, name: "Kursinhalt", summaryHtml: "", summaryEl: null, activities });
      }
    } else {
      sectionNodes.forEach(collect);
    }

    return sections;
  }

  function parseActivity(node, baseUrl) {
    const link =
      node.querySelector("a.aalink") ||
      node.querySelector("a.stretched-link") ||
      node.querySelector(".activityname a, .activitytitle a, .instancename") ||
      node.querySelector('a[href*="/mod/"]');

    const anchor = link && link.tagName === "A" ? link : node.querySelector('a[href*="/mod/"]');
    const href = anchor ? abs(anchor.getAttribute("href"), baseUrl) : null;

    let type = null;
    const cls = /(?:^|\s)modtype_([a-z0-9_]+)/i.exec(node.className || "");
    if (cls) type = cls[1].toLowerCase();
    if (!type && href) {
      const m = /\/mod\/([a-z0-9_]+)\//i.exec(href);
      if (m) type = m[1].toLowerCase();
    }
    if (!type) {
      const attr = node.getAttribute("data-activityname") || "";
      type = attr ? "unknown" : "label";
    }

    const nameEl = node.querySelector(".instancename, .activityname, .activitytitle");
    let name = cleanText(nameEl);

    let cmid = null;
    const idAttr = /module-(\d+)/.exec(node.id || "");
    if (idAttr) cmid = idAttr[1];
    if (!cmid && node.getAttribute("data-id")) cmid = node.getAttribute("data-id");
    if (!cmid && href) {
      try {
        cmid = new URL(href).searchParams.get("id");
      } catch (e) { /* ignorieren */ }
    }

    const descEl =
      node.querySelector(".contentafterlink .no-overflow, .activity-description, .description .no-overflow, .contentafterlink") ||
      null;

    const inlineEl =
      node.querySelector(".contentwithoutlink .no-overflow, .activity-altcontent, .contentwithoutlink") || null;

    if (type === "label" || (!href && inlineEl)) {
      const text = htmlToText(inlineEl || node);
      if (!text) return null;
      return {
        type: "label",
        cmid: cmid || "label-" + Math.random().toString(36).slice(2, 8),
        name: name || text.split("\n")[0].slice(0, 60),
        url: null,
        descHtml: inlineEl ? inlineEl.innerHTML : node.innerHTML,
        descEl: inlineEl || node,
      };
    }

    if (!href) return null;
    if (!name) name = cleanText(anchor) || "Aktivität " + (cmid || "");

    return {
      type: type || "unknown",
      cmid,
      name,
      url: href,
      descHtml: descEl ? descEl.innerHTML : "",
      descEl,
    };
  }

  /* ------------------------------------------------------------------ *
   * Archiv-Zugriff (serialisiert, damit die ZIP-Offsets stimmen)
   * ------------------------------------------------------------------ */

  function makeArchive(zip) {
    let lock = Promise.resolve();
    const run = (fn) => {
      const p = lock.then(fn);
      lock = p.then(() => {}, () => {});
      return p;
    };
    return {
      reserve: (path) => run(() => zip.uniqueName(path)),
      reserveStem: (basePath, extensions) => run(() => zip.uniqueStem(basePath, extensions)),
      addAt: (path, data) => run(async () => {
        await zip.add(path, data);
        return path;
      }),
      add: (path, data) => run(async () => {
        const finalPath = zip.uniqueName(path);
        await zip.add(finalPath, data);
        return finalPath;
      }),
    };
  }

  async function pool(items, limit, worker) {
    const queue = items.slice();
    const runners = new Array(Math.min(limit, queue.length || 1)).fill(0).map(async () => {
      while (queue.length) {
        checkCancelled();
        const item = queue.shift();
        try {
          await worker(item);
        } catch (err) {
          if (err && err.message === "__cancelled__") throw err;
          log("Übersprungen: " + (err && err.message ? err.message : err), "warn");
        }
      }
    });
    await Promise.all(runners);
  }

  /* ------------------------------------------------------------------ *
   * Binärdateien laden
   * ------------------------------------------------------------------ */

  /** Stellt der Kurs-Reihenfolge entsprechend eine Nummer voran. */
  function prefixed(ctx, dir, name) {
    return dir === ctx.sectionDir && ctx.filePrefix ? `${ctx.filePrefix} ${name}` : name;
  }

  async function downloadBinary(ctx, url) {
    const limit = ctx.options.maxFileMB > 0 ? ctx.options.maxFileMB * 1024 * 1024 : 0;
    const res = await request(url, { delay: ctx.options.delay });
    if (!res.ok) throw new Error("HTTP " + res.status + " bei " + url);

    const declared = parseInt(res.headers.get("content-length") || "0", 10);
    if (limit && declared > limit) {
      state.stats.skipped++;
      log(`Zu groß (${(declared / 1048576).toFixed(1)} MB), übersprungen: ${url}`, "warn");
      return null;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (limit && bytes.length > limit) {
      state.stats.skipped++;
      log(`Zu groß (${(bytes.length / 1048576).toFixed(1)} MB), übersprungen: ${url}`, "warn");
      return null;
    }

    return {
      bytes,
      name: filenameFrom(res, res.url || url),
      type: res.headers.get("content-type") || "",
      finalUrl: res.url || url,
    };
  }

  /** Lädt eine Datei und legt sie im Archiv ab. Gibt den Archivpfad zurück. */
  async function saveFile(ctx, url, dir, hintName) {
    const key = abs(url);
    if (!key) return null;
    if (ctx.seenFiles.has(key)) return ctx.seenFiles.get(key);

    const result = await downloadBinary(ctx, key);
    if (!result) {
      ctx.seenFiles.set(key, null);
      return null;
    }

    let name = result.name || hintName || "datei";
    if (hintName && !result.name) name = hintName;
    name = ensureExtension(sanitize(name, "datei"), result.type);

    const path = await ctx.archive.add(`${dir}/${prefixed(ctx, dir, name)}`, result.bytes);
    ctx.seenFiles.set(key, path);
    state.stats.files++;
    state.stats.bytes += result.bytes.length;
    return path;
  }

  /** Lädt ein eingebettetes Medium in den gemeinsamen Assets-Ordner. */
  async function saveAsset(ctx, url) {
    const key = abs(url);
    if (!key) return null;
    if (ctx.seenAssets.has(key)) return ctx.seenAssets.get(key);
    if (!sameOrigin(key)) {
      // Fremde Hosts lassen sich ohne zusätzliche Berechtigung nicht laden.
      ctx.seenAssets.set(key, null);
      return null;
    }

    try {
      const result = await downloadBinary(ctx, key);
      if (!result) {
        ctx.seenAssets.set(key, null);
        return null;
      }
      let name = ensureExtension(sanitize(result.name || "bild", "bild"), result.type);
      const path = await ctx.archive.add(`${ctx.root}/_bilder/${name}`, result.bytes);
      ctx.seenAssets.set(key, path);
      state.stats.images++;
      state.stats.bytes += result.bytes.length;
      return path;
    } catch (err) {
      if (err && err.message === "__cancelled__") throw err;
      ctx.seenAssets.set(key, null);
      log("Bild nicht ladbar: " + key, "warn");
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * HTML-Inhalte speichern (inkl. Bildern und Anhängen)
   * ------------------------------------------------------------------ */

  /** Sammelt alle Verweise aus einem Kurstext ein (für Links.md). */
  function collectLinks(ctx, root, source, baseUrl) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("a[href]").forEach((a) => {
      const raw = a.getAttribute("href");
      if (!raw || /^(#|javascript:|data:|blob:)/i.test(raw)) return;
      // Dateien werden als Datei gesichert, nicht als Link geführt.
      if (/\/(pluginfile|draftfile)\.php\//.test(raw)) return;
      const full = /^mailto:|^tel:/i.test(raw) ? raw : abs(raw, baseUrl);
      if (!full) return;
      const key = source + "|" + full;
      if (ctx.linkSeen.has(key)) return;
      ctx.linkSeen.add(key);
      ctx.links.push({
        text: cleanText(a) || full,
        url: full,
        source,
        external: !sameOrigin(full),
      });
    });
  }

  function buildLinks(ctx) {
    const lines = ["# Links im Kurs", ""];
    const render = (title, list) => {
      if (!list.length) return;
      lines.push(`## ${title}`, "");
      const bySource = new Map();
      list.forEach((l) => {
        if (!bySource.has(l.source)) bySource.set(l.source, []);
        bySource.get(l.source).push(l);
      });
      for (const [source, items] of bySource) {
        lines.push(`### ${source}`, "");
        items.forEach((l) => lines.push(`- [${l.text}](${l.url})`));
        lines.push("");
      }
    };
    render("Externe Links", ctx.links.filter((l) => l.external));
    render("Links innerhalb von Moodle", ctx.links.filter((l) => !l.external));
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ *
   * HTML → Markdown (für Obsidian)
   * ------------------------------------------------------------------ */

  function mdUrl(url) {
    if (!url) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return /[ ()<>]/.test(url) ? `<${url}>` : url;
    return url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
  }

  function mdEscape(text) {
    return text.replace(/([\\`*_[\]<>])/g, "\\$1");
  }

  function mdYaml(value) {
    return '"' + String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function convertChildren(node, ctx) {
    let out = "";
    node.childNodes.forEach((child) => {
      out += convertNode(child, ctx);
    });
    return out;
  }

  function convertList(node, ctx) {
    const ordered = node.tagName.toLowerCase() === "ol";
    const depth = ctx.listDepth || 0;
    const indent = "    ".repeat(depth);
    const items = [];
    let index = 1;
    [...node.children].forEach((li) => {
      if (li.tagName.toLowerCase() !== "li") return;
      // Leerzeilen vor verschachtelten Listen entfernen, sonst wird die Liste "lose".
      const body = convertChildren(li, { ...ctx, listDepth: depth + 1 })
        .trim()
        .replace(/\n{2,}(?=[ \t]*(?:[-*] |\d+\. ))/g, "\n");
      if (!body) return;
      const marker = ordered ? `${index++}. ` : "- ";
      const [first, ...rest] = body.split("\n");
      items.push(indent + marker + first);
      rest.forEach((line) => items.push(line.startsWith(" ") ? indent + line : indent + "    " + line));
    });
    return items.length ? `\n\n${items.join("\n")}\n\n` : "";
  }

  function convertTable(node, ctx) {
    const rows = [...node.querySelectorAll("tr")].map((tr) =>
      [...tr.children]
        .filter((cell) => /^(td|th)$/i.test(cell.tagName))
        .map((cell) => convertChildren(cell, ctx).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim())
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (row) => {
      const copy = row.slice();
      while (copy.length < width) copy.push("");
      return copy;
    };
    const head = pad(rows[0]);
    const out = [
      "| " + head.join(" | ") + " |",
      "| " + head.map(() => "---").join(" | ") + " |",
      ...rows.slice(1).map((r) => "| " + pad(r).join(" | ") + " |"),
    ];
    return `\n\n${out.join("\n")}\n\n`;
  }

  function convertNode(node, ctx) {
    if (node.nodeType === 3) return mdEscape(node.textContent.replace(/\s+/g, " "));
    if (node.nodeType !== 1) return "";

    const tag = node.tagName.toLowerCase();
    const inner = () => convertChildren(node, ctx);

    switch (tag) {
      case "script": case "style": case "noscript": return "";
      case "br": return "  \n";
      case "hr": return "\n\n---\n\n";
      case "strong": case "b": { const t = inner().trim(); return t ? `**${t}**` : ""; }
      case "em": case "i": { const t = inner().trim(); return t ? `*${t}*` : ""; }
      case "del": case "s": { const t = inner().trim(); return t ? `~~${t}~~` : ""; }
      case "code":
        if (node.closest && node.closest("pre")) return node.textContent;
        return "`" + node.textContent.replace(/`/g, "") + "`";
      case "pre":
        return `\n\n\`\`\`\n${node.textContent.replace(/\n+$/, "")}\n\`\`\`\n\n`;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const t = inner().trim();
        return t ? `\n\n${"#".repeat(Number(tag[1]))} ${t}\n\n` : "";
      }
      case "a": {
        const href = node.getAttribute("href");
        const t = inner().trim();
        if (!href || href.startsWith("#")) return t;
        return `[${t || href}](${mdUrl(href)})`;
      }
      case "img": {
        const src = node.getAttribute("src");
        if (!src) return "";
        return `![${(node.getAttribute("alt") || "").replace(/[[\]]/g, "")}](${mdUrl(src)})`;
      }
      case "ul": case "ol": return convertList(node, ctx);
      case "blockquote": {
        const t = inner().trim();
        return t ? "\n\n" + t.split("\n").map((l) => "> " + l).join("\n") + "\n\n" : "";
      }
      case "table": return convertTable(node, ctx);
      case "iframe": case "embed": case "object": case "video": case "audio": {
        const src = node.getAttribute("src") || node.getAttribute("data");
        return src ? `\n\n[Eingebetteter Inhalt](${mdUrl(src)})\n\n` : "";
      }
      case "p": case "div": case "section": case "article": case "figure":
      case "figcaption": case "dl": case "dt": case "dd": case "address": {
        const t = inner().trim();
        return t ? `\n\n${t}\n\n` : "";
      }
      default: return inner();
    }
  }

  /** Wandelt einen HTML-Ausschnitt in Markdown um. */
  function htmlToMarkdown(root) {
    if (!root) return "";
    return convertChildren(root, { listDepth: 0 })
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** Markdown-Notiz mit YAML-Frontmatter, wie Obsidian es erwartet. */
  function wrapMarkdown(ctx, { title, type, sourceUrl, subtitle }, body) {
    const front = [
      "---",
      `title: ${mdYaml(title)}`,
      `kurs: ${mdYaml(ctx.course.name)}`,
    ];
    if (type) front.push(`typ: ${mdYaml(type)}`);
    if (subtitle) front.push(`abschnitt: ${mdYaml(subtitle)}`);
    if (sourceUrl) front.push(`quelle: ${mdYaml(sourceUrl)}`);
    front.push(`gesichert: ${new Date().toISOString().slice(0, 10)}`);
    front.push("tags:", "  - moodle");
    front.push("---", "");
    return `${front.join("\n")}\n# ${title}\n\n${body}\n`;
  }

  const STRIP_SELECTOR = [
    "script", "style", "noscript", "form", "nav", ".breadcrumb", ".navbar",
    ".moodle-actionmenu", ".commands", ".activity-navigation", ".editing_move",
    ".activityinstance .accesshide", ".visually-hidden", ".sr-only", "#page-footer",
    ".activity-header .completion-info", ".drawer", ".stickyfooter",
  ].join(",");

  function wrapHtml(title, bodyHtml, meta) {
    return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         max-width: 62rem; margin: 2rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  .mc-meta { color: #6b7280; font-size: .85rem; margin-bottom: 1.5rem;
             padding-bottom: 1rem; border-bottom: 1px solid #d1d5db; }
  .mc-meta a { color: inherit; }
  img, video { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #d1d5db; padding: .35rem .6rem; }
  pre { overflow-x: auto; background: rgba(127,127,127,.12); padding: .75rem; border-radius: .4rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="mc-meta">${meta}</div>
${bodyHtml}
</body>
</html>`;
  }

  /**
   * Speichert einen HTML-Ausschnitt als eigenständige Seite: Bilder werden
   * mitgeladen und die Verweise auf die lokalen Kopien umgeschrieben.
   */
  function formatsFor(options) {
    if (options.format === "html") return [".html"];
    if (options.format === "both") return [".md", ".html"];
    return [".md"];
  }

  async function saveContent(ctx, { dir, baseName, title, element, baseUrl, sourceUrl, subtitle, linkSource, type }) {
    if (!element) return null;

    collectLinks(ctx, element, linkSource || title, baseUrl);

    const extensions = formatsFor(ctx.options);
    const stem = await ctx.archive.reserveStem(
      `${dir}/${prefixed(ctx, dir, sanitize(baseName, "inhalt"))}`,
      extensions
    );
    // Beide Formate liegen im selben Ordner, die relativen Pfade sind identisch.
    const htmlPath = stem + extensions[0];
    const clone = element.cloneNode(true);
    clone.querySelectorAll(STRIP_SELECTOR).forEach((n) => n.remove());

    // Eingebettete Medien einsammeln.
    if (ctx.options.images || ctx.options.files) {
      const media = [...clone.querySelectorAll("img[src], source[src], video[src], audio[src], embed[src], object[data]")];
      await pool(media, 3, async (el) => {
        const attr = el.hasAttribute("data") ? "data" : "src";
        const raw = el.getAttribute(attr);
        if (!raw || /^(data:|blob:|about:)/i.test(raw)) return;
        const full = abs(raw, baseUrl);
        if (!full) return;
        const isImage = el.tagName === "IMG";
        if (isImage && !ctx.options.images) return;
        if (!isImage && !ctx.options.files) return;
        const saved = await saveAsset(ctx, full);
        if (saved) {
          el.setAttribute(attr, relPath(htmlPath, saved));
          el.removeAttribute("srcset");
          el.removeAttribute("loading");
        } else {
          el.setAttribute(attr, full);
        }
      });
      clone.querySelectorAll("[srcset]").forEach((n) => n.removeAttribute("srcset"));
    }

    // Verlinkte Moodle-Dateien mitnehmen.
    if (ctx.options.files) {
      const links = [...clone.querySelectorAll('a[href*="pluginfile.php"], a[href*="/draftfile.php"]')];
      await pool(links, 3, async (a) => {
        const full = abs(a.getAttribute("href"), baseUrl);
        if (!full) return;
        const saved = await saveFile(ctx, full, dir, cleanText(a));
        if (saved) a.setAttribute("href", relPath(htmlPath, saved));
      });
    }

    // Übrige Moodle-Links absolut machen, damit sie online weiter funktionieren.
    clone.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href || /^(#|mailto:|tel:|data:)/i.test(href)) return;
      if (/^https?:/i.test(href) || href.startsWith("..") || href.startsWith("_bilder/")) return;
      const full = abs(href, baseUrl);
      if (full) a.setAttribute("href", full);
    });

    const paths = [];
    for (const ext of extensions) {
      const target = stem + ext;
      if (ext === ".html") {
        const metaParts = [];
        if (subtitle) metaParts.push(escapeHtml(subtitle));
        if (sourceUrl) metaParts.push(`Quelle: <a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</a>`);
        metaParts.push("Gesichert am " + new Date().toLocaleString("de-DE"));
        await ctx.archive.addAt(target, wrapHtml(title, clone.innerHTML, metaParts.join(" · ")));
      } else {
        await ctx.archive.addAt(
          target,
          wrapMarkdown(ctx, { title, type, sourceUrl, subtitle }, htmlToMarkdown(clone))
        );
      }
      paths.push(target);
    }
    state.stats.pages++;

    return { path: paths[0], paths, text: htmlToText(clone) };
  }

  /* ------------------------------------------------------------------ *
   * Handler je Aktivitätstyp
   * ------------------------------------------------------------------ */

  function contentRegion(doc) {
    return (
      doc.querySelector("#region-main [role='main'] .box.generalbox") ||
      doc.querySelector("#region-main .box.py-3.generalbox") ||
      doc.querySelector("#region-main .generalbox") ||
      doc.querySelector("#region-main") ||
      doc.querySelector("[role='main']") ||
      doc.body
    );
  }

  async function handleResource(ctx, act, dir) {
    const res = await request(act.url, { delay: ctx.options.delay });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const type = res.headers.get("content-type") || "";

    // Moodle leitet häufig direkt auf die Datei um.
    if (!/text\/html/i.test(type)) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const limit = ctx.options.maxFileMB > 0 ? ctx.options.maxFileMB * 1048576 : 0;
      if (limit && bytes.length > limit) {
        state.stats.skipped++;
        log(`Zu groß, übersprungen: ${act.name}`, "warn");
        return { saved: [] };
      }
      const name = ensureExtension(sanitize(filenameFrom(res, res.url || act.url) || act.name), type);
      const path = await ctx.archive.add(`${dir}/${prefixed(ctx, dir, name)}`, bytes);
      ctx.seenFiles.set(abs(act.url), path);
      state.stats.files++;
      state.stats.bytes += bytes.length;
      return { saved: [path] };
    }

    const doc = parser.parseFromString(await res.text(), "text/html");
    const base = res.url || act.url;
    const targets = new Set();
    doc
      .querySelectorAll('a[href*="pluginfile.php"], .resourceworkaround a[href], object[data*="pluginfile.php"], iframe[src*="pluginfile.php"], embed[src*="pluginfile.php"]')
      .forEach((el) => {
        const raw = el.getAttribute("href") || el.getAttribute("data") || el.getAttribute("src");
        const full = abs(raw, base);
        if (full) targets.add(full);
      });

    const saved = [];
    await pool([...targets], 2, async (url) => {
      const path = await saveFile(ctx, url, dir, act.name);
      if (path) saved.push(path);
    });

    if (!saved.length && ctx.options.texts) {
      const page = await saveContent(ctx, {
        dir, baseName: act.name, title: act.name, type: "Datei",
        element: contentRegion(doc), baseUrl: base, sourceUrl: act.url,
      });
      return { saved: page ? page.paths : [], text: page && page.text };
    }
    return { saved };
  }

  /**
   * Dateien, die vom Nutzer selbst stammen (Abgaben) oder sich persönlich auf
   * ihn beziehen (Bewertung/Feedback) – im Unterschied zum Kursmaterial.
   */
  const OWN_SUBMISSION = /\/(assignsubmission_[a-z]+|assignfeedback_[a-z]+|mod_workshop\/submission_attachment|mod_workshop\/submission_content)\//i;

  function splitOwnFiles(urls) {
    const material = [];
    const own = [];
    urls.forEach((url) => (OWN_SUBMISSION.test(url) ? own : material).push(url));
    return { material, own };
  }

  /** Unterordner für die eigenen Abgaben einer Aktivität. */
  function submissionDir(ctx, dir, name) {
    return `${dir}/${prefixed(ctx, dir, sanitize(name, "Aufgabe"))} - Meine Abgabe`;
  }

  async function handleAssign(ctx, act, dir) {
    const { doc, finalUrl } = await fetchDocument(act.url);
    if (!doc) return { saved: [] };

    const saved = [];
    if (ctx.options.files) {
      const urls = new Set();
      doc.querySelectorAll('#region-main a[href*="pluginfile.php"]').forEach((a) => {
        const full = abs(a.getAttribute("href"), finalUrl);
        if (full) urls.add(full);
      });
      const { material, own } = splitOwnFiles([...urls]);

      await pool(material, 3, async (url) => {
        const path = await saveFile(ctx, url, dir, act.name);
        if (path) saved.push(path);
      });

      if (ctx.options.submissions && own.length) {
        const target = submissionDir(ctx, dir, act.name);
        await pool(own, 3, async (url) => {
          const path = await saveFile(ctx, url, target);
          if (path) saved.push(path);
        });
        log(`${own.length} eigene Datei(en) bei „${act.name}“ gesichert.`);
      }
    }

    let text = "";
    if (ctx.options.texts) {
      const main =
        doc.querySelector("#region-main [role='main']") ||
        doc.querySelector("#region-main") ||
        contentRegion(doc);
      // Die Aufgabenstellung samt Anhängen des Lehrenden.
      const introSelector = "#intro, .box.generalbox";
      const intro = doc.querySelector("#region-main " + introSelector) || doc.querySelector(introSelector);

      const page = await saveContent(ctx, {
        dir, baseName: act.name, title: act.name, type: "Aufgabe",
        element: intro || main, baseUrl: finalUrl, sourceUrl: act.url,
      });
      if (page) {
        saved.push(...page.paths);
        text = page.text;
      }

      // Abgabestatus und Bewertung sind persönliche Daten – nur auf Wunsch.
      if (ctx.options.submissions && intro && main) {
        const rest = main.cloneNode(true);
        const duplicate = rest.querySelector(introSelector);
        if (duplicate) duplicate.remove();
        if (rest.querySelector("table, .submissionstatustable, [data-region='submission-status']")) {
          const status = await saveContent(ctx, {
            dir, baseName: `${act.name} - Meine Abgabe`, title: `${act.name} – Meine Abgabe`,
            type: "Abgabe", element: rest, baseUrl: finalUrl, sourceUrl: act.url,
            linkSource: `Abgabe: ${act.name}`,
          });
          if (status) saved.push(...status.paths);
        }
      }
    }
    return { saved, text };
  }

  async function handleFolder(ctx, act, dir) {
    const { doc, finalUrl } = await fetchDocument(act.url);
    if (!doc) return { saved: [] };
    const target = `${dir}/${prefixed(ctx, dir, sanitize(act.name, "Ordner"))}`;
    const urls = new Set();
    doc
      .querySelectorAll('#region-main a[href*="pluginfile.php"], .foldertree a[href*="pluginfile.php"], .filemanager a[href*="pluginfile.php"]')
      .forEach((a) => {
        const full = abs(a.getAttribute("href"), finalUrl);
        if (full) urls.add(full);
      });

    const saved = [];
    await pool([...urls], 3, async (url) => {
      const path = await saveFile(ctx, url, target);
      if (path) saved.push(path);
    });
    return { saved };
  }

  async function handlePage(ctx, act, dir) {
    const { doc, finalUrl } = await fetchDocument(act.url);
    if (!doc) return { saved: [] };
    const region =
      doc.querySelector("#region-main [role='main'] .box.generalbox") ||
      doc.querySelector("#region-main .box.generalbox") ||
      contentRegion(doc);
    const page = await saveContent(ctx, {
      dir, baseName: act.name, title: act.name, type: "Textseite",
      element: region, baseUrl: finalUrl, sourceUrl: act.url,
    });
    return { saved: page ? page.paths : [], text: page && page.text };
  }

  async function handleBook(ctx, act, dir) {
    const { doc, finalUrl } = await fetchDocument(act.url);
    if (!doc) return { saved: [] };
    const target = `${dir}/${prefixed(ctx, dir, sanitize(act.name, "Buch"))}`;

    const chapters = [];
    const seen = new Set();
    doc.querySelectorAll('.book_toc a[href*="/mod/book/view.php"], .booktoc a[href*="/mod/book/view.php"]').forEach((a) => {
      const full = abs(a.getAttribute("href"), finalUrl);
      if (full && !seen.has(full)) {
        seen.add(full);
        chapters.push({ url: full, title: cleanText(a) });
      }
    });
    if (!chapters.length) chapters.push({ url: finalUrl, title: act.name });

    const saved = [];
    const texts = [];
    let n = 1;
    for (const chapter of chapters) {
      checkCancelled();
      const chapterDoc = chapter.url === finalUrl ? doc : (await fetchDocument(chapter.url)).doc;
      if (!chapterDoc) continue;
      const region = chapterDoc.querySelector(".book_content") || contentRegion(chapterDoc);
      const page = await saveContent(ctx, {
        dir: target,
        baseName: `${pad(n)} ${chapter.title || "Kapitel " + n}`,
        title: chapter.title || act.name,
        element: region, baseUrl: chapter.url, sourceUrl: chapter.url,
        subtitle: act.name, type: "Buchkapitel",
      });
      if (page) {
        saved.push(...page.paths);
        texts.push(`### ${chapter.title || "Kapitel " + n}\n\n${page.text}`);
      }
      n++;
    }
    return { saved, text: texts.join("\n\n") };
  }

  async function handleForum(ctx, act, dir) {
    const { doc, finalUrl } = await fetchDocument(act.url);
    if (!doc) return { saved: [] };
    const target = `${dir}/${prefixed(ctx, dir, sanitize(act.name, "Forum"))}`;

    const discussions = [];
    const seen = new Set();
    doc.querySelectorAll('a[href*="/mod/forum/discuss.php"]').forEach((a) => {
      const full = abs(a.getAttribute("href"), finalUrl);
      if (!full) return;
      const clean = full.split("#")[0];
      if (seen.has(clean)) return;
      seen.add(clean);
      discussions.push({ url: clean, title: cleanText(a) || "Diskussion" });
    });

    const saved = [];
    const texts = [];
    let n = 1;
    for (const discussion of discussions.slice(0, 300)) {
      checkCancelled();
      const d = await fetchDocument(discussion.url);
      if (!d.doc) continue;
      const region =
        d.doc.querySelector("#region-main [role='main']") ||
        d.doc.querySelector(".forumpost") ||
        contentRegion(d.doc);
      const page = await saveContent(ctx, {
        dir: target,
        baseName: `${pad(n)} ${discussion.title}`,
        title: discussion.title,
        element: region, baseUrl: d.finalUrl, sourceUrl: discussion.url,
        subtitle: act.name, type: "Forenbeitrag",
      });
      if (page) {
        saved.push(...page.paths);
        texts.push(`### ${discussion.title}\n\n${page.text}`);
      }
      n++;
    }
    return { saved, text: texts.join("\n\n") };
  }

  async function handleUrl(ctx, act, dir) {
    let external = null;
    try {
      const { doc, finalUrl } = await fetchDocument(act.url);
      if (doc) {
        const a =
          doc.querySelector(".urlworkaround a[href]") ||
          doc.querySelector("#region-main .box.generalbox a[href^='http']") ||
          doc.querySelector("#region-main a[href^='http']:not([href*='" + session.host + "'])");
        if (a) external = abs(a.getAttribute("href"), finalUrl);
      } else {
        external = finalUrl;
      }
    } catch (err) {
      if (err && err.message === "__cancelled__") throw err;
    }
    const target = external || act.url;
    const key = "url|" + target;
    if (!ctx.linkSeen.has(key)) {
      ctx.linkSeen.add(key);
      ctx.links.push({
        text: act.name,
        url: target,
        source: "Link-Aktivitäten",
        external: !sameOrigin(target),
      });
    }
    return { saved: [], external };
  }

  async function handleGeneric(ctx, act, dir) {
    const { doc, finalUrl } = await fetchDocument(act.url);
    if (!doc) return { saved: [] };

    const saved = [];
    if (ctx.options.files) {
      const urls = new Set();
      doc.querySelectorAll('#region-main a[href*="pluginfile.php"]').forEach((a) => {
        const full = abs(a.getAttribute("href"), finalUrl);
        if (full) urls.add(full);
      });
      const { material, own } = splitOwnFiles([...urls]);

      await pool(material, 3, async (url) => {
        const path = await saveFile(ctx, url, dir, act.name);
        if (path) saved.push(path);
      });

      if (ctx.options.submissions && own.length) {
        const target = submissionDir(ctx, dir, act.name);
        await pool(own, 3, async (url) => {
          const path = await saveFile(ctx, url, target);
          if (path) saved.push(path);
        });
      }
    }

    let text = "";
    if (ctx.options.texts) {
      const region =
        doc.querySelector("#region-main [role='main']") ||
        doc.querySelector("#region-main") ||
        contentRegion(doc);
      const page = await saveContent(ctx, {
        dir, baseName: act.name, title: act.name,
        element: region, baseUrl: finalUrl, sourceUrl: act.url,
        subtitle: TYPE_LABEL[act.type] || act.type, type: TYPE_LABEL[act.type] || act.type,
      });
      if (page) {
        saved.push(...page.paths);
        text = page.text;
      }
    }
    return { saved, text };
  }

  const HANDLERS = {
    assign: handleAssign,
    resource: handleResource,
    folder: handleFolder,
    page: handlePage,
    book: handleBook,
    forum: handleForum,
    url: handleUrl,
  };

  const TYPE_LABEL = {
    resource: "Datei", folder: "Ordner", page: "Textseite", book: "Buch",
    url: "Link", forum: "Forum", assign: "Aufgabe", quiz: "Test",
    label: "Textfeld", label_: "Textfeld", lesson: "Lektion", glossary: "Glossar",
    wiki: "Wiki", choice: "Abstimmung", feedback: "Feedback", h5pactivity: "H5P",
    scorm: "SCORM", data: "Datenbank", chat: "Chat", workshop: "Gegenseitige Beurteilung",
  };

  /* ------------------------------------------------------------------ *
   * Kursstruktur über alle Abschnittsseiten einsammeln
   * ------------------------------------------------------------------ */

  function mergeSections(target, incoming, seenCmids) {
    for (const section of incoming) {
      const key = section.name.toLowerCase().trim();
      let existing = target.find((s) => s.name.toLowerCase().trim() === key);
      if (!existing) {
        existing = { ...section, activities: [] };
        target.push(existing);
      }
      if (!existing.summaryHtml && section.summaryHtml) {
        existing.summaryHtml = section.summaryHtml;
        existing.summaryEl = section.summaryEl;
      }
      for (const act of section.activities) {
        const id = act.cmid || act.url || act.name;
        if (seenCmids.has(id)) continue;
        seenCmids.add(id);
        existing.activities.push(act);
      }
    }
  }

  async function collectSections(course, options, rootDoc, rootUrl) {
    const sections = [];
    const seenCmids = new Set();
    mergeSections(sections, parseCoursePage(rootDoc, rootUrl), seenCmids);

    if (!options.allSections) return sections;

    // Kursformate mit einer Seite pro Abschnitt: weitere Abschnittsseiten holen.
    const pages = new Set();
    rootDoc.querySelectorAll('a[href*="/course/view.php"], a[href*="/course/section.php"]').forEach((a) => {
      const full = abs(a.getAttribute("href"), rootUrl);
      if (!full) return;
      let u;
      try {
        u = new URL(full);
      } catch (e) {
        return;
      }
      const clean = u.origin + u.pathname + u.search;
      if (/\/course\/section\.php$/.test(u.pathname) && u.searchParams.get("id")) {
        pages.add(clean);
      } else if (
        /\/course\/view\.php$/.test(u.pathname) &&
        u.searchParams.get("id") === String(course.id) &&
        u.searchParams.get("section") !== null
      ) {
        pages.add(clean);
      }
    });
    try {
      const current = new URL(rootUrl);
      pages.delete(current.origin + current.pathname + current.search);
    } catch (e) { /* ignorieren */ }

    const list = [...pages].slice(0, 200);
    let i = 0;
    for (const url of list) {
      checkCancelled();
      i++;
      progress(`Kursstruktur wird gelesen … (${i}/${list.length})`);
      try {
        const { doc, finalUrl } = await fetchDocument(url);
        if (doc) mergeSections(sections, parseCoursePage(doc, finalUrl), seenCmids);
      } catch (err) {
        if (err && err.message === "__cancelled__") throw err;
        log("Abschnittsseite nicht lesbar: " + url, "warn");
      }
    }
    return sections;
  }

  /* ------------------------------------------------------------------ *
   * Übersichtsdateien
   * ------------------------------------------------------------------ */

  function buildReadme(ctx, model) {
    const lines = [
      `# ${ctx.course.name}`,
      "",
      `* Quelle: ${ctx.course.url}`,
      `* Gesichert am: ${new Date().toLocaleString("de-DE")}`,
      `* Abschnitte: ${model.length}`,
      `* Dateien: ${state.stats.files} · Seiten: ${state.stats.pages} · Bilder: ${state.stats.images}`,
      `* Gesamtgröße der geladenen Inhalte: ${(state.stats.bytes / 1048576).toFixed(1)} MB`,
      "",
      "## Inhalt",
      "",
    ];

    for (const entry of model) {
      lines.push(`### ${entry.section.name}`, "");
      if (entry.summaryText) lines.push(entry.summaryText, "");
      if (!entry.items.length) {
        lines.push("_(keine Inhalte)_", "");
        continue;
      }
      for (const item of entry.items) {
        const label = TYPE_LABEL[item.type] || item.type;
        const files = item.files.map((f) => `\`${f.replace(ctx.root + "/", "")}\``).join(", ");
        lines.push(`- **${item.name}** (${label})${files ? " → " + files : ""}${item.url ? `  \n  ${item.url}` : ""}`);
      }
      lines.push("");
    }

    if (state.warnings.length) {
      lines.push("## Hinweise", "");
      state.warnings.slice(0, 200).forEach((w) => lines.push(`- ${w}`));
      lines.push("");
    }
    return lines.join("\n");
  }

  function buildIndexMarkdown(ctx, model) {
    const indexPath = `${ctx.root}/Kursübersicht.md`;
    const lines = [
      "---",
      `title: ${mdYaml(ctx.course.name)}`,
      `quelle: ${mdYaml(ctx.course.url)}`,
      `gesichert: ${new Date().toISOString().slice(0, 10)}`,
      "tags:", "  - moodle", "---", "",
      `# ${ctx.course.name}`, "",
      `${state.stats.files} Dateien · ${state.stats.pages} Seiten · ${state.stats.images} Bilder · ` +
        `${(state.stats.bytes / 1048576).toFixed(1)} MB`,
      "",
    ];

    for (const entry of model) {
      lines.push(`## ${entry.section.name}`, "");
      if (entry.summaryText) lines.push(entry.summaryText, "");
      if (!entry.items.length) {
        lines.push("_(keine Inhalte)_", "");
        continue;
      }
      for (const item of entry.items) {
        const label = TYPE_LABEL[item.type] || item.type;
        const files = item.files.map(
          (f) => `[${f.split("/").pop()}](${mdUrl(relPath(indexPath, f))})`
        );
        let line = `- **${item.name}** _(${label})_`;
        if (files.length) line += "  \n  " + files.join(" · ");
        if (item.url) line += `  \n  [Im Moodle öffnen](${mdUrl(item.url)})`;
        lines.push(line);
      }
      lines.push("");
    }

    if (state.warnings.length) {
      lines.push("## Hinweise", "");
      state.warnings.slice(0, 200).forEach((w) => lines.push(`- ${w}`));
    }
    return lines.join("\n");
  }

  function buildIndexHtml(ctx, model) {
    const parts = model.map((entry) => {
      const items = entry.items
        .map((item) => {
          const label = escapeHtml(TYPE_LABEL[item.type] || item.type);
          const links = item.files
            .map((f) => `<a href="${escapeHtml(relPath(ctx.root + "/index.html", f))}">${escapeHtml(f.split("/").pop())}</a>`)
            .join(" · ");
          const online = item.url ? `<a class="src" href="${escapeHtml(item.url)}">Original</a>` : "";
          return `<li><span class="badge">${label}</span> <strong>${escapeHtml(item.name)}</strong>
            <div class="files">${links || "<em>keine lokale Datei</em>"} ${online}</div></li>`;
        })
        .join("\n");
      return `<section><h2>${escapeHtml(entry.section.name)}</h2>
        ${entry.summaryText ? `<p class="summary">${escapeHtml(entry.summaryText).replace(/\n/g, "<br>")}</p>` : ""}
        <ul>${items || "<li><em>keine Inhalte</em></li>"}</ul></section>`;
    });

    const meta = `Quelle: <a href="${escapeHtml(ctx.course.url)}">${escapeHtml(ctx.course.url)}</a> ·
      ${state.stats.files} Dateien · ${state.stats.pages} Seiten · ${state.stats.images} Bilder ·
      gesichert am ${escapeHtml(new Date().toLocaleString("de-DE"))}`;

    return wrapHtml(
      ctx.course.name,
      `<style>
        section { margin-bottom: 2rem; }
        h2 { font-size: 1.15rem; border-bottom: 1px solid #d1d5db; padding-bottom: .3rem; }
        ul { list-style: none; padding: 0; }
        li { padding: .5rem 0; border-bottom: 1px solid rgba(127,127,127,.2); }
        .badge { display: inline-block; font-size: .72rem; text-transform: uppercase;
                 letter-spacing: .04em; background: #f98012; color: #fff;
                 border-radius: .3rem; padding: .1rem .4rem; vertical-align: .1rem; }
        .files { font-size: .85rem; margin-top: .2rem; }
        .src { color: #6b7280; }
        .summary { color: #4b5563; }
      </style>` + parts.join("\n"),
      meta
    );
  }

  /* ------------------------------------------------------------------ *
   * Hauptablauf
   * ------------------------------------------------------------------ */

  async function processActivity(ctx, act, dir, number) {
    const item = { type: act.type, name: act.name, url: act.url, files: [], text: "" };
    ctx.filePrefix = pad(number);
    ctx.sectionDir = dir;

    if (act.type === "label") {
      if (act.descEl) collectLinks(ctx, act.descEl, `Textfeld: ${act.name}`, ctx.course.url);
      if (ctx.options.texts && act.descEl) {
        const page = await saveContent(ctx, {
          dir, baseName: act.name, title: act.name,
          element: act.descEl, baseUrl: ctx.course.url, subtitle: "Textfeld im Kurs",
          type: "Textfeld",
        });
        if (page) {
          item.files.push(...page.paths);
          item.text = page.text;
        }
      } else if (act.descEl) {
        item.text = htmlToText(act.descEl);
      }
      return item;
    }

    const textOnlyTypes = ["page", "book", "forum"];
    if (!ctx.options.texts && textOnlyTypes.includes(act.type) && !ctx.options.files) {
      return item;
    }

    let handler = HANDLERS[act.type] || handleGeneric;
    if (act.type === "forum" && !ctx.options.forums) handler = handleGeneric;
    if (!ctx.options.texts && (act.type === "page" || act.type === "book")) handler = handleGeneric;

    const result = await handler(ctx, act, dir);
    if (result) {
      item.files = result.saved || [];
      item.text = result.text || "";
      if (result.external) item.external = result.external;
    }
    // Die Beschreibung unter dem Aktivitätsnamen gehört ebenfalls zum Kursinhalt.
    if (act.descEl) {
      collectLinks(ctx, act.descEl, `Beschreibung: ${act.name}`, ctx.course.url);
      const descText = htmlToText(act.descEl);
      if (descText) item.text = item.text ? `${descText}\n\n${item.text}` : descText;

      const hasMedia = act.descEl.querySelector('img, a[href*="pluginfile.php"]');
      if (hasMedia && ctx.options.texts && (ctx.options.images || ctx.options.files)) {
        const page = await saveContent(ctx, {
          dir, baseName: `${act.name} - Beschreibung`, title: `${act.name} – Beschreibung`,
          element: act.descEl, baseUrl: ctx.course.url, subtitle: "Beschreibung im Kurs",
          type: "Beschreibung",
          linkSource: `Beschreibung: ${act.name}`,
        });
        if (page) item.files.push(...page.paths);
      }
    }
    return item;
  }

  /**
   * Führt einen kompletten Lauf aus.
   * @param {object} config
   *   course   – {id, name, url}, z.B. aus detectCourse()
   *   options  – Nutzereinstellungen aus dem Popup
   *   rootDoc/rootUrl – bereits geladene Kursseite (sonst wird sie geholt)
   *   onEvent  – Rückmeldungen (progress, log, done, …)
   *   download – (blob, dateiname) => Promise, Umgebung entscheidet wie
   */
  /* ------------------------------------------------------------------ *
   * Kursliste ermitteln ("Alle meine Kurse")
   * ------------------------------------------------------------------ */

  /** Moodles CSRF-Token aus einer geladenen Seite fischen. */
  function extractSesskey(doc, baseUrl) {
    if (!doc) return null;
    const input = doc.querySelector('input[name="sesskey"]');
    if (input && input.value) return input.value;

    const link = doc.querySelector('a[href*="sesskey="]');
    if (link) {
      try {
        const value = new URL(link.getAttribute("href"), baseUrl).searchParams.get("sesskey");
        if (value) return value;
      } catch (e) { /* weiter unten */ }
    }
    const match = /"sesskey"\s*:\s*"([A-Za-z0-9]+)"/.exec(doc.documentElement.innerHTML || "");
    return match ? match[1] : null;
  }

  /** Fragt die eingeschriebenen Kurse über Moodles eigenen Webservice ab. */
  async function fetchEnrolledCourses(origin, sesskey) {
    const method = "core_course_get_enrolled_courses_by_timeline_classification";
    const url = `${origin}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=${method}`;
    const courses = [];
    const limit = 50;

    for (let offset = 0, page = 0; page < 40; page++, offset += limit) {
      checkCancelled();
      const body = JSON.stringify([{
        index: 0,
        methodname: method,
        args: { offset, limit, classification: "all", sort: "fullname", customfieldname: "", customfieldvalue: "" },
      }]);

      let payload;
      try {
        const res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!res.ok) break;
        payload = await res.json();
      } catch (err) {
        break;
      }

      const entry = payload && payload[0];
      if (!entry || entry.error) break;
      const list = (entry.data && entry.data.courses) || [];
      list.forEach((c) => {
        courses.push({
          id: String(c.id),
          name: c.fullname || c.shortname || "Kurs " + c.id,
          // viewurl kann je nach Moodle-Version relativ sein.
          url: abs(c.viewurl, origin) || `${origin}/course/view.php?id=${c.id}`,
        });
      });
      if (list.length < limit) break;
    }
    return courses;
  }

  /** Ersatzweg: Kurslinks aus der Übersichtsseite lesen. */
  function coursesFromDom(doc, baseUrl, origin) {
    const found = new Map();
    if (!doc) return [];
    doc.querySelectorAll('a[href*="/course/view.php?id="]').forEach((a) => {
      const href = abs(a.getAttribute("href"), baseUrl);
      const id = courseIdFromUrl(href, baseUrl);
      if (!id || id === "1") return; // id=1 ist die Moodle-Startseite
      const name = cleanText(a) || a.getAttribute("title") || "";
      const previous = found.get(id);
      if (!previous || name.length > previous.name.length) {
        found.set(id, { id, name, url: `${origin}/course/view.php?id=${id}` });
      }
    });
    return [...found.values()];
  }

  /** Ermittelt alle Kurse, in die der angemeldete Nutzer eingeschrieben ist. */
  async function discoverCourses(baseUrl) {
    const origin = new URL(baseUrl).origin;
    session.origin = origin;
    session.host = new URL(baseUrl).host;
    session.base = baseUrl;
    state.cancelled = false;

    let doc = null;
    let finalUrl = null;
    for (const path of ["/my/courses.php", "/my/", "/"]) {
      try {
        const loaded = await fetchDocument(new URL(path, origin).href);
        if (loaded.doc) {
          doc = loaded.doc;
          finalUrl = loaded.finalUrl;
          if (!looksLikeLogin(finalUrl, doc)) break;
        }
      } catch (err) {
        /* nächste Adresse versuchen */
      }
    }
    if (!doc) return { ok: false, error: "Die Kursübersicht konnte nicht geladen werden." };
    if (looksLikeLogin(finalUrl, doc)) return { ok: false, error: "login" };

    const sesskey = extractSesskey(doc, finalUrl);
    if (sesskey) {
      const viaService = await fetchEnrolledCourses(origin, sesskey);
      if (viaService.length) return { ok: true, courses: viaService, source: "webservice" };
    }

    const viaDom = coursesFromDom(doc, finalUrl, origin);
    if (viaDom.length) return { ok: true, courses: viaDom, source: "seite" };
    return { ok: false, error: "Es wurden keine Kurse gefunden." };
  }

  /* ------------------------------------------------------------------ *
   * Hauptablauf
   * ------------------------------------------------------------------ */

  function createArchive() {
    const zip = new ZipWriter();
    return { zip, archive: makeArchive(zip) };
  }

  /** Sichert einen Kurs in ein (ggf. geteiltes) Archiv. */
  async function crawlCourse(target, course, options, providedDoc, providedUrl) {
    const courseUrl = new URL(course.url);
    session.origin = courseUrl.origin;
    session.host = courseUrl.host;
    session.base = course.url;

    state.done = 0;
    state.total = 0;

    let rootDoc = providedDoc;
    let rootUrl = providedUrl || course.url;
    if (!rootDoc) {
      progress("Kursseite wird geladen …");
      const loaded = await fetchDocument(course.url);
      if (!loaded.doc) throw new Error("Kursseite konnte nicht gelesen werden.");
      rootDoc = loaded.doc;
      rootUrl = loaded.finalUrl;
      const detected = detectCourse(rootDoc, rootUrl);
      if (detected && detected.name && !course.name) course.name = detected.name;
    }

    const ctx = {
      zip: target.zip,
      archive: target.archive,
      root: sanitize(course.name, "Moodle-Kurs"),
      options,
      course,
      seenFiles: new Map(),
      seenAssets: new Map(),
      links: [],
      linkSeen: new Set(),
      filePrefix: "",
      sectionDir: "",
    };

    log(`Kurs: ${course.name}`);
    progress("Kursstruktur wird gelesen …");

    const sections = await collectSections(course, options, rootDoc, rootUrl);
    state.total = sections.reduce((n, s) => n + s.activities.length, 0);
    log(`${sections.length} Abschnitte, ${state.total} Elemente gefunden.`);
    progress("Inhalte werden geladen …");

    const model = [];
    let sectionNumber = 0;

    for (const section of sections) {
      checkCancelled();
      sectionNumber++;
      const dir = `${ctx.root}/${pad(sectionNumber)} ${sanitize(section.name, "Abschnitt")}`;
      const entry = { section, dir, items: [], summaryText: "" };

      if (section.summaryEl) {
        collectLinks(ctx, section.summaryEl, `Abschnitt: ${section.name}`, course.url);
      }
      if (section.summaryEl && ctx.options.texts) {
        const summaryText = htmlToText(section.summaryEl);
        if (summaryText) {
          entry.summaryText = summaryText;
          ctx.filePrefix = "00";
          ctx.sectionDir = dir;
          const page = await saveContent(ctx, {
            dir, baseName: "Abschnittstext", title: section.name,
            element: section.summaryEl, baseUrl: course.url, subtitle: "Abschnittsbeschreibung",
            type: "Abschnittsbeschreibung",
          });
          if (page) entry.summaryFiles = page.paths;
        }
      }

      let number = 0;
      for (const act of section.activities) {
        checkCancelled();
        number++;
        progress(`${section.name} – ${act.name}`);
        try {
          entry.items.push(await processActivity(ctx, act, dir, number));
        } catch (err) {
          if (err && err.message === "__cancelled__") throw err;
          log(`Fehler bei „${act.name}“: ${err && err.message ? err.message : err}`, "error");
          entry.items.push({ type: act.type, name: act.name, url: act.url, files: [], text: "" });
        }
        state.done++;
        progress();
      }
      model.push(entry);
    }

    progress("Übersicht wird geschrieben …");

    // Gesammelte Texte als eine durchsuchbare Datei.
    if (ctx.options.texts) {
      const textParts = [
        "---",
        `title: ${mdYaml(course.name + " – alle Texte")}`,
        `kurs: ${mdYaml(course.name)}`,
        `quelle: ${mdYaml(course.url)}`,
        `gesichert: ${new Date().toISOString().slice(0, 10)}`,
        "tags:", "  - moodle", "---", "",
        `# ${course.name} – alle Texte`, "",
      ];
      for (const entry of model) {
        textParts.push(`## ${entry.section.name}`, "");
        if (entry.summaryText) textParts.push(entry.summaryText, "");
        for (const item of entry.items) {
          if (!item.text) continue;
          textParts.push(`### ${item.name} (${TYPE_LABEL[item.type] || item.type})`, "", item.text, "");
        }
      }
      await ctx.archive.add(`${ctx.root}/Kurs-Texte.md`, textParts.join("\n"));
    }

    if (ctx.links.length) {
      await ctx.archive.add(`${ctx.root}/Links.md`, buildLinks(ctx));
    }

    await ctx.archive.add(`${ctx.root}/README.md`, buildReadme(ctx, model));
    const extensions = formatsFor(ctx.options);
    if (extensions.includes(".md")) {
      await ctx.archive.add(`${ctx.root}/Kursübersicht.md`, buildIndexMarkdown(ctx, model));
    }
    if (extensions.includes(".html")) {
      await ctx.archive.add(`${ctx.root}/index.html`, buildIndexHtml(ctx, model));
    }

    return { ctx, model };
  }

  /** Übersichtsnotiz über alle Kurse in einem gemeinsamen Archiv. */
  function buildCourseIndex(overview) {
    const lines = [
      "---",
      'title: "Moodle-Kurse"',
      `gesichert: ${new Date().toISOString().slice(0, 10)}`,
      "tags:", "  - moodle", "---", "",
      "# Gesicherte Kurse", "",
    ];
    overview.forEach((o) => {
      const items = o.model.reduce((n, e) => n + e.items.length, 0);
      lines.push(`- [${o.course.name}](${mdUrl(o.root + "/README.md")}) — ${items} Elemente`);
    });
    return lines.join("\n");
  }

  /**
   * Führt einen kompletten Lauf aus – für einen Kurs (config.course) oder
   * für mehrere (config.courses).
   */
  async function run(config) {
    const options = config.options || {};
    const courses = config.courses && config.courses.length
      ? config.courses.slice()
      : (config.course ? [config.course] : []);
    if (!courses.length) throw new Error("Kein Kurs angegeben.");
    courses.forEach((c) => {
      if (!c || !c.url) throw new Error("Kurs ohne Adresse in der Liste.");
    });

    hooks = {
      onEvent: config.onEvent || (() => {}),
      download: config.download,
    };

    state.running = true;
    state.cancelled = false;
    state.done = 0;
    state.total = 0;
    state.warnings = [];
    state.stats = { files: 0, pages: 0, images: 0, bytes: 0, skipped: 0 };
    state.courseCount = courses.length;
    state.courseIndex = 0;
    state.courseName = "";

    // Eine bereits geladene Seite hilft nur beim Einzelkurs.
    const providedDoc = courses.length === 1 ? config.rootDoc : null;
    const providedUrl = courses.length === 1 ? config.rootUrl : null;

    const combined = courses.length > 1 && options.combine === "single";
    const stamp = new Date().toISOString().slice(0, 10);
    const results = [];

    try {
      if (combined) {
        const target = createArchive();
        const overview = [];
        for (const course of courses) {
          checkCancelled();
          state.courseIndex++;
          state.courseName = course.name;
          const { ctx, model } = await crawlCourse(target, course, options, providedDoc, providedUrl);
          overview.push({ course, root: ctx.root, model });
        }
        await target.archive.add("Alle Kurse.md", buildCourseIndex(overview));
        const blob = target.zip.close();
        const filename = `Moodle-Kurse ${stamp}.zip`;
        progress("Datei wird gespeichert …");
        await hooks.download(blob, filename);
        results.push({ filename, size: blob.size });
        log(`Fertig: ${filename} (${(blob.size / 1048576).toFixed(1)} MB)`);
      } else {
        for (const course of courses) {
          checkCancelled();
          state.courseIndex++;
          state.courseName = course.name;
          const target = createArchive();
          await crawlCourse(target, course, options, providedDoc, providedUrl);
          const blob = target.zip.close();
          const filename = `${sanitize(course.name, "Moodle-Kurs")} ${stamp}.zip`;
          progress("Datei wird gespeichert …");
          await hooks.download(blob, filename);
          results.push({ filename, size: blob.size });
          log(`Fertig: ${filename} (${(blob.size / 1048576).toFixed(1)} MB)`);
        }
      }
    } finally {
      state.running = false;
    }

    progress("Fertig");
    const size = results.reduce((n, r) => n + r.size, 0);
    const summary = results.length === 1
      ? { filename: results[0].filename, size }
      : { filename: `${results.length} Archive`, size };

    emit("done", {
      ...summary,
      archives: results,
      stats: state.stats,
      warnings: state.warnings.length,
    });
    return { ...summary, archives: results };
  }

  /* ------------------------------------------------------------------ *
   * Öffentliche Schnittstelle
   * ------------------------------------------------------------------ */

  /** Erkennt den Kurs auf einer geöffneten Seite und zählt die Elemente. */
  function inspect(doc, pageUrl) {
    const course = detectCourse(doc, pageUrl);
    if (!course) {
      return {
        ok: false,
        error: "Keine Moodle-Kursseite erkannt. Bitte zuerst die Kursübersicht öffnen (…/course/view.php?id=…).",
      };
    }
    session.origin = new URL(course.url).origin;
    session.host = new URL(course.url).host;
    session.base = course.url;
    const sections = parseCoursePage(doc, pageUrl);
    return {
      ok: true,
      course,
      sections: sections.length,
      activities: sections.reduce((n, s) => n + s.activities.length, 0),
    };
  }

  /** Prüft, ob eine Antwort auf die Moodle-Anmeldeseite führt. */
  function looksLikeLogin(finalUrl, doc) {
    if (/\/login\/(index|signup)\.php/.test(finalUrl)) return true;
    if (!doc) return false;
    if (doc.querySelector("#region-main .course-content, li.activity, [data-for='cmitem']")) return false;
    return !!doc.querySelector("form#login, .loginform, form[action*='/login/index.php']");
  }

  /**
   * Prüft, ob der Kurs aus der aktuellen Umgebung heraus erreichbar ist
   * (in der Hintergrundseite hängt das an den Cookies des Moodle-Servers).
   */
  async function probe(courseUrl) {
    session.origin = new URL(courseUrl).origin;
    session.host = new URL(courseUrl).host;
    session.base = courseUrl;
    state.cancelled = false;
    try {
      const { doc, finalUrl } = await fetchDocument(courseUrl);
      if (looksLikeLogin(finalUrl, doc)) return { ok: false, reason: "login" };
      if (!doc) return { ok: false, reason: "kein HTML" };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err && err.message ? err.message : String(err) };
    }
  }

  window.MoodleCrawler = {
    version: "1.1.0",
    run,
    inspect,
    probe,
    discoverCourses,
    detectCourse,
    cancel: () => {
      state.cancelled = true;
    },
    isRunning: () => state.running,
    getStatus: () => ({
      running: state.running,
      phase: state.phase,
      done: state.done,
      total: state.total,
      stats: state.stats,
      courseIndex: state.courseIndex,
      courseCount: state.courseCount,
      courseName: state.courseName,
      warnings: state.warnings.length,
    }),
  };
})();
