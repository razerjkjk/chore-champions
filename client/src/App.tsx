import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import worldBg from "./assets/adventure-bg.webp";

/** Yesterday's day key (YYYY-MM-DD) for a given day key. */
function prevDayKey(key: string): string {
  const [y = 2026, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

type State = ApiResponse<typeof api, "getState">;
type Player = State["players"][number];
type Chore = State["chores"][number];
type Reward = State["rewards"][number];

const CADENCE_LABEL: Record<Chore["cadence"], string> = {
  daily: "Daily",
  weekly: "Weekly",
  once: "One-time",
};

function playerById(state: State, id: number): Player | undefined {
  return state.players.find((p) => p.id === id);
}

// ---------------- Living world background ----------------
//
// Static, deterministic configs (no Math.random in render) so the layer
// never re-randomizes. Counts are small on purpose: 4 clouds, 4 torches,
// 2 lava layers, ~19 particles total — cheap transform/opacity loops.

const CLOUDS: {
  top: string;
  width: number;
  duration: string;
  delay: string;
  opacity: number;
}[] = [
  { top: "3%", width: 150, duration: "135s", delay: "-38s", opacity: 0.85 },
  { top: "9%", width: 104, duration: "105s", delay: "-78s", opacity: 0.65 },
  { top: "15%", width: 176, duration: "160s", delay: "-112s", opacity: 0.75 },
  { top: "6%", width: 76, duration: "88s", delay: "-14s", opacity: 0.5 },
];

/** One blocky, stepped cloud built from chunky squares. */
function BlockyCloud({
  width,
  opacity,
}: {
  width: number;
  opacity: number;
}) {
  const h = Math.round(width * 0.18);
  return (
    <div className="relative" style={{ width, height: h * 2, opacity }}>
      <div
        className="absolute bg-white"
        style={{ left: "12%", top: 0, width: "52%", height: h }}
      />
      <div
        className="absolute bg-white"
        style={{ left: 0, top: h, width: "100%", height: h }}
      />
      <div
        className="absolute bg-white/90"
        style={{ left: "64%", top: h * 2, width: "24%", height: Math.round(h * 0.7) }}
      />
    </div>
  );
}

const TORCHES: { left?: string; right?: string; top: string; delay: string }[] = [
  { left: "5%", top: "42%", delay: "0s" },
  { right: "5%", top: "42%", delay: "-0.55s" },
  { left: "9%", top: "68%", delay: "-0.3s" },
  { right: "9%", top: "68%", delay: "-0.85s" },
];

/** A wall torch: wooden stick, a square flickering flame, soft glow. */
function Torch({ delay }: { delay: string }) {
  return (
    <div className="absolute" style={{ width: 14, height: 30 }}>
      <div
        className="cc-live-torch-glow absolute rounded-full"
        style={{
          left: -17,
          top: -20,
          width: 48,
          height: 48,
          background:
            "radial-gradient(circle, rgba(255,170,40,0.55) 0%, rgba(255,120,20,0.22) 55%, transparent 72%)",
          animationDelay: delay,
        }}
      />
      <div
        className="absolute bg-[#6b4423]"
        style={{ left: 5, top: 12, width: 4, height: 16 }}
      />
      <div
        className="cc-live-torch-flame absolute bg-[#ffb52e]"
        style={{
          left: 2,
          top: 2,
          width: 10,
          height: 12,
          boxShadow:
            "inset 0 -4px 0 rgba(255,110,0,0.85), inset 0 3px 0 rgba(255,240,170,0.9)",
          animationDelay: delay,
        }}
      />
    </div>
  );
}

const EMBERS: {
  left: string;
  size: number;
  duration: string;
  delay: string;
  sway: string;
  color: string;
  opacity: number;
}[] = [
  { left: "8%", size: 4, duration: "11s", delay: "-2s", sway: "14px", color: "#ff9a2e", opacity: 0.8 },
  { left: "18%", size: 3, duration: "14s", delay: "-9s", sway: "-10px", color: "#ffc93b", opacity: 0.65 },
  { left: "31%", size: 5, duration: "12s", delay: "-5s", sway: "18px", color: "#ff7a1a", opacity: 0.75 },
  { left: "44%", size: 3, duration: "16s", delay: "-12s", sway: "-14px", color: "#ffd23f", opacity: 0.6 },
  { left: "57%", size: 4, duration: "10s", delay: "-1s", sway: "10px", color: "#ff8a2a", opacity: 0.8 },
  { left: "68%", size: 3, duration: "15s", delay: "-7s", sway: "-16px", color: "#ffbe3b", opacity: 0.6 },
  { left: "79%", size: 5, duration: "13s", delay: "-4s", sway: "12px", color: "#ff7a1a", opacity: 0.7 },
  { left: "90%", size: 3, duration: "12s", delay: "-10s", sway: "-8px", color: "#ffc93b", opacity: 0.65 },
  { left: "24%", size: 3, duration: "17s", delay: "-3s", sway: "8px", color: "#ff9a2e", opacity: 0.5 },
  { left: "63%", size: 4, duration: "14s", delay: "-13s", sway: "-12px", color: "#ff8a2a", opacity: 0.55 },
  { left: "38%", size: 3, duration: "11s", delay: "-8s", sway: "16px", color: "#ffd23f", opacity: 0.55 },
  { left: "85%", size: 4, duration: "15s", delay: "-6s", sway: "-18px", color: "#ff9a2e", opacity: 0.5 },
];

const FIREFLIES: {
  left: string;
  top: string;
  size: number;
  duration: string;
  delay: string;
}[] = [
  { left: "12%", top: "26%", size: 4, duration: "6.5s", delay: "0s" },
  { left: "28%", top: "34%", size: 3, duration: "7.5s", delay: "-2.4s" },
  { left: "47%", top: "24%", size: 4, duration: "5.8s", delay: "-4.1s" },
  { left: "66%", top: "32%", size: 3, duration: "8s", delay: "-1.2s" },
  { left: "82%", top: "27%", size: 4, duration: "6.8s", delay: "-3.3s" },
  { left: "38%", top: "44%", size: 3, duration: "7.2s", delay: "-5s" },
  { left: "74%", top: "46%", size: 3, duration: "6.2s", delay: "-0.7s" },
];

/** Clouds, sun glow, torches, and lava — rendered UNDER the readability
 *  scrim so everything stays soft and subtle. */
function LivingWorld() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Square-sun glow, top right */}
      <div
        className="cc-live-sun-glow absolute"
        style={{
          right: "6%",
          top: "2%",
          width: 120,
          height: 120,
          background:
            "radial-gradient(circle, rgba(255,225,120,0.85) 0%, rgba(255,200,60,0.3) 55%, transparent 72%)",
        }}
      />
      {/* Drifting blocky clouds */}
      {CLOUDS.map((c, i) => (
        <div
          key={i}
          className="cc-live-cloud"
          style={{
            top: c.top,
            animationDuration: c.duration,
            animationDelay: c.delay,
          }}
        >
          <BlockyCloud width={c.width} opacity={c.opacity} />
        </div>
      ))}
      {/* Flickering torches along the edges */}
      {TORCHES.map((t, i) => (
        <div
          key={i}
          className="absolute"
          style={{ left: t.left, right: t.right, top: t.top }}
        >
          <Torch delay={t.delay} />
        </div>
      ))}
      {/* Glowing lava along the very bottom */}
      <div className="absolute inset-x-0 bottom-0" style={{ height: "13%" }}>
        <div
          className="cc-live-lava absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, transparent 0%, rgba(255,90,0,0.35) 38%, rgba(255,60,0,0.75) 72%, rgba(255,140,10,0.95) 100%)",
          }}
        />
        <div
          className="cc-live-lava-shimmer absolute inset-0"
          style={{
            background:
              "repeating-linear-gradient(90deg, transparent 0 34px, rgba(255,220,90,0.5) 34px 52px, transparent 52px 96px)",
            maskImage:
              "linear-gradient(180deg, transparent 30%, black 85%)",
            WebkitMaskImage:
              "linear-gradient(180deg, transparent 30%, black 85%)",
          }}
        />
      </div>
    </div>
  );
}

/** Embers rising from the lava and fireflies drifting in the grass
 *  band — rendered ABOVE the scrim at very low opacity so the motion
 *  reads without ever fighting the cards. */
function LivingParticles() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {EMBERS.map((e, i) => (
        <span
          key={`ember-${i}`}
          className="cc-live-particle"
          style={
            {
              left: e.left,
              width: e.size,
              height: e.size,
              background: e.color,
              boxShadow: `0 0 6px 1px ${e.color}`,
              animationDuration: e.duration,
              animationDelay: e.delay,
              "--cc-sway": e.sway,
              "--cc-particle-opacity": e.opacity,
            } as CSSProperties
          }
        />
      ))}
      {FIREFLIES.map((f, i) => (
        <span
          key={`firefly-${i}`}
          className="cc-live-firefly"
          style={{
            left: f.left,
            top: f.top,
            width: f.size,
            height: f.size,
            background: "#c6f542",
            boxShadow: "0 0 7px 2px rgba(170,240,60,0.55)",
            animationDuration: f.duration,
            animationDelay: f.delay,
          }}
        />
      ))}
    </div>
  );
}

// ---------------- Account sign-in (public version) ----------------
// Each family has its own account; the game board belongs to that
// account alone. No texting, no sharing — the board is yours.

function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api.getMe({}),
    staleTime: 5 * 60 * 1000,
  });
}

