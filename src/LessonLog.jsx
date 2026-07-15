import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { supabase } from "./supabase";

/* ============================================================
   LESSON LOG — song & lesson tracker module for FretLab
   Local-first, same philosophy as FretLab sync and Gear Vault.
   - Songs: title/artist/status (learning → working → repertoire),
     tuning, key, notes.
   - Lessons: dated timeline entries with notes, techniques,
     linked songs, and whiteboard photos.
   - Whiteboard photos are compressed at 1280px (legible) with a
     small 240px thumb for the timeline; full images live in the
     lesson-images Storage bucket and load on demand.
   Status jewel: grey local · amber saving · green synced · red error.
   ============================================================ */

const LS_DATA = "fretlab-lessons";
const lsThumbKey = (pid) => `fretlab-lesson-thumb-${pid}`;
const lsFullKey = (pid) => `fretlab-lesson-full-${pid}`;
const lsDocKey = (did) => `fretlab-lesson-doc-${did}`;
const MAX_DOC_BYTES = 8 * 1024 * 1024;

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function normalizeUrl(u) {
  const s = (u || "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : "https://" + s;
}
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const todayStr = () => new Date().toISOString().slice(0, 10);

const STATUSES = [
  { id: "wishlist", label: "Want to learn", color: "#8E44AD" },
  { id: "learning", label: "Learning", color: "#D9A63B" },
  { id: "working", label: "Working on it", color: "#2E86C1" },
  { id: "repertoire", label: "Repertoire", color: "#3FA34D" },
];
const statusById = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

/* ---------- local storage (quota-safe) ---------- */
function readLocal() {
  try {
    const raw = localStorage.getItem(LS_DATA);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* unavailable */ }
  return null;
}
function writeLocal(songs, lessons) {
  try { localStorage.setItem(LS_DATA, JSON.stringify({ songs, lessons })); }
  catch (e) { console.warn("Local save failed", e); }
}
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* quota — cloud copy remains */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* fine */ } }

/* ---------- image handling ---------- */
function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
function scaleToDataUrl(img, maxDim, quality) {
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    const s = maxDim / Math.max(width, height);
    width = Math.round(width * s);
    height = Math.round(height * s);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}
/* Whiteboards need legibility: full at 1280px q0.8, thumb at 240px. */
function processPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const img = await loadImageEl(e.target.result);
        resolve({
          full: scaleToDataUrl(img, 1280, 0.8),
          thumb: scaleToDataUrl(img, 240, 0.7),
        });
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(",");
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/* ---------- cloud helpers ---------- */
const photoPath = (userId, pid) => `${userId}/${pid}.jpg`;
const docPath = (userId, did) => `${userId}/${did}`;

async function cloudUploadDoc(userId, did, dataUrl, mime) {
  const { error } = await supabase.storage.from("lesson-images")
    .upload(docPath(userId, did), dataUrlToBlob(dataUrl), { upsert: true, contentType: mime || "application/octet-stream" });
  if (error) throw error;
}
async function cloudDownloadDoc(userId, did) {
  const { data, error } = await supabase.storage.from("lesson-images").download(docPath(userId, did));
  if (error || !data) return null;
  return blobToDataUrl(data);
}

async function cloudUpsertSong(userId, s) {
  const { error } = await supabase.from("lesson_songs").upsert({
    id: s.id, user_id: userId, title: s.title, artist: s.artist, status: s.status,
    tuning: s.tuning, song_key: s.key, notes: s.notes,
    photo_ids: s.photoIds || [], links: s.links || [], docs: s.docs || [],
    updated_at: s.updatedAt,
  });
  if (error) throw error;
}
async function cloudUpsertLesson(userId, l) {
  const { error } = await supabase.from("lessons").upsert({
    id: l.id, user_id: userId, lesson_date: l.date, notes: l.notes,
    techniques: l.techniques, song_ids: l.songIds, photo_ids: l.photoIds,
    links: l.links || [], docs: l.docs || [],
    updated_at: l.updatedAt,
  });
  if (error) throw error;
}
async function cloudDeleteSong(userId, s) {
  const { error } = await supabase.from("lesson_songs").delete().eq("id", s.id);
  if (error) throw error;
  const paths = [
    ...(s.photoIds || []).map((p) => photoPath(userId, p)),
    ...(s.docs || []).map((d) => docPath(userId, d.id)),
  ];
  if (paths.length) {
    await supabase.storage.from("lesson-images").remove(paths);
  }
}
async function cloudDeleteLesson(userId, l) {
  const { error } = await supabase.from("lessons").delete().eq("id", l.id);
  if (error) throw error;
  const paths = [
    ...(l.photoIds || []).map((p) => photoPath(userId, p)),
    ...(l.docs || []).map((d) => docPath(userId, d.id)),
  ];
  if (paths.length) {
    await supabase.storage.from("lesson-images").remove(paths);
  }
}
async function cloudUploadPhoto(userId, pid, dataUrl) {
  const { error } = await supabase.storage.from("lesson-images")
    .upload(photoPath(userId, pid), dataUrlToBlob(dataUrl), { upsert: true, contentType: "image/jpeg" });
  if (error) throw error;
}
async function cloudDownloadPhoto(userId, pid) {
  const { data, error } = await supabase.storage.from("lesson-images").download(photoPath(userId, pid));
  if (error || !data) return null;
  return blobToDataUrl(data);
}

