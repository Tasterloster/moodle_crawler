#!/usr/bin/env python3
"""Minimaler Fake-Moodle-Server für den End-to-End-Test des Scrapers.

Bildet das DOM von Moodle 4.x nach: Kursseite mit Abschnitten, Aktivitäten
vom Typ resource/page/folder/book/url/forum/assign/quiz sowie pluginfile.php
für die eigentlichen Dateien.
"""
import json
import struct
import sys
import zlib
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

COURSE_NAME = "Einführung in die Informatik"


def png(width, height, rgb):
    """Erzeugt ein gültiges PNG, damit sich die Bilder byteweise unterscheiden."""
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def pdf(title):
    return ("%PDF-1.4\n% Fake-PDF für Tests: " + title + "\n%%EOF\n").encode("utf-8")


FILES = {
    "banner.png": ("image/png", png(8, 4, (200, 30, 30))),
    "diagramm.png": ("image/png", png(6, 6, (30, 80, 200))),
    "hinweis.png": ("image/png", png(5, 3, (10, 160, 90))),
    "Skript.pdf": ("application/pdf", pdf("Vorlesungsskript")),
    "Folien.pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    b"PK\x03\x04 fake pptx"),
    "Uebung1.pdf": ("application/pdf", pdf("Uebung 1")),
    "Uebung2.docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                     b"PK\x03\x04 fake docx"),
    "Aufgabenblatt.pdf": ("application/pdf", pdf("Aufgabenblatt")),
    "anhang.txt": ("text/plain", "Anhang mit Ümläuten\n".encode("utf-8")),
    # Ohne Endung im Pfad: Name kommt nur aus Content-Disposition.
    "cheatsheet": ("application/pdf", pdf("Cheatsheet"), "Spickzettel.pdf"),
}


def page(title, body, body_class=""):
    return f"""<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><title>{title} | Moodle</title></head>
<body id="page-mod" class="format-topics {body_class}">
<nav class="navbar"><a href="/">Start</a></nav>
<div class="breadcrumb"><a href="/course/view.php?id=2">{COURSE_NAME}</a></div>
<header id="page-header"><div class="page-context-header"><div class="page-header-headings">
<h1 class="h2">{title}</h1></div></div></header>
<div id="region-main"><div role="main">{body}</div></div>
<footer id="page-footer">Moodle</footer>
</body></html>"""


def activity(cmid, modtype, name, href, description="", extra=""):
    return f"""
<li class="activity activity-wrapper {modtype} modtype_{modtype}" id="module-{cmid}" data-id="{cmid}">
  <div class="activity-item">
    <div class="activity-basis">
      <div class="activityname"><a class="aalink stretched-link" href="{href}">
        <span class="instancename">{name}<span class="accesshide"> {modtype}</span></span></a></div>
    </div>
    <div class="description"><div class="activity-description"><div class="no-overflow">{description}</div></div></div>
    {extra}
  </div>
</li>"""


def label(cmid, html):
    return f"""
<li class="activity activity-wrapper label modtype_label" id="module-{cmid}" data-id="{cmid}">
  <div class="activity-item"><div class="activity-altcontent"><div class="no-overflow">{html}</div></div></div>
</li>"""


def section(number, name, summary, activities):
    return f"""
<li id="section-{number}" class="section course-section main clearfix" data-number="{number}">
  <div class="course-section-header"><h3 class="sectionname">{name}</h3></div>
  <div class="content">
    <div class="summary"><div class="no-overflow">{summary}</div></div>
    <ul class="section img-text">{''.join(activities)}</ul>
  </div>
</li>"""


SECTION_0 = section(0, "Allgemeines",
    '<p>Willkommen im Kurs! Alle Unterlagen liegen hier.</p>'
    '<p>Siehe auch das <a href="https://moodle.org/">Moodle-Handbuch</a> und die '
    '<a href="/course/view.php?id=3">Vorlesung aus dem Vorjahr</a>.</p>'
    '<img src="/pluginfile.php/1/course/section/0/banner.png" alt="Banner">',
    [
        label(10, '<p>Wichtiger <strong>Hinweis</strong>: Die Klausur findet am 12. Februar statt.</p>'
                  '<p>Anmeldung über das <a href="https://example.org/pruefungsamt">Prüfungsamt</a>, '
                  'Fragen an <a href="mailto:pruefungsamt@example.org">pruefungsamt@example.org</a>.</p>'),
        activity(12, "resource", "Vorlesungsskript", "/mod/resource/view.php?id=12",
                 'Das Skript zur gesamten Vorlesung. Ergänzend: '
                 '<a href="https://example.com/zusatzmaterial">Zusatzmaterial</a>. '
                 '<img src="/pluginfile.php/1/mod_resource/intro/0/hinweis.png" alt="Hinweis">'),
        activity(16, "url", "Wikipedia: Informatik", "/mod/url/view.php?id=16",
                 "Externer Hintergrundartikel."),
    ])

