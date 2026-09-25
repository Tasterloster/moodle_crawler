/*
 * Prüft den ZIP-Writer: schreibt ein Archiv und lässt es von Pythons
 * zipfile-Modul (unabhängige Implementierung) gegenprüfen.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

globalThis.window = {};
new Function(fs.readFileSync("lib/zip.js", "utf8"))();
const { ZipWriter } = globalThis.window.__moodleCrawlerZip;

const outDir = path.join(process.env.CLAUDE_JOB_DIR || ".", "tmp");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, "zip-writer-test.zip");

const zip = new ZipWriter();
const big = "Moodle ".repeat(5000);
const random = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 97 + 31) % 256));
const umlaut = "Grüße aus dem Kurs – äöüß";

await zip.add("Kurs/README.md", "# Test\n" + big);
await zip.add("Kurs/01 Abschnitt/Ünterlagen.bin", new Uint8Array(random));
await zip.add("Kurs/01 Abschnitt/Text.txt", umlaut);
await zip.add("Kurs/leer.txt", "");
const dup1 = zip.uniqueName("Kurs/Datei.pdf");
const dup2 = zip.uniqueName("Kurs/Datei.pdf");
await zip.add(dup1, "eins");
await zip.add(dup2, "zwei");

const bytes = Buffer.from(await zip.close().arrayBuffer());
fs.writeFileSync(file, bytes);

const expected = {
  "Kurs/README.md": "# Test\n" + big,
  "Kurs/01 Abschnitt/Ünterlagen.bin": random.toString("base64"),
  "Kurs/01 Abschnitt/Text.txt": umlaut,
  "Kurs/leer.txt": "",
  "Kurs/Datei.pdf": "eins",
  "Kurs/Datei (2).pdf": "zwei",
};

const verifier = path.join(outDir, "verify_zip.py");
fs.writeFileSync(verifier, `
import base64, json, sys, zipfile
archive, expected_json = sys.argv[1], sys.argv[2]
expected = json.loads(expected_json)
failures = []
with zipfile.ZipFile(archive) as z:
    bad = z.testzip()
    if bad: failures.append("CRC-Fehler bei " + bad)
    names = z.namelist()
    if sorted(names) != sorted(expected): failures.append("Namen weichen ab: %r" % names)
    for name, want in expected.items():
        if name not in names: continue
        raw = z.read(name)
        got = base64.b64encode(raw).decode() if name.endswith(".bin") else raw.decode("utf-8")
        if got != want: failures.append("Inhalt weicht ab: " + name)
    methods = {i.filename: i.compress_type for i in z.infolist()}
print(json.dumps({"failures": failures, "methods": methods}))
`);

const raw = execFileSync("python3", [verifier, file, JSON.stringify(expected)], { encoding: "utf8" });
const result = JSON.parse(raw);

const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? " – " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

check("Archiv ist gültig, Namen und Inhalte stimmen",
  result.failures.length === 0, result.failures.join("; "));
check("Doppelter Name wurde entschärft", dup2 === "Kurs/Datei (2).pdf", dup2);
check("Komprimierbarer Text wurde deflatet (Methode 8)",
  result.methods["Kurs/README.md"] === 8);
check("Leere Datei wird gespeichert (Methode 0)",
  result.methods["Kurs/leer.txt"] === 0);
check("Archiv deutlich kleiner als Rohdaten",
  bytes.length < Buffer.byteLength(big) / 2,
  `${bytes.length} statt ${Buffer.byteLength(big)} Bytes`);

fs.rmSync(verifier, { force: true });