/* ---------- styles ---------- */
const S = {
  wrap: { color: "#E8DFC8", fontFamily: "'Helvetica Neue', Arial, sans-serif", paddingBottom: 50 },
  bar: {
    display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center",
    padding: "18px 20px 0", maxWidth: 1080, margin: "0 auto",
  },
  heading: {
    fontFamily: "'Arial Narrow', Impact, sans-serif", fontSize: 20, fontWeight: 700,
    letterSpacing: "0.2em", textTransform: "uppercase", margin: 0, display: "flex",
    alignItems: "center", gap: 10,
  },
  jewel: (state) => {
    const map = { local: "#6E6250", saving: "#D9A63B", synced: "#3FA34D", error: "#E03A2F" };
    const c = map[state] || map.local;
    return {
      width: 12, height: 12, borderRadius: "50%", background: c, flexShrink: 0,
      boxShadow: state !== "local" ? `0 0 8px 1px ${c}99` : "inset 0 1px 2px rgba(0,0,0,0.6)",
      transition: "background 0.3s, box-shadow 0.3s",
    };
  },
  jewelLabel: { fontSize: 9, letterSpacing: "0.18em", color: "#7A6E58", textTransform: "uppercase" },
  viewToggle: (active) => ({
    padding: "9px 14px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
    letterSpacing: "0.1em", textTransform: "uppercase",
    border: active ? "1px solid #D4A73B" : "1px solid #4A3F32",
    background: active ? "#3A3125" : "#2B2622",
    color: active ? "#E8D8A8" : "#8A7E66",
  }),
  btn: (primary) => ({
    padding: "9px 14px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
    letterSpacing: "0.1em", textTransform: "uppercase",
    border: primary ? "1px solid #D4A73B" : "1px solid #4A3F32",
    background: primary ? "linear-gradient(180deg, #D9AE45, #B8902E)" : "#2B2622",
    color: primary ? "#211B10" : "#CDBFA5",
  }),
  chipRow: { maxWidth: 1080, margin: "14px auto 0", padding: "0 20px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  search: {
    flex: "1 1 200px", minWidth: 160, padding: "9px 13px", background: "#26211E",
    border: "1px solid #4A3F32", borderRadius: 6, color: "#E8DFC8", fontSize: 14, outline: "none",
  },
  chip: (active, color) => ({
    display: "flex", alignItems: "center", gap: 7, padding: "6px 13px", borderRadius: 20,
    cursor: "pointer", fontSize: 12, userSelect: "none",
    border: active ? `1px solid ${color}` : "1px solid #3B342C",
    background: active ? "#2E2823" : "#221E1A", color: active ? "#F0E8D2" : "#9C8F76",
  }),
  led: (color, on) => ({
    width: 9, height: 9, borderRadius: "50%", background: on ? color : "#3B342C",
    boxShadow: on ? `0 0 7px 1px ${color}88` : "inset 0 1px 1px rgba(0,0,0,0.6)",
  }),
  /* songs */
  grid: {
    maxWidth: 1080, margin: "18px auto 0", padding: "0 20px",
    display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 14,
  },
  listWrap: { maxWidth: 1080, margin: "16px auto 0", padding: "0 20px" },
  listRow: {
    display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
    padding: "9px 14px", marginBottom: 6,
    background: "#241F1C", border: "1px solid #3B342C", borderRadius: 8,
  },
  songCard: {
    background: "#262120", border: "1px solid #3B342C", borderRadius: 8,
    padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6,
    boxShadow: "0 3px 10px rgba(0,0,0,0.35)",
  },
  songTitle: { fontSize: 15, fontWeight: 700, color: "#F0E8D2", margin: 0 },
  meta: { fontSize: 12, color: "#9C8F76" },
  statusRow: { display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" },
  statusPill: (active, color) => ({
    padding: "4px 10px", borderRadius: 12, cursor: "pointer", fontSize: 10, fontWeight: 700,
    letterSpacing: "0.08em", textTransform: "uppercase",
    border: active ? `1px solid ${color}` : "1px solid #3B342C",
    background: active ? color + "22" : "transparent",
    color: active ? "#F0E8D2" : "#6E6250",
  }),
  cardActions: { display: "flex", gap: 8, marginTop: 10 },
  smallBtn: (danger) => ({
    flex: 1, padding: "6px 0", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
    textTransform: "uppercase", borderRadius: 5, cursor: "pointer",
    border: danger ? "1px solid #6E332C" : "1px solid #4A3F32",
    background: "transparent", color: danger ? "#D8776C" : "#CDBFA5",
  }),
  /* lessons timeline */
  timeline: { maxWidth: 780, margin: "18px auto 0", padding: "0 20px" },
  lessonCard: {
    background: "#262120", border: "1px solid #3B342C", borderRadius: 8,
    padding: "16px 18px", marginBottom: 14, boxShadow: "0 3px 10px rgba(0,0,0,0.35)",
  },
  lessonDate: {
    fontFamily: "'Arial Narrow', Impact, sans-serif", fontSize: 16, fontWeight: 700,
    letterSpacing: "0.12em", color: "#D4A73B", textTransform: "uppercase",
  },
  lessonNotes: { fontSize: 13, color: "#CDBFA5", lineHeight: 1.6, marginTop: 8, whiteSpace: "pre-wrap" },
  techChip: {
    display: "inline-block", padding: "3px 10px", borderRadius: 12, fontSize: 11,
    background: "#33291C", border: "1px solid #4A3F32", color: "#D9C58A", marginRight: 6, marginTop: 6,
  },
  songChip: (color) => ({
    display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 12,
    fontSize: 11, background: "#221E1A", border: "1px solid #3B342C", color: "#CDBFA5",
    marginRight: 6, marginTop: 6,
  }),
  photoRow: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 },
  photoThumb: {
    width: 88, height: 66, objectFit: "cover", borderRadius: 6, cursor: "pointer",
    border: "1px solid #4A3F32", background: "#1B1715",
  },
  photoPlaceholder: {
    width: 88, height: 66, borderRadius: 6, cursor: "pointer", border: "1px dashed #4A3F32",
    background: "#1B1715", display: "flex", alignItems: "center", justifyContent: "center",
    color: "#7A6E58", fontSize: 11, textAlign: "center", lineHeight: 1.3,
  },
  /* lightbox */
  lightbox: {
    position: "fixed", inset: 0, background: "rgba(8,7,6,0.94)", zIndex: 80,
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    padding: 20,
  },
  lightboxImg: {
    maxWidth: "96vw", maxHeight: "84vh", objectFit: "contain", borderRadius: 6,
    boxShadow: "0 8px 50px rgba(0,0,0,0.8)",
  },
  lightboxBar: { display: "flex", gap: 12, marginTop: 14, alignItems: "center" },
  lightboxBtn: {
    padding: "8px 18px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700,
    letterSpacing: "0.1em", textTransform: "uppercase", border: "1px solid #4A3F32",
    background: "#2B2622", color: "#CDBFA5",
  },
  /* modals */
  overlay: {
    position: "fixed", inset: 0, background: "rgba(12,10,9,0.78)", display: "flex",
    alignItems: "flex-start", justifyContent: "center", overflowY: "auto", zIndex: 50, padding: "40px 16px",
  },
  modal: {
    background: "#2A2522", border: "1px solid #4A3F32", borderRadius: 10, width: "100%",
    maxWidth: 540, padding: 24, boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
  },
  modalTitle: {
    fontFamily: "'Arial Narrow', Impact, sans-serif", fontSize: 17, fontWeight: 700,
    letterSpacing: "0.18em", textTransform: "uppercase", color: "#E8DFC8",
    margin: "0 0 18px", borderBottom: "1px solid #4A3F32", paddingBottom: 12,
  },
  label: {
    display: "block", fontSize: 10, fontWeight: 700, letterSpacing: "0.16em",
    textTransform: "uppercase", color: "#9C8F76", marginBottom: 5, marginTop: 14,
  },
  input: {
    width: "100%", boxSizing: "border-box", padding: "9px 12px", background: "#1F1B18",
    border: "1px solid #4A3F32", borderRadius: 6, color: "#E8DFC8", fontSize: 14, outline: "none",
  },
  empty: {
    maxWidth: 1080, margin: "50px auto", padding: "0 20px", textAlign: "center",
    color: "#7A6E58", fontSize: 14, lineHeight: 1.7,
  },
};

function formatLessonDate(d) {
  try {
    const dt = new Date(d + "T12:00:00");
    return dt.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  } catch (e) { return d; }
}
function parseTechniques(t) {
  return (t || "").split(",").map((x) => x.trim()).filter(Boolean);
}

