# Moodle Crawler

Deutsch- und englischsprachige Firefox-Erweiterung, die einen kompletten
Moodle-Kurs sichert: **alle Dateien,
alle Texte, alle Links und alle im Kurs eingebetteten Bilder** landen in einer
einzigen ZIP-Datei — sortiert nach Kursabschnitten, offline lesbar und
standardmäßig als **Markdown für Obsidian**.

Wahlweise für den geöffneten Kurs oder **für alle Kurse auf einmal**, in die du
eingeschrieben bist.

Der Download läuft **im Hintergrund**: Tab wechseln, weiterarbeiten oder den
Kurs-Tab schließen ist erlaubt, während gesichert wird.

Die Erweiterung nutzt deine bestehende Moodle-Anmeldung. Es werden keine
Zugangsdaten abgefragt, gespeichert oder übertragen; es gibt keinen Server im
Hintergrund und keine Telemetrie.

## Was gesichert wird

| Moodle-Element | Ergebnis im Archiv |
| --- | --- |
| Datei (`resource`) | Originaldatei (PDF, DOCX, PPTX …) |
| Verzeichnis (`folder`) | Unterordner mit allen enthaltenen Dateien |
| Textseite (`page`) | eigenständige Notiz inkl. Bildern |
| Buch (`book`) | eine Notiz je Kapitel |
| Textfeld / Label | Notiz mit Text und Bildern |
| Abschnittsbeschreibung | `00 Abschnittstext.md` im Abschnittsordner |
| Beschreibungstext unter einer Aktivität | in `Kurs-Texte.md`; enthält er Bilder oder Dateien, zusätzlich als eigene Notiz |
| Forum (optional) | eine Notiz je Diskussion |
| Link (`url`) | Eintrag in `Links.md` |
| Aufgabe (`assign`) | Aufgabenstellung + Arbeitsblätter; auf Wunsch zusätzlich deine Abgabe, Bewertung und Feedbackdateien |
| Test und sonstige | Beschreibungstext + angehängte Dateien |

Zusätzlich entstehen im Archiv:

* `Kursübersicht.md` — Inhaltsverzeichnis mit Links auf alle Notizen und Dateien
* `README.md` — dieselbe Übersicht mit Quelllinks und Hinweisen zum Lauf
* `Kurs-Texte.md` — alle Texte des Kurses in einer durchsuchbaren Datei
* `Links.md` — **alle** Links aus dem Kurs, nicht nur Link-Aktivitäten: auch
  Verweise, die mitten in Textfeldern, Abschnittsbeschreibungen oder
  Aktivitätsbeschreibungen stehen. Gruppiert nach externen und
  Moodle-internen Links und nach ihrer Fundstelle; E-Mail-Adressen inklusive
* `_bilder/` — alle eingebetteten Bilder; die Notizen verweisen auf diese
  lokalen Kopien, sind also ohne Internet vollständig lesbar

Beispielstruktur:

```
Einführung in die Informatik/
├── Kursübersicht.md
├── README.md
├── Kurs-Texte.md
├── Links.md
├── _bilder/
│   ├── banner.png
│   └── diagramm.png
├── 01 Allgemeines/
│   ├── 00 Abschnittstext.md
│   ├── 01 Wichtiger Hinweis ….md
│   └── 02 Skript.pdf
├── 02 Woche 1 - Grundlagen/
│   ├── 01 Lernziele Woche 1.md
│   └── 02 Übungsblätter/
│       ├── Uebung1.pdf
│       └── Uebung2.docx
└── 03 Woche 2 - Vertiefung/
    ├── 03 Abgabe Übung 1.md              ← Aufgabenstellung
    ├── 03 Abgabe Übung 1 - Meine Abgabe.md
    └── 03 Abgabe Übung 1 - Meine Abgabe/ ← eigene Dateien, getrennt
        ├── Meine_Loesung.pdf
        └── Korrektur.pdf
```

Der oberste Ordner heißt genau wie der Kurs in Moodle; nur für Dateisysteme
verbotene Zeichen (`/ \ : * ? " < > |`) werden durch `-` ersetzt. Die Nummern
vor den Namen erhalten die Reihenfolge aus dem Kurs.

### Texte und Links, die „einfach so" im Kurs stehen

Auch Inhalte, die zu keiner eigenen Aktivität gehören, werden erfasst:

* **Textfelder** zwischen den Aktivitäten — als Notiz und in `Kurs-Texte.md`.
* **Abschnittsbeschreibungen** — als `00 Abschnittstext.md`.
* **Beschreibungstexte** unter einem Aktivitätsnamen — landen in
  `Kurs-Texte.md`. Stecken darin Bilder oder Dateianhänge, wird die
  Beschreibung zusätzlich als eigene Notiz gesichert, damit nichts verloren geht.
* **Links in laufenden Texten** — bleiben in den Notizen anklickbar und werden
  zusätzlich in `Links.md` gesammelt, jeweils mit der Angabe, wo im Kurs sie
  gefunden wurden. Verweise auf Moodle-Dateien tauchen dort nicht auf, weil
  die Dateien selbst heruntergeladen werden.

### Eigene Abgaben

Auf Aufgabenseiten liegen drei verschiedene Sorten Dateien nebeneinander. Der
Crawler unterscheidet sie anhand der Moodle-Dateikomponente:

| Sorte | Moodle-Komponente | Wohin |
| --- | --- | --- |
| Arbeitsblätter des Lehrenden | `mod_assign/introattachment` | direkt in den Abschnittsordner |
| Deine hochgelösten Abgaben | `assignsubmission_*` | Unterordner `… - Meine Abgabe/` |
| Bewertung und Feedbackdateien | `assignfeedback_*` | derselbe Unterordner |

Die Option **„Eigene Abgaben & Feedback"** steuert die letzten beiden Zeilen.
Ist sie aus, werden deine Uploads, deine Note und die Korrekturen weder
heruntergeladen noch im Text erwähnt — dann bleibt nur das Kursmaterial übrig,
das man z. B. bedenkenlos weitergeben kann. Dasselbe gilt für Abgaben bei
„Gegenseitiger Beurteilung" (`mod_workshop`).

## Alle Kurse auf einmal

Im Popup lässt sich von **„Nur dieser Kurs"** auf **„Alle meine Kurse"**
umschalten. Dann passiert Folgendes:

1. Ein Klick auf **„Kurse suchen"** fragt Moodles eigenen Webservice
   (`core_course_get_enrolled_courses_by_timeline_classification`) nach allen
   Kursen, in die du eingeschrieben bist — auch versteckte und abgelaufene.
   Klappt das nicht (ältere Moodle-Version, abgeschalteter Dienst), werden
   ersatzweise die Kurslinks von `/my/courses.php` ausgelesen.
2. Die gefundenen Kurse erscheinen als Liste mit Häkchen, alle vorausgewählt.
   Was du nicht brauchst, hakst du ab.
3. Der Knopf zeigt dann z. B. „7 Kurse herunterladen".

Über die Option **Mehrere Kurse** wählst du, wie gespeichert wird:

* **Ein Archiv pro Kurs** (Standard) — je Kurs eine ZIP-Datei, nacheinander
  gespeichert. Schont den Arbeitsspeicher, weil immer nur ein Kurs gleichzeitig
  im RAM liegt. Bei vielen oder großen Kursen die sichere Wahl.
* **Alles in einem Archiv** — eine ZIP-Datei mit einem Ordner je Kurs und einer
  zusätzlichen Notiz `Alle Kurse.md`, die auf alle Kurse verlinkt. Praktisch
  fürs Archiv, braucht aber Speicher für **alle** Kurse zusammen.

## Obsidian

Markdown ist das Standardformat, weil Obsidian HTML-Dateien nicht rendert.
Entpacke das Archiv einfach in deinen Vault (oder öffne den Ordner als eigenen
Vault). Jede Notiz bringt mit:

* **YAML-Frontmatter** mit `title`, `kurs`, `typ`, `abschnitt`, `quelle`,
  `gesichert` und dem Tag `moodle` — damit lässt sich direkt per Dataview oder
  Suche filtern, z. B. alles vom Typ „Buchkapitel" eines Kurses.
* **Relative Links** auf die lokalen Bilder (`![Diagramm](../_bilder/…)`) und
  auf heruntergeladene Dateien — Obsidian löst beides auf, Bilder werden in
  der Vorschau angezeigt, PDFs öffnen sich per Klick.
* Umgewandelt werden Überschriften, Listen (auch verschachtelt), Tabellen,
  Zitate, Code, Hervorhebungen, Links und Bilder.

Über die Option **Format** lässt sich stattdessen HTML erzeugen oder beides
zugleich.

## Installation in Firefox