SECTION_1 = section(1, "Woche 1: Grundlagen", "<p>Einstieg in die Grundbegriffe.</p>",
    [
        activity(11, "page", "Lernziele Woche 1", "/mod/page/view.php?id=11",
                 "Was Sie nach dieser Woche können sollten."),
        activity(14, "folder", "Übungsblätter", "/mod/folder/view.php?id=14"),
        activity(13, "resource", "Foliensatz 1", "/mod/resource/view.php?id=13"),
        activity(20, "resource", "Spickzettel", "/mod/resource/view.php?id=20"),
    ])

SECTION_2 = section(2, "Woche 2: Vertiefung", "<p>Zweite Woche.</p>",
    [
        activity(15, "book", "Skript als Buch", "/mod/book/view.php?id=15"),
        activity(18, "forum", "Fragen zur Vorlesung", "/mod/forum/view.php?id=18"),
        activity(17, "assign", "Abgabe Übung 1", "/mod/assign/view.php?id=17",
                 "Bitte bis Freitag abgeben."),
        activity(19, "quiz", "Selbsttest", "/mod/quiz/view.php?id=19"),
    ])

COURSE_INDEX = """
<div id="courseindex"><ul>
  <li><a href="/course/view.php?id=2&amp;section=0">Allgemeines</a></li>
  <li><a href="/course/view.php?id=2&amp;section=1">Woche 1: Grundlagen</a></li>
  <li><a href="/course/view.php?id=2&amp;section=2">Woche 2: Vertiefung</a></li>
</ul></div>"""


def course_page(section_param):
    """Ohne section-Parameter: Abschnitte 0 und 1. Mit section=2: nur Abschnitt 2.

    Bildet ein Kursformat mit eigener Seite je Abschnitt nach – so wird
    geprüft, ob der Crawler weitere Abschnittsseiten nachlädt.
    """
    if section_param == "2":
        content = SECTION_2
    else:
        content = SECTION_0 + SECTION_1
    body = f'{COURSE_INDEX}<div class="course-content"><ul class="topics">{content}</ul></div>'
    return f"""<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><title>{COURSE_NAME}</title></head>
<body id="page-course-view-topics" class="path-course path-course-view course-2 format-topics">
<nav class="navbar"><a href="/">Start</a></nav>
<header id="page-header"><div class="page-context-header"><div class="page-header-headings">
<h1 class="h2">{COURSE_NAME}</h1></div></div></header>
<div id="region-main"><div role="main">{body}</div></div>
</body></html>"""


PAGES = {
    ("/mod/page/view.php", "11"): lambda: page("Lernziele Woche 1", """
<div class="box py-3 generalbox">
  <div class="no-overflow">
    <h2>Lernziele</h2>
    <p>Nach dieser Woche kennen Sie die <em>Grundbegriffe</em> der Informatik.</p>
    <ul><li>Algorithmusbegriff</li><li>Datenstrukturen<ul><li>Listen</li></ul></li></ul>
    <table><thead><tr><th>Woche</th><th>Thema</th></tr></thead>
      <tbody><tr><td>1</td><td>Grundlagen</td></tr></tbody></table>
    <blockquote><p>Lesen Sie Kapitel 1.</p></blockquote>
    <p><img src="/pluginfile.php/1/mod_page/content/1/diagramm.png" alt="Diagramm"></p>
    <p><a href="/pluginfile.php/1/mod_page/content/1/anhang.txt">Anhang herunterladen</a></p>
    <p><a href="/mod/page/view.php?id=11">Interner Link</a></p>
  </div>
</div>"""),

    ("/mod/resource/view.php", "13"): lambda: page("Foliensatz 1", """
<div class="box generalbox">
  <div class="resourceworkaround">
    <a href="/pluginfile.php/1/mod_resource/content/1/Folien.pptx">Folien anzeigen</a>
  </div>
</div>"""),

    ("/mod/folder/view.php", "14"): lambda: page("Übungsblätter", """
<div class="box generalbox foldertree">
  <ul><li><a href="/pluginfile.php/1/mod_folder/content/0/Uebung1.pdf">Uebung1.pdf</a></li>
      <li><a href="/pluginfile.php/1/mod_folder/content/0/Uebung2.docx">Uebung2.docx</a></li></ul>
</div>"""),

    ("/mod/url/view.php", "16"): lambda: page("Wikipedia: Informatik", """
<div class="box generalbox urlworkaround">
  <a href="https://de.wikipedia.org/wiki/Informatik">https://de.wikipedia.org/wiki/Informatik</a>
</div>"""),

    ("/mod/assign/view.php", "17"): lambda: page("Abgabe Übung 1", """
<div class="box generalbox">
  <div id="intro"><p>Bitte lösen Sie die Aufgaben auf dem Blatt.</p></div>
  <div class="fileuploadsubmission">
    <a href="/pluginfile.php/1/mod_assign/introattachment/0/Aufgabenblatt.pdf">Aufgabenblatt.pdf</a>
  </div>
</div>"""),

    ("/mod/quiz/view.php", "19"): lambda: page("Selbsttest", """
<div class="box generalbox"><p>Dieser Test besteht aus 10 Fragen.</p></div>"""),

    ("/mod/forum/view.php", "18"): lambda: page("Fragen zur Vorlesung", """
<div class="box generalbox">
  <table><tbody>
    <tr><td><a href="/mod/forum/discuss.php?d=1">Frage zur Klausur</a></td></tr>
    <tr><td><a href="/mod/forum/discuss.php?d=2">Tippfehler im Skript</a></td></tr>
  </tbody></table>
</div>"""),
}