/* ---------- song form modal ---------- */
function SongModal({ song, thumbs, onSave, onCancel }) {
  const [title, setTitle] = useState(song?.title || "");
  const [artist, setArtist] = useState(song?.artist || "");
  const [status, setStatus] = useState(song?.status || "learning");
  const [tuning, setTuning] = useState(song?.tuning || "");
  const [key, setKey] = useState(song?.key || "");
  const [notes, setNotes] = useState(song?.notes || "");
  const [photoIds, setPhotoIds] = useState(song?.photoIds || []);
  const [newPhotos, setNewPhotos] = useState({});
  const [removedPhotos, setRemovedPhotos] = useState([]);
  const [links, setLinks] = useState(song?.links || []);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [docs, setDocs] = useState(song?.docs || []);
  const [newDocs, setNewDocs] = useState({});
  const [removedDocs, setRemovedDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const docRef = useRef(null);

  const addLink = () => {
    const url = normalizeUrl(linkUrl);
    if (!url) return;
    setLinks([...links, { id: uid(), label: linkLabel.trim() || url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40), url }]);
    setLinkLabel("");
    setLinkUrl("");
  };
  const removeLink = (id) => setLinks(links.filter((l) => l.id !== id));

  const handleDocs = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    setBusy(true);
    const added = {};
    const metas = [];
    for (const f of files) {
      if (f.size > MAX_DOC_BYTES) {
        window.alert(`"${f.name}" is over 8 MB — too large to attach. Link to it instead.`);
        continue;
      }
      try {
        const did = uid();
        added[did] = { dataUrl: await fileToDataUrl(f), name: f.name, mime: f.type || "application/octet-stream" };
        metas.push({ id: did, name: f.name, mime: f.type || "application/octet-stream" });
      } catch (err) { console.error("Doc failed", err); }
    }
    setNewDocs((p) => ({ ...p, ...added }));
    setDocs((p) => [...p, ...metas]);
    setBusy(false);
  };

  const removeDoc = (did) => {
    setDocs(docs.filter((d) => d.id !== did));
    if (newDocs[did]) {
      setNewDocs((p) => { const q = { ...p }; delete q[did]; return q; });
    } else {
      setRemovedDocs((r) => [...r, did]);
    }
  };

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    setBusy(true);
    const added = {};
    const ids = [];
    for (const f of files) {
      try {
        const pid = uid();
        added[pid] = await processPhoto(f);
        ids.push(pid);
      } catch (err) { console.error("Photo failed", err); }
    }
    setNewPhotos((p) => ({ ...p, ...added }));
    setPhotoIds((p) => [...p, ...ids]);
    setBusy(false);
  };

  const removePhoto = (pid) => {
    setPhotoIds(photoIds.filter((x) => x !== pid));
    if (newPhotos[pid]) {
      setNewPhotos((p) => { const q = { ...p }; delete q[pid]; return q; });
    } else {
      setRemovedPhotos((r) => [...r, pid]);
    }
  };

  const submit = () => {
    if (!title.trim()) return;
    onSave({
      id: song?.id || uid(),
      title: title.trim(), artist: artist.trim(), status,
      tuning: tuning.trim(), key: key.trim(), notes: notes.trim(),
      photoIds, links, docs,
      updatedAt: new Date().toISOString(),
    }, newPhotos, removedPhotos, newDocs, removedDocs);
  };

  return (
    <div style={S.overlay} onClick={onCancel}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={S.modalTitle}>{song ? "Edit song" : "Add song"}</h2>

        <label style={S.label}>Title *</label>
        <input style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. I Ran" autoFocus />

        <label style={S.label}>Artist</label>
        <input style={S.input} value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="e.g. A Flock of Seagulls" />

        <label style={S.label}>Status</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STATUSES.map((s) => (
            <span key={s.id} style={S.statusPill(status === s.id, s.color)} onClick={() => setStatus(s.id)}>
              {s.label}
            </span>
          ))}
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Tuning</label>
            <input style={S.input} value={tuning} onChange={(e) => setTuning(e.target.value)} placeholder="e.g. Standard, Drop D" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Key</label>
            <input style={S.input} value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. A minor" />
          </div>
        </div>

        <label style={S.label}>Notes</label>
        <textarea style={{ ...S.input, minHeight: 70, resize: "vertical", fontFamily: "inherit" }}
          value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Tricky sections, tempo goals, chart links…" />

        <label style={S.label}>Photos (charts, tabs, whiteboard)</label>
        {photoIds.length > 0 && (
          <div style={{ ...S.photoRow, marginTop: 4, marginBottom: 8 }}>
            {photoIds.map((pid) => {
              const src = newPhotos[pid]?.thumb || thumbs[pid];
              return (
                <div key={pid} style={{ position: "relative" }}>
                  {src
                    ? <img src={src} alt="song reference" style={S.photoThumb} />
                    : <div style={S.photoPlaceholder}>photo<br />(in cloud)</div>}
                  <span
                    onClick={() => removePhoto(pid)}
                    style={{
                      position: "absolute", top: -6, right: -6, width: 20, height: 20,
                      borderRadius: "50%", background: "#5A2622", color: "#F0C9C2",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, fontWeight: 700, cursor: "pointer", border: "1px solid #6E332C",
                    }}>×</span>
                </div>
              );
            })}
          </div>
        )}
        <button style={S.btn(false)} onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "Processing…" : "+ Add photos"}
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFiles} />

        <label style={S.label}>Links (lessons, tabs, videos)</label>
        {links.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {links.map((l) => (
              <span key={l.id} style={{ ...S.chip(false, "#2E86C1"), cursor: "default", padding: "5px 10px" }}>
                🔗 {l.label}
                <span style={{ cursor: "pointer", color: "#D8776C", marginLeft: 4, fontWeight: 700 }} onClick={() => removeLink(l.id)}>×</span>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...S.input, flex: 1 }} placeholder="Label (optional)" value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} />
          <input style={{ ...S.input, flex: 2 }} placeholder="URL" value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addLink()} />
          <button style={S.btn(false)} onClick={addLink} disabled={!linkUrl.trim()}>Add</button>
        </div>

        <label style={S.label}>Documents (PDF tabs, charts — up to 8 MB)</label>
        {docs.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {docs.map((d) => (
              <span key={d.id} style={{ ...S.chip(false, "#D4A73B"), cursor: "default", padding: "5px 10px" }}>
                📄 {d.name}
                <span style={{ cursor: "pointer", color: "#D8776C", marginLeft: 4, fontWeight: 700 }} onClick={() => removeDoc(d.id)}>×</span>
              </span>
            ))}
          </div>
        )}
        <button style={S.btn(false)} onClick={() => docRef.current?.click()} disabled={busy}>
          {busy ? "Processing…" : "+ Attach documents"}
        </button>
        <input ref={docRef} type="file" accept=".pdf,.doc,.docx,.txt,.gp,.gpx,.gp5,.ptb,.musicxml,.xml" multiple style={{ display: "none" }} onChange={handleDocs} />

        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <button style={{ ...S.btn(true), flex: 1, opacity: title.trim() ? 1 : 0.5 }} onClick={submit} disabled={!title.trim()}>
            {song ? "Save changes" : "Add song"}
          </button>
          <button style={{ ...S.btn(false), flex: 1 }} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- lesson form modal ---------- */
