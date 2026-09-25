/*
 * End-to-End-Test: startet den Fake-Moodle-Server, lädt die Kursseite in
 * jsdom, lässt den echten Scraper laufen und prüft das erzeugte ZIP.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jsdomPath = process.env.JSDOM_PATH || "jsdom";
const { JSDOM, VirtualConsole } = require(jsdomPath);

const PORT = Number(process.env.FIXTURE_PORT || 8731);
const BASE = `http://127.0.0.1:${PORT}`;
const outDir = path.join(process.env.CLAUDE_JOB_DIR || ".", "tmp");
fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, "kurs.zip");
const uploadPath = path.join(outDir, "upload.bin");

const server = spawn("python3", ["test/fixture_server.py", String(PORT), uploadPath], {
  stdio: ["ignore", "inherit", "inherit"],
});

const failures = [];
function check(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? " – " + extra : ""}`);
  if (!cond) failures.push(label);
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/course/view.php?id=2`);
      if (res.ok) return;
    } catch (e) { /* noch nicht bereit */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Fixture-Server startet nicht");
}

try {
  await waitForServer();

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  const dom = await JSDOM.fromURL(`${BASE}/course/view.php?id=2`, {
    runScripts: "outside-only",
    virtualConsole,
  });
  const w = dom.window;

  // Browser-Umgebung ergänzen, die jsdom nicht mitbringt.
  w.fetch = (url, init) => fetch(url, init);
  w.Blob = Blob;
  w.Response = Response;
  w.CompressionStream = CompressionStream;
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.HTMLAnchorElement.prototype.click = function () {};

  let captured = null;
  w.URL.createObjectURL = (blob) => {
    captured = blob;
    return "blob:moodle-crawler-test";
  };
  w.URL.revokeObjectURL = () => {};

  const logs = [];

  w.eval(fs.readFileSync("lib/zip.js", "utf8"));
  w.eval(fs.readFileSync("lib/i18n.js", "utf8"));
  w.eval(fs.readFileSync("lib/crawler.js", "utf8"));

  const detected = w.MoodleCrawler.inspect(w.document, `${BASE}/course/view.php?id=2`);
  check("Kurs wird erkannt", detected.ok && detected.course.name === "Einführung in die Informatik",
    detected.ok ? detected.course.name : detected.error);
  check("Abschnitte der Startseite gefunden", detected.sections === 2, String(detected.sections));

  let downloadedName = null;
  const result = await w.MoodleCrawler.run({
    course: detected.course,
    rootDoc: w.document,
    rootUrl: `${BASE}/course/view.php?id=2`,
    options: {
      files: true, texts: true, images: true, forums: true, submissions: true,
      allSections: true, format: "both", language: "de", maxFileMB: 0, delay: 0,
    },
    onEvent: (type, payload) => {
      if (type === "log") logs.push(`${payload.level}: ${payload.message}`);
    },
    download: (blob, filename) => {
      captured = blob;
      downloadedName = filename;
    },
  });

  check("Download wurde ausgelöst", captured !== null && downloadedName === result.filename);
  check("Dateiname enthält den Kursnamen",
    /^Einführung in die Informatik \d{4}-\d{2}-\d{2}\.zip$/.test(result.filename), result.filename);

  fs.writeFileSync(zipPath, Buffer.from(await captured.arrayBuffer()));

  const inspector = path.join(outDir, "inspect_zip.py");
  fs.writeFileSync(inspector, `
import base64, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    names = z.namelist()
    texts = {}
    blobs = {}
    for n in names:
        if n.endswith(('.html', '.md', '.txt')):
            texts[n] = z.read(n).decode('utf-8', 'replace')
        else:
            blobs[n] = base64.b64encode(z.read(n)).decode()
print(json.dumps({"bad": bad, "names": names, "texts": texts, "blobs": blobs}))
`);
  const zip = JSON.parse(execFileSync("python3", [inspector, zipPath], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  }));

  const names = zip.names;
  const has = (needle) => names.some((n) => n.includes(needle));
  const textOf = (needle) => {
    const key = Object.keys(zip.texts).find((n) => n.includes(needle));
    return key ? zip.texts[key] : "";
  };

  check("ZIP ist fehlerfrei", zip.bad === null, String(zip.bad));
  check("Wurzelordner trägt den Kursnamen",
    names.every((n) => n.startsWith("Einführung in die Informatik/")));

  check("Übersichtsdateien vorhanden",
    has("/README.md") && has("/Kursübersicht.md") && has("/index.html") &&
    has("/Kurs-Texte.md") && has("/Links.md"));

  check("Alle drei Abschnitte angelegt (inkl. separater Abschnittsseite)",
    has("/01 Allgemeines/") && has("/02 Woche 1- Grundlagen/") && has("/03 Woche 2- Vertiefung/"),
    names.filter((n) => /^[^/]+\/\d\d /.test(n)).slice(0, 3).join(" | "));

  const pdf = (title) => Buffer.from(`%PDF-1.4\n% Fake-PDF für Tests: ${title}\n%%EOF\n`).toString("base64");
  const blobOf = (needle) => {
    const key = Object.keys(zip.blobs).find((n) => n.includes(needle));
    return key ? zip.blobs[key] : null;
  };

  check("Datei hinter Redirect geladen (Skript.pdf)",
    blobOf("Skript.pdf") === pdf("Vorlesungsskript"));
  check("Dateiname aus Content-Disposition übernommen (Spickzettel.pdf)",
    blobOf("Spickzettel.pdf") === pdf("Cheatsheet"), has("Spickzettel.pdf") ? "" : "fehlt");
  check("Datei hinter resourceworkaround-Seite geladen (Folien.pptx)", has("Folien.pptx"));
  check("Ordnerinhalte geladen",
    has("Übungsblätter/Uebung1.pdf") && has("Übungsblätter/Uebung2.docx"),
    names.filter((n) => n.includes("Uebung")).join(" | "));
  check("Aufgabenanhang des Lehrenden geladen", has("Aufgabenblatt.pdf"));
  check("Eigene Abgabe liegt im eigenen Unterordner",
    has("Meine Abgabe/Meine_Loesung.pdf"),
    names.filter((n) => n.includes("Loesung") || n.includes("Korrektur")).join(" | "));
  check("Feedbackdatei liegt beim eigenen Abgabeordner",
    has("Meine Abgabe/Korrektur.pdf"));
  check("Abgabestatus als eigene Notiz gesichert",
    textOf("Abgabe Übung 1 - Meine Abgabe.md").includes("87 von 100"),
    names.filter((n) => n.includes("Meine Abgabe")).join(" | "));
  check("Aufgabenstellung bleibt ohne persönliche Daten",
    textOf("03 Woche 2- Vertiefung/03 Abgabe Übung 1.md").includes("Aufgaben auf dem Blatt") &&
    !textOf("03 Woche 2- Vertiefung/03 Abgabe Übung 1.md").includes("87 von 100"));

  check("Bilder liegen im Bilderordner",
    has("/_bilder/banner.png") && has("/_bilder/diagramm.png"),
    names.filter((n) => n.includes("_bilder")).join(" | "));

  const pageHtml = textOf("Lernziele Woche 1.html");
  const pageMd = textOf("Lernziele Woche 1.md");
  check("Textseite gespeichert", pageHtml.includes("Grundbegriffe"));
  check("Textseite liegt als Markdown und als HTML vor",
    !!pageMd && !!pageHtml && pageMd.includes("Grundbegriffe"));
  check("Bildverweis zeigt auf die lokale Kopie",
    /src="\.\.\/_bilder\/diagramm\.png"/.test(pageHtml),
    (pageHtml.match(/src="[^"]*"/) || ["kein img"])[0]);
  check("Verlinkte Datei wurde mitgenommen und umgeschrieben",
    has("anhang.txt") && /href="[^"]*anhang\.txt"/.test(pageHtml));
  check("Interner Moodle-Link wurde absolut gemacht",
    pageHtml.includes(`href="${BASE}/mod/page/view.php?id=11"`));

  // --- Markdown-Ausgabe für Obsidian ---------------------------------------
  check("Markdown beginnt mit YAML-Frontmatter",
    pageMd.startsWith("---\n") && /\ntitle: "Lernziele Woche 1"/.test(pageMd));
  check("Frontmatter nennt Kurs, Typ und Quelle",
    pageMd.includes('kurs: "Einführung in die Informatik"') &&
    pageMd.includes('typ: "Textseite"') &&
    pageMd.includes(`quelle: "${BASE}/mod/page/view.php?id=11"`));
  check("Überschriften werden zu Markdown-Überschriften",
    pageMd.includes("# Lernziele Woche 1") && pageMd.includes("## Lernziele"));
  check("Bild wird als Markdown-Bild eingebunden",
    pageMd.includes("![Diagramm](../_bilder/diagramm.png)"),
    (pageMd.match(/!\[[^\]]*\]\([^)]*\)/) || ["kein Bild"])[0]);
  check("Listen werden zu Markdown-Listen (inkl. Verschachtelung)",
    /- Algorithmusbegriff/.test(pageMd) && /\n {4}- Listen/.test(pageMd),
    (pageMd.match(/- Datenstrukturen[\s\S]{0,40}/) || [""])[0].replace(/\n/g, "\\n"));
  check("Tabellen werden zu Markdown-Tabellen",
    pageMd.includes("| Woche | Thema |") && pageMd.includes("| --- | --- |"));
  check("Zitate werden zu Markdown-Zitaten", /^> Lesen Sie Kapitel 1\./m.test(pageMd));
  check("Hervorhebung bleibt erhalten", pageMd.includes("*Grundbegriffe*"));
  check("Dateianhang als Markdown-Link",
    /\[Anhang herunterladen\]\([^)]*anhang\.txt\)/.test(pageMd));

  check("Buchkapitel einzeln gespeichert",
    has("Skript als Buch/01 Kapitel 1- Einleitung.md") &&
    has("Skript als Buch/02 Kapitel 2- Algorithmen.md"),
    names.filter((n) => n.includes("Buch/")).join(" | "));

  check("Forendiskussionen gespeichert",
    textOf("Frage zur Klausur.html").includes("Open Book") &&
    has("Tippfehler im Skript.html"));

  check("Textfeld (Label) gespeichert",
    textOf("Allgemeines/01 Wichtiger").includes("12. Februar"),
    names.filter((n) => n.includes("01 Allgemeines/")).join(" | "));

  check("Abschnittsbeschreibung gespeichert",
    textOf("01 Allgemeines/00 Abschnittstext.md").includes("Willkommen im Kurs"));

  const links = textOf("Links.md");
  check("Link-Aktivität in Links.md vermerkt",
    links.includes("https://de.wikipedia.org/wiki/Informatik"));
  check("Link aus einem Textfeld erfasst",
    links.includes("https://example.org/pruefungsamt") && links.includes("Textfeld:"),
    links.includes("https://example.org/pruefungsamt") ? "" : "Link fehlt");
  check("Link aus der Abschnittsbeschreibung erfasst",
    links.includes("https://moodle.org/") && links.includes("Abschnitt:"));
  check("Link aus einer Aktivitätsbeschreibung erfasst",
    links.includes("https://example.com/zusatzmaterial") && links.includes("Beschreibung:"));
  check("E-Mail-Adresse aus dem Kurstext erfasst",
    links.includes("mailto:pruefungsamt@example.org"));
  check("Moodle-interne Links getrennt aufgeführt",
    links.includes("Links innerhalb von Moodle") && links.includes("/course/view.php?id=3"));
  check("Dateilinks stehen nicht in Links.md", !links.includes("pluginfile.php"));

  check("Bild aus einer Aktivitätsbeschreibung geladen",
    has("/_bilder/hinweis.png"),
    names.filter((n) => n.includes("_bilder")).join(" | "));
  check("Beschreibung mit Bild als eigene Seite gesichert",
    has("Vorlesungsskript - Beschreibung.html") &&
    /src="\.\.\/_bilder\/hinweis\.png"/.test(textOf("Vorlesungsskript - Beschreibung.html")),
    names.filter((n) => n.includes("Beschreibung")).join(" | "));

  const gesamt = textOf("Kurs-Texte.md");
  check("Gesammelte Texte enthalten Label- und Seitentext",
    gesamt.includes("12. Februar") && gesamt.includes("Grundbegriffe") && gesamt.includes("10 Fragen"));
  check("Gesammelte Texte enthalten auch die Aktivitätsbeschreibungen",
    gesamt.includes("Was Sie nach dieser Woche können sollten") &&
    gesamt.includes("Das Skript zur gesamten Vorlesung"));

  const readme = textOf("README.md");
  check("README listet alle Abschnitte", ["Allgemeines", "Woche 1", "Woche 2"].every((s) => readme.includes(s)));

  const index = textOf("index.html");
  check("index.html verlinkt lokale Dateien", index.includes("Skript.pdf") && index.includes("Lernziele"));

  const indexMd = textOf("Kursübersicht.md");
  check("Kursübersicht.md verlinkt die Notizen relativ",
    /\[01%20Lernziele%20Woche%201\.md\]\(02%20Woche%201-%20Grundlagen\/01%20Lernziele%20Woche%201\.md\)/.test(indexMd) ||
    /\]\(02%20Woche%201-%20Grundlagen\//.test(indexMd),
    (indexMd.match(/\]\([^)]*Lernziele[^)]*\)/) || ["kein Link"])[0]);
  check("Kursübersicht.md hat Frontmatter und alle Abschnitte",
    indexMd.startsWith("---\n") &&
    ["Allgemeines", "Woche 1", "Woche 2"].every((s2) => indexMd.includes(s2)));

  check("Keine Fehler im Protokoll",
    !logs.some((l) => l.startsWith("error")),
    logs.filter((l) => l.startsWith("error")).join(" | "));

  console.log(`\n${names.length} Einträge im Archiv, ${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB`);

  // ------------------------------------------------------------------
  // Durchlauf B: Kurse des Nutzers ermitteln
  // ------------------------------------------------------------------
  console.log("\n— Kurserkennung —");
  const found = await w.MoodleCrawler.discoverCourses(`${BASE}/my/courses.php`);
  check("Kursliste wird gefunden", found.ok && found.courses.length === 2,
    found.ok ? `${found.courses.length} Kurse über ${found.source}` : found.error);
  check("Kurse kommen aus Moodles Webservice", found.source === "webservice", found.source);
  check("Kursnamen und absolute Adressen stimmen",
    found.courses.some((c) => c.name === "Einführung in die Informatik" && c.url === `${BASE}/course/view.php?id=2`) &&
    found.courses.some((c) => c.name === "Mathematik 1" && c.url === `${BASE}/course/view.php?id=3`),
    JSON.stringify(found.courses));

  // ------------------------------------------------------------------
  // Durchlauf C: alle Kurse in ein Archiv, ohne eigene Abgaben
  // ------------------------------------------------------------------
  console.log("\n— Alle Kurse, englisch, ohne eigene Abgaben —");
  captured = null;
  const multi = await w.MoodleCrawler.run({
    courses: found.courses,
    options: {
      files: true, texts: true, images: true, forums: false, submissions: false,
      allSections: true, format: "md", combine: "single", language: "en",
      maxFileMB: 0, delay: 0,
    },
    onEvent: () => {},
    download: (blob, filename) => {
      captured = blob;
      downloadedName = filename;
    },
  });

  check("Ein gemeinsames Archiv für alle Kurse, englisch benannt",
    (multi.archives || []).length === 1 && /^Moodle courses \d{4}-\d{2}-\d{2}\.zip$/.test(multi.filename),
    multi.filename);

  const multiPath = path.join(outDir, "alle-kurse.zip");
  fs.writeFileSync(multiPath, Buffer.from(await captured.arrayBuffer()));
  const multiZip = JSON.parse(execFileSync("python3", [inspector, multiPath], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  }));
  const multiNames = multiZip.names;
  const multiHas = (needle) => multiNames.some((n) => n.includes(needle));

  check("Archiv ist fehlerfrei", multiZip.bad === null, String(multiZip.bad));
  check("Beide Kurse liegen in eigenen Ordnern",
    multiHas("Einführung in die Informatik/") && multiHas("Mathematik 1/"),
    [...new Set(multiNames.map((n) => n.split("/")[0]))].join(" | "));
  check("Übersicht über alle Kurse vorhanden",
    multiHas("All courses.md") &&
    multiZip.texts["All courses.md"].includes("Mathematik 1") &&
    multiZip.texts["All courses.md"].includes("Einführung in die Informatik"));
  check("Inhalte des zweiten Kurses gesichert",
    multiHas("Mathematik 1/01 Zahlenbereiche/01 Mengenlehre.md") &&
    multiHas("Mathematik 1/Course overview.md") && multiHas("Mathematik 1/Course texts.md"),
    multiNames.filter((n) => n.startsWith("Mathematik 1/")).join(" | "));

  check("Arbeitsblatt des Lehrenden ist dabei", multiHas("Aufgabenblatt.pdf"));
  check("Eigene Abgabe wurde NICHT geladen", !multiHas("Meine_Loesung.pdf"),
    multiNames.filter((n) => n.includes("Loesung")).join(" | "));
  check("Feedbackdatei wurde NICHT geladen", !multiHas("Korrektur.pdf"));
  check("Bewertung taucht nirgends im Text auf",
    !Object.values(multiZip.texts).some((t) => t.includes("87 von 100")));

  // Sprachumschaltung wirkt bis in Dateinamen, Ordner und Frontmatter hinein.
  const multiTextOf = (needle) => {
    const key = Object.keys(multiZip.texts).find((n) => n.includes(needle));
    return key ? multiZip.texts[key] : "";
  };
  check("Bilderordner trägt den englischen Namen",
    multiHas("/_images/banner.png") && !multiNames.some((n) => n.includes("_bilder")),
    multiNames.filter((n) => n.includes("_image") || n.includes("_bilder")).join(" | "));
  const noteEn = multiTextOf("01 Mengenlehre.md");
  check("Frontmatter ist englisch",
    /\ncourse: "Mathematik 1"/.test(noteEn) && /\ntype: "Page"/.test(noteEn) &&
    /\nsource: "/.test(noteEn) && /\nsaved: \d{4}/.test(noteEn),
    noteEn.split("---")[1] ? noteEn.split("---")[1].trim().replace(/\n/g, " | ") : "kein Frontmatter");
  check("Abschnittstext heißt englisch",
    multiHas("00 Section text.md") && !multiNames.some((n) => n.includes("Abschnittstext")));
  check("Übersichten nutzen englische Überschriften",
    multiTextOf("Mathematik 1/README.md").includes("## Contents") &&
    multiTextOf("All courses.md").includes("# Saved courses"));
  check("Deutscher Durchlauf blieb deutsch",
    has("/_bilder/banner.png") && has("00 Abschnittstext.md") && has("Kursübersicht.md"));

  console.log(`\n${multiNames.length} Einträge im Sammelarchiv, ${(fs.statSync(multiPath).size / 1024).toFixed(1)} KB`);
  fs.rmSync(inspector, { force: true });
} finally {
  server.kill();
}

if (failures.length) {
  console.log(`\n${failures.length} Test(s) fehlgeschlagen.`);
  process.exitCode = 1;
} else {
  console.log("\nAlle E2E-Tests bestanden.");
}
