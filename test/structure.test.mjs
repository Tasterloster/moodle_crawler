/* Prüft, dass das Manifest gültig ist und alle referenzierten Dateien existieren. */
import fs from "node:fs";

const failures = [];
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? " – " + extra : ""}`);
  if (!cond) failures.push(label);
};

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
check("manifest.json ist gültiges JSON", true);
check("Manifest-Version 2 (Firefox-kompatibel)", manifest.manifest_version === 2);
check("Add-on-ID gesetzt",
  !!(manifest.browser_specific_settings && manifest.browser_specific_settings.gecko.id));
check("Version folgt dem Schema x.y.z", /^\d+\.\d+(\.\d+)?$/.test(manifest.version), manifest.version);

const referenced = [
  manifest.browser_action.default_popup,
  ...Object.values(manifest.browser_action.default_icon),
  ...Object.values(manifest.icons),
];
for (const file of new Set(referenced)) {
  check(`Referenzierte Datei existiert: ${file}`, fs.existsSync(file));
}

const popup = fs.readFileSync("popup/popup.html", "utf8");
for (const [ref, file] of [
  ["popup.css", "popup/popup.css"],
  ["popup.js", "popup/popup.js"],
  ["../icons/icon.svg", "icons/icon.svg"],
  ["../lib/i18n.js", "lib/i18n.js"],
]) {
  check(`Popup bindet ${ref} ein und die Datei existiert`,
    popup.includes(ref) && fs.existsSync(file));
}

for (const file of ["lib/zip.js", "lib/i18n.js", "lib/crawler.js", "content/agent.js", "background/background.js"]) {
  check(`Skript vorhanden: ${file}`, fs.existsSync(file));
  new Function(fs.readFileSync(file, "utf8"));
}
check("Alle Skripte sind syntaktisch gültig", true);

const backgroundPage = manifest.background && manifest.background.page;
check("Hintergrundseite ist eingetragen", !!backgroundPage, String(backgroundPage));
check("Hintergrundseite läuft dauerhaft (Download überlebt Tab-Wechsel)",
  manifest.background && manifest.background.persistent === true);
check("Hintergrundseite existiert", fs.existsSync(backgroundPage));
const bgHtml = fs.readFileSync(backgroundPage, "utf8");
for (const [ref, file] of [
  ["../lib/zip.js", "lib/zip.js"],
  ["../lib/i18n.js", "lib/i18n.js"],
  ["../lib/crawler.js", "lib/crawler.js"],
  ["background.js", "background/background.js"],
]) {
  check(`Hintergrundseite bindet ${ref} ein`, bgHtml.includes(ref) && fs.existsSync(file));
}
check("Download-Berechtigung vorhanden", (manifest.permissions || []).includes("downloads"));
check("Host-Zugriff ist optional und wird erst bei Bedarf erfragt",
  (manifest.optional_permissions || []).includes("<all_urls>"));

for (const locale of ["de", "en"]) {
  const p = `_locales/${locale}/messages.json`;
  const messages = JSON.parse(fs.readFileSync(p, "utf8"));
  check(`Übersetzung ${locale} enthält Name und Beschreibung`,
    !!messages.extensionName && !!messages.extensionDescription);
}
check("default_locale ist vorhanden", fs.existsSync(`_locales/${manifest.default_locale}/messages.json`));

// Sprachtabelle: beide Sprachen müssen dieselben Schlüssel kennen.
globalThis.window = {};
new Function(fs.readFileSync("lib/i18n.js", "utf8"))();
const { t, setLanguage } = globalThis.window.MoodleCrawlerI18n;
const source = fs.readFileSync("lib/i18n.js", "utf8");
const deBlock = source.slice(source.indexOf("    de: {"), source.indexOf("    en: {"));
const enBlock = source.slice(source.indexOf("    en: {"));
const collect = (block) => new Set([...block.matchAll(/^\s*"([a-zA-Z.]+)":/gm)].map((m) => m[1]));
const deKeys = collect(deBlock);
const enKeys = collect(enBlock);
const missingEn = [...deKeys].filter((k) => !enKeys.has(k));
const missingDe = [...enKeys].filter((k) => !deKeys.has(k));
check("Englische Tabelle ist vollständig", missingEn.length === 0, missingEn.join(", "));
check("Deutsche Tabelle ist vollständig", missingDe.length === 0, missingDe.join(", "));
check("Beide Sprachen liefern Text", (setLanguage("en"), t("ui.download") === "Download course") &&
  (setLanguage("de"), t("ui.download") === "Kurs herunterladen"));
check("Unbekannter Schlüssel fällt auf sich selbst zurück", t("gibt.es.nicht") === "gibt.es.nicht");

const permissions = manifest.permissions || [];
check("Keine breiten Berechtigungen ohne Nachfrage",
  !permissions.includes("<all_urls>") && !permissions.some((p) => p.includes("://")),
  permissions.join(", "));

if (failures.length) {
  console.log(`\n${failures.length} Test(s) fehlgeschlagen.`);
  process.exitCode = 1;
} else {
  console.log("\nStruktur in Ordnung.");
}