### Variante A — zum Ausprobieren (dauert 1 Minute)

Temporär geladene Erweiterungen verschwinden beim Beenden von Firefox wieder.

1. Repository herunterladen: `git clone https://github.com/Tasterloster/moodle_crawler.git`
2. In Firefox `about:debugging` in die Adressleiste eingeben.
3. Links auf **„Dieser Firefox"** klicken.
4. Auf **„Temporäres Add-on laden…"** klicken.
5. Im Dateidialog die Datei `manifest.json` aus dem Projektordner auswählen.

Das Symbol erscheint nun in der Symbolleiste. Falls nicht: Puzzleteil-Symbol
anklicken und „Moodle Crawler" an die Symbolleiste anheften.

### Variante B — dauerhaft installieren

Firefox installiert dauerhaft nur **signierte** Add-ons. Es gibt zwei Wege:

* **Über Mozilla signieren lassen** (empfohlen, funktioniert in jedem Firefox) —
  siehe [Veröffentlichung](#veröffentlichung-im-add-on-store). Bei der
  Einreichung als *„On your own"* bekommst du eine `.xpi`, die sich über
  `about:addons` → Zahnrad → „Add-on aus Datei installieren…" einrichten
  lässt — ohne dass das Add-on öffentlich gelistet wird.
* **Ohne Signatur** geht nur in *Firefox Developer Edition*, *Nightly* oder
  *ESR*: dort in `about:config` die Einstellung
  `xpinstall.signatures.required` auf `false` setzen und anschließend die von
  `./build.sh` erzeugte ZIP-Datei über `about:addons` installieren. Im normalen
  Firefox-Release funktioniert das **nicht**.

## Bedienung

1. Den gewünschten Moodle-Kurs im Browser öffnen (die Kursübersicht,
   also eine Adresse der Form `…/course/view.php?id=123`).
2. Auf das Symbol **Moodle Crawler** klicken. Die Erweiterung zeigt den
   erkannten Kursnamen und die Zahl der gefundenen Elemente an.
3. Oben wählen, ob nur dieser Kurs oder **alle deine Kurse** gesichert werden
   sollen. Bei „Alle meine Kurse" sucht ein erster Klick die Kurse und zeigt
   sie zur Auswahl; der zweite Klick startet den Download.
4. Optionen setzen und auf **„Kurs herunterladen"** klicken.
5. Beim ersten Mal fragt Firefox nach Zugriff auf die Moodle-Adresse. Das ist
   nötig, damit der Download unabhängig vom Tab weiterläuft (siehe unten).
6. Der Fortschritt läuft im Popup — das Popup darf geschlossen werden. Beim
   nächsten Öffnen zeigt es den aktuellen Stand bzw. das letzte Ergebnis.
7. Am Ende speichert Firefox die ZIP-Datei wie einen normalen Download.

### Hintergrund oder Tab?

| | Hintergrund | Im Tab |
| --- | --- | --- |
| Voraussetzung | Zugriffsrecht auf die Moodle-Adresse erteilt | nichts |
| Tab wechseln | ja | ja |
| Tab schließen oder woanders hin navigieren | ja | nein, bricht ab |
| Geschwindigkeit | voll | Firefox bremst Timer in Hintergrund-Tabs |

Die Erweiterung nimmt automatisch den Hintergrundweg, sobald das Zugriffsrecht
erteilt ist. Sie prüft dabei vorher, ob die Moodle-Sitzung dort auch gilt —
falls nicht (manche Moodle-Server schränken ihre Sitzungs-Cookies ein), fällt
sie von selbst auf den Tab-Weg zurück und sagt das im Protokoll. Wer das
Zugriffsrecht ablehnt, bekommt ebenfalls den Tab-Weg; dann muss der Tab offen
bleiben.

### Optionen

| Option | Standard | Bedeutung |
| --- | --- | --- |
| Dateien herunterladen | an | Lädt Dateien, Verzeichnisse und Anhänge |
| Texte & Seiten speichern | an | Sichert Textseiten, Bücher und Textfelder |
| Bilder aus Texten mitladen | an | Lädt eingebettete Bilder und verweist lokal darauf |
| Eigene Abgaben & Feedback | an | Deine Uploads, Bewertungen und Korrekturen (siehe oben) |
| Forenbeiträge einbeziehen | aus | Sichert jede Diskussion einzeln (kann lange dauern) |
| Alle Abschnittsseiten durchsuchen | an | Nötig bei Kursformaten mit einer Seite je Abschnitt |
| Format | Markdown | Markdown (Obsidian), HTML oder beides |
| Mehrere Kurse | Ein Archiv pro Kurs | Nur im Modus „Alle meine Kurse" |
| Sprache | Automatisch | Deutsch oder English – siehe unten |
| Max. Dateigröße | 0 (unbegrenzt) | Überspringt Dateien oberhalb der Grenze |
| Pause je Anfrage | 150 ms | Schont den Moodle-Server; höher = langsamer, aber sanfter |

## Sprache

Die Einstellung **Sprache** schaltet zwischen Deutsch und English um; auf
*Automatisch* richtet sie sich nach der Sprache deines Firefox. Sie betrifft
nicht nur die Oberfläche, sondern **auch das erzeugte Archiv**:

| | Deutsch | English |
| --- | --- | --- |
| Übersicht | `Kursübersicht.md` | `Course overview.md` |
| Texte | `Kurs-Texte.md` | `Course texts.md` |
| Bilder | `_bilder/` | `_images/` |
| Abschnittstext | `00 Abschnittstext.md` | `00 Section text.md` |
| Eigene Abgaben | `… - Meine Abgabe/` | `… - My submission/` |
| Sammelarchiv | `Alle Kurse.md` | `All courses.md` |
| Frontmatter | `kurs:`, `typ:`, `quelle:`, `gesichert:` | `course:`, `type:`, `source:`, `saved:` |
| Typbezeichnung | `Textseite`, `Aufgabe`, `Buch` | `Page`, `Assignment`, `Book` |

Namen, die aus Moodle stammen — Kurs-, Abschnitts- und Aktivitätsnamen —
bleiben selbstverständlich unverändert.

Wer seine Notizen in Obsidian nach `type` filtert, sollte die Sprache also
einmal festlegen und dabei bleiben, sonst entstehen zwei Sätze von
Frontmatter-Feldern.

Der Name und die Beschreibung der Erweiterung selbst (in `about:addons`)
folgen weiterhin der Firefox-Oberflächensprache; das legt Firefox über
`_locales/` fest und lässt sich nicht im Add-on umschalten.

## Hinweise und Grenzen

* Gesichert wird nur, was dein Konto auch im Browser sehen darf. Die
  Erweiterung umgeht keine Zugriffsrechte und meldet sich nirgends an.
* Der gesamte Kurs wird im Arbeitsspeicher zusammengebaut, bevor die ZIP-Datei
  geschrieben wird. Bei sehr großen Kursen (viele GB Video) lohnt sich die
  Option „Max. Dateigröße", z. B. 200 MB.
* Bilder und Dateien von **fremden Servern** (eingebettete YouTube-Videos,
  Bilder anderer Domains) werden nicht heruntergeladen. Solche Verweise
  bleiben als absolute Links in den Notizen erhalten.
* Tests, Aufgaben und ähnliche Aktivitäten werden als Beschreibungstext samt
  Anhängen gesichert, nicht als bearbeitbare Aktivität.
* Bitte nur für eigene Kurse verwenden und die Nutzungsbedingungen deiner
  Hochschule beachten.

## Berechtigungen

| Berechtigung | Wofür | Wann |
| --- | --- | --- |
| `activeTab` | Kurs im geöffneten Tab erkennen | beim Klick auf das Symbol |
| `storage` | gewählte Optionen merken | immer, rein lokal |
| `downloads` | fertige ZIP-Datei speichern | beim Speichern |
| Zugriff auf die Moodle-Adresse | Download im Hintergrund | wird beim ersten Start erfragt und kann abgelehnt werden |

Die Adress-Berechtigung ist **optional**: Sie steht nicht im Manifest als
Pflichtrecht, sondern wird erst beim ersten Download für genau den Server
erfragt, auf dem dein Kurs liegt.

## Entwicklung

```
manifest.json            Manifest (MV2, Firefox 115+)
popup/                   Oberfläche der Erweiterung
lib/i18n.js              Sprachtabelle für Oberfläche und Archivinhalte
lib/zip.js               ZIP-Writer (Deflate + ZIP64, ohne Fremdbibliothek)
lib/crawler.js           Kurs-Erkennung, Kursliste, Scraping, Markdown, Archivaufbau
background/              Hintergrundseite: führt den Lauf unabhängig vom Tab aus
content/agent.js         Content-Skript: Kurs-Erkennung und Ersatzweg im Tab
test/                    Tests inkl. Fake-Moodle-Server
build.sh                 Erzeugt dist/moodle-crawler-<version>.zip
```

`lib/crawler.js` kennt weder `document` noch `location` der Moodle-Seite —
alles kommt über die Konfiguration herein. Deshalb läuft derselbe Code
unverändert in der Hintergrundseite und als Content-Skript im Tab.

### Tests

```bash
npm install jsdom      # nur für den End-to-End-Test nötig
./test/run.sh
```

* `structure.test.mjs` — Manifest, Berechtigungen, referenzierte Dateien und
  Vollständigkeit beider Sprachtabellen
* `zip.test.mjs` — schreibt ein Archiv und lässt es von Pythons `zipfile`
  gegenprüfen (Inhalte, UTF-8-Namen, Kompression)
* `e2e.test.mjs` — startet einen Fake-Moodle-Server mit Moodle-4-DOM, lässt den
  echten Crawler in jsdom durchlaufen und prüft das erzeugte ZIP: Dateien
  hinter Weiterleitungen, Ordner, Buchkapitel, Foren, Bilder, Markdown-Umwandlung
  und die gesammelten Links; dazu die Kurserkennung und ein Durchlauf über
  mehrere Kurse ohne eigene Abgaben, einmal auf Deutsch und einmal auf Englisch

### Paket bauen

```bash
./build.sh
```

Ergebnis: `dist/moodle-crawler-<version>.zip` — genau diese Datei wird bei
Mozilla hochgeladen.

## Veröffentlichung im Add-on-Store

Der Firefox-Add-on-Store heißt **addons.mozilla.org**, kurz **AMO**. Der Ablauf:

**1. Vorbereiten**

* In `manifest.json` die `version` erhöhen (bei jedem Upload nötig, eine
  Version darf nie zweimal hochgeladen werden).
* Die Add-on-ID in `browser_specific_settings.gecko.id` auf eine Adresse
  ändern, die dir gehört — z. B. `moodle-crawler@deine-domain.de`. Die ID ist
  nach der ersten Veröffentlichung unveränderlich.
* `./build.sh` ausführen.

**2. Konto anlegen**

Auf <https://addons.mozilla.org/developers/> mit einem Mozilla-Konto anmelden.

**3. Hochladen**

„Submit a New Add-on" → ZIP-Datei aus `dist/` hochladen. Dann die
Verteilungsart wählen:

* **On this site (gelistet)** — das Add-on erscheint öffentlich im Store und
  ist für alle suchbar. Es durchläuft eine inhaltliche Prüfung.
* **On your own (unlisted)** — Mozilla signiert nur, das Add-on bleibt
  ungelistet. Du bekommst eine `.xpi`-Datei, die du selbst weitergeben kannst
  und die in jedem Firefox installierbar ist. Das ist der schnellste Weg,
  wenn du das Add-on nur selbst oder im Freundeskreis nutzen willst.

**4. Angaben ausfüllen (nur bei „gelistet")**

* Beschreibung, Kategorie („Productivity") und mindestens ein Screenshot des
  Popups.
* Datenschutzerklärung: Hier passt der Hinweis, dass die Erweiterung keine
  Daten erhebt oder überträgt und alles lokal im Browser verarbeitet.
* Ein Link zum Quellcode (dieses Repository) beschleunigt die Prüfung.

**5. Prüfung**

Da dieses Projekt **kein Build-System und keinen minifizierten Code** enthält,
musst du keinen separaten Quellcode einreichen — Mozilla kann die hochgeladenen
Dateien direkt lesen. Signierte, ungelistete Add-ons sind meist nach wenigen
Minuten fertig; die redaktionelle Prüfung gelisteter Add-ons dauert in der
Regel einige Tage.

**Alternative Kommandozeile:** Mit Mozillas Werkzeug `web-ext` geht Bauen und
Signieren in einem Schritt. API-Schlüssel gibt es unter
<https://addons.mozilla.org/developers/addon/api/key/>:

```bash
npm install --global web-ext
web-ext lint                          # prüft auf typische Fehler
web-ext sign --channel=unlisted \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET"      # erzeugt eine signierte .xpi
```

`web-ext lint` vor jedem Upload auszuführen, spart erfahrungsgemäß die meisten
Ablehnungen.

## Lizenz

MIT