function AuthView() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const auth = useMutation({
    mutationFn: async () => {
      if (mode === "signup") {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return await api.signUp({ email, name, password, timezone: tz });
      }
      return await api.signIn({ email, password });
    },
    onSuccess: (data) => {
      if (!data.ok) {
        setError(data.error ?? "That didn't work. Try again.");
        return;
      }
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : "Could not reach the server."),
  });
  return (
    <div className="mx-auto max-w-md rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] p-5">
      <h2 className="font-display text-xl">
        {mode === "signup" ? "Make your family's account" : "Welcome back!"}
      </h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        {mode === "signup"
          ? "One account per family — your kids, chores, and points stay yours alone. Add your kids after you sign up."
          : "Sign in to your family's board."}
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          auth.mutate();
        }}
      >
        {mode === "signup" && (
          <label className={labelCls}>
            Your first name
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="given-name"
            />
          </label>
        )}
        <label className={labelCls}>
          Email
          <input
            className={inputCls}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label className={labelCls}>
          Password
          <input
            className={inputCls}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </label>
        {error && <p className="text-sm font-semibold text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={auth.isPending}
          className="rounded-lg bg-[var(--accent)] px-5 py-2 font-black text-black disabled:opacity-60"
        >
          {auth.isPending
            ? "One moment…"
            : mode === "signup"
              ? "Create account"
              : "Sign in"}
        </button>
      </form>
      <button
        type="button"
        className="mt-3 text-sm font-bold text-[var(--dim)] underline"
        onClick={() => {
          setMode(mode === "signup" ? "signin" : "signup");
          setError(null);
        }}
      >
        {mode === "signup"
          ? "Already have an account? Sign in"
          : "New here? Make an account"}
      </button>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const me = useMe();
  const [accountDeleted, setAccountDeleted] = useState(false);
  // A fresh sign-in after a deletion clears the confirmation banner.
  useEffect(() => {
    if (me.data?.user) setAccountDeleted(false);
  }, [me.data?.user]);
  const state = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState({}),
    enabled: !!me.data?.user,
  });

  const signOut = async () => {
    await api.signOut({});
    queryClient.invalidateQueries({ queryKey: ["me"] });
    queryClient.invalidateQueries({ queryKey: ["state"] });
  };

  return (
    <div className="relative min-h-screen bg-[var(--bg)] text-[var(--text)]">
      {/* The whole app lives inside the blocky adventure world: one blocky scene —
          sky, grass hills, and the ore-filled underground — fixed behind
          everything, darkened enough that every card stays readable.
          On top of the still picture, a living layer: blocky clouds drift
          across the sky, torches flicker, lava glows at the bottom, and
          embers / fireflies float up. Pure CSS transform + opacity, few
          elements, low opacity — fast on a phone and still under the
          readability scrim. Reduced-motion turns the moving layers off
          (see theme.css). */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <img
          src={worldBg}
          alt=""
          className="h-full w-full object-cover [image-rendering:pixelated]"
        />
        <LivingWorld />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(16,11,8,0.40) 0%, rgba(16,11,8,0.52) 45%, rgba(16,11,8,0.66) 100%)",
          }}
        />
        {/* A second, lighter living layer above the scrim so the motion
            is still perceptible — kept very faint for readability. */}
        <LivingParticles />
      </div>
      <main className="relative z-10 mx-auto w-full max-w-3xl px-4 pb-10">
        <header className="pt-5 pb-2 text-center">
          <h1
            className="font-display text-3xl leading-tight tracking-wide text-[var(--accent)]"
            style={{ textShadow: "3px 3px 0 rgba(0,0,0,0.45)" }}
          >
            Chore Champions
          </h1>
          <p className="mt-1 text-sm font-semibold text-[var(--dim)]">
            Dig, build, and explore. Earn XP. Become a Crystal Champion! ⛏️
          </p>
          <div className="mt-3 flex items-end justify-center gap-1" aria-hidden>
            {GEM_COLORS.map((c, i) => (
              <span
                key={c}
                className="inline-block w-5 border-2 border-black/40"
                style={{
                  background: c,
                  height: i % 3 === 0 ? 28 : i % 3 === 1 ? 20 : 24,
                  boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.35)",
                }}
              />
            ))}
          </div>
          {me.data?.user && (
            <div className="mt-2 flex items-center justify-center gap-2 text-xs text-[var(--dim)]">
              <span>Playing as {me.data.user.name}</span>
              <button type="button" onClick={signOut} className="font-bold underline">
                Sign out
              </button>
            </div>
          )}
        </header>

        {me.isPending && (
          <p className="py-16 text-center text-[var(--dim)]">Loading…</p>
        )}
        {me.data && !me.data.user && accountDeleted && (
          <div className="mx-auto mb-4 max-w-md rounded-[var(--radius)] border-2 border-red-400 bg-[var(--surface)] p-5 text-center">
            <p className="font-display text-xl">Account deleted.</p>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Your account and everything in it — kids, chores, points,
              and prizes — is gone for good. You can make a fresh account
              any time.
            </p>
          </div>
        )}
        {me.data && !me.data.user && <AuthView />}
        {me.data?.user && state.isPending && (
          <p className="py-16 text-center text-[var(--dim)]">
            Loading your world…
          </p>
        )}
        {me.data?.user && state.error && (
          <div className="py-16 text-center">
            <p className="font-semibold">The world hit a glitch.</p>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Your points are saved and safe.
            </p>
            <button
              type="button"
              onClick={() => state.refetch()}
              className="mt-4 rounded-lg bg-[var(--accent)] px-5 py-2 font-bold text-black"
            >
              Try again
            </button>
          </div>
        )}
        {me.data?.user && state.data && (
          <Game state={state.data} onDeleted={() => setAccountDeleted(true)} />
        )}
      </main>
    </div>
  );
}

interface Celebration {
  id: number;
  title: string;
  subtitle: string;
  emoji: string;
  color: string;
  big: boolean;
}

const GEM_COLORS = ["#5eb83a", "#8a5a2b", "#9a9a9a", "#4aedd9", "#f9d13b", "#e53935", "#2f5fd0"];
const CONFETTI_COLORS = GEM_COLORS;