function LessonModal({ lesson, songs, thumbs, onSave, onCancel }) {
  const [date, setDate] = useState(lesson?.date || todayStr());
  const [notes, setNotes] = useState(lesson?.notes || "");
  const [techniques, setTechniques] = useState(lesson?.techniques || "");
  const [songIds, setSongIds] = useState(lesson?.songIds || []);
  const [photoIds, setPhotoIds] = useState(lesson?.photoIds || []);
  const [newPhotos, setNewPhotos] = useState({}); // pid -> {full, thumb}
  const [removedPhotos, setRemovedPhotos] = useState([]);
  const [links, setLinks] = useState(lesson?.links || []);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [docs, setDocs] = useState(lesson?.docs || []);
  const [newDocs, setNewDocs] = useState({});
  const [removedDocs, setRemovedDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const docRef = useRef(null);

  const addLink = () => {
    const url = normalizeUrl(linkUrl);
    if (!url) return;
    setLinks([...links, { id: uid(), label: linkLabel.trim() || url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40), url }]);
    setLinkLabel("");
    setLinkUrl("");
  };
  const removeLink = (id) => setLinks(links.filter((l) => l.id !== id));

  const handleDocs = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    setBusy(true);
    const added = {};
    const metas = [];
    for (const f of files) {
      if (f.size > MAX_DOC_BYTES) {
        window.alert(`"${f.name}" is over 8 MB — too large to attach. Link to it instead.`);
        continue;
      }
      try {
        const did = uid();
        added[did] = { dataUrl: await fileToDataUrl(f), name: f.name, mime: f.type || "application/octet-stream" };
        metas.push({ id: did, name: f.name, mime: f.type || "application/octet-stream" });
      } catch (err) { console.error("Doc failed", err); }
    }
    setNewDocs((p) => ({ ...p, ...added }));
    setDocs((p) => [...p, ...metas]);
    setBusy(false);
  };

  const removeDoc = (did) => {
    setDocs(docs.filter((d) => d.id !== did));
    if (newDocs[did]) {
      setNewDocs((p) => { const q = { ...p }; delete q[did]; return q; });
    } else {
      setRemovedDocs((r) => [...r, did]);
    }
  };

  const toggleSong = (id) =>
    setSongIds(songIds.includes(id) ? songIds.filter((x) => x !== id) : [...songIds, id]);

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    setBusy(true);
    const added = {};
    const ids = [];
    for (const f of files) {
      try {
        const pid = uid();
        added[pid] = await processPhoto(f);
        ids.push(pid);
      } catch (err) { console.error("Photo failed", err); }
    }
    setNewPhotos((p) => ({ ...p, ...added }));
    setPhotoIds((p) => [...p, ...ids]);
    setBusy(false);
  };

  const removePhoto = (pid) => {
    setPhotoIds(photoIds.filter((x) => x !== pid));
    if (newPhotos[pid]) {
      setNewPhotos((p) => { const q = { ...p }; delete q[pid]; return q; });
    } else {
      setRemovedPhotos((r) => [...r, pid]);
    }
  };

  const submit = () => {
    onSave({
      id: lesson?.id || uid(),
      date, notes: notes.trim(), techniques: techniques.trim(),
      songIds, photoIds, links, docs,
      updatedAt: new Date().toISOString(),
    }, newPhotos, removedPhotos, newDocs, removedDocs);
  };

  return (
    <div style={S.overlay} onClick={onCancel}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={S.modalTitle}>{lesson ? "Edit lesson" : "Log lesson"}</h2>

        <label style={S.label}>Date</label>
        <input style={S.input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />

        {songs.length > 0 && (
          <>
            <label style={S.label}>Songs covered</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {songs.map((s) => {
                const active = songIds.includes(s.id);
                const st = statusById[s.status] || STATUSES[0];
                return (
                  <span key={s.id} style={S.chip(active, st.color)} onClick={() => toggleSong(s.id)}>
                    <span style={S.led(st.color, active)} /> {s.title}
                  </span>
                );
              })}
            </div>
          </>
        )}

        <label style={S.label}>Techniques (comma-separated)</label>
        <input style={S.input} value={techniques} onChange={(e) => setTechniques(e.target.value)}
          placeholder="e.g. hybrid picking, CAGED shapes, palm muting" />

        <label style={S.label}>Notes</label>
        <textarea style={{ ...S.input, minHeight: 90, resize: "vertical", fontFamily: "inherit" }}
          value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="What was covered, homework, what to practice this week…" />

        <label style={S.label}>Whiteboard photos</label>
        {photoIds.length > 0 && (
          <div style={{ ...S.photoRow, marginTop: 4, marginBottom: 8 }}>
            {photoIds.map((pid) => {
              const src = newPhotos[pid]?.thumb || thumbs[pid];
              return (
                <div key={pid} style={{ position: "relative" }}>
                  {src
                    ? <img src={src} alt="whiteboard" style={S.photoThumb} />
                    : <div style={S.photoPlaceholder}>photo<br />(in cloud)</div>}
                  <span
                    onClick={() => removePhoto(pid)}
                    style={{
                      position: "absolute", top: -6, right: -6, width: 20, height: 20,
                      borderRadius: "50%", background: "#5A2622", color: "#F0C9C2",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, fontWeight: 700, cursor: "pointer", border: "1px solid #6E332C",
                    }}>×</span>
                </div>
              );
            })}
          </div>
        )}
        <button style={S.btn(false)} onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "Processing…" : "+ Add photos"}
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFiles} />
        <div style={{ fontSize: 11, color: "#7A6E58", marginTop: 6 }}>
          Snap the whiteboard before it gets erased — you can add several at once.
        </div>

        <label style={S.label}>Links (lessons, tabs, videos)</label>
        {links.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {links.map((l) => (
              <span key={l.id} style={{ ...S.chip(false, "#2E86C1"), cursor: "default", padding: "5px 10px" }}>
                🔗 {l.label}
                <span style={{ cursor: "pointer", color: "#D8776C", marginLeft: 4, fontWeight: 700 }} onClick={() => removeLink(l.id)}>×</span>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...S.input, flex: 1 }} placeholder="Label (optional)" value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} />
          <input style={{ ...S.input, flex: 2 }} placeholder="URL" value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addLink()} />
          <button style={S.btn(false)} onClick={addLink} disabled={!linkUrl.trim()}>Add</button>
        </div>

        <label style={S.label}>Documents (PDF tabs, charts — up to 8 MB)</label>
        {docs.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {docs.map((d) => (
              <span key={d.id} style={{ ...S.chip(false, "#D4A73B"), cursor: "default", padding: "5px 10px" }}>
                📄 {d.name}
                <span style={{ cursor: "pointer", color: "#D8776C", marginLeft: 4, fontWeight: 700 }} onClick={() => removeDoc(d.id)}>×</span>
              </span>
            ))}
          </div>
        )}
        <button style={S.btn(false)} onClick={() => docRef.current?.click()} disabled={busy}>
          {busy ? "Processing…" : "+ Attach documents"}
        </button>
        <input ref={docRef} type="file" accept=".pdf,.doc,.docx,.txt,.gp,.gpx,.gp5,.ptb,.musicxml,.xml" multiple style={{ display: "none" }} onChange={handleDocs} />

        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <button style={{ ...S.btn(true), flex: 1 }} onClick={submit}>
            {lesson ? "Save changes" : "Log lesson"}
          </button>
          <button style={{ ...S.btn(false), flex: 1 }} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- main module ---------- */