BOOK_CHAPTERS = {
    "1": ("Kapitel 1: Einleitung", "<p>Die Informatik beschäftigt sich mit Information.</p>"),
    "2": ("Kapitel 2: Algorithmen", "<p>Ein Algorithmus ist eine endliche Folge von Schritten.</p>"),
}

DISCUSSIONS = {
    "1": ("Frage zur Klausur", "<div class='forumpost'><p>Ist die Klausur Open Book?</p></div>"
                               "<div class='forumpost'><p>Nein, geschlossene Bücher.</p></div>"),
    "2": ("Tippfehler im Skript", "<div class='forumpost'><p>Auf Seite 12 fehlt ein Wort.</p></div>"),
}

PLUGINFILE_MAP = {
    "banner.png": "banner.png",
    "diagramm.png": "diagramm.png",
    "hinweis.png": "hinweis.png",
    "Skript.pdf": "Skript.pdf",
    "Folien.pptx": "Folien.pptx",
    "Uebung1.pdf": "Uebung1.pdf",
    "Uebung2.docx": "Uebung2.docx",
    "Aufgabenblatt.pdf": "Aufgabenblatt.pdf",
    "anhang.txt": "anhang.txt",
    "cheatsheet": "cheatsheet",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_body(self, body, content_type, extra_headers=()):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in extra_headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length)
        with open(sys.argv[2], "wb") as handle:
            handle.write(data)
        self.send_body(json.dumps({"ok": True, "bytes": len(data)}), "application/json")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        ident = (query.get("id") or [None])[0]

        if path == "/course/view.php":
            return self.send_body(course_page((query.get("section") or [None])[0]),
                                  "text/html; charset=utf-8")

        if path == "/mod/resource/view.php" and ident in ("12", "20"):
            target = ("/pluginfile.php/1/mod_resource/content/1/Skript.pdf" if ident == "12"
                      else "/pluginfile.php/1/mod_resource/content/1/cheatsheet")
            self.send_response(303)
            self.send_header("Location", target)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        if path == "/mod/book/view.php":
            chapter = (query.get("chapterid") or ["1"])[0]
            title, text = BOOK_CHAPTERS.get(chapter, BOOK_CHAPTERS["1"])
            toc = "".join(
                f'<li><a href="/mod/book/view.php?id=15&amp;chapterid={cid}">{name}</a></li>'
                for cid, (name, _) in BOOK_CHAPTERS.items())
            return self.send_body(page("Skript als Buch",
                f'<div class="book_toc"><ul>{toc}</ul></div>'
                f'<div class="book_content"><h3>{title}</h3>{text}</div>'),
                "text/html; charset=utf-8")

        if path == "/mod/forum/discuss.php":
            did = (query.get("d") or ["1"])[0]
            title, posts = DISCUSSIONS.get(did, DISCUSSIONS["1"])
            return self.send_body(page(title, posts), "text/html; charset=utf-8")

        if path.startswith("/pluginfile.php/"):
            key = path.rsplit("/", 1)[-1]
            name = PLUGINFILE_MAP.get(key)
            if name:
                entry = FILES[name]
                content_type, data = entry[0], entry[1]
                filename = entry[2] if len(entry) > 2 else name
                return self.send_body(data, content_type,
                                      [("Content-Disposition", f'inline; filename="{filename}"')])

        handler = PAGES.get((path, ident))
        if handler:
            return self.send_body(handler(), "text/html; charset=utf-8")

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return None


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
    server.serve_forever()
