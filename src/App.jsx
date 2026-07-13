import { useState, useEffect } from "react";
import { supabase } from "./supabase";
import LessonLog from "./LessonLog";

/* ============================================================
   FRETLAB COMPANION — phone-first lesson companion
   A thin shell around the exact same LessonLog component that
   ships inside FretLab. Same Supabase project, same tables,
   same user — so both apps are always looking at the same data.
   To update: copy src/LessonLog.jsx from the FretLab repo.
   ============================================================ */

const S = {
  faceplate: {
    background: "linear-gradient(180deg, #EFE6CE 0%, #E3D8BC 100%)",
    color: "#26211C",
    borderBottom: "3px solid #B89B4A",
    boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
    padding: "calc(14px + env(safe-area-inset-top)) 18px 12px",
    display: "flex",
    alignItems: "center",
    gap: 12,
    position: "sticky",
    top: 0,
    zIndex: 40,
  },
  jewel: {
    width: 16, height: 16, borderRadius: "50%", flexShrink: 0,
    background: "radial-gradient(circle at 35% 30%, #FF8A7A, #C41E12 60%, #7A0E06)",
    boxShadow: "0 0 12px 2px rgba(228,58,40,0.55), inset 0 1px 2px rgba(255,255,255,0.35)",
  },
  title: {
    fontFamily: "'Arial Narrow', 'Helvetica Neue Condensed', Impact, sans-serif",
    fontSize: 20, fontWeight: 700, letterSpacing: "0.18em",
    textTransform: "uppercase", margin: 0, lineHeight: 1,
  },
  subtitle: {
    fontSize: 9, letterSpacing: "0.26em", textTransform: "uppercase",
    color: "#6B5D3F", marginTop: 3,
  },
  authBtn: {
    marginLeft: "auto", padding: "7px 12px", borderRadius: 6, cursor: "pointer",
    fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
    border: "1px solid #8A7B52", background: "transparent", color: "#6B5D3F",
  },
  /* sign-in screen */
  gate: {
    minHeight: "70vh", display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", padding: 24,
    color: "#E8DFC8", fontFamily: "'Helvetica Neue', Arial, sans-serif",
    textAlign: "center",
  },
  gateCard: {
    background: "#2A2522", border: "1px solid #4A3F32", borderRadius: 12,
    padding: "28px 22px", width: "100%", maxWidth: 380,
    boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
  },
  gateTitle: {
    fontFamily: "'Arial Narrow', Impact, sans-serif", fontSize: 18, fontWeight: 700,
    letterSpacing: "0.2em", textTransform: "uppercase", margin: "0 0 6px",
  },
  gateText: { fontSize: 13, color: "#9C8F76", lineHeight: 1.6, margin: "0 0 18px" },
  input: {
    width: "100%", boxSizing: "border-box", padding: "12px 14px",
    background: "#1F1B18", border: "1px solid #4A3F32", borderRadius: 8,
    color: "#E8DFC8", fontSize: 16, outline: "none", marginBottom: 12,
  },
  primaryBtn: (enabled) => ({
    width: "100%", padding: "13px 0", borderRadius: 8, cursor: "pointer",
    fontSize: 13, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase",
    border: "1px solid #D4A73B",
    background: "linear-gradient(180deg, #D9AE45, #B8902E)",
    color: "#211B10", opacity: enabled ? 1 : 0.5,
  }),
  skipBtn: {
    marginTop: 14, background: "none", border: "none", cursor: "pointer",
    fontSize: 12, color: "#7A6E58", textDecoration: "underline",
  },
  sentNote: { fontSize: 13, color: "#8FBF8F", lineHeight: 1.6, marginTop: 4 },
  banner: {
    background: "#33291C", borderBottom: "1px solid #4A3F32", color: "#D9C58A",
    fontSize: 12, padding: "9px 16px", textAlign: "center",
  },
};

function SignInGate({ onSkip }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const send = async () => {
    if (!email.trim() || !supabase) return;
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (err) setError(err.message);
    else setSent(true);
  };

  return (
    <div style={S.gate}>
      <div style={S.gateCard}>
        <h2 style={S.gateTitle}>Sign in</h2>
        <p style={S.gateText}>
          Use the same email as FretLab and your lessons, songs, photos, and
          docs sync between both apps automatically.
        </p>
        {sent ? (
          <p style={S.sentNote}>
            Magic link sent — check your email on this phone and tap the link.
            It'll open the companion signed in.
          </p>
        ) : (
          <>
            <input
              style={S.input}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
            <button style={S.primaryBtn(!!email.trim() && !busy)} onClick={send} disabled={!email.trim() || busy}>
              {busy ? "Sending…" : "Send magic link"}
            </button>
            {error && <p style={{ ...S.gateText, color: "#D8776C", marginTop: 10 }}>{error}</p>}
          </>
        )}
        <button style={S.skipBtn} onClick={onSkip}>
          Skip for now (local only)
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [checked, setChecked] = useState(false);
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    if (!supabase) { setChecked(true); return; }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data?.session || null);
      setChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => setSession(s));
    return () => sub?.subscription?.unsubscribe();
  }, []);

  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
    setSkipped(false);
  };

  const signedIn = !!session;
  const showGate = checked && supabase && !signedIn && !skipped;

  return (
    <div>
      <header style={S.faceplate}>
        <span style={S.jewel} />
        <div>
          <h1 style={S.title}>FretLab Companion</h1>
          <div style={S.subtitle}>Lessons · Songs · Whiteboards</div>
        </div>
        {checked && supabase && (
          signedIn
            ? <button style={S.authBtn} onClick={signOut}>Sign out</button>
            : skipped
              ? <button style={S.authBtn} onClick={() => setSkipped(false)}>Sign in</button>
              : null
        )}
      </header>

      {!supabase && (
        <div style={S.banner}>
          Supabase env vars not set — running local-only. See .env.example.
        </div>
      )}
      {supabase && skipped && !signedIn && (
        <div style={S.banner}>
          Local only — sign in to sync with FretLab.
        </div>
      )}

      {!checked ? null : showGate ? (
        <SignInGate onSkip={() => setSkipped(true)} />
      ) : (
        <LessonLog />
      )}
    </div>
  );
}