function Confetti({ burstId, big }: { burstId: number; big: boolean }) {
  const pieces = useMemo(() => {
    const count = big ? 70 : 36;
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.35,
      duration: 1.6 + Math.random() * 1.4,
      size: 7 + Math.random() * 8,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length] ?? "#ffd23f",
      round: i % 3 === 0,
    }));
  }, [burstId, big]);
  if (burstId === 0) return null;
  return (
    <div key={burstId} className="pointer-events-none fixed inset-0 z-40 overflow-hidden" aria-hidden>
      {pieces.map((p) => (
        <span
          key={p.id}
          className="cc-confetti-piece"
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.size,
            background: p.color,
            borderRadius: 2,
            border: "2px solid rgba(0,0,0,0.35)",
            boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.35)",
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

// ---------------- Grown-Up Zone PIN gate (client side) ----------------
//
// The unlock token is kept in sessionStorage — never localStorage — so
// it survives the page reloads and webview restarts that are routine on
// a phone, but dies with the browser session (tab/app closed for real).
// On load, a stored token is checked with the server before the zone
// trusts it: the server still expires tokens after 5 idle minutes, and
// a token it no longer knows is dropped here. While unlocked, any
// pointer/key activity in the app resets an idle timer;
// PIN_IDLE_LOCK_MS of quiet locks it. (An earlier version also locked
// the instant the page hid or unloaded — on a phone that fired on
// ordinary interruptions and stranded parents at the pad, so the idle
// timer and the server expiry are the locks now.)

const PIN_IDLE_LOCK_MS = 3 * 60_000;
const PIN_TOKEN_STORAGE_KEY = "cc-grownup-pin-token";

interface PinGate {
  token: string | null;
  unlock: (token: string) => void;
  lock: () => void;
  poke: () => void;
}

function usePinGate(): PinGate {
  const [token, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLocal = () => {
    tokenRef.current = null;
    setToken(null);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    try {
      sessionStorage.removeItem(PIN_TOKEN_STORAGE_KEY);
    } catch {
      // Storage unavailable (private mode, odd webview) — the in-memory
      // token still works for this page load.
    }
  };

  const lock = () => {
    const current = tokenRef.current;
    clearLocal();
    if (current) {
      // Best effort: kill the server session too. Fire and forget —
      // the token also expires server-side on its own.
      void api.lockZone({ pinToken: current }).catch(() => undefined);
    }
  };

  const armIdleTimer = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(lock, PIN_IDLE_LOCK_MS);
  };

  const poke = () => {
    if (!tokenRef.current) return;
    armIdleTimer();
  };

  const unlock = (next: string) => {
    tokenRef.current = next;
    setToken(next);
    try {
      sessionStorage.setItem(PIN_TOKEN_STORAGE_KEY, next);
    } catch {
      // See clearLocal — non-fatal.
    }
    armIdleTimer();
  };

  // Restore an unlock that survived a reload in this browser session.
  // The server has the last word: a token it has already expired is
  // dropped instead of resurrecting a dead unlock.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(PIN_TOKEN_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (!stored) return;
    const candidate = stored;
    void api
      .checkPinSession({ pinToken: candidate })
      .then((res) => {
        if (res.ok) {
          tokenRef.current = candidate;
          setToken(candidate);
          armIdleTimer();
        } else {
          try {
            sessionStorage.removeItem(PIN_TOKEN_STORAGE_KEY);
          } catch {
            // Non-fatal.
          }
        }
      })
      .catch(() => undefined);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { token, unlock, lock, poke };
}

function Game({ state, onDeleted }: { state: State; onDeleted: () => void }) {
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const [burstId, setBurstId] = useState(0);
  const [closetFor, setClosetFor] = useState<number | null>(null);
  const prevTiers = useRef<Map<number, string> | null>(null);
  const pinGate = usePinGate();

  const celebrate = (c: Omit<Celebration, "id">) => {
    setCelebration({ ...c, id: Date.now() });
    setBurstId((b) => b + 1);
  };

  // Level-up detector: when a player's level changes, PARTY.
  useEffect(() => {
    const current = new Map(state.players.map((p) => [p.id, p.tier]));
    if (prevTiers.current) {
      for (const p of state.players) {
        const before = prevTiers.current.get(p.id);
        if (before && before !== p.tier) {
          celebrate({
            title: "⭐ LEVEL UP! ⭐",
            subtitle: `${p.name} just reached ${p.tier}! New skins may have unlocked — check the Skin Closet!`,
            emoji: p.avatarEmoji,
            color: p.color,
            big: true,
          });
        }
      }
    }
    prevTiers.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.players]);

  useEffect(() => {
    if (!celebration) return;
    const t = setTimeout(() => setCelebration(null), celebration.big ? 5200 : 3600);
    return () => clearTimeout(t);
  }, [celebration]);

  const closetPlayer = closetFor != null ? playerById(state, closetFor) : undefined;

  return (
    <div
      className="flex flex-col gap-6"
      onPointerDown={pinGate.poke}
      onKeyDown={pinGate.poke}
    >
      <Confetti burstId={burstId} big={celebration?.big ?? false} />
      {celebration && (
        <div
          role="status"
          className="cc-pop-in fixed inset-x-4 top-16 z-50 mx-auto max-w-md rounded-[var(--radius)] border-4 bg-[var(--surface-2)] p-4 text-center shadow-2xl"
          style={{ borderColor: celebration.color }}
        >
          <p className="text-5xl" aria-hidden>{celebration.emoji}</p>
          <p className="font-display mt-1 text-xl" style={{ color: celebration.color }}>
            {celebration.title}
          </p>
          <p className="mt-1 text-sm font-semibold">{celebration.subtitle}</p>
          <button
            type="button"
            onClick={() => setCelebration(null)}
            className="mt-3 rounded-lg bg-[var(--accent)] px-5 py-2 font-black text-black"
          >
            KEEP DIGGING! ⛏️
          </button>
        </div>
      )}
      {closetPlayer && (
        <AvatarCloset
          state={state}
          player={closetPlayer}
          onClose={() => setClosetFor(null)}
        />
      )}
      {state.players.length === 0 && (
        <section className="rounded-[var(--radius)] border-2 border-dashed border-[var(--accent)] bg-[var(--surface)] p-4 text-center">
          <p className="font-display text-lg">No kids on the board yet!</p>
          <p className="mt-1 text-sm text-[var(--dim)]">
            A grown-up adds the kids in the Grown-Up Zone below — unlock it
            with the PIN you created, then add a player.
          </p>
        </section>
      )}
      <Scoreboard state={state} onOpenCloset={(id) => setClosetFor(id)} />
      <GrumblerAlert state={state} />
      <BossBattle state={state} />
      <QuestBanners state={state} />
      <ChoreBoard state={state} celebrate={celebrate} />
      <TreasureVault state={state} celebrate={celebrate} />
      <RewardShop state={state} pinGate={pinGate} />
      <RecentActivity state={state} />
      <GrownUpZone state={state} pinGate={pinGate} onDeleted={onDeleted} />
    </div>
  );
}

// ---------------- Grumbler alert ----------------

/** Shows for a day after a grumbler took a heart overnight. */
function GrumblerAlert({ state }: { state: State }) {
  const yesterday = prevDayKey(state.today);
  const hit = state.players.filter((p) => p.grumblerHitDay === yesterday);
  if (hit.length === 0) return null;
  return (
    <section aria-label="Grumbler attack" className="flex flex-col gap-3">
      {hit.map((p) => (
        <div
          key={p.id}
          className="cc-pop-in rounded-[var(--radius)] border-4 border-red-500 bg-[#2a0f0f] p-4 text-center"
        >
          <p className="text-4xl" aria-hidden>👹</p>
          <p className="font-display mt-1 text-lg text-red-400">
            GRUMBLER ATTACK!
          </p>
          <p className="mt-1 text-sm font-semibold">
            {p.knockedOut
              ? `A grumbler snuck into ${p.name}'s world last night and took the LAST heart — the daily quests weren't all finished! ${p.name} is knocked out: finish the Rally Quest below to get back in the game!`
              : `A grumbler snuck into ${p.name}'s world last night and took a heart — the daily quests weren't all finished! ${p.name} has ${p.hearts} ${p.hearts === 1 ? "heart" : "hearts"} left. Finish every daily quest today to keep the grumblers out tonight!`}
          </p>
        </div>
      ))}
    </section>
  );
}

// ---------------- Scoreboard ----------------

function Scoreboard({
  state,
  onOpenCloset,
}: {
  state: State;
  onOpenCloset: (playerId: number) => void;
}) {
  const [a, b] = state.players;
  const total = state.players.reduce((s, p) => s + p.weekPoints, 0);
  const leader =
    a && b && a.weekPoints !== b.weekPoints
      ? a.weekPoints > b.weekPoints
        ? a
        : b
      : null;
  const lastWinner = state.lastWeekWinner
    ? playerById(state, state.lastWeekWinner.playerId)
    : undefined;

  return (
    <section aria-label="Scoreboard">
      {lastWinner && state.lastWeekWinner && (
        <div className="mb-3 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface-2)] px-4 py-3 text-center">
          <p className="font-display text-lg text-[var(--accent)]">
            🏆 Star Champion!
          </p>
          <p className="text-sm font-semibold">
            {lastWinner.emoji} {lastWinner.name} mined the most XP last week with{" "}
            {state.lastWeekWinner.points} points!
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {state.players.map((p) => (
          <PlayerCard
            key={p.id}
            player={p}
            isLeader={leader?.id === p.id}
            onOpenCloset={onOpenCloset}
          />
        ))}
      </div>

      {a && b && (
        <div className="mt-3" aria-label="This week's race">
          <div className="flex h-6 w-full overflow-hidden rounded-sm border-2 border-black/60">
            <div
              style={{
                width: `${total > 0 ? (a.weekPoints / total) * 100 : 50}%`,
                background: a.color,
              }}
            />
            <div
              style={{
                width: `${total > 0 ? (b.weekPoints / total) * 100 : 50}%`,
                background: b.color,
              }}
            />
          </div>
          <p className="mt-1 text-center text-xs font-bold text-[var(--dim)]">
            {total === 0
              ? "This week's world is brand new — first chore earns the first XP!"
              : leader
                ? `${leader.name} is earning the most XP this week!`
                : "Dead tie this week — next quest breaks it!"}
          </p>
        </div>
      )}
    </section>
  );
}

function PlayerCard({
  player,
  isLeader,
  onOpenCloset,
}: {
  player: Player;
  isLeader: boolean;
  onOpenCloset: (playerId: number) => void;
}) {
  const passPct =
    player.nextTierAt != null
      ? Math.min(
          100,
          Math.round(
            ((player.lifetimePoints - player.tierMin) /
              (player.nextTierAt - player.tierMin)) *
              100,
          ),
        )
      : 100;
  const onFire = player.streak >= 3;
  const combo = player.todayCount;
  return (
    <article
      className="rounded-[var(--radius)] border-b-4 bg-[var(--surface)] p-3"
      style={{ borderColor: player.color }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Change ${player.name}'s skin`}
          onClick={() => onOpenCloset(player.id)}
          className={`relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-3xl ${onFire ? "cc-aura" : ""}`}
          style={{
            background: player.color,
            border: `3px solid ${player.avatarFrame}`,
          }}
        >
          <span aria-hidden>{player.avatarEmoji}</span>
          {player.unopenedChests > 0 && (
            <span
              className="absolute -top-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-black text-black"
              aria-label={`${player.unopenedChests} unopened treasure chests`}
            >
              {player.unopenedChests}
            </span>
          )}
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-lg leading-tight font-black">
            {player.name}
            {isLeader && <span aria-label="leading this week"> 👑</span>}
          </h2>
          <p className="text-xs font-semibold text-[var(--dim)]">
            Age {player.age}
            {player.crowns > 0 && ` · ${player.crowns} 👑`}
          </p>
          <p className="truncate text-xs font-bold" style={{ color: player.avatarFrame }}>
            {player.avatarName}
          </p>
        </div>
      </div>
      {combo >= 2 && (
        <p className="cc-pop-in mt-2 rounded-lg bg-black/30 px-2 py-1 text-center text-sm font-black text-[var(--accent)]">
          ⛏️ DIGGING COMBO x{combo} today{combo >= 5 ? " — CRYSTAL ENERGY!" : combo >= 3 ? " — digging fast!" : "!"}
        </p>
      )}

      <p className="mt-3 font-display text-3xl" style={{ color: player.color }}>
        {player.weekPoints}
        <span className="ml-1 text-sm text-[var(--dim)]">pts this week</span>
      </p>
      <p className="text-sm font-semibold">
        ⭐ {player.balance} points to spend
      </p>
      <p className="text-sm font-semibold">
        {player.streak > 0 ? `🔥 ${player.streak}-day streak` : "No streak yet — start one today!"}
      </p>

      <div
        className="mt-2 flex items-center gap-0.5"
        role="img"
        aria-label={`${player.name} has ${player.hearts} of ${player.maxHearts} hearts`}
      >
        {Array.from({ length: player.maxHearts }, (_, i) => (
          <span key={i} aria-hidden className="text-base leading-none">
            {i < player.hearts ? "❤️" : "🖤"}
          </span>
        ))}
        <span className="ml-1 text-xs font-bold text-[var(--dim)]">
          {player.knockedOut
            ? "Knocked out!"
            : player.hearts <= 2
              ? "Grumblers are close!"
              : "Hearts"}
        </span>
      </div>
      {player.knockedOut && (
        <p className="cc-pop-in mt-2 rounded-lg bg-[#2a0f0f] px-2 py-1 text-center text-sm font-black text-red-400">
          👹 KNOCKED OUT! Finish the Rally Quest below to get back in!
        </p>
      )}
      <div className="mt-3">
        <p className="text-xs font-black tracking-wide text-[var(--accent)] uppercase">
          Level: {player.tier}
        </p>
        <div
          className="mt-1 flex gap-0.5"
          role="progressbar"
          aria-valuenow={passPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Progress to next level: ${passPct}%`}
        >
          {Array.from({ length: 10 }, (_, i) => (
            <span
              key={i}
              className="h-3 flex-1 border border-black/40"
              style={{
                background:
                  (i + 1) * 10 <= passPct ? "var(--accent)" : "rgba(0,0,0,0.4)",
                boxShadow:
                  (i + 1) * 10 <= passPct
                    ? "inset 0 0 0 1px rgba(255,255,255,0.35)"
                    : undefined,
              }}
            />
          ))}
        </div>
        <p className="mt-1 text-xs text-[var(--dim)]">
          {player.nextTierAt != null
            ? `${player.nextTierAt - player.lifetimePoints} pts to level up`
            : "Max level — Crystal Champion!"}
        </p>
      </div>
      <button
        type="button"
        aria-label={`Open ${player.name}'s skin closet`}
        onClick={() => onOpenCloset(player.id)}
        className="mt-3 w-full rounded-lg border-2 border-dashed px-2 py-1.5 text-xs font-black"
        style={{ borderColor: player.avatarFrame, color: player.avatarFrame }}
      >
        ⛏️ Change Skin{player.unopenedChests > 0 ? ` · 📦 ${player.unopenedChests} chests!` : ""}
      </button>
    </article>
  );
}

// ---------------- Boss battle ----------------

function BossBattle({ state }: { state: State }) {
  const boss = state.boss;
  const hpPct = Math.max(0, Math.min(100, (boss.remaining / boss.maxHp) * 100));
  const prevDamage = useRef(boss.damage);
  const [hit, setHit] = useState(false);
  const [floatPts, setFloatPts] = useState<{ id: number; pts: number } | null>(null);

  useEffect(() => {
    if (boss.damage > prevDamage.current) {
      const diff = boss.damage - prevDamage.current;
      setHit(true);
      setFloatPts({ id: Date.now(), pts: diff });
      const t1 = setTimeout(() => setHit(false), 550);
      const t2 = setTimeout(() => setFloatPts(null), 1450);
      prevDamage.current = boss.damage;
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
    prevDamage.current = boss.damage;
  }, [boss.damage]);

  return (
    <section
      aria-label="Weekly boss battle"
      className={`relative overflow-hidden rounded-[var(--radius)] border-4 bg-[var(--surface)] p-4 ${boss.defeated ? "border-[var(--accent)]" : "cc-pulse-border"}`}
    >
      <p className="font-display text-center text-sm tracking-wide text-red-300">
        {boss.defeated ? "🏆 MONSTER BOSS DEFEATED! 🏆" : "👾 WEEKLY MONSTER BOSS 👾"}
      </p>
      <div className="relative mt-1 text-center">
        <span
          className={`text-7xl ${boss.defeated ? "" : hit ? "cc-boss-hit" : "cc-boss-idle"}`}
          aria-hidden
        >
          {boss.defeated ? "💥" : boss.emoji}
        </span>
        {floatPts && !boss.defeated && (
          <span
            key={floatPts.id}
            className="cc-float-up font-display absolute top-0 left-1/2 -translate-x-1/2 text-2xl text-red-300"
            aria-hidden
          >
            -{floatPts.pts} HP!
          </span>
        )}
      </div>
      <h3 className="font-display mt-1 text-center text-lg">{boss.name}</h3>
      {boss.defeated ? (
        <p className="mt-1 text-center text-sm font-semibold">
          You two defeated the boss TOGETHER! 🎉 +50 bonus pts each and a
          CRYSTAL chest for both of you — check the Treasure Vault!
        </p>
      ) : (
        <>
          <p className="mt-1 text-center text-sm font-semibold text-[var(--dim)] italic">
            “{boss.taunt}”
          </p>
          <div
            className="mt-3 h-6 w-full overflow-hidden rounded-full border-2 border-black/50 bg-black/40"
            role="progressbar"
            aria-valuenow={boss.remaining}
            aria-valuemin={0}
            aria-valuemax={boss.maxHp}
            aria-label={`Boss health: ${boss.remaining} of ${boss.maxHp} left`}
          >
            <div
              className="h-full bg-gradient-to-r from-[#ff3355] via-[#ff8a00] to-[#ffe600] transition-all duration-700"
              style={{ width: `${hpPct}%` }}
            />
          </div>
          <p className="mt-1 text-center text-sm font-black">
            {boss.remaining} HP left · every point you BOTH earn lands a hit on the boss!
          </p>
          <p className="text-center text-xs font-semibold text-[var(--dim)]">
            Beat it before Monday and you both win +50 pts and a CRYSTAL chest 💎
          </p>
        </>
      )}
    </section>
  );
}

// ---------------- Treasure vault ----------------

const CHEST_STYLE: Record<string, { emoji: string; label: string; cls: string }> = {
  common: { emoji: "📦", label: "Wooden Chest", cls: "border-[var(--border)]" },
  epic: { emoji: "✨", label: "MAGIC Chest", cls: "border-[#b537f2]" },
  legendary: { emoji: "💎", label: "CRYSTAL Chest", cls: "border-[var(--accent)]" },
};

function TreasureVault({
  state,
  celebrate,
}: {
  state: State;
  celebrate: (c: Omit<Celebration, "id">) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const open = useMutation({
    mutationFn: async (args: { chestId: number; playerId: number }) =>
      await api.openChest(args),
    onSuccess: (data, args) => {
      setError(null);
      const p = playerById(state, args.playerId);
      celebrate({
        title: `${data.rewardLabel}`,
        subtitle: `${p?.name ?? "Player"} cracked it open for +${data.rewardPoints} bonus points!`,
        emoji: "🎁",
        color: p?.color ?? "var(--accent)",
        big: data.rewardPoints >= 75,
      });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "That chest wouldn't open."),
  });

  if (state.chests.length === 0) return null;
  return (
    <section aria-label="Treasure vault">
      <h3 className="font-display mb-2 text-base">📦 Treasure Vault — tap a chest to crack it open!</h3>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {state.chests.map((chest) => {
          const p = playerById(state, chest.playerId);
          const style = CHEST_STYLE[chest.tier] ?? CHEST_STYLE.common!;
          return (
            <li key={chest.id}>
              <button
                type="button"
                aria-label={`Open ${style.label} for ${p?.name ?? "player"}`}
                disabled={open.isPending}
                onClick={() => open.mutate({ chestId: chest.id, playerId: chest.playerId })}
                className={`w-full rounded-[var(--radius)] border-2 bg-[var(--surface)] p-3 text-center disabled:opacity-50 ${style.cls}`}
              >
                <span className="cc-chest-wiggle text-4xl" aria-hidden>{style.emoji}</span>
                <span className="mt-1 block text-sm font-black">{style.label}</span>
                <span className="block text-xs font-bold" style={{ color: p?.color }}>
                  {p?.emoji} {p?.name}'s treasure
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-2 text-sm font-semibold text-red-300">{error}</p>}
      <p className="mt-2 text-xs font-semibold text-[var(--dim)]">
        Chests drop from finished quests, completed adventures, and defeating the Monster Boss.
      </p>
    </section>
  );
}

// ---------------- Avatar closet ----------------

function AvatarCloset({
  state,
  player,
  onClose,
}: {
  state: State;
  player: Player;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const equip = useMutation({
    mutationFn: async (avatarKey: string) =>
      await api.equipAvatar({ playerId: player.id, avatarKey }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["state"] });
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't change that look."),
  });
  return (
    <div
      role="dialog"
      aria-label={`${player.name}'s skin closet`}
      className="cc-pop-in fixed inset-x-4 top-16 bottom-16 z-50 mx-auto flex max-w-md flex-col overflow-hidden rounded-[var(--radius)] border-4 bg-[var(--surface-2)] shadow-2xl"
      style={{ borderColor: player.color }}
    >
      <div className="flex items-center justify-between p-4 pb-2">
        <h3 className="font-display text-base">
          ⛏️ {player.name}'s Skin Closet
        </h3>
        <button
          type="button"
          aria-label="Close skin closet"
          onClick={onClose}
          className="rounded-md bg-black/30 px-3 py-1 font-black"
        >
          ✕
        </button>
      </div>
      <p className="px-4 text-sm font-semibold text-[var(--dim)]">
        {player.lifetimePoints} lifetime points. Earn more to unlock cooler skins!
      </p>
      <ul className="mt-3 flex-1 overflow-y-auto px-4 pb-4">
        {state.avatarItems.map((item) => {
          const unlocked = player.lifetimePoints >= item.unlockAt;
          const equipped = player.equippedAvatar === item.key;
          const emoji = item.key === "starter" ? player.emoji : item.emoji;
          return (
            <li key={item.key} className="mb-2">
              <button
                type="button"
                aria-label={
                  unlocked
                    ? `Wear ${item.name}`
                    : `${item.name} locked, needs ${item.unlockAt} lifetime points`
                }
                disabled={!unlocked || equipped || equip.isPending}
                onClick={() => equip.mutate(item.key)}
                className="flex w-full items-center gap-3 rounded-lg bg-[var(--surface)] p-3 text-left disabled:opacity-60"
              >
                <span
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-2xl"
                  style={{
                    background: player.color,
                    border: `3px solid ${item.frame || player.color}`,
                    filter: unlocked ? undefined : "grayscale(1)",
                  }}
                  aria-hidden
                >
                  {unlocked ? emoji : "🔒"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-black">{item.name}</span>
                  <span className="block text-xs font-semibold text-[var(--dim)]">
                    {unlocked
                      ? equipped
                        ? "You're wearing this now!"
                        : "Unlocked — tap to wear it!"
                      : `Unlocks at ${item.unlockAt} lifetime pts (${item.unlockAt - player.lifetimePoints} to go)`}
                  </span>
                </span>
                {equipped && <span className="font-black text-[var(--accent)]">ON ✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className="px-4 pb-3 text-sm font-semibold text-red-300">{error}</p>}
    </div>
  );
}

// ---------------- Quests (motivation engine) ----------------

function QuestBanners({ state }: { state: State }) {
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (id: number) => api.dismissQuest({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  if (state.quests.length === 0) return null;
  return (
    <section aria-label="Quests" className="flex flex-col gap-3">
      {state.quests.map((q) => {
        const player = playerById(state, q.playerId);
        return (
          <article
            key={q.id}
            className={`cc-pop-in rounded-[var(--radius)] border-2 border-dashed p-4 ${q.kind === "rally" ? "cc-pulse-border bg-[#2a0f0f]" : "bg-[var(--surface-2)]"}`}
            style={{
              borderColor:
                q.kind === "rally" ? "#e53935" : (player?.color ?? "var(--accent)"),
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-display text-base">{q.title}</h3>
              <button
                type="button"
                aria-label={`Dismiss quest for ${player?.name ?? "player"}`}
                onClick={() => dismiss.mutate(q.id)}
                className="shrink-0 rounded-md bg-black/30 px-2 text-sm font-bold"
              >
                ✕
              </button>
            </div>
            <p className="mt-1 text-sm font-medium">{q.message}</p>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-black/40">
                <div
                  className="h-full"
                  style={{
                    width: `${Math.min(100, (q.progress / q.targetChores) * 100)}%`,
                    background: player?.color ?? "var(--accent)",
                  }}
                />
              </div>
              <p className="text-xs font-black whitespace-nowrap">
                {q.progress}/{q.targetChores} chores · +{q.bonusPoints} bonus pts
              </p>
            </div>
          </article>
        );
      })}
    </section>
  );
}

// ---------------- Chore board ----------------

function ChoreBoard({
  state,
  celebrate,
}: {
  state: State;
  celebrate: (c: Omit<Celebration, "id">) => void;
}) {
  const groups: { cadence: Chore["cadence"]; heading: string }[] = [
    { cadence: "daily", heading: "⛏️ Today's Quests to Dig" },
    { cadence: "weekly", heading: "🗓️ This Week's Quests" },
    { cadence: "once", heading: "⭐ Bonus Star Quests" },
  ];
  return (
    <section aria-label="Chore board" className="flex flex-col gap-5">
      {groups.map((g) => {
        const chores = state.chores.filter((c) => c.cadence === g.cadence);
        if (chores.length === 0) return null;
        return (
          <div key={g.cadence}>
            <h3 className="font-display mb-2 text-base">{g.heading}</h3>
            {g.cadence === "daily" && (
              <p className="mb-2 rounded-[var(--radius)] border-2 border-red-500/60 bg-[#2a0f0f]/80 px-3 py-2 text-sm font-bold text-red-200">
                👹 Tap "did it" on ALL of today's quests before bed — a quest
                waiting for a parent check still counts! Leave any one
                untapped and a grumbler sneaks in tonight and takes a heart.
                Points land when a grown-up verifies each quest in the
                PIN-locked Grown-Up Zone.
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {chores.map((chore) => (
                <ChoreRow key={chore.id} chore={chore} state={state} celebrate={celebrate} />
              ))}
            </ul>
          </div>
        );
      })}
      {state.chores.length === 0 && (
        <p className="text-sm text-[var(--dim)]">
          No quests on the board yet. A grown-up can add some below.
        </p>
      )}
    </section>
  );
}

function ChoreRow({
  chore,
  state,
  celebrate,
}: {
  chore: Chore;
  state: State;
  celebrate: (c: Omit<Celebration, "id">) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const complete = useMutation({
    mutationFn: async (playerId: number) =>
      await api.completeChore({ choreId: chore.id, playerId }),
    onSuccess: (_data, playerId) => {
      setError(null);
      const p = playerById(state, playerId);
      celebrate({
        title: "👀 SENT FOR CHECKING!",
        subtitle: `${p?.name ?? "You"} tapped “${chore.title}” done! A grown-up will check it — the ${chore.points} points land the moment it's verified.`,
        emoji: "👀",
        color: p?.color ?? "var(--accent)",
        big: false,
      });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "That didn't save."),
  });
  const undo = useMutation({
    mutationFn: async (playerId: number) =>
      await api.undoCompletion({ choreId: chore.id, playerId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const eligible =
    chore.assignedPlayerId != null
      ? state.players.filter((p) => p.id === chore.assignedPlayerId)
      : state.players;
  const assigned = chore.assignedPlayerId
    ? playerById(state, chore.assignedPlayerId)
    : undefined;

  return (
    <li className="cc-item-drop rounded-[var(--radius)] bg-[var(--surface)] p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-bold">{chore.title}</p>
        <p className="shrink-0 font-display text-sm text-[var(--accent)]">
          +{chore.points}
        </p>
      </div>
      <p className="text-xs font-semibold text-[var(--dim)]">
        {CADENCE_LABEL[chore.cadence]}
        {assigned ? ` · ${assigned.name}'s quest` : " · open to both miners"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {eligible.map((p) => {
          const done = chore.doneByPlayerIds.includes(p.id);
          const waiting = !done && chore.pendingByPlayerIds.includes(p.id);
          if (done) {
            return (
              <button
                key={p.id}
                type="button"
                aria-label={`Undo ${chore.title} for ${p.name}`}
                onClick={() => undo.mutate(p.id)}
                className="cc-pop-in rounded-lg px-3 py-2 text-sm font-black text-black"
                style={{ background: p.color }}
              >
                ✓ {p.name} did it! (tap to undo)
              </button>
            );
          }
          if (waiting) {
            return (
              <button
                key={p.id}
                type="button"
                aria-label={`Withdraw ${chore.title} for ${p.name} — it is waiting for a parent to check it`}
                onClick={() => undo.mutate(p.id)}
                className="cc-pop-in rounded-lg border-2 border-dashed border-amber-400 bg-amber-400/15 px-3 py-2 text-left text-sm font-black text-amber-300"
              >
                👀 {p.name} — waiting for a parent to check it
                <span className="block text-xs font-bold text-amber-200/80">
                  points land when it's verified · tap to undo the tap
                </span>
              </button>
            );
          }
          return (
            <button
              key={p.id}
              type="button"
              aria-label={`Mark ${chore.title} done by ${p.name}`}
              disabled={complete.isPending}
              onClick={() => complete.mutate(p.id)}
              className="rounded-lg border-2 bg-transparent px-3 py-2 text-sm font-black disabled:opacity-50"
              style={{ borderColor: p.color, color: p.color }}
            >
              {p.emoji} {p.name} did it!
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm font-semibold text-red-300">{error}</p>}
    </li>
  );
}

// ---------------- Reward shop ----------------

function RewardShop({ state, pinGate }: { state: State; pinGate: PinGate }) {
  const queryClient = useQueryClient();
  const [buyerId, setBuyerId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const buyer = buyerId != null ? playerById(state, buyerId) : state.players[0];
  const redeem = useMutation({
    mutationFn: async (reward: Reward) => {
      if (!buyer) throw new Error("Pick a player first.");
      return await api.redeemReward({ rewardId: reward.id, playerId: buyer.id });
    },
    onSuccess: (_data, reward) => {
      setMessage(
        `🏆 ${reward.title} requested! A grown-up just needs to approve it.`,
      );
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) =>
      setMessage(e instanceof Error ? e.message : "That didn't go through."),
  });
  const resolve = useMutation({
    mutationFn: async (args: { id: number; approve: boolean }) => {
      if (!pinGate.token) {
        throw new Error(
          "Locked — a grown-up unlocks the Grown-Up Zone with the PIN to approve prizes.",
        );
      }
      return await api.resolveRedemption({ ...args, pinToken: pinGate.token });
    },
    onSuccess: () => {
      setResolveError(null);
      pinGate.poke();
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) =>
      setResolveError(e instanceof Error ? e.message : "That didn't save."),
  });

  const pending = state.redemptions.filter((r) => r.status === "pending");
  const history = state.redemptions.filter((r) => r.status !== "pending");

  return (
    <section aria-label="Reward shop">
      <h3 className="font-display mb-2 text-base">🏆 Prize Shop</h3>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold">Shopping for:</span>
        {state.players.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-label={`Shop as ${p.name}`}
            onClick={() => setBuyerId(p.id)}
            className="rounded-full px-3 py-1 text-sm font-black"
            style={{
              background: buyer?.id === p.id ? p.color : "transparent",
              color: buyer?.id === p.id ? "#000" : p.color,
              border: `2px solid ${p.color}`,
            }}
          >
            {p.emoji} {p.name} · ⭐ {p.balance}
          </button>
        ))}
      </div>

      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {state.rewards.map((r) => {
          const afford = buyer != null && buyer.balance >= r.cost;
          return (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 rounded-[var(--radius)] bg-[var(--surface)] p-3"
            >
              <div>
                <p className="font-bold">{r.title}</p>
                <p className="font-display text-sm text-[var(--accent)]">
                  {r.cost} pts
                </p>
              </div>
              <button
                type="button"
                aria-label={`Get ${r.title} for ${buyer?.name ?? "player"}`}
                disabled={!afford || redeem.isPending}
                onClick={() => redeem.mutate(r)}
                className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-black text-black disabled:opacity-40"
              >
                {afford ? "Get it!" : "Keep earning!"}
              </button>
            </li>
          );
        })}
      </ul>
      {state.rewards.length === 0 && (
        <p className="text-sm text-[var(--dim)]">
          The shop is empty — a grown-up can stock it below.
        </p>
      )}
      {message && <p className="mt-2 text-sm font-semibold">{message}</p>}

      {pending.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 text-sm font-black tracking-wide uppercase">
            Waiting for a grown-up ✅
          </h4>
          {pinGate.token == null ? (
            <p className="rounded-[var(--radius)] border-2 border-dashed border-[var(--border)] bg-[var(--surface)] p-3 text-sm font-semibold text-[var(--dim)]">
              🔒 Approving prizes is grown-up work — a parent unlocks the
              Grown-Up Zone below with the PIN, then Approve lights up here.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pending.map((r) => {
                const p = playerById(state, r.playerId);
                return (
                  <li
                    key={r.id}
                    className="rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] p-3"
                  >
                    <p className="font-bold">
                      {p?.emoji} {p?.name} wants: {r.rewardTitle}
                    </p>
                    <p className="text-sm text-[var(--dim)]">{r.cost} points</p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        aria-label={`Approve ${r.rewardTitle} for ${p?.name ?? "player"}`}
                        disabled={resolve.isPending}
                        onClick={() => resolve.mutate({ id: r.id, approve: true })}
                        className="rounded-lg bg-green-500 px-3 py-2 text-sm font-black text-black disabled:opacity-50"
                      >
                        Approve 👍
                      </button>
                      <button
                        type="button"
                        aria-label={`Decline ${r.rewardTitle} for ${p?.name ?? "player"}`}
                        disabled={resolve.isPending}
                        onClick={() => resolve.mutate({ id: r.id, approve: false })}
                        className="rounded-lg bg-red-400 px-3 py-2 text-sm font-black text-black disabled:opacity-50"
                      >
                        Not yet 👎
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {resolveError && (
            <p className="mt-2 text-sm font-semibold text-red-300">{resolveError}</p>
          )}
        </div>
      )}

      {history.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-sm text-[var(--dim)]">
          {history.slice(0, 5).map((r) => {
            const p = playerById(state, r.playerId);
            return (
              <li key={r.id}>
                {r.status === "approved" ? "✅" : "↩️"} {p?.name} · {r.rewardTitle} (
                {r.cost} pts)
                {r.status === "declined" && " — declined, points refunded"}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------- Recent activity ----------------

function RecentActivity({ state }: { state: State }) {
  if (state.recent.length === 0) return null;
  return (
    <section aria-label="Recent activity">
      <h3 className="font-display mb-2 text-base">⚡ Latest Adventures</h3>
      <ul className="flex flex-col gap-1">
        {state.recent.map((r) => {
          const p = playerById(state, r.playerId);
          return (
            <li
              key={`${r.id}-${r.label}`}
              className="flex items-baseline justify-between gap-2 rounded-lg bg-[var(--surface)] px-3 py-2 text-sm"
            >
              <span>
                <strong style={{ color: p?.color }}>{p?.name}</strong> · {r.label}
              </span>
              <span
                className={`shrink-0 font-black ${r.points < 0 ? "text-red-300" : "text-[var(--accent)]"}`}
              >
                {r.points < 0 ? r.points : `+${r.points}`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------- Grown-up zone ----------------
//
// The whole zone sits behind a 4-digit parent PIN. The first time a
// parent opens it, they create the PIN right here (typed twice) plus a
// recovery phrase only grown-ups know — no PIN is ever set from chat.
// Until the PIN unlocks it, NONE of the zone renders: no verification
// buttons, no points-off, no editing. Every action inside also carries
// the unlock token and the server refuses without a live one, so the
// lock is real, not just hidden buttons.

function GrownUpZone({ state, pinGate, onDeleted }: { state: State; pinGate: PinGate; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const waiting = state.pendingVerifications.length;
  const unlocked = pinGate.token != null;
  return (
    <section aria-label="Grown-up zone" className="border-t border-[var(--border)] pt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full rounded-lg bg-[var(--surface)] px-4 py-3 text-left font-display text-sm"
      >
        {unlocked ? "🔓" : "🔒"} Grown-Up Zone{" "}
        {waiting > 0 && (
          <span className="ml-1 rounded-full bg-amber-400 px-2 py-0.5 text-xs font-black text-black">
            👀 {waiting} to check
          </span>
        )}{" "}
        {open ? "▲" : "▼"}
      </button>
      {open && !unlocked && <PinPad pinGate={pinGate} />}
      {open && unlocked && pinGate.token && (
        <div className="mt-4 flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] px-3 py-2">
            <p className="text-sm font-bold">
              🔓 Unlocked for grown-ups. It locks itself after 3 quiet
              minutes — tap Lock now when you're done.
            </p>
            <button
              type="button"
              aria-label="Lock the Grown-Up Zone now"
              onClick={() => pinGate.lock()}
              className="shrink-0 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm font-black"
            >
              🔒 Lock now
            </button>
          </div>
          <NeedsChecking state={state} pinToken={pinGate.token} pinGate={pinGate} />
          <NotListeningPenalty state={state} pinToken={pinGate.token} pinGate={pinGate} />
          <PlayerEditor state={state} pinToken={pinGate.token} />
          <ChoreManager state={state} pinToken={pinGate.token} />
          <RewardManager state={state} pinToken={pinGate.token} />
          <ChangePinForm pinToken={pinGate.token} pinGate={pinGate} />
          <DeleteAccountForm pinToken={pinGate.token} pinGate={pinGate} onDeleted={onDeleted} />
        </div>
      )}
    </section>
  );
}

/** Grown-Up Zone only — never on the kid-facing board. Deleting an
 *  account is permanent: the account, kids, chores, points, prizes,
 *  quests, and PIN all go. It takes the account password to confirm,
 *  so a tap or a kid on an unlocked phone can't wipe the account by
 *  accident — and the server also requires the live PIN unlock when a
 *  PIN is set. On success the app signs out and shows a plain
 *  confirmation that the account is gone. */
function DeleteAccountForm({
  pinToken,
  pinGate,
  onDeleted,
}: {
  pinToken: string;
  pinGate: PinGate;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const del = useMutation({
    mutationFn: async () => await api.deleteAccount({ password, pinToken }),
    onSuccess: (data) => {
      if (!data.ok) {
        setError(data.error ?? "That didn't work. Try again.");
        return;
      }
      setPassword("");
      setError(null);
      // The account is gone: drop the local PIN unlock, then let the
      // app show the signed-out confirmation.
      pinGate.lock();
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: ["pinStatus"] });
      onDeleted();
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : "That didn't work."),
  });
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius)] border-2 border-red-500/70 bg-[#2a0f0f] p-3">
      <h4 className="font-display text-sm">🗑️ Delete my account</h4>
      {!confirming ? (
        <>
          <p className="text-sm text-[var(--dim)]">
            Remove your account and everything in it, for good.
          </p>
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
              setError(null);
            }}
            className="self-start rounded-lg border-2 border-red-400 px-4 py-2 text-sm font-black text-red-300"
          >
            Delete my account…
          </button>
        </>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (password.length > 0) del.mutate();
          }}
        >
          <p className="text-sm font-semibold">
            This is permanent and can't be undone. Your account, kids,
            chores, points, prizes, quests, and PIN will all be deleted.
            There is no way to get them back.
          </p>
          <label className={labelCls}>
            Type your account password to confirm
            <input
              aria-label="Account password to confirm deletion"
              className={inputCls}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={password.length === 0 || del.isPending}
              className="rounded-lg bg-red-500 px-4 py-2 text-sm font-black text-white disabled:opacity-40"
            >
              {del.isPending ? "Deleting…" : "Yes, delete it all"}
            </button>
            <button
              type="button"
              disabled={del.isPending}
              onClick={() => {
                setConfirming(false);
                setPassword("");
                setError(null);
              }}
              className="rounded-lg bg-[var(--surface-2)] px-4 py-2 text-sm font-black"
            >
              Keep my account
            </button>
          </div>
          {error && <p className="text-sm font-semibold text-red-300">{error}</p>}
        </form>
      )}
    </div>
  );
}

/** Four dots showing how many PIN digits have been tapped so far. */
function PinDots({ filled }: { filled: number }) {
  return (
    <div className="flex items-center justify-center gap-3 py-1" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="inline-block h-4 w-4 rounded-full border-2 border-[var(--accent)]"
          style={{ background: i < filled ? "var(--accent)" : "transparent" }}
        />
      ))}
    </div>
  );
}

/** A big tappable on-screen PIN pad. The PIN is tapped, never typed:
 *  the old version relied on the phone's on-screen keyboard feeding a
 *  masked password field, which is exactly where entry broke down on
 *  the family's phones and the Echo Show. Buttons work everywhere a
 *  tap works. */
function PinKeypad({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const keyCls =
    "rounded-lg bg-[var(--surface-2)] py-3 text-2xl font-black text-[var(--text)] disabled:opacity-40";
  const press = (digit: string) => {
    if (disabled || value.length >= 4) return;
    onChange(value + digit);
  };
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="PIN keypad">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
        <button
          key={d}
          type="button"
          aria-label={`PIN digit ${d}`}
          disabled={disabled}
          onClick={() => press(d)}
          className={keyCls}
        >
          {d}
        </button>
      ))}
      <span aria-hidden />
      <button
        type="button"
        aria-label="PIN digit 0"
        disabled={disabled}
        onClick={() => press("0")}
        className={keyCls}
      >
        0
      </button>
      <button
        type="button"
        aria-label="Delete the last PIN digit"
        disabled={disabled || value.length === 0}
        onClick={() => onChange(value.slice(0, -1))}
        className={keyCls}
      >
        ⌫
      </button>
    </div>
  );
}

/** The PIN pad: create-a-PIN on first use, enter-to-unlock after that,
 *  and a recovery-phrase reset for a forgotten PIN. Digits are tapped
 *  on the on-screen pad and a full 4-digit entry submits itself, wrong
 *  tries show the server's count, and during the brief lockout the pad
 *  disables itself with a live countdown. */
function PinPad({ pinGate }: { pinGate: PinGate }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["pinStatus"],
    queryFn: () => api.getPinStatus({}),
  });
  const [mode, setMode] = useState<"enter" | "forgot">("enter");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [recovery, setRecovery] = useState("");
  const [newRecovery, setNewRecovery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lockLeft, setLockLeft] = useState(0);
  // First-run setup walks pin -> confirm -> recovery on the keypad.
  const [setupStep, setSetupStep] = useState<"pin" | "confirm" | "recovery">(
    "pin",
  );

  // Live countdown while the pad is locked out after wrong tries.
  useEffect(() => {
    const serverLeft = status.data?.lockSecondsRemaining ?? 0;
    if (serverLeft > 0) setLockLeft((v) => Math.max(v, serverLeft));
  }, [status.data?.lockSecondsRemaining]);
  useEffect(() => {
    if (lockLeft <= 0) return;
    const t = setTimeout(
      () => setLockLeft((v) => Math.max(0, v - 1)),
      1000,
    );
    return () => clearTimeout(t);
  }, [lockLeft]);
  useEffect(() => {
    if (lockLeft === 0 && status.data?.locked) status.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockLeft]);

  const refreshStatus = () =>
    queryClient.invalidateQueries({ queryKey: ["pinStatus"] });

  const applyResult = (data: {
    ok: boolean;
    token: string | null;
    message: string;
    locked: boolean;
    lockSecondsRemaining: number;
  }) => {
    setPin("");
    setPinConfirm("");
    if (data.lockSecondsRemaining > 0) setLockLeft(data.lockSecondsRemaining);
    if (data.ok && data.token) {
      setError(null);
      setNote(null);
      pinGate.unlock(data.token);
      refreshStatus();
    } else if (data.ok) {
      // Recovery reset succeeded: PIN cleared, show the create form.
      setError(null);
      setNote(data.message);
      setMode("enter");
      setRecovery("");
      refreshStatus();
    } else {
      setNote(null);
      setError(data.message);
      refreshStatus();
    }
  };

  // A stalled gate call (the request or its answer dropped on the
  // phone's connection; every call now times out instead of hanging)
  // surfaces from the client as an unconfirmed outcome. The tap may
  // still have landed on the server — a wrong PIN may have counted, a
  // right one may have minted a session whose token never arrived —
  // so the honest recovery is: clear the pad, re-read the lock's real
  // state (tries left, lockout), and say plainly it may have gone
  // through. Re-entering a correct PIN is always safe: it just mints
  // a fresh session.
  const isStall = (e: unknown): boolean => {
    if (!(e instanceof Error)) return false;
    if ((e as { status?: unknown }).status === 0) return true;
    return /could not confirm|abort/i.test(e.message);
  };
  const gateError = (e: unknown, stallText: string) => {
    refreshStatus();
    setError(
      isStall(e)
        ? stallText
        : e instanceof Error
          ? e.message
          : "That didn't work.",
    );
  };

  const verify = useMutation({
    mutationFn: async (pinToTry: string) =>
      await api.verifyPin({ pin: pinToTry }),
    onSuccess: applyResult,
    onError: (e) => {
      setPin("");
      gateError(
        e,
        "That check didn't come back — the connection stalled, and it may have gone through on the app's side. The pad is ready again: if your PIN was right, tap it in once more and the zone will unlock.",
      );
    },
  });
  const setup = useMutation({
    mutationFn: async () =>
      await api.setupPin({ pin, recoveryPhrase: newRecovery }),
    onSuccess: (data) => {
      setNewRecovery("");
      applyResult(data);
    },
    onError: (e) =>
      gateError(
        e,
        "That setup didn't come back — the connection stalled, and it may have gone through. If the pad now asks you to enter a PIN, yours was created: tap it in to unlock. If it still asks you to create one, run through the steps again.",
      ),
  });
  const reset = useMutation({
    mutationFn: async () =>
      await api.resetPinWithRecovery({ recoveryPhrase: recovery }),
    onSuccess: (data) => {
      if (data.ok) setRecovery("");
      applyResult(data);
    },
    onError: (e) =>
      gateError(
        e,
        "That reset didn't come back — the connection stalled, and it may have gone through. If the pad now asks you to create a PIN, the reset worked. If it still asks for the PIN, try the recovery phrase again.",
      ),
  });

  // Keypad flow: a full 4-digit entry acts on its own — no separate
  // submit tap to miss. Unlocking submits the moment the fourth digit
  // lands; setup advances pin -> confirm, and a matching confirm moves
  // on to the recovery phrase (a mismatch clears just the confirm).
  useEffect(() => {
    if (!status.data?.hasPin || mode !== "enter") return;
    if (pin.length !== 4 || verify.isPending) return;
    if (lockLeft > 0 || status.data.locked) return;
    verify.mutate(pin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, mode, status.data?.hasPin, lockLeft]);
  useEffect(() => {
    if (status.data?.hasPin) return;
    if (setupStep === "pin" && pin.length === 4) setSetupStep("confirm");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, setupStep, status.data?.hasPin]);
  useEffect(() => {
    if (status.data?.hasPin || setupStep !== "confirm") return;
    if (pinConfirm.length !== 4) return;
    if (pinConfirm === pin) {
      setError(null);
      setSetupStep("recovery");
    } else {
      setError("Those two PINs didn't match — tap the second one again.");
      setPinConfirm("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinConfirm, setupStep, pin, status.data?.hasPin]);

  if (status.isPending) {
    return (
      <p className="mt-4 text-sm font-semibold text-[var(--dim)]">
        Checking the lock…
      </p>
    );
  }
  if (status.error) {
    return (
      <div className="mt-4 rounded-[var(--radius)] bg-[var(--surface)] p-4">
        <p className="text-sm font-semibold">
          The lock didn't answer. Your points are saved and safe.
        </p>
        <button
          type="button"
          onClick={() => status.refetch()}
          className="mt-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-black text-black"
        >
          Try again
        </button>
      </div>
    );
  }

  const hasPin = status.data.hasPin;
  const lockedOut = lockLeft > 0 || status.data.locked;

  // ----- First run: a parent creates the PIN -----
  if (!hasPin) {
    const recoveryReady = newRecovery.trim().length >= 6;
    return (
      <div className="mt-4 flex flex-col gap-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
        <h4 className="font-display text-sm">🔐 Grown-ups: create your PIN</h4>
        <p className="text-sm font-semibold text-[var(--dim)]">
          This zone checks chores, takes points off, and edits the board —
          so it stays behind a PIN only grown-ups know. Tap a 4-digit PIN
          on the pad, then tap it again to confirm it. Last, add a
          recovery phrase only grown-ups would know (at least 6 letters)
          — that's the only way back in if the PIN is ever forgotten.
          There's no tap-through reset, so the kids can't reset it
          themselves.
        </p>
        {setupStep === "pin" && (
          <>
            <p className="text-center text-sm font-bold">
              Step 1 of 3: tap your new PIN
            </p>
            <PinDots filled={pin.length} />
            <PinKeypad
              value={pin}
              onChange={(v) => {
                setError(null);
                setPin(v);
              }}
              disabled={setup.isPending}
            />
          </>
        )}
        {setupStep === "confirm" && (
          <>
            <p className="text-center text-sm font-bold">
              Step 2 of 3: tap it again to confirm
            </p>
            <PinDots filled={pinConfirm.length} />
            <PinKeypad
              value={pinConfirm}
              onChange={(v) => {
                setError(null);
                setPinConfirm(v);
              }}
              disabled={setup.isPending}
            />
            <button
              type="button"
              onClick={() => {
                setSetupStep("pin");
                setPin("");
                setPinConfirm("");
                setError(null);
              }}
              className="self-center text-sm font-bold text-[var(--dim)] underline"
            >
              Start over
            </button>
          </>
        )}
        {setupStep === "recovery" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (recoveryReady) setup.mutate();
            }}
          >
            <p className="text-center text-sm font-bold">
              Step 3 of 3: a recovery phrase only grown-ups know
            </p>
            <PinDots filled={4} />
            <label className={labelCls}>
              Recovery phrase (only grown-ups know it)
              <input
                aria-label="Recovery phrase only grown-ups know"
                className={inputCls}
                type="password"
                autoComplete="off"
                value={newRecovery}
                onChange={(e) => setNewRecovery(e.target.value)}
                placeholder="e.g. grandma's maiden name + first pet"
              />
            </label>
            {!recoveryReady && (
              <p className="text-sm font-semibold text-[var(--dim)]">
                The phrase needs at least 6 letters before the button
                lights up.
              </p>
            )}
            <button
              type="submit"
              disabled={!recoveryReady || setup.isPending}
              className="rounded-lg bg-[var(--accent)] px-4 py-3 font-black text-black disabled:opacity-40"
            >
              {setup.isPending ? "Setting it up…" : "Create PIN & unlock"}
            </button>
            <button
              type="button"
              onClick={() => {
                setSetupStep("pin");
                setPin("");
                setPinConfirm("");
                setError(null);
              }}
              className="self-center text-sm font-bold text-[var(--dim)] underline"
            >
              Start over
            </button>
          </form>
        )}
        {note && <p className="text-sm font-semibold">{note}</p>}
        {error && <p className="text-sm font-semibold text-red-300">{error}</p>}
      </div>
    );
  }

  // ----- Forgotten PIN: recovery phrase only -----
  if (mode === "forgot") {
    return (
      <form
        className="mt-4 flex flex-col gap-3 rounded-[var(--radius)] bg-[var(--surface)] p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (recovery.trim() !== "" && !lockedOut) reset.mutate();
        }}
      >
        <h4 className="font-display text-sm">🔑 Forgot the PIN?</h4>
        <p className="text-sm font-semibold text-[var(--dim)]">
          Only a grown-up can reset it: type the recovery phrase chosen
          when the PIN was created. If it matches, the old PIN is cleared
          and you set a new one. Wrong phrases count toward the same
          lockout as wrong PINs — there's no other way through, on purpose.
        </p>
        <label className={labelCls}>
          Recovery phrase
          <input
            aria-label="Recovery phrase"
            className={inputCls}
            type="password"
            autoComplete="off"
            value={recovery}
            onChange={(e) => setRecovery(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={recovery.trim() === "" || lockedOut || reset.isPending}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 font-black text-black disabled:opacity-40"
          >
            {reset.isPending ? "Checking…" : "Reset PIN"}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("enter");
              setError(null);
              setNote(null);
            }}
            className="rounded-lg bg-[var(--surface-2)] px-4 py-2 font-bold"
          >
            Back to PIN
          </button>
        </div>
        {lockedOut && (
          <p className="text-sm font-semibold text-amber-300" role="status">
            ⏳ Locked — try again in {lockLeft} seconds.
          </p>
        )}
        {note && <p className="text-sm font-semibold">{note}</p>}
        {error && <p className="text-sm font-semibold text-red-300">{error}</p>}
      </form>
    );
  }

  // ----- Locked: enter the PIN -----
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
      <h4 className="font-display text-sm">🔒 Grown-ups only — enter the PIN</h4>
      <p className="text-sm font-semibold text-[var(--dim)]">
        Checking chores, points off, and editing the board all live behind
        the PIN so the kids can't approve their own work. Tap your
        4-digit PIN on the pad — it unlocks the moment the fourth digit
        lands.
      </p>
      <PinDots filled={pin.length} />
      <PinKeypad
        value={pin}
        onChange={(v) => {
          setError(null);
          setPin(v);
        }}
        disabled={lockedOut || verify.isPending}
      />
      <button
        type="button"
        onClick={() => {
          if (pin.length === 4 && !lockedOut) verify.mutate(pin);
        }}
        disabled={pin.length !== 4 || lockedOut || verify.isPending}
        className="rounded-lg bg-[var(--accent)] px-4 py-3 font-black text-black disabled:opacity-40"
      >
        {verify.isPending ? "Checking…" : "Unlock"}
      </button>
      {lockedOut ? (
        <p className="text-sm font-semibold text-amber-300" role="status">
          ⏳ Too many wrong tries — the PIN pad is locked for {lockLeft}{" "}
          more seconds.
        </p>
      ) : (
        status.data.attemptsRemaining < status.data.maxAttempts && (
          <p className="text-sm font-semibold text-amber-300" role="status">
            {status.data.attemptsRemaining}{" "}
            {status.data.attemptsRemaining === 1 ? "try" : "tries"} left
            before a short lockout.
          </p>
        )
      )}
      {error && <p className="text-sm font-semibold text-red-300">{error}</p>}
      <button
        type="button"
        onClick={() => {
          setMode("forgot");
          setError(null);
          setNote(null);
        }}
        className="self-start text-sm font-bold text-[var(--dim)] underline"
      >
        Forgot the PIN?
      </button>
    </div>
  );
}

/** Change the PIN from inside the unlocked zone. */
function ChangePinForm({
  pinToken,
  pinGate,
}: {
  pinToken: string;
  pinGate: PinGate;
}) {
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [activeField, setActiveField] = useState<"pin" | "confirm">("pin");
  const [recovery, setRecovery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: async () =>
      await api.changePin({
        pinToken,
        pin,
        ...(recovery.trim().length >= 6
          ? { recoveryPhrase: recovery }
          : {}),
      }),
    onSuccess: () => {
      setPin("");
      setPinConfirm("");
      setRecovery("");
      setError(null);
      setNote("✅ PIN changed. Use the new one next time the zone locks.");
      pinGate.poke();
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : "That didn't save."),
  });
  const mismatch = pinConfirm !== "" && pin !== pinConfirm;
  const ready = /^\d{4}$/.test(pin) && pin === pinConfirm;
  return (
    <form
      className="flex flex-col gap-2 rounded-[var(--radius)] bg-[var(--surface)] p-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (ready) change.mutate();
      }}
    >
      <h4 className="font-display text-sm">🔐 Change the PIN</h4>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-label="Enter the new PIN on the keypad"
          aria-pressed={activeField === "pin"}
          onClick={() => setActiveField("pin")}
          className={`rounded-lg border-2 px-3 py-2 text-left ${
            activeField === "pin"
              ? "border-[var(--accent)]"
              : "border-[var(--border)]"
          }`}
        >
          <span className="text-sm font-bold">New PIN</span>
          <PinDots filled={pin.length} />
        </button>
        <button
          type="button"
          aria-label="Enter the new PIN again on the keypad to confirm"
          aria-pressed={activeField === "confirm"}
          onClick={() => setActiveField("confirm")}
          className={`rounded-lg border-2 px-3 py-2 text-left ${
            activeField === "confirm"
              ? "border-[var(--accent)]"
              : "border-[var(--border)]"
          }`}
        >
          <span className="text-sm font-bold">Again to confirm</span>
          <PinDots filled={pinConfirm.length} />
        </button>
        <PinKeypad
          value={activeField === "pin" ? pin : pinConfirm}
          onChange={(v) => {
            if (activeField === "pin") setPin(v);
            else setPinConfirm(v);
          }}
          disabled={change.isPending}
        />
      </div>
      {mismatch && (
        <p className="text-sm font-semibold text-red-300">
          Those two PINs don't match yet.
        </p>
      )}
      <label className={labelCls}>
        New recovery phrase (optional — leave blank to keep the old one)
        <input
          aria-label="New recovery phrase, optional"
          className={inputCls}
          type="password"
          autoComplete="off"
          value={recovery}
          onChange={(e) => setRecovery(e.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={!ready || change.isPending}
        className="self-start rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-black text-black disabled:opacity-40"
      >
        {change.isPending ? "Saving…" : "Change PIN"}
      </button>
      {note && <p className="text-sm font-semibold">{note}</p>}
      {error && <p className="text-sm font-semibold text-red-300">{error}</p>}
    </form>
  );
}

// ---------------- Parent verification ----------------

/** The "Needs checking" list: chores a kid tapped, waiting for a parent.
 *  "Yes, they did it" awards the held points; "Not done" sends the chore
 *  back open with no points. This is the only place verification lives —
 *  never on the kid-facing chore cards. */
function NeedsChecking({
  state,
  pinToken,
  pinGate,
}: {
  state: State;
  pinToken: string;
  pinGate: PinGate;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const verify = useMutation({
    mutationFn: async (args: { completionId: number; approve: boolean }) =>
      await api.verifyCompletion({ ...args, pinToken }),
    onSuccess: (data, args) => {
      pinGate.poke();
      setError(null);
      const item = state.pendingVerifications.find((v) => v.id === args.completionId);
      const who = item ? (playerById(state, item.playerId)?.name ?? "Player") : "Player";
      if (!args.approve) {
        setNote(
          `↩️ Sent back: “${item?.choreTitle ?? "That chore"}” is open again for ${who} — no points.`,
        );
      } else if (data.rallied) {
        setNote(`💚 ${who} rallied! Back in the game with fresh hearts.`);
      } else if (data.knockedOut) {
        setNote(
          `👹 Verified, but ${who} is still knocked out — that one counted toward the Rally Quest, no points yet.`,
        );
      } else {
        setNote(
          `✅ Verified! ${who} earned +${data.points} pts for “${item?.choreTitle ?? "that chore"}”${data.questCompleted ? " — and finished a side quest!" : ""}${data.bossDefeated ? " — and landed the final hit on the Monster Boss!" : ""}${data.tierUp ? ` — LEVEL UP to ${data.tierUp}!` : ""}${data.heartGained ? " A heart came back too! ❤️" : ""}${data.chestTier ? " A treasure chest dropped!" : ""}`,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "That didn't save."),
  });

  return (
    <div>
      <h4 className="font-display mb-2 text-sm">👀 Needs checking</h4>
      {state.pendingVerifications.length === 0 ? (
        <p className="rounded-[var(--radius)] bg-[var(--surface)] p-3 text-sm font-semibold text-[var(--dim)]">
          Nothing waiting right now. When a kid taps "did it", the chore
          lands here — its points are held until you check it.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {state.pendingVerifications.map((v) => {
            const p = playerById(state, v.playerId);
            return (
              <li
                key={v.id}
                className="rounded-[var(--radius)] border-2 border-amber-400/70 bg-[var(--surface)] p-3"
              >
                <p className="font-bold">
                  {p?.emoji} {p?.name} says they did: {v.choreTitle}
                </p>
                <p className="text-sm text-[var(--dim)]">
                  +{v.points} pts held ·{" "}
                  {v.day === state.today ? "today" : `tapped ${v.day}`}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-label={`Yes, ${p?.name ?? "they"} did ${v.choreTitle} — award ${v.points} points`}
                    disabled={verify.isPending}
                    onClick={() => verify.mutate({ completionId: v.id, approve: true })}
                    className="rounded-lg bg-green-500 px-3 py-2 text-sm font-black text-black disabled:opacity-50"
                  >
                    ✅ Yes, they did it
                  </button>
                  <button
                    type="button"
                    aria-label={`Not done — send ${v.choreTitle} back open for ${p?.name ?? "player"} with no points`}
                    disabled={verify.isPending}
                    onClick={() => verify.mutate({ completionId: v.id, approve: false })}
                    className="rounded-lg bg-red-400 px-3 py-2 text-sm font-black text-black disabled:opacity-50"
                  >
                    ↩️ Not done
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {note && <p className="mt-2 text-sm font-semibold">{note}</p>}
      {error && <p className="mt-2 text-sm font-semibold text-red-300">{error}</p>}
    </div>
  );
}

// ---------------- Points off for not listening ----------------

/** Grown-Up Zone only — never on the kid-facing cards. A parent picks
 *  how many points come off (5, 10, 15, or 20 — 5 by default), picks
 *  the kid, and taps to take that many off their WEEKLY score when
 *  they don't do what they're told the first time. The spendable prize
 *  balance is untouched, the weekly score never drops below zero, and
 *  this has nothing to do with grumbler hearts. */
const PENALTY_AMOUNTS = [5, 10, 15, 20] as const;
type PenaltyAmount = (typeof PENALTY_AMOUNTS)[number];

function NotListeningPenalty({
  state,
  pinToken,
  pinGate,
}: {
  state: State;
  pinToken: string;
  pinGate: PinGate;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState<PenaltyAmount>(5);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deduct = useMutation({
    mutationFn: async (playerId: number) =>
      await api.deductForNotListening({ playerId, points: amount, pinToken }),
    onSuccess: (data, playerId) => {
      pinGate.poke();
      setError(null);
      const p = playerById(state, playerId);
      setNote(
        `👂 ${data.deducted} points off ${p?.name ?? "that player"} for not listening the first time — now at ${data.weekPoints} pts this week. Prize balance untouched.`,
      );
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "That didn't save."),
  });

  return (
    <div>
      <h4 className="font-display mb-2 text-sm">👂 Points off for not listening</h4>
      <p className="mb-3 rounded-[var(--radius)] bg-[var(--surface)] p-3 text-sm font-semibold text-[var(--dim)]">
        Didn't do what they were told the first time? Pick how many
        points come off this week's score, then tap the kid. It never
        touches their spendable prize points, the score never drops
        below zero, and it shows in Latest Adventures as “Didn't listen
        the first time — {amount} points off”.
      </p>
      <div className="mb-3">
        <p className="mb-2 text-sm font-bold">How many points off?</p>
        <div
          role="group"
          aria-label="How many points to take off"
          className="flex flex-wrap gap-2"
        >
          {PENALTY_AMOUNTS.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={amount === n}
              aria-label={`Take off ${n} points`}
              onClick={() => setAmount(n)}
              className={
                amount === n
                  ? "rounded-lg bg-red-400 px-4 py-2 text-base font-black text-black"
                  : "rounded-lg border-2 border-red-400/50 bg-[var(--surface)] px-4 py-2 text-base font-black text-red-300"
              }
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {state.players.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-2 rounded-[var(--radius)] border-2 border-red-400/50 bg-[var(--surface)] p-3"
          >
            <div className="min-w-0">
              <p className="font-bold">
                {p.emoji} {p.name}
              </p>
              <p className="text-sm text-[var(--dim)]">
                {p.weekPoints} pts this week · ⭐ {p.balance} to spend (stays put)
              </p>
            </div>
            <button
              type="button"
              aria-label={`Take ${amount} points off ${p.name} for not listening the first time`}
              disabled={deduct.isPending}
              onClick={() => deduct.mutate(p.id)}
              className="shrink-0 rounded-lg bg-red-400 px-3 py-2 text-sm font-black text-black disabled:opacity-50"
            >
              −{amount} pts
            </button>
          </li>
        ))}
      </ul>
      {note && <p className="mt-2 text-sm font-semibold">{note}</p>}
      {error && <p className="mt-2 text-sm font-semibold text-red-300">{error}</p>}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[var(--text)]";
const labelCls = "block text-xs font-black tracking-wide uppercase text-[var(--dim)]";

function PlayerEditor({ state, pinToken }: { state: State; pinToken: string }) {
  return (
    <div>
      <h4 className="font-display mb-2 text-sm">Players</h4>
      <AddPlayerForm pinToken={pinToken} />
      <div className="flex flex-col gap-3">
        {state.players.map((p) => (
          <PlayerForm key={p.id} player={p} pinToken={pinToken} />
        ))}
      </div>
    </div>
  );
}

const PLAYER_COLORS = ["#e53935", "#f9d13b", "#5eb83a", "#2f7fd0", "#b537f2", "#ff8a3d"];

/** Grown-Up Zone only: add a kid to this account's board. */
function AddPlayerForm({ pinToken }: { pinToken: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [age, setAge] = useState("9");
  const [emoji, setEmoji] = useState("😀");
  const [color, setColor] = useState(PLAYER_COLORS[2]!);
  const [note, setNote] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async () =>
      await api.addPlayer({
        name,
        age: Number(age) || 9,
        color,
        emoji: emoji || "😀",
        pinToken,
      }),
    onSuccess: () => {
      setName("");
      setNote("Player added — they're on the board!");
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (e) =>
      setNote(e instanceof Error ? e.message : "Could not add that player."),
  });
  return (
    <form
      className="mb-3 rounded-[var(--radius)] bg-[var(--surface)] p-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setNote(null);
        add.mutate();
      }}
    >
      <p className="mb-2 text-sm font-bold">Add a kid</p>
      <div className="grid grid-cols-[1fr_5rem_4rem] items-end gap-2">
        <label className={labelCls}>
          Name
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Kid's name"
          />
        </label>
        <label className={labelCls}>
          Age
          <input
            className={inputCls}
            inputMode="numeric"
            value={age}
            onChange={(e) => setAge(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Avatar
          <input
            className={inputCls}
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
          />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs font-bold text-[var(--dim)]">Color:</span>
        {PLAYER_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Pick color ${c}`}
            onClick={() => setColor(c)}
            className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-white" : "border-black/40"}`}
            style={{ background: c }}
          />
        ))}
        <button
          type="submit"
          disabled={add.isPending}
          className="ml-auto rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-black text-black disabled:opacity-60"
        >
          {add.isPending ? "Adding…" : "Add player"}
        </button>
      </div>
      {note && <p className="mt-2 text-sm font-semibold">{note}</p>}
    </form>
  );
}

function PlayerForm({ player, pinToken }: { player: Player; pinToken: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(player.name);
  const [age, setAge] = useState(String(player.age));
  const [emoji, setEmoji] = useState(player.emoji);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: async () =>
      await api.updatePlayer({
        id: player.id,
        name,
        age: Number(age) || player.age,
        emoji: emoji || player.emoji,
        color: player.color,
        pinToken,
      }),
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  return (
    <form
      className="grid grid-cols-[1fr_5rem_4rem_auto] items-end gap-2 rounded-[var(--radius)] bg-[var(--surface)] p-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className={labelCls}>
        Name
        <input
          aria-label={`${player.name} name`}
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className={labelCls}>
        Age
        <input
          aria-label={`${player.name} age`}
          className={inputCls}
          inputMode="numeric"
          value={age}
          onChange={(e) => setAge(e.target.value)}
        />
      </label>
      <label className={labelCls}>
        Avatar
        <input
          aria-label={`${player.name} avatar emoji`}
          className={inputCls}
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
        />
      </label>
      <button
        type="submit"
        className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-black text-black"
      >
        {saved && !save.isPending ? "Saved ✓" : "Save"}
      </button>
    </form>
  );
}

function ChoreManager({ state, pinToken }: { state: State; pinToken: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [points, setPoints] = useState("10");
  const [cadence, setCadence] = useState<Chore["cadence"]>("daily");
  const [assignee, setAssignee] = useState<string>("");
  const [editingId, setEditingId] = useState<number | null>(null);
  // Removing a chore is permanent for the board, so the first tap only
  // arms a confirm on that row; the second tap actually removes it.
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });
  const add = useMutation({
    mutationFn: async () =>
      await api.addChore({
        title,
        points: Number(points) || 10,
        cadence,
        assignedPlayerId: assignee === "" ? null : Number(assignee),
        pinToken,
      }),
    onSuccess: () => {
      setTitle("");
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: async () =>
      await api.updateChore({
        id: editingId ?? 0,
        title,
        points: Number(points) || 10,
        cadence,
        assignedPlayerId: assignee === "" ? null : Number(assignee),
        pinToken,
      }),
    onSuccess: () => {
      setEditingId(null);
      setTitle("");
      invalidate();
    },
  });
  const del = useMutation({
    mutationFn: async (id: number) => await api.deleteChore({ id, pinToken }),
    onSuccess: () => {
      setConfirmRemoveId(null);
      invalidate();
    },
  });

  const startEdit = (c: Chore) => {
    setConfirmRemoveId(null);
    setEditingId(c.id);
    setTitle(c.title);
    setPoints(String(c.points));
    setCadence(c.cadence);
    setAssignee(c.assignedPlayerId != null ? String(c.assignedPlayerId) : "");
  };

  return (
    <div>
      <h4 className="font-display mb-2 text-sm">Quests (chores)</h4>
      <form
        className="mb-3 flex flex-col gap-2 rounded-[var(--radius)] bg-[var(--surface)] p-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (editingId != null) update.mutate();
          else add.mutate();
        }}
      >
        <label className={labelCls}>
          Chore
          <input
            aria-label="Chore title"
            className={inputCls}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Water the plants"
          />
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className={labelCls}>
            Points
            <input
              aria-label="Chore points"
              className={inputCls}
              inputMode="numeric"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            How often
            <select
              aria-label="Chore frequency"
              className={inputCls}
              value={cadence}
              onChange={(e) => setCadence(e.target.value as Chore["cadence"])}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="once">One-time</option>
            </select>
          </label>
          <label className={labelCls}>
            Whose
            <select
              aria-label="Chore assignment"
              className={inputCls}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">Both players</option>
              {state.players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={title.trim() === ""}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-black text-black disabled:opacity-40"
          >
            {editingId != null ? "Save changes" : "Add quest"}
          </button>
          {editingId != null && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setTitle("");
              }}
              className="rounded-lg bg-[var(--surface-2)] px-4 py-2 text-sm font-bold"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
      <ul className="flex flex-col gap-1">
        {state.chores.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface)] px-3 py-2 text-sm"
          >
            {confirmRemoveId === c.id ? (
              <>
                <span>
                  Remove <strong>{c.title}</strong> from the board? Points
                  already earned from it stay in the records.
                </span>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label={`Yes, remove ${c.title} from the board`}
                    disabled={del.isPending}
                    onClick={() => del.mutate(c.id)}
                    className="rounded-md bg-red-700 px-2 py-1 font-bold text-white disabled:opacity-40"
                  >
                    {del.isPending ? "Removing…" : "Yes, remove"}
                  </button>
                  <button
                    type="button"
                    aria-label={`Keep ${c.title} on the board`}
                    onClick={() => setConfirmRemoveId(null)}
                    className="rounded-md bg-[var(--surface-2)] px-2 py-1 font-bold"
                  >
                    Keep it
                  </button>
                </span>
              </>
            ) : (
              <>
                <span>
                  <strong>{c.title}</strong> · {c.points} pts ·{" "}
                  {CADENCE_LABEL[c.cadence]}
                  {c.assignedPlayerId != null &&
                    ` · ${playerById(state, c.assignedPlayerId)?.name ?? ""}`}
                </span>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label={`Edit ${c.title}`}
                    onClick={() => startEdit(c)}
                    className="rounded-md bg-[var(--surface-2)] px-2 py-1 font-bold"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${c.title}`}
                    onClick={() => setConfirmRemoveId(c.id)}
                    className="rounded-md bg-[var(--surface-2)] px-2 py-1 font-bold text-red-300"
                  >
                    Remove
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RewardManager({ state, pinToken }: { state: State; pinToken: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [cost, setCost] = useState("100");
  const [editingId, setEditingId] = useState<number | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });
  const add = useMutation({
    mutationFn: async () =>
      await api.addReward({ title, cost: Number(cost) || 100, pinToken }),
    onSuccess: () => {
      setTitle("");
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: async () =>
      await api.updateReward({
        id: editingId ?? 0,
        title,
        cost: Number(cost) || 100,
        pinToken,
      }),
    onSuccess: () => {
      setEditingId(null);
      setTitle("");
      invalidate();
    },
  });
  const del = useMutation({
    mutationFn: async (id: number) => await api.deleteReward({ id, pinToken }),
    onSuccess: invalidate,
  });

  return (
    <div>
      <h4 className="font-display mb-2 text-sm">Prize shop items</h4>
      <form
        className="mb-3 flex flex-col gap-2 rounded-[var(--radius)] bg-[var(--surface)] p-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (editingId != null) update.mutate();
          else add.mutate();
        }}
      >
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <label className={labelCls}>
            Reward
            <input
              aria-label="Reward title"
              className={inputCls}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Pick a fun outing"
            />
          </label>
          <label className={labelCls}>
            Cost (pts)
            <input
              aria-label="Reward cost"
              className={inputCls}
              inputMode="numeric"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </label>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={title.trim() === ""}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-black text-black disabled:opacity-40"
          >
            {editingId != null ? "Save changes" : "Add reward"}
          </button>
          {editingId != null && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setTitle("");
              }}
              className="rounded-lg bg-[var(--surface-2)] px-4 py-2 text-sm font-bold"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
      <ul className="flex flex-col gap-1">
        {state.rewards.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface)] px-3 py-2 text-sm"
          >
            <span>
              <strong>{r.title}</strong> · {r.cost} pts
            </span>
            <span className="flex shrink-0 gap-1">
              <button
                type="button"
                aria-label={`Edit ${r.title}`}
                onClick={() => {
                  setEditingId(r.id);
                  setTitle(r.title);
                  setCost(String(r.cost));
                }}
                className="rounded-md bg-[var(--surface-2)] px-2 py-1 font-bold"
              >
                Edit
              </button>
              <button
                type="button"
                aria-label={`Remove ${r.title}`}
                onClick={() => del.mutate(r.id)}
                className="rounded-md bg-[var(--surface-2)] px-2 py-1 font-bold text-red-300"
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
