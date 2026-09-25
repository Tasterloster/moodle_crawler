/*
 * Minimaler ZIP-Writer (Deflate via CompressionStream, Fallback: STORE).
 * Unterstützt ZIP64, damit auch Archive > 4 GB / > 65535 Einträge funktionieren.
 * Bewusst ohne externe Abhängigkeit, weil Content-Skripte kein CDN laden dürfen.
 */
(function () {
  if (window.__moodleCrawlerZip) return;

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function deflateRaw(bytes) {
    if (typeof CompressionStream === "undefined" || bytes.length === 0) return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      const out = new Uint8Array(await new Response(stream).arrayBuffer());
      return out.length < bytes.length ? out : null;
    } catch (e) {
      return null; // z.B. wenn "deflate-raw" nicht unterstützt wird
    }
  }

  const UINT32_MAX = 0xffffffff;
  const UINT16_MAX = 0xffff;

  function dosDateTime(date) {
    const y = date.getFullYear();
    if (y < 1980) return { time: 0, date: 33 }; // 1980-01-01
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  function u64(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
    view.setUint32(offset + 4, Math.floor(value / 4294967296), true);
  }

  class ZipWriter {
    constructor() {
      this.chunks = [];
      this.entries = [];
      this.offset = 0;
      this.names = new Set();
    }

    /** Sorgt für einen im Archiv eindeutigen Pfad ("Datei.pdf" -> "Datei (2).pdf"). */
    uniqueName(path) {
      if (!this.names.has(path)) {
        this.names.add(path);
        return path;
      }
      const slash = path.lastIndexOf("/");
      const dir = slash === -1 ? "" : path.slice(0, slash + 1);
      const base = path.slice(slash + 1);
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      for (let i = 2; ; i++) {
        const candidate = `${dir}${stem} (${i})${ext}`;
        if (!this.names.has(candidate)) {
          this.names.add(candidate);
          return candidate;
        }
      }
    }

    /**
     * Reserviert einen Namensstamm, der für alle angegebenen Endungen frei
     * ist – damit "Seite.md" und "Seite.html" zusammengehören.
     */
    uniqueStem(basePath, extensions) {
      const slash = basePath.lastIndexOf("/");
      const dir = slash === -1 ? "" : basePath.slice(0, slash + 1);
      const stem = basePath.slice(slash + 1);
      for (let i = 1; ; i++) {
        const candidate = i === 1 ? `${dir}${stem}` : `${dir}${stem} (${i})`;
        if (extensions.every((ext) => !this.names.has(candidate + ext))) {
          extensions.forEach((ext) => this.names.add(candidate + ext));
          return candidate;
        }
      }
    }

    push(bytes) {
      this.chunks.push(bytes);
      this.offset += bytes.length;
    }

    /**
     * @param {string} path  Pfad im Archiv (mit "/" als Trenner)
     * @param {Uint8Array|ArrayBuffer|string} data
     */
    async add(path, data, { date = new Date() } = {}) {
      let bytes;
      if (typeof data === "string") bytes = new TextEncoder().encode(data);
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else bytes = data;

      const name = new TextEncoder().encode(path);
      const crc = crc32(bytes);
      const deflated = await deflateRaw(bytes);
      const method = deflated ? 8 : 0;
      const payload = deflated || bytes;

      const zip64 = bytes.length > UINT32_MAX || payload.length > UINT32_MAX;
      const { time, date: dosDate } = dosDateTime(date);
      const localOffset = this.offset;

      const extraLen = zip64 ? 20 : 0;
      const header = new Uint8Array(30 + name.length + extraLen);
      const hv = new DataView(header.buffer);
      hv.setUint32(0, 0x04034b50, true);
      hv.setUint16(4, zip64 ? 45 : 20, true); // benötigte Version
      hv.setUint16(6, 0x0800, true); // Bit 11: Dateiname ist UTF-8
      hv.setUint16(8, method, true);
      hv.setUint16(10, time, true);
      hv.setUint16(12, dosDate, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, zip64 ? UINT32_MAX : payload.length, true);
      hv.setUint32(22, zip64 ? UINT32_MAX : bytes.length, true);
      hv.setUint16(26, name.length, true);
      hv.setUint16(28, extraLen, true);
      header.set(name, 30);
      if (zip64) {
        const ev = new DataView(header.buffer, 30 + name.length, 20);
        ev.setUint16(0, 0x0001, true);
        ev.setUint16(2, 16, true);
        u64(ev, 4, bytes.length);
        u64(ev, 12, payload.length);
      }

      this.push(header);
      this.push(payload);

      this.entries.push({
        name, crc, method, time, dosDate,
        size: bytes.length,
        csize: payload.length,
        offset: localOffset,
      });
    }

    /** Schließt das Archiv ab und liefert einen Blob. */
    close() {
      const cdChunks = [];
      let cdSize = 0;

      for (const e of this.entries) {
        const needSizes = e.size > UINT32_MAX || e.csize > UINT32_MAX;
        const needOffset = e.offset > UINT32_MAX;
        const zip64 = needSizes || needOffset;
        const extraLen = zip64 ? 4 + (needSizes ? 16 : 0) + (needOffset ? 8 : 0) : 0;

        const rec = new Uint8Array(46 + e.name.length + extraLen);
        const v = new DataView(rec.buffer);
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, 0x031e, true); // erstellt von: Unix, Version 3.0
        v.setUint16(6, zip64 ? 45 : 20, true);
        v.setUint16(8, 0x0800, true);
        v.setUint16(10, e.method, true);
        v.setUint16(12, e.time, true);
        v.setUint16(14, e.dosDate, true);
        v.setUint32(16, e.crc, true);
        v.setUint32(20, needSizes ? UINT32_MAX : e.csize, true);
        v.setUint32(24, needSizes ? UINT32_MAX : e.size, true);
        v.setUint16(28, e.name.length, true);
        v.setUint16(30, extraLen, true);
        v.setUint32(42, needOffset ? UINT32_MAX : e.offset, true);
        rec.set(e.name, 46);

        if (zip64) {
          const ev = new DataView(rec.buffer, 46 + e.name.length, extraLen);
          ev.setUint16(0, 0x0001, true);
          ev.setUint16(2, extraLen - 4, true);
          let p = 4;
          if (needSizes) {
            u64(ev, p, e.size); p += 8;
            u64(ev, p, e.csize); p += 8;
          }
          if (needOffset) u64(ev, p, e.offset);
        }

        cdChunks.push(rec);
        cdSize += rec.length;
      }

      const cdOffset = this.offset;
      for (const c of cdChunks) this.push(c);

      const count = this.entries.length;
      const needZip64End = count > UINT16_MAX || cdSize > UINT32_MAX || cdOffset > UINT32_MAX;

      if (needZip64End) {
        const end64 = new Uint8Array(56);
        const v = new DataView(end64.buffer);
        v.setUint32(0, 0x06064b50, true);
        u64(v, 4, 44); // Größe dieses Records - 12
        v.setUint16(12, 0x031e, true);
        v.setUint16(14, 45, true);
        v.setUint32(16, 0, true);
        v.setUint32(20, 0, true);
        u64(v, 24, count);
        u64(v, 32, count);
        u64(v, 40, cdSize);
        u64(v, 48, cdOffset);

        const loc = new Uint8Array(20);
        const lv = new DataView(loc.buffer);
        lv.setUint32(0, 0x07064b50, true);
        lv.setUint32(4, 0, true);
        u64(lv, 8, this.offset);
        lv.setUint32(16, 1, true);

        this.push(end64);
        this.push(loc);
      }

      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, Math.min(count, UINT16_MAX), true);
      ev.setUint16(10, Math.min(count, UINT16_MAX), true);
      ev.setUint32(12, Math.min(cdSize, UINT32_MAX), true);
      ev.setUint32(16, Math.min(cdOffset, UINT32_MAX), true);
      this.push(end);

      const blob = new Blob(this.chunks, { type: "application/zip" });
      this.chunks = [];
      return blob;
    }
  }

  window.__moodleCrawlerZip = { ZipWriter, crc32 };
})();