export default function LessonLog() {
  const [songs, setSongs] = useState([]);
  const [lessons, setLessons] = useState([]);
  const [thumbs, setThumbs] = useState({});   // pid -> thumb dataUrl
  const [fulls, setFulls] = useState({});     // pid -> full dataUrl (in-memory)
  const [userId, setUserId] = useState(null);
  const [sync, setSync] = useState("local");
  const [view, setView] = useState("lessons"); // lessons | songs
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(null);
  const [techFilter, setTechFilter] = useState(null);
  const [layout, setLayout] = useState(() => {
    try { return localStorage.getItem("fretlab-lessons-layout") || "cards"; } catch { return "cards"; }
  });
  const setLayoutMode = (m) => {
    setLayout(m);
    try { localStorage.setItem("fretlab-lessons-layout", m); } catch {}
  };
  const [editingSong, setEditingSong] = useState(null);
  const [editingLesson, setEditingLesson] = useState(null);
  const [lightbox, setLightbox] = useState(null); // {photoIds, index, loading}
  const mergedRef = useRef(false);

  const runCloud = useCallback(async (fn) => {
    if (!supabase || !userId) return;
    setSync("saving");
    try { await fn(); setSync("synced"); }
    catch (e) { console.error("Lesson sync error", e); setSync("error"); }
  }, [userId]);

  /* --- load local immediately --- */
  useEffect(() => {
    const local = readLocal();
    if (local) {
      setSongs(local.songs || []);
      setLessons(local.lessons || []);
      const t = {};
      for (const l of local.lessons || []) {
        for (const pid of l.photoIds || []) {
          const d = lsGet(lsThumbKey(pid));
          if (d) t[pid] = d;
        }
      }
      for (const s of local.songs || []) {
        for (const pid of s.photoIds || []) {
          const d = lsGet(lsThumbKey(pid));
          if (d) t[pid] = d;
        }
      }
      setThumbs(t);
    }
  }, []);

  /* --- watch auth session --- */
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setUserId(data?.session?.user?.id || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUserId(session?.user?.id || null);
      mergedRef.current = false;
    });
    return () => sub?.subscription?.unsubscribe();
  }, []);

  /* --- on sign-in: merge, newest wins per row --- */
  useEffect(() => {
    if (!supabase || !userId || mergedRef.current) return;
    mergedRef.current = true;
    (async () => {
      setSync("saving");
      try {
        const [{ data: cSongs, error: e1 }, { data: cLessons, error: e2 }] = await Promise.all([
          supabase.from("lesson_songs").select("*"),
          supabase.from("lessons").select("*"),
        ]);
        if (e1) throw e1;
        if (e2) throw e2;

        const local = readLocal() || { songs: [], lessons: [] };

        const mergeRows = (localRows, cloudRows, fromCloud) => {
          const byId = Object.fromEntries(localRows.map((r) => [r.id, r]));
          const merged = { ...byId };
          const toUpload = [];
          for (const cr of cloudRows || []) {
            const asLocal = fromCloud(cr);
            const lr = byId[cr.id];
            if (!lr || new Date(cr.updated_at) >= new Date(lr.updatedAt || 0)) merged[cr.id] = asLocal;
          }
          for (const lr of localRows) {
            const cr = (cloudRows || []).find((c) => c.id === lr.id);
            if (!cr || new Date(lr.updatedAt || 0) > new Date(cr.updated_at)) toUpload.push(lr);
          }
          return [Object.values(merged), toUpload];
        };

        const [mSongs, upSongs] = mergeRows(local.songs || [], cSongs, (c) => ({
          id: c.id, title: c.title, artist: c.artist, status: c.status,
          tuning: c.tuning, key: c.song_key, notes: c.notes,
          photoIds: Array.isArray(c.photo_ids) ? c.photo_ids : [],
          links: Array.isArray(c.links) ? c.links : [],
          docs: Array.isArray(c.docs) ? c.docs : [],
          updatedAt: c.updated_at,
        }));
        const [mLessons, upLessons] = mergeRows(local.lessons || [], cLessons, (c) => ({
          id: c.id, date: c.lesson_date, notes: c.notes, techniques: c.techniques,
          songIds: Array.isArray(c.song_ids) ? c.song_ids : [],
          photoIds: Array.isArray(c.photo_ids) ? c.photo_ids : [],
          links: Array.isArray(c.links) ? c.links : [],
          docs: Array.isArray(c.docs) ? c.docs : [],
          updatedAt: c.updated_at,
        }));

        mLessons.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        setSongs(mSongs);
        setLessons(mLessons);
        writeLocal(mSongs, mLessons);

        for (const s of upSongs) {
          await cloudUpsertSong(userId, s);
          for (const pid of s.photoIds || []) {
            const full = lsGet(lsFullKey(pid));
            if (full) await cloudUploadPhoto(userId, pid, full);
          }
          for (const d of s.docs || []) {
            const data = lsGet(lsDocKey(d.id));
            if (data) await cloudUploadDoc(userId, d.id, data, d.mime);
          }
        }
        for (const l of upLessons) {
          await cloudUpsertLesson(userId, l);
          for (const pid of l.photoIds || []) {
            const full = lsGet(lsFullKey(pid));
            if (full) await cloudUploadPhoto(userId, pid, full);
          }
          for (const d of l.docs || []) {
            const data = lsGet(lsDocKey(d.id));
            if (data) await cloudUploadDoc(userId, d.id, data, d.mime);
          }
        }
        setSync("synced");
      } catch (e) {
        console.error("Lesson merge failed", e);
        setSync("error");
      }
    })();
  }, [userId]);

  /* --- songs --- */
  const handleSaveSong = (song, newPhotos, removedPhotos, newDocs, removedDocs) => {
    for (const [pid, imgs] of Object.entries(newPhotos || {})) {
      lsSet(lsThumbKey(pid), imgs.thumb);
      lsSet(lsFullKey(pid), imgs.full);
      setThumbs((t) => ({ ...t, [pid]: imgs.thumb }));
      setFulls((f) => ({ ...f, [pid]: imgs.full }));
    }
    for (const pid of removedPhotos || []) {
      lsDel(lsThumbKey(pid));
      lsDel(lsFullKey(pid));
    }
    for (const [did, doc] of Object.entries(newDocs || {})) {
      lsSet(lsDocKey(did), doc.dataUrl);
    }
    for (const did of removedDocs || []) {
      lsDel(lsDocKey(did));
    }
    const exists = songs.some((s) => s.id === song.id);
    const newSongs = exists ? songs.map((s) => (s.id === song.id ? song : s)) : [song, ...songs];
    setSongs(newSongs);
    writeLocal(newSongs, lessons);
    setEditingSong(null);
    runCloud(async () => {
      await cloudUpsertSong(userId, song);
      for (const [pid, imgs] of Object.entries(newPhotos || {})) {
        await cloudUploadPhoto(userId, pid, imgs.full);
      }
      for (const [did, doc] of Object.entries(newDocs || {})) {
        await cloudUploadDoc(userId, did, doc.dataUrl, doc.mime);
      }
      const removedPaths = [
        ...(removedPhotos || []).map((p) => photoPath(userId, p)),
        ...(removedDocs || []).map((d) => docPath(userId, d)),
      ];
      if (removedPaths.length) {
        await supabase.storage.from("lesson-images").remove(removedPaths);
      }
    });
  };

  const quickStatus = (song, status) => {
    if (song.status === status) return;
    handleSaveSong({ ...song, status, updatedAt: new Date().toISOString() });
  };

  const handleDeleteSong = (song) => {
    const lessonCount = lessons.filter((l) => l.songIds?.includes(song.id)).length;
    const msg = lessonCount
      ? `Remove "${song.title}"? It's linked to ${lessonCount} lesson(s); those entries will keep their notes but lose the song link.`
      : `Remove "${song.title}"?`;
    if (!window.confirm(msg)) return;
    for (const pid of song.photoIds || []) {
      lsDel(lsThumbKey(pid));
      lsDel(lsFullKey(pid));
    }
    const newSongs = songs.filter((s) => s.id !== song.id);
    const newLessons = lessons.map((l) =>
      l.songIds?.includes(song.id) ? { ...l, songIds: l.songIds.filter((x) => x !== song.id) } : l);
    setSongs(newSongs);
    setLessons(newLessons);
    writeLocal(newSongs, newLessons);
    runCloud(async () => {
      await cloudDeleteSong(userId, song);
      for (const l of newLessons) {
        const old = lessons.find((x) => x.id === l.id);
        if (old && old.songIds?.includes(song.id)) await cloudUpsertLesson(userId, l);
      }
    });
  };

  /* --- lessons --- */
  const handleSaveLesson = (lesson, newPhotos, removedPhotos, newDocs, removedDocs) => {
    for (const [pid, imgs] of Object.entries(newPhotos || {})) {
      lsSet(lsThumbKey(pid), imgs.thumb);
      lsSet(lsFullKey(pid), imgs.full);
      setThumbs((t) => ({ ...t, [pid]: imgs.thumb }));
      setFulls((f) => ({ ...f, [pid]: imgs.full }));
    }
    for (const pid of removedPhotos || []) {
      lsDel(lsThumbKey(pid));
      lsDel(lsFullKey(pid));
    }
    for (const [did, doc] of Object.entries(newDocs || {})) {
      lsSet(lsDocKey(did), doc.dataUrl);
    }
    for (const did of removedDocs || []) {
      lsDel(lsDocKey(did));
    }
    const exists = lessons.some((l) => l.id === lesson.id);
    const newLessons = (exists ? lessons.map((l) => (l.id === lesson.id ? lesson : l)) : [lesson, ...lessons])
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    setLessons(newLessons);
    writeLocal(songs, newLessons);
    setEditingLesson(null);

    runCloud(async () => {
      await cloudUpsertLesson(userId, lesson);
      for (const [pid, imgs] of Object.entries(newPhotos || {})) {
        await cloudUploadPhoto(userId, pid, imgs.full);
      }
      for (const [did, doc] of Object.entries(newDocs || {})) {
        await cloudUploadDoc(userId, did, doc.dataUrl, doc.mime);
      }
      const removedPaths = [
        ...(removedPhotos || []).map((p) => photoPath(userId, p)),
        ...(removedDocs || []).map((d) => docPath(userId, d)),
      ];
      if (removedPaths.length) {
        await supabase.storage.from("lesson-images").remove(removedPaths);
      }
    });
  };

  const handleDeleteLesson = (lesson) => {
    if (!window.confirm(`Delete the ${formatLessonDate(lesson.date)} lesson${lesson.photoIds?.length ? " and its photos" : ""}?`)) return;
    for (const pid of lesson.photoIds || []) {
      lsDel(lsThumbKey(pid));
      lsDel(lsFullKey(pid));
    }
    for (const d of lesson.docs || []) {
      lsDel(lsDocKey(d.id));
    }
    const newLessons = lessons.filter((l) => l.id !== lesson.id);
    setLessons(newLessons);
    writeLocal(songs, newLessons);
    runCloud(() => cloudDeleteLesson(userId, lesson));
  };

  /* --- photo viewing --- */
  const getFullPhoto = useCallback(async (pid) => {
    if (fulls[pid]) return fulls[pid];
    let d = lsGet(lsFullKey(pid));
    if (!d && supabase && userId) {
      d = await cloudDownloadPhoto(userId, pid);
      if (d) {
        lsSet(lsFullKey(pid), d);
        /* generate a thumb for the timeline if we didn't have one */
        if (!thumbs[pid]) {
          try {
            const img = await loadImageEl(d);
            const th = scaleToDataUrl(img, 240, 0.7);
            lsSet(lsThumbKey(pid), th);
            setThumbs((t) => ({ ...t, [pid]: th }));
          } catch (e) { /* fine */ }
        }
      }
    }
    if (d) setFulls((f) => ({ ...f, [pid]: d }));
    return d;
  }, [fulls, thumbs, userId]);

  const [busyDoc, setBusyDoc] = useState(null);
  const openDoc = useCallback(async (doc) => {
    setBusyDoc(doc.id);
    try {
      let d = lsGet(lsDocKey(doc.id));
      if (!d && supabase && userId) {
        d = await cloudDownloadDoc(userId, doc.id);
        if (d) lsSet(lsDocKey(doc.id), d);
      }
      if (!d) {
        window.alert("Document unavailable offline — sign in to fetch it from the cloud.");
        return;
      }
      const blob = dataUrlToBlob(d);
      const typed = new Blob([blob], { type: doc.mime || "application/octet-stream" });
      const url = URL.createObjectURL(typed);
      const win = window.open(url, "_blank");
      if (!win) {
        /* popup blocked — fall back to download */
        const a = document.createElement("a");
        a.href = url;
        a.download = doc.name;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } finally {
      setBusyDoc(null);
    }
  }, [userId]);

  const openLightbox = async (photoIds, index) => {
    setLightbox({ photoIds, index, loading: true });
    await getFullPhoto(photoIds[index]);
    setLightbox((lb) => (lb ? { ...lb, loading: false } : lb));
  };
  const lightboxStep = async (dir) => {
    if (!lightbox) return;
    const next = lightbox.index + dir;
    if (next < 0 || next >= lightbox.photoIds.length) return;
    setLightbox({ ...lightbox, index: next, loading: true });
    await getFullPhoto(lightbox.photoIds[next]);
    setLightbox((lb) => (lb ? { ...lb, loading: false } : lb));
  };

  const songById = useMemo(() => Object.fromEntries(songs.map((s) => [s.id, s])), [songs]);

  const visibleSongs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return songs.filter((s) => {
      if (statusFilter && s.status !== statusFilter) return false;
      if (!q) return true;
      return [s.title, s.artist, s.tuning, s.key, s.notes].some((f) => (f || "").toLowerCase().includes(q));
    });
  }, [songs, search, statusFilter]);

  const visibleLessons = useMemo(() => {
    const q = search.trim().toLowerCase();
    return lessons.filter((l) => {
      if (techFilter && !parseTechniques(l.techniques).some((t) => t.toLowerCase() === techFilter)) return false;
      if (!q) return true;
      const songText = (l.songIds || []).map((id) => songById[id]?.title || "").join(" ");
      return [l.notes, l.techniques, l.date, songText].some((f) => (f || "").toLowerCase().includes(q));
    });
  }, [lessons, search, songById, techFilter]);

  const allTechs = useMemo(() => {
    const m = new Map();
    lessons.forEach((l) =>
      parseTechniques(l.techniques).forEach((t) => {
        const k = t.toLowerCase();
        m.set(k, { label: t, count: (m.get(k)?.count || 0) + 1 });
      })
    );
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  }, [lessons]);

  const lessonCountFor = (songId) => lessons.filter((l) => l.songIds?.includes(songId)).length;

  const syncLabel = { local: "local", saving: "saving", synced: "synced", error: "sync error" }[sync];

  return (
    <div style={S.wrap}>
      <div style={S.bar}>
        <h2 style={S.heading}>
          Lesson Log
          <span style={S.jewel(sync)} title={userId ? `Cloud: ${syncLabel}` : "Local only — sign in via the SYNC jewel to back up lessons"} />
          <span style={S.jewelLabel}>{userId ? syncLabel : "local"}</span>
        </h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button style={S.viewToggle(view === "lessons")} onClick={() => setView("lessons")}>Lessons</button>
          <button style={S.viewToggle(view === "songs")} onClick={() => setView("songs")}>Songs</button>
          {view === "lessons"
            ? <button style={S.btn(true)} onClick={() => setEditingLesson("new")}>+ Log lesson</button>
            : <button style={S.btn(true)} onClick={() => setEditingSong("new")}>+ Add song</button>}
        </div>
      </div>

      <div style={S.chipRow}>
        <input style={S.search}
          placeholder={view === "songs" ? "Search title, artist, tuning, key…" : "Search notes, techniques, songs, dates…"}
          value={search} onChange={(e) => setSearch(e.target.value)} />
        {view === "songs" && (
          <>
            <span style={S.chip(statusFilter === null, "#D4A73B")} onClick={() => setStatusFilter(null)}>
              <span style={S.led("#D4A73B", statusFilter === null)} /> All
            </span>
            {STATUSES.map((s) => {
              const active = statusFilter === s.id;
              return (
                <span key={s.id} style={S.chip(active, s.color)} onClick={() => setStatusFilter(active ? null : s.id)}>
                  <span style={S.led(s.color, active)} /> {s.label}
                  <span style={{ color: "#6E6250", fontSize: 11 }}>{songs.filter((x) => x.status === s.id).length}</span>
                </span>
              );
            })}
          </>
        )}
        {view === "lessons" && allTechs.length > 0 && (
          <>
            <span style={S.chip(techFilter === null, "#D4A73B")} onClick={() => setTechFilter(null)}>
              <span style={S.led("#D4A73B", techFilter === null)} /> All
            </span>
            {allTechs.map(([k, t]) => {
              const active = techFilter === k;
              return (
                <span key={k} style={S.chip(active, "#8E44AD")} onClick={() => setTechFilter(active ? null : k)}>
                  <span style={S.led("#8E44AD", active)} /> {t.label}
                  <span style={{ color: "#6E6250", fontSize: 11 }}>{t.count}</span>
                </span>
              );
            })}
          </>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button style={S.viewToggle(layout === "cards")} onClick={() => setLayoutMode("cards")}>
            {view === "songs" ? "⊞ Cards" : "⊞ Timeline"}
          </button>
          <button style={S.viewToggle(layout === "list")} onClick={() => setLayoutMode("list")}>≡ List</button>
        </span>
      </div>

      {/* ---- SONGS VIEW ---- */}
      {view === "songs" && (
        visibleSongs.length === 0 ? (
          <div style={S.empty}>
            {songs.length === 0
              ? <>No songs yet.<br />Hit <strong style={{ color: "#D4A73B" }}>+ Add song</strong> when your teacher hands you the next one.</>
              : "Nothing matches that search or filter."}
          </div>
        ) : layout === "list" ? (
          <div style={S.listWrap}>
            {visibleSongs.map((song) => {
              const st = statusById[song.status] || STATUSES[0];
              const count = lessonCountFor(song.id);
              const nextSt = STATUSES[(STATUSES.findIndex((s) => s.id === st.id) + 1) % STATUSES.length];
              const nAtt = (song.links || []).length + (song.docs || []).length + (song.photoIds || []).length;
              return (
                <div key={song.id} style={S.listRow}>
                  <span style={S.statusPill(true, st.color)} title={`Tap to move to ${nextSt.label}`}
                    onClick={() => quickStatus(song, nextSt.id)}>{st.label}</span>
                  <div style={{ flex: "2 1 160px", minWidth: 140 }}>
                    <div style={{ fontWeight: 700, color: "#F0E8D2", fontSize: 14 }}>{song.title}</div>
                    {song.artist && <div style={{ fontSize: 11, color: "#9C8F76" }}>{song.artist}</div>}
                  </div>
                  <div style={{ flex: "1 1 110px", fontSize: 12, color: "#9C8F76" }}>
                    {[song.tuning, song.key].filter(Boolean).join(" · ")}
                  </div>
                  <div style={{ flex: "1 1 120px", fontSize: 11, color: "#7A6E58" }}>
                    {count > 0 ? `${count} lesson${count !== 1 ? "s" : ""}` : ""}
                    {nAtt > 0 ? `${count > 0 ? " · " : ""}${nAtt} attachment${nAtt !== 1 ? "s" : ""}` : ""}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={S.smallBtn(false)} onClick={() => setEditingSong(song)}>Edit</button>
                    <button style={S.smallBtn(true)} onClick={() => handleDeleteSong(song)}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={S.grid}>
            {visibleSongs.map((song) => {
              const st = statusById[song.status] || STATUSES[0];
              const count = lessonCountFor(song.id);
              return (
                <div key={song.id} style={S.songCard}>
                  <h3 style={S.songTitle}>{song.title}</h3>
                  {song.artist && <div style={S.meta}>{song.artist}</div>}
                  {(song.tuning || song.key) && (
                    <div style={S.meta}>{[song.tuning, song.key].filter(Boolean).join(" · ")}</div>
                  )}
                  <div style={S.statusRow}>
                    {STATUSES.map((s) => (
                      <span key={s.id} style={S.statusPill(song.status === s.id, s.color)} onClick={() => quickStatus(song, s.id)}>
                        {s.label}
                      </span>
                    ))}
                  </div>
                  {count > 0 && <div style={{ ...S.meta, marginTop: 4 }}>{count} lesson{count !== 1 ? "s" : ""}</div>}
                  {song.notes && <div style={{ ...S.meta, fontSize: 11, lineHeight: 1.5 }}>{song.notes}</div>}
                  {((song.links || []).length > 0 || (song.docs || []).length > 0) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 4 }}>
                      {(song.links || []).map((l) => (
                        <a key={l.id} href={l.url} target="_blank" rel="noopener noreferrer"
                          style={{ ...S.chip(false, "#2E86C1"), padding: "4px 10px", textDecoration: "none", color: "#8FBBDB" }}>
                          🔗 {l.label}
                        </a>
                      ))}
                      {(song.docs || []).map((d) => (
                        <span key={d.id} onClick={() => openDoc(d)}
                          style={{ ...S.chip(false, "#D4A73B"), padding: "4px 10px", color: "#D9C58A" }}>
                          📄 {busyDoc === d.id ? "Loading…" : d.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {(song.photoIds || []).length > 0 && (
                    <div style={S.photoRow}>
                      {song.photoIds.map((pid, idx) => (
                        thumbs[pid]
                          ? <img key={pid} src={thumbs[pid]} alt="song reference" style={S.photoThumb}
                              onClick={() => openLightbox(song.photoIds, idx)} />
                          : <div key={pid} style={S.photoPlaceholder} onClick={() => openLightbox(song.photoIds, idx)}>
                              photo<br />(tap to load)
                            </div>
                      ))}
                    </div>
                  )}
                  <div style={S.cardActions}>
                    <button style={S.smallBtn(false)} onClick={() => setEditingSong(song)}>Edit</button>
                    <button style={S.smallBtn(true)} onClick={() => handleDeleteSong(song)}>Remove</button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ---- LESSONS VIEW ---- */}
      {view === "lessons" && (
        visibleLessons.length === 0 ? (
          <div style={S.empty}>
            {lessons.length === 0
              ? <>No lessons logged yet.<br />After your next one, hit <strong style={{ color: "#D4A73B" }}>+ Log lesson</strong> — and photograph the whiteboard before it's erased.</>
              : "Nothing matches that search."}
          </div>
        ) : layout === "list" ? (
          <div style={S.listWrap}>
            {visibleLessons.map((lesson) => {
              const titles = (lesson.songIds || []).map((id) => songById[id]?.title).filter(Boolean).join(", ");
              const techs = parseTechniques(lesson.techniques).join(", ");
              const nPhotos = (lesson.photoIds || []).length;
              return (
                <div key={lesson.id} style={S.listRow}>
                  <span style={{ ...S.lessonDate, fontSize: 13, flex: "0 0 auto" }}>{formatLessonDate(lesson.date)}</span>
                  <div style={{ flex: "2 1 160px", minWidth: 140, fontSize: 13, color: "#F0E8D2", fontWeight: 600 }}>
                    {titles || <span style={{ color: "#7A6E58", fontWeight: 400 }}>no songs tagged</span>}
                  </div>
                  <div style={{ flex: "2 1 140px", fontSize: 11, color: "#9C8F76" }}>{techs}</div>
                  <div style={{ flex: "0 0 auto", fontSize: 11, color: "#7A6E58" }}>{nPhotos > 0 ? `📷 ${nPhotos}` : ""}</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={S.smallBtn(false)} onClick={() => setEditingLesson(lesson)}>Edit</button>
                    <button style={S.smallBtn(true)} onClick={() => handleDeleteLesson(lesson)}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={S.timeline}>
            {visibleLessons.map((lesson) => (
              <div key={lesson.id} style={S.lessonCard}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                  <span style={S.lessonDate}>{formatLessonDate(lesson.date)}</span>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button style={{ ...S.smallBtn(false), flex: "none", padding: "4px 12px" }} onClick={() => setEditingLesson(lesson)}>Edit</button>
                    <button style={{ ...S.smallBtn(true), flex: "none", padding: "4px 12px" }} onClick={() => handleDeleteLesson(lesson)}>Delete</button>
                  </span>
                </div>

                {(lesson.songIds || []).length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    {lesson.songIds.map((id) => {
                      const s = songById[id];
                      if (!s) return null;
                      const st = statusById[s.status] || STATUSES[0];
                      return (
                        <span key={id} style={S.songChip(st.color)}>
                          <span style={S.led(st.color, true)} /> {s.title}
                        </span>
                      );
                    })}
                  </div>
                )}

                {parseTechniques(lesson.techniques).length > 0 && (
                  <div>
                    {parseTechniques(lesson.techniques).map((t) => (
                      <span key={t} style={S.techChip}>{t}</span>
                    ))}
                  </div>
                )}

                {lesson.notes && <div style={S.lessonNotes}>{lesson.notes}</div>}

                {((lesson.links || []).length > 0 || (lesson.docs || []).length > 0) && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
                    {(lesson.links || []).map((l) => (
                      <a key={l.id} href={l.url} target="_blank" rel="noopener noreferrer"
                        style={{ ...S.chip(false, "#2E86C1"), padding: "4px 10px", textDecoration: "none", color: "#8FBBDB" }}>
                        🔗 {l.label}
                      </a>
                    ))}
                    {(lesson.docs || []).map((d) => (
                      <span key={d.id} onClick={() => openDoc(d)}
                        style={{ ...S.chip(false, "#D4A73B"), padding: "4px 10px", color: "#D9C58A" }}>
                        📄 {busyDoc === d.id ? "Loading…" : d.name}
                      </span>
                    ))}
                  </div>
                )}

                {(lesson.photoIds || []).length > 0 && (
                  <div style={S.photoRow}>
                    {lesson.photoIds.map((pid, idx) => (
                      thumbs[pid]
                        ? <img key={pid} src={thumbs[pid]} alt="whiteboard" style={S.photoThumb}
                            onClick={() => openLightbox(lesson.photoIds, idx)} />
                        : <div key={pid} style={S.photoPlaceholder} onClick={() => openLightbox(lesson.photoIds, idx)}>
                            whiteboard<br />(tap to load)
                          </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* ---- lightbox ---- */}
      {lightbox && (
        <div style={S.lightbox} onClick={() => setLightbox(null)}>
          {lightbox.loading
            ? <div style={{ color: "#9C8F76", fontSize: 13, letterSpacing: "0.15em", textTransform: "uppercase" }}>Loading photo…</div>
            : fulls[lightbox.photoIds[lightbox.index]]
              ? <img src={fulls[lightbox.photoIds[lightbox.index]]} alt="whiteboard full size" style={S.lightboxImg} onClick={(e) => e.stopPropagation()} />
              : <div style={{ color: "#9C8F76", fontSize: 13 }}>Photo unavailable — sign in to fetch it from the cloud.</div>}
          <div style={S.lightboxBar} onClick={(e) => e.stopPropagation()}>
            <button style={{ ...S.lightboxBtn, opacity: lightbox.index === 0 ? 0.35 : 1 }}
              onClick={() => lightboxStep(-1)} disabled={lightbox.index === 0}>◀ Prev</button>
            <span style={{ fontSize: 12, color: "#7A6E58" }}>{lightbox.index + 1} / {lightbox.photoIds.length}</span>
            <button style={{ ...S.lightboxBtn, opacity: lightbox.index === lightbox.photoIds.length - 1 ? 0.35 : 1 }}
              onClick={() => lightboxStep(1)} disabled={lightbox.index === lightbox.photoIds.length - 1}>Next ▶</button>
            <button style={S.lightboxBtn} onClick={() => setLightbox(null)}>Close</button>
          </div>
        </div>
      )}

      {/* ---- modals ---- */}
      {editingSong && (
        <SongModal song={editingSong === "new" ? null : editingSong} thumbs={thumbs} onSave={handleSaveSong} onCancel={() => setEditingSong(null)} />
      )}
      {editingLesson && (
        <LessonModal
          lesson={editingLesson === "new" ? null : editingLesson}
          songs={songs}
          thumbs={thumbs}
          onSave={handleSaveLesson}
          onCancel={() => setEditingLesson(null)}
        />
      )}
    </div>
  );
}
