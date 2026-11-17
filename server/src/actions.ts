// Chore Champions — game engine actions.
//
// Points flow: tapping "did it" inserts a `completions` row with status
// "pending" (points snapshotted but held). A parent verifies it from the
// Grown-Up Zone ("verified" — points land, quests/boss/hearts settle) or
// sends it back ("rejected" — chore reopens, no points). Only verified
// rows count in loadStats. Bonuses (quests, streak saves) insert
// `bonuses` rows.
// A player's balance = completions + bonuses - approved/pending redemptions.
// The week runs Monday-Sunday in America/Chicago (the family's timezone);
// daily chores reset each local day, weekly chores each Monday — both fall
// out of comparing completion `day` strings, and the daily cron action
// (resetDaily) additionally crowns last week's Star Champion and expires
// stale quests.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "./db";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import * as schema from "./schema";
import {
  createSession,
  clearSessionCookie,
  deleteSession,
  hashPassword,
  hashToken,
  isValidEmail,
  sessionCookie,
  verifyPassword,
  type SessionStore,
  type SessionUser,
} from "./auth";
import { sendPasswordResetEmail } from "./email";
import { allow, reset as resetLimit } from "./ratelimit";

/** Fallback timezone; real play uses the account's own timezone. */
const DEFAULT_TZ = "America/Chicago";

// ---------- standalone action plumbing (replaces the Muse SDK) ----------

/** The context every action handler receives. */
export interface ActionContext {
  db: Db;
  /** Raw session token from the cookie (needed to sign out), or null. */
  sessionToken: string | null;
  /** The caller, resolved from the session cookie, or null. */
  user: SessionUser | null;
  /** Client IP for rate limits. */
  ip: string;
  /** Cookies the handler wants set on the response. */
  cookies: string[];
}

type Handler<Req extends z.ZodType, Res extends z.ZodType> = (
  ctx: ActionContext,
  args: z.infer<Req>,
) => Promise<z.infer<Res>>;

interface ActionDef<Req extends z.ZodType, Res extends z.ZodType> {
  description: string;
  request: Req;
  response: Res;
  handler: Handler<Req, Res>;
}

function defineAction<Req extends z.ZodType, Res extends z.ZodType>(
  def: ActionDef<Req, Res>,
): ActionDef<Req, Res> {
  return def;
}

/** The signed-in account, or a thrown "Please sign in" for the client. */
function requireUser(ctx: ActionContext): SessionUser {
  if (!ctx.user) throw new Error("Please sign in to play Chore Champions.");
  return ctx.user;
}

/** The account's own timezone (the day, week, and grumbler check all run in it). */
function userTz(user: SessionUser): string {
  return user.timezone || DEFAULT_TZ;
}

// Rate limits (per IP / per email).
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const SIGNUPS_PER_IP_PER_HOUR = 10;
const SIGNIN_PER_IP_PER_15_MIN = 30;
const SIGNIN_FAILURES_PER_EMAIL_PER_15_MIN = 10;
const DELETE_PER_IP_PER_15_MIN = 10;
const DELETE_FAILURES_PER_EMAIL_PER_15_MIN = 10;
// Password resets: a link lives 1 hour and works once. Requests are
// capped per IP and per email; over the cap the caller still gets the
// same generic message, so the cap never leaks whether an email has
// an account.
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const RESET_REQUEST_PER_IP_PER_15_MIN = 10;
const RESET_REQUEST_PER_EMAIL_PER_HOUR = 5;
const RESET_ATTEMPTS_PER_IP_PER_15_MIN = 10;

// ---------- date helpers (all in the family's timezone) ----------

function dayKey(d: Date, tz: string = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function todayKey(tz: string = DEFAULT_TZ): string {
  return dayKey(new Date(), tz);
}

function shiftDay(key: string, delta: number): string {
  const [y = 2026, m = 1, d = 1] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

/** Monday (YYYY-MM-DD) of the week containing the given day key. */
function mondayOf(key: string): string {
  const [y = 2026, m = 1, d = 1] = key.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  const back = (dow + 6) % 7;
  return shiftDay(key, -back);
}

// ---------- levels (XP-style progression) ----------

const TIERS: { min: number; name: string }[] = [
  { min: 0, name: "Sprout Scout" },
  { min: 100, name: "Pebble Miner" },
  { min: 250, name: "Copper Crafter" },
  { min: 500, name: "Silver Seeker" },
  { min: 900, name: "Gold Gatherer" },
  { min: 1400, name: "Gem Hunter" },
  { min: 2200, name: "Crystal Champion" },
];

// ---------- avatar looks (unlocked by lifetime points) ----------

export const AVATAR_ITEMS: {
  key: string;
  name: string;
  emoji: string;
  unlockAt: number;
  frame: string;
}[] = [
  { key: "starter", name: "Starter Scout", emoji: "", unlockAt: 0, frame: "" },
  { key: "ninja", name: "Shadow Ninja", emoji: "🥷", unlockAt: 100, frame: "#7b2fbe" },
  { key: "pirate", name: "Ocean Captain", emoji: "🏴‍☠️", unlockAt: 200, frame: "#2f7fd0" },
  { key: "hero", name: "Gem Hero", emoji: "🦸", unlockAt: 350, frame: "#4aedd9" },
  { key: "robot", name: "Stone Guardian", emoji: "🤖", unlockAt: 500, frame: "#b8c0c8" },
  { key: "dragon", name: "Ember Dragon Rider", emoji: "🐉", unlockAt: 900, frame: "#9b30ff" },
  { key: "wizard", name: "Mystic Wizard", emoji: "🧙", unlockAt: 1400, frame: "#3ddc5a" },
  { key: "legend", name: "Crystal Champion", emoji: "👑", unlockAt: 2200, frame: "#f9d13b" },
];

function avatarItem(key: string) {
  return AVATAR_ITEMS.find((a) => a.key === key) ?? AVATAR_ITEMS[0];
}

// ---------- weekly boss catalog ----------

const BOSSES: { name: string; emoji: string; taunt: string; maxHp: number }[] = [
  { name: "King Grumbler", emoji: "👹", taunt: "GRRR! I'll grumble your whole chore board away if you don't clean up! GRRR!", maxHp: 300 },
  { name: "Mud Brute", emoji: "🟤", taunt: "SPLAT! I'm muddy, I'm messy, and I'll track dirt through every room!", maxHp: 320 },
  { name: "Bone Baron", emoji: "💀", taunt: "My bone arrows will pin your chores to the wall — try and stop me!", maxHp: 340 },
  { name: "Ember Dragon", emoji: "🐲", taunt: "I rule the ember caves and hoard all the lost socks and toys. ROAR!", maxHp: 360 },
  { name: "Giant Goo King", emoji: "🟢", taunt: "Bounce bounce! I split into a hundred messy goo blobs — clean me up if you can!", maxHp: 380 },
  { name: "Cave Crawler Queen", emoji: "🕷️", taunt: "I spin webs in every corner and hide your stuff in the dark!", maxHp: 400 },
];

// ---------- hearts & the nightly grumbler ----------

const MAX_HEARTS = 5;
const RALLY_HEARTS = 3;

// ---------- not-listening penalty (Grown-Up Zone only) ----------
// A parent picks how many points to take off a kid's WEEKLY score when
// they don't do what they're told the first time, from these presets.
// Weekly only: the spendable prize balance and lifetime points are
// never touched, and the weekly score never drops below zero.
const LISTENING_PENALTY_AMOUNTS = [5, 10, 15, 20] as const;
type ListeningPenaltyAmount = (typeof LISTENING_PENALTY_AMOUNTS)[number];
const listeningPenaltyLabel = (points: number) =>
  `Didn't listen the first time — ${points} points off`;

// ---------- Grown-Up Zone PIN gate ----------
// The PIN itself is never stored — only a salted SHA-256 hash (same for
// the recovery phrase). Unlocking mints a random session token; only its
// hash is stored, it slides forward on every protected action, and it
// dies after PIN_SESSION_IDLE_MS with no protected action, so the zone
// locks itself after a few idle minutes (the client also locks on
// pagehide / close). After MAX_PIN_ATTEMPTS wrong PIN or recovery tries
// the gate locks for PIN_LOCKOUT_MS.
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 60_000;
const PIN_SESSION_IDLE_MS = 5 * 60_000;
const PIN_FORMAT = /^\d{4}$/;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashSecret(secret: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${secret}`);
}

/** Recovery phrases compare case-insensitively with tidy spacing. */
function normalizeRecovery(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

type AuthRow = typeof schema.grownupAuth.$inferSelect;

async function getAuthRow(db: Db, userId: number): Promise<AuthRow | null> {
  const rows = await db
    .select()
    .from(schema.grownupAuth)
    .where(and(eq(schema.grownupAuth.userId, userId)));
  return rows[0] ?? null;
}

function pinLockSeconds(auth: AuthRow, now: Date): number {
  if (!auth.lockedUntil) return 0;
  const ms = auth.lockedUntil.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/** Record a wrong PIN / recovery try; locks the gate at the limit. */
async function registerFailedAttempt(db: Db, userId: number, auth: AuthRow): Promise<number> {
  const now = new Date();
  const attempts = auth.failedAttempts + 1;
  if (attempts >= MAX_PIN_ATTEMPTS) {
    await db
      .update(schema.grownupAuth)
      .set({
        failedAttempts: 0,
        lockedUntil: new Date(now.getTime() + PIN_LOCKOUT_MS),
        updatedAt: now,
      })
      .where(and(eq(schema.grownupAuth.userId, userId)));
    return Math.ceil(PIN_LOCKOUT_MS / 1000);
  }
  await db
    .update(schema.grownupAuth)
    .set({ failedAttempts: attempts, updatedAt: now })
    .where(and(eq(schema.grownupAuth.userId, userId)));
  return 0;
}

async function clearFailedAttempts(db: Db, userId: number): Promise<void> {
  await db
    .update(schema.grownupAuth)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
    .where(and(eq(schema.grownupAuth.userId, userId)));
}

/** Mint an unlock token. The raw token goes to the client once; only
 *  its hash is stored. Expired sessions are swept opportunistically. */
async function mintPinSession(db: Db, userId: number): Promise<string> {
  const now = new Date();
  const token = randomHex(32);
  await db.insert(schema.pinSessions).values({
    userId,
    tokenHash: await sha256Hex(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + PIN_SESSION_IDLE_MS),
  });
  const all = await db.select().from(schema.pinSessions).where(eq(schema.pinSessions.userId, userId));
  for (const s of all) {
    if (s.expiresAt.getTime() <= now.getTime()) {
      await db
        .delete(schema.pinSessions)
        .where(and(eq(schema.pinSessions.userId, userId), eq(schema.pinSessions.id, s.id)));
    }
  }
  return token;
}

/** Gate for every grown-up action. A missing, unknown, or idle-expired
 *  token is an honest error — the zone's contents never move without a
 *  live unlock. A valid call slides the session's expiry forward. */
async function requirePinSession(db: Db, userId: number, token: string): Promise<void> {
  if (!token) {
    throw new Error(
      "The Grown-Up Zone is locked — a grown-up needs to enter the PIN first.",
    );
  }
  const tokenHash = await sha256Hex(token);
  const rows = await db
    .select()
    .from(schema.pinSessions)
    .where(and(eq(schema.pinSessions.userId, userId), eq(schema.pinSessions.tokenHash, tokenHash)));
  const session = rows[0];
  const now = new Date();
  if (!session || session.expiresAt.getTime() <= now.getTime()) {
    if (session) {
      await db
        .delete(schema.pinSessions)
        .where(and(eq(schema.pinSessions.userId, userId), eq(schema.pinSessions.id, session.id)));
    }
    throw new Error(
      "The Grown-Up Zone locked itself — enter the PIN again to keep going.",
    );
  }
  await db
    .update(schema.pinSessions)
    .set({ expiresAt: new Date(now.getTime() + PIN_SESSION_IDLE_MS) })
    .where(and(eq(schema.pinSessions.userId, userId), eq(schema.pinSessions.id, session.id)));
}

function bossForWeek(weekStart: string) {
  const [y = 2026, m = 1, d = 1] = weekStart.split("-").map(Number);
  const weekNum = Math.floor(Date.UTC(y, m - 1, d) / (7 * 86400000));
  const idx = ((weekNum % BOSSES.length) + BOSSES.length) % BOSSES.length;
  return BOSSES[idx] ?? BOSSES[0]!;
}

async function ensureBoss(db: Db, userId: number, weekStart: string) {
  const existing = await db
    .select()
    .from(schema.bossBattles)
    .where(and(eq(schema.bossBattles.userId, userId), eq(schema.bossBattles.weekStart, weekStart)));
  if (existing.length > 0) return existing[0]!;
  const def = bossForWeek(weekStart);
  const inserted = await db
    .insert(schema.bossBattles)
    .values({
      userId,
      name: def.name,
      emoji: def.emoji,
      taunt: def.taunt,
      maxHp: def.maxHp,
      weekStart,
    })
    .returning();
  return inserted[0]!;
}

async function grantChest(
  db: Db,
  userId: number,
  playerId: number,
  tier: "common" | "epic" | "legendary",
) {
  await db.insert(schema.lootChests).values({ userId, playerId, tier });
}

/** Boss down? Grant each player a legendary chest, once. */
async function maybeGrantBossLoot(db: Db, userId: number, weekStart: string, damage: number, tz: string) {
  const boss = await ensureBoss(db, userId, weekStart);
  if (damage < boss.maxHp || boss.lootGranted) return boss;
  const playerRows = await db.select().from(schema.players).where(eq(schema.players.userId, userId));
  for (const p of playerRows) {
    await grantChest(db, userId, p.id, "legendary");
    await db.insert(schema.bonuses).values({
      userId,
      playerId: p.id,
      points: 50,
      label: `🏆 Monster Boss defeated: ${boss.name}!`,
      day: todayKey(tz),
    });
  }
  await db
    .update(schema.bossBattles)
    .set({ lootGranted: true, defeatedAt: new Date() })
    .where(and(eq(schema.bossBattles.userId, userId), eq(schema.bossBattles.id, boss.id)));
  return { ...boss, lootGranted: true, defeatedAt: new Date() };
}

function tierFor(lifetime: number): { name: string; min: number; nextAt: number | null } {
  let current = TIERS[0] ?? { min: 0, name: "Dirt Digger" };
  let nextAt: number | null = null;
  for (const t of TIERS) {
    if (lifetime >= t.min) current = t;
    else {
      nextAt = t.min;
      break;
    }
  }
  return { name: current.name, min: current.min, nextAt };
}

// ---------- shared loaders ----------



// Second-wave missions, added later at Johnny's request: ten more chores,
// five inside the house and five outside, open to either kid. Points follow
// the starter board's scale (quick job 5, everyday job 10, bigger job 15,
// weekly deep job 20). They behave exactly like the starter chores: a tap
// waits for parent verification, and the daily ones count toward the
// nightly grumbler check. Topped up by title (any state — active or
// removed), so a title already on the board is never duplicated.
const EXTRA_CHORES: {
  title: string;
  points: number;
  cadence: "daily" | "weekly";
}[] = [
  // Inside the house
  { title: "Wipe down kitchen counters", points: 10, cadence: "daily" },
  { title: "Empty bathroom trash cans", points: 10, cadence: "weekly" },
  { title: "Dust the living room", points: 15, cadence: "weekly" },
  { title: "Mop the kitchen floor", points: 20, cadence: "weekly" },
  { title: "Match & fold socks", points: 10, cadence: "weekly" },
  // Outside
  { title: "Get the mail", points: 5, cadence: "daily" },
  { title: "Water the flowers & plants", points: 10, cadence: "daily" },
  { title: "Sweep the porch & steps", points: 15, cadence: "weekly" },
  { title: "Pick up sticks in the yard", points: 15, cadence: "weekly" },
  { title: "Wipe down patio furniture", points: 15, cadence: "weekly" },
];

// ---------- starter board (seeded into each new account) ----------
// The same 26 starter chores and 8 rewards the original app ships
// with — generic lists, nothing tied to any real family. Each account
// gets its own copy at signup, inside the signup transaction.

const STARTER_CHORES: { title: string; points: number; cadence: "daily" | "weekly" | "once" }[] = [
  { title: "Tidy up bedroom", points: 10, cadence: "daily" },
  { title: "Make bed", points: 5, cadence: "daily" },
  { title: "Put away toys & clutter", points: 10, cadence: "daily" },
  { title: "Brush teeth (morning)", points: 5, cadence: "daily" },
  { title: "Brush teeth (bedtime)", points: 5, cadence: "daily" },
  { title: "Set the table", points: 5, cadence: "daily" },
  { title: "Clear dishes after meals", points: 10, cadence: "daily" },
  { title: "Feed the pets", points: 5, cadence: "daily" },
  { title: "Take out the trash", points: 10, cadence: "weekly" },
  { title: "Help with laundry (load or fold)", points: 10, cadence: "weekly" },
  { title: "Read for 20 minutes", points: 15, cadence: "weekly" },
  { title: "Do homework", points: 15, cadence: "daily" },
  { title: "Pack school bag", points: 5, cadence: "daily" },
  { title: "Vacuum living room", points: 15, cadence: "weekly" },
  { title: "Help cook dinner", points: 15, cadence: "weekly" },
  { title: "Clean bathroom sink", points: 10, cadence: "weekly" },
];

const STARTER_REWARDS: { title: string; cost: number }[] = [
  { title: "Stay up 30 minutes late", cost: 30 },
  { title: "Pick the movie for movie night", cost: 40 },
  { title: "Extra 30 minutes of screen time", cost: 50 },
  { title: "Choose a special dinner", cost: 60 },
  { title: "Ice cream trip", cost: 100 },
  { title: "Small toy or treat ($5)", cost: 150 },
  { title: "Special outing with a parent", cost: 250 },
  { title: "Pick a family activity", cost: 200 },
];

/** Seeds one account's board: 26 starter chores + 8 rewards, no players. */
async function seedBoardForUser(tx: Pick<Db, "insert" | "select">, userId: number) {
  await tx.insert(schema.chores).values(
    [...STARTER_CHORES, ...EXTRA_CHORES].map((c) => ({
      userId,
      title: c.title,
      points: c.points,
      cadence: c.cadence,
      assignedPlayerId: null,
    })),
  );
  await tx.insert(schema.rewards).values(
    STARTER_REWARDS.map((r) => ({ userId, title: r.title, cost: r.cost })),
  );
}

interface PlayerStats {
  weekPoints: number;
  lifetimePoints: number;
  balance: number;
  streak: number;
  todayCount: number;
  lastActiveDay: string | null;
  daysSinceActive: number | null;
}

async function loadStats(db: Db, userId: number, playerId: number, tz: string): Promise<PlayerStats> {
  const today = todayKey(tz);
  const weekStart = mondayOf(today);
  // Only parent-verified completions score. Pending rows hold their
  // points; rejected rows never counted.
  const comps = await db
    .select()
    .from(schema.completions)
    .where(
      and(eq(schema.completions.userId, userId), 
        eq(schema.completions.playerId, playerId),
        eq(schema.completions.status, "verified"),
      ),
    );
  const bons = await db
    .select()
    .from(schema.bonuses)
    .where(and(eq(schema.bonuses.userId, userId), eq(schema.bonuses.playerId, playerId)));
  const pens = await db
    .select()
    .from(schema.penalties)
    .where(and(eq(schema.penalties.userId, userId), eq(schema.penalties.playerId, playerId)));
  const reds = await db
    .select()
    .from(schema.redemptions)
    .where(
      and(eq(schema.redemptions.userId, userId), 
        eq(schema.redemptions.playerId, playerId),
        inArray(schema.redemptions.status, ["pending", "approved"]),
      ),
    );

  let lifetime = 0;
  let week = 0;
  let todayCount = 0;
  const activeDays = new Set<string>();
  for (const c of comps) {
    lifetime += c.points;
    if (c.day >= weekStart) week += c.points;
    if (c.day === today) todayCount += 1;
    activeDays.add(c.day);
  }
  for (const b of bons) {
    lifetime += b.points;
    if (b.day >= weekStart) week += b.points;
  }
  // Penalties (not listening) come off this week's score only. They
  // never touch lifetime points or the spendable balance, and the
  // weekly score never drops below zero — points earned later in the
  // same week still count against an earlier penalty first.
  let weekPenalty = 0;
  for (const pen of pens) {
    if (pen.day >= weekStart) weekPenalty += pen.points;
  }
  week = Math.max(0, week - weekPenalty);
  const spent = reds.reduce((s, r) => s + r.cost, 0);

  const sortedDays = [...activeDays].sort();
  const lastActiveDay = sortedDays[sortedDays.length - 1] ?? null;

  // Streak: consecutive active days ending today or yesterday.
  let streak = 0;
  let cursor = activeDays.has(today) ? today : shiftDay(today, -1);
  while (activeDays.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }

  let daysSinceActive: number | null = null;
  if (lastActiveDay) {
    const msPerDay = 86400000;
    const [ty = 2026, tm = 1, td = 1] = today.split("-").map(Number);
    const [ly = 2026, lm = 1, ld = 1] = lastActiveDay.split("-").map(Number);
    daysSinceActive = Math.round(
      (Date.UTC(ty, tm - 1, td) - Date.UTC(ly, lm - 1, ld)) / msPerDay,
    );
  }

  return {
    weekPoints: week,
    lifetimePoints: lifetime,
    balance: lifetime - spent,
    streak,
    todayCount,
    lastActiveDay,
    daysSinceActive,
  };
}

/** Expire quests past deadline and crown finished weeks' Star Champions. */
async function housekeeping(db: Db, userId: number, tz: string) {
  const today = todayKey(tz);
  const active = await db
    .select()
    .from(schema.quests)
    .where(and(eq(schema.quests.userId, userId), eq(schema.quests.status, "active")));
  for (const q of active) {
    if (q.deadlineDay < today) {
      await db
        .update(schema.quests)
        .set({ status: "expired" })
        .where(and(eq(schema.quests.userId, userId), eq(schema.quests.id, q.id)));
    }
  }

  // Crown any finished week that has completions but no winner yet.
  // Only verified completions count toward a crown.
  const allComps = await db
    .select()
    .from(schema.completions)
    .where(and(eq(schema.completions.userId, userId), eq(schema.completions.status, "verified")));
  const allBons = await db.select().from(schema.bonuses).where(eq(schema.bonuses.userId, userId));
  const allPens = await db.select().from(schema.penalties).where(eq(schema.penalties.userId, userId));
  const weeks = new Set<string>();
  for (const c of allComps) weeks.add(mondayOf(c.day));
  for (const b of allBons) weeks.add(mondayOf(b.day));
  for (const pen of allPens) weeks.add(mondayOf(pen.day));
  const thisWeek = mondayOf(today);
  const crowned = await db.select().from(schema.weekWinners).where(eq(schema.weekWinners.userId, userId));
  const crownedWeeks = new Set(crowned.map((w) => w.weekStart));
  for (const wk of weeks) {
    if (wk >= thisWeek || crownedWeeks.has(wk)) continue;
    const nextMonday = shiftDay(wk, 7);
    const totals = new Map<number, number>();
    for (const c of allComps) {
      if (c.day >= wk && c.day < nextMonday) {
        totals.set(c.playerId, (totals.get(c.playerId) ?? 0) + c.points);
      }
    }
    for (const b of allBons) {
      if (b.day >= wk && b.day < nextMonday) {
        totals.set(b.playerId, (totals.get(b.playerId) ?? 0) + b.points);
      }
    }
    // Weekly-only penalties lower that week's crown total too, never
    // below zero (same rule as loadStats).
    for (const pen of allPens) {
      if (pen.day >= wk && pen.day < nextMonday) {
        totals.set(pen.playerId, (totals.get(pen.playerId) ?? 0) - pen.points);
      }
    }
    let bestId: number | null = null;
    let bestPts = 0;
    for (const [pid, rawPts] of totals) {
      const pts = Math.max(0, rawPts);
      if (pts > bestPts) {
        bestPts = pts;
        bestId = pid;
      }
    }
    if (bestId != null) {
      await db
        .insert(schema.weekWinners)
        .values({ userId, weekStart: wk, playerId: bestId, points: bestPts });
    }
  }

  await grumblerCheck(db, userId, tz);
}

/** Create the Rally Quest for a knocked-out player (hearts at zero). */
async function ensureRallyQuest(
  db: Db,
  userId: number,
  player: { id: number; name: string },
  tz: string,
) {
  const active = await db
    .select()
    .from(schema.quests)
    .where(
      and(eq(schema.quests.userId, userId), eq(schema.quests.playerId, player.id), eq(schema.quests.status, "active")),
    );
  if (active.some((q) => q.kind === "rally")) return;
  // Other quests wait — rallying comes first.
  for (const q of active) {
    await db
      .update(schema.quests)
      .set({ status: "dismissed" })
      .where(and(eq(schema.quests.userId, userId), eq(schema.quests.id, q.id)));
  }
  const today = todayKey(tz);
  await db.insert(schema.quests).values({
    userId,
    playerId: player.id,
    kind: "rally",
    title: "👹 GRUMBLER ATTACK! Rally Quest",
    message: `Oh no, ${player.name} — a grumbler caught you with no hearts left and knocked you OUT of the game! No points until you rally. Finish 3 chores to climb back into your world with ${RALLY_HEARTS} fresh hearts!`,
    targetChores: 3,
    bonusPoints: 30,
    deadlineDay: shiftDay(today, 1),
  });
}

/** The nightly grumbler. For every finished day not yet settled, a player
 *  who didn't complete ALL of their daily chores (theirs plus the shared
 *  ones) loses a heart. A chore the kid tapped counts as done even while
 *  it waits for a parent to verify it — the grumbler only takes a heart
 *  for chores never tapped (or sent back by a parent). Settling is
 *  watermarked per player (lastGrumblerDay), so each day is judged
 *  exactly once. Reaching zero hearts knocks the player out and lines
 *  up a Rally Quest. */
async function grumblerCheck(db: Db, userId: number, tz: string) {
  const today = todayKey(tz);
  const yesterday = shiftDay(today, -1);
  const playerRows = await db.select().from(schema.players).where(eq(schema.players.userId, userId));
  if (playerRows.length === 0) return;
  const dailyChores = await db
    .select()
    .from(schema.chores)
    .where(
      and(eq(schema.chores.userId, userId), eq(schema.chores.active, true), eq(schema.chores.cadence, "daily")),
    );
  for (const p of playerRows) {
    const settled = p.lastGrumblerDay;
    if (settled != null && settled >= yesterday) {
      if (p.hearts <= 0) await ensureRallyQuest(db, userId, p, tz);
      continue;
    }
    let cursor = settled ? shiftDay(settled, 1) : dayKey(p.createdAt, tz);
    let hearts = p.hearts;
    let lastHit = p.lastGrumblerHit;
    while (cursor <= yesterday) {
      const mine = dailyChores.filter(
        (c) => c.assignedPlayerId == null || c.assignedPlayerId === p.id,
      );
      if (mine.length > 0 && hearts > 0) {
        const done = await db
          .select()
          .from(schema.completions)
          .where(
            and(eq(schema.completions.userId, userId), 
              eq(schema.completions.playerId, p.id),
              eq(schema.completions.day, cursor),
              inArray(schema.completions.status, ["pending", "verified"]),
            ),
          );
        const doneIds = new Set(done.map((c) => c.choreId));
        if (!mine.every((c) => doneIds.has(c.id))) {
          hearts -= 1;
          lastHit = cursor;
        }
      }
      cursor = shiftDay(cursor, 1);
    }
    if (hearts !== p.hearts || lastHit !== p.lastGrumblerHit || settled !== yesterday) {
      await db
        .update(schema.players)
        .set({ hearts, lastGrumblerDay: yesterday, lastGrumblerHit: lastHit })
        .where(and(eq(schema.players.userId, userId), eq(schema.players.id, p.id)));
    }
    if (hearts <= 0) await ensureRallyQuest(db, userId, p, tz);
  }
}

/** Create a motivation quest for a player who is drifting, if none is active. */
async function maybeCreateQuest(
  db: Db,
  userId: number,
  player: { id: number; name: string; hearts: number },
  stats: PlayerStats,
  rivalWeekPoints: number,
  tz: string,
) {
  // Knocked out? The Rally Quest is the only quest that matters.
  if (player.hearts <= 0) {
    await ensureRallyQuest(db, userId, player, tz);
    return;
  }
  const today = todayKey(tz);
  const existing = await db
    .select()
    .from(schema.quests)
    .where(
      and(eq(schema.quests.userId, userId), eq(schema.quests.playerId, player.id), eq(schema.quests.status, "active")),
    );
  if (existing.length > 0) return;

  const gap = rivalWeekPoints - stats.weekPoints;
  const inactive = stats.daysSinceActive != null && stats.daysSinceActive >= 2;

  if (stats.lastActiveDay == null) {
    await db.insert(schema.quests).values({
      userId,
      playerId: player.id,
      kind: "comeback",
      title: "⛏️ First Dig: Welcome to Your World!",
      message: `Welcome to Chore Champions, ${player.name}! Finish 2 quests today to earn your first bonus and start leveling up your XP.`,
      targetChores: 2,
      bonusPoints: 20,
      deadlineDay: shiftDay(today, 1),
    });
    return;
  }
  if (stats.streak >= 2 && stats.todayCount === 0) {
    await db.insert(schema.quests).values({
      userId,
      playerId: player.id,
      kind: "streak_save",
      title: "⚡ Save the Streak — Keep Your XP Alive!",
      message: `${player.name}, your ${stats.streak}-day streak is about to burn out like a torch! Finish ONE chore today to keep it alive — and pocket a bonus.`,
      targetChores: 1,
      bonusPoints: 15,
      deadlineDay: today,
    });
    return;
  }
  if (inactive) {
    await db.insert(schema.quests).values({
      userId,
      playerId: player.id,
      kind: "comeback",
      title: "🔄 Rally Quest: Back to the Dig!",
      message: `Your world missed you, ${player.name}! Rally and dig back in — finish 3 chores by tomorrow night and grab a comeback bonus.`,
      targetChores: 3,
      bonusPoints: 30,
      deadlineDay: shiftDay(today, 1),
    });
    return;
  }
  if (gap >= 40) {
    await db.insert(schema.quests).values({
      userId,
      playerId: player.id,
      kind: "comeback",
      title: "🎯 Comeback Quest: Close the Gap!",
      message: `You're ${gap} points behind this week, ${player.name} — but this game isn't over! One good digging run can turn the whole game around. Finish 4 chores by tomorrow night for a comeback bonus and reel them in.`,
      targetChores: 4,
      bonusPoints: 40,
      deadlineDay: shiftDay(today, 1),
    });
  }
}

/** After a completion is verified, advance any active quest for that
 *  player (progress counts verified completions only — a tapped chore
 *  still waiting for a parent check doesn't advance a quest yet).
 *  Completing a quest banks its bonus, drops an epic chest, and earns a
 *  heart back; completing the Rally Quest restores RALLY_HEARTS. */
async function advanceQuests(
  db: Db,
  userId: number,
  playerId: number,
  tz: string,
): Promise<{ completed: boolean; heartGained: boolean; rallied: boolean }> {
  const today = todayKey(tz);
  const active = await db
    .select()
    .from(schema.quests)
    .where(
      and(eq(schema.quests.userId, userId), eq(schema.quests.playerId, playerId), eq(schema.quests.status, "active")),
    );
  if (active.length === 0) return { completed: false, heartGained: false, rallied: false };
  const todays = await db
    .select()
    .from(schema.completions)
    .where(
      and(eq(schema.completions.userId, userId), 
        eq(schema.completions.playerId, playerId),
        eq(schema.completions.day, today),
        eq(schema.completions.status, "verified"),
      ),
    );
  let completed = false;
  let heartGained = false;
  let rallied = false;
  for (const q of active) {
    if (todays.length >= q.targetChores) {
      await db
        .update(schema.quests)
        .set({ status: "completed", completedAt: new Date() })
        .where(and(eq(schema.quests.userId, userId), eq(schema.quests.id, q.id)));
      await db.insert(schema.bonuses).values({
        userId,
        playerId,
        points: q.bonusPoints,
        label: q.title,
        day: today,
      });
      await grantChest(db, userId, playerId, "epic");
      completed = true;
      const rows = await db
        .select()
        .from(schema.players)
        .where(and(eq(schema.players.userId, userId), eq(schema.players.id, playerId)));
      const pl = rows[0];
      if (pl) {
        if (q.kind === "rally") {
          await db
            .update(schema.players)
            .set({ hearts: RALLY_HEARTS })
            .where(and(eq(schema.players.userId, userId), eq(schema.players.id, playerId)));
          rallied = true;
          heartGained = true;
        } else if (pl.hearts >= 1 && pl.hearts < MAX_HEARTS) {
          await db
            .update(schema.players)
            .set({ hearts: pl.hearts + 1 })
            .where(and(eq(schema.players.userId, userId), eq(schema.players.id, playerId)));
          heartGained = true;
        }
      }
    }
  }
  return { completed, heartGained, rallied };
}

/** Settle a parent-verified completion: flip the pending row to
 *  "verified" with its awarded points, then run everything a finished
 *  chore triggers — quest progress, the perfect-day heart, a possible
 *  treasure chest drop, and Monster Boss damage/loot. A knocked-out player
 *  banks 0 points for the chore itself, but it still counts toward the
 *  Rally Quest. Returns the celebration payload. */
async function settleVerification(
  db: Db,
  userId: number,
  pending: typeof schema.completions.$inferSelect,
  tz: string,
): Promise<{
  points: number;
  chestTier: "common" | "epic" | "legendary" | null;
  questCompleted: boolean;
  bossDefeated: boolean;
  tierUp: string | null;
  hearts: number;
  heartGained: boolean;
  rallied: boolean;
  knockedOut: boolean;
}> {
  const today = todayKey(tz);
  const weekStart = mondayOf(today);
  const playerRows = await db
    .select()
    .from(schema.players)
    .where(and(eq(schema.players.userId, userId), eq(schema.players.id, pending.playerId)));
  const player = playerRows[0];
  if (!player) throw new Error("That player isn't in the game.");
  // Knocked out by the grumbler: verified chores still count toward the
  // Rally Quest, but they score no points until the player rallys.
  const knockedOut = player.hearts <= 0;
  const awarded = knockedOut ? 0 : pending.points;

  const before = await loadStats(db, userId, pending.playerId, tz);
  const tierBefore = tierFor(before.lifetimePoints).name;
  const bossBefore = await ensureBoss(db, userId, weekStart);
  const allBefore = await db.select().from(schema.players).where(eq(schema.players.userId, userId));
  let damageBefore = 0;
  for (const p of allBefore) {
    damageBefore += (await loadStats(db, userId, p.id, tz)).weekPoints;
  }

  await db
    .update(schema.completions)
    .set({ status: "verified", points: awarded })
    .where(and(eq(schema.completions.userId, userId), eq(schema.completions.id, pending.id)));
  const quest = await advanceQuests(db, userId, pending.playerId, tz);
  let heartGained = quest.heartGained;

  // Perfect day: when every one of today's daily chores is verified
  // done, the player earns a heart back — the grumbler can't touch a
  // finished list tonight. (A chore still waiting for a check doesn't
  // count here; points and hearts settle on verification.)
  if (!quest.rallied) {
    const choreRows = await db
      .select()
      .from(schema.chores)
      .where(and(eq(schema.chores.userId, userId), eq(schema.chores.id, pending.choreId)));
    const chore = choreRows[0];
    if (chore && chore.cadence === "daily") {
      const now = await db
        .select()
        .from(schema.players)
        .where(and(eq(schema.players.userId, userId), eq(schema.players.id, pending.playerId)));
      const me = now[0];
      if (me && me.hearts >= 1 && me.hearts < MAX_HEARTS) {
        const myDailies = (
          await db
            .select()
            .from(schema.chores)
            .where(
              and(eq(schema.chores.userId, userId), 
                eq(schema.chores.active, true),
                eq(schema.chores.cadence, "daily"),
              ),
            )
        ).filter(
          (c) => c.assignedPlayerId == null || c.assignedPlayerId === pending.playerId,
        );
        if (myDailies.length > 0) {
          const todays = await db
            .select()
            .from(schema.completions)
            .where(
              and(eq(schema.completions.userId, userId), 
                eq(schema.completions.playerId, pending.playerId),
                eq(schema.completions.day, today),
                eq(schema.completions.status, "verified"),
              ),
            );
          const doneIds = new Set(todays.map((c) => c.choreId));
          if (myDailies.every((c) => doneIds.has(c.id))) {
            await db
              .update(schema.players)
              .set({ hearts: me.hearts + 1 })
              .where(and(eq(schema.players.userId, userId), eq(schema.players.id, pending.playerId)));
            heartGained = true;
          }
        }
      }
    }
  }

  // Treasure chest drop: roughly 1 in 5 verified quests shakes loose a chest.
  let chestTier: "common" | "epic" | "legendary" | null = null;
  const roll = Math.random();
  if (roll < 0.16) chestTier = "common";
  else if (roll < 0.21) chestTier = "epic";
  if (chestTier) await grantChest(db, userId, pending.playerId, chestTier);

  const after = await loadStats(db, userId, pending.playerId, tz);
  const tierAfter = tierFor(after.lifetimePoints).name;
  // Every point earned by this verification (chore + any quest bonus)
  // hits the boss.
  const damageAfter = damageBefore + (after.weekPoints - before.weekPoints);
  const bossDefeated =
    damageBefore < bossBefore.maxHp && damageAfter >= bossBefore.maxHp;
  if (bossDefeated) {
    await maybeGrantBossLoot(db, userId, weekStart, damageAfter, tz);
  }

  const finalPlayer = await db
    .select()
    .from(schema.players)
    .where(and(eq(schema.players.userId, userId), eq(schema.players.id, pending.playerId)));
  return {
    points: awarded,
    chestTier,
    questCompleted: quest.completed,
    bossDefeated,
    tierUp: tierAfter !== tierBefore ? tierAfter : null,
    hearts: finalPlayer[0]?.hearts ?? player.hearts,
    heartGained,
    rallied: quest.rallied,
    knockedOut: knockedOut && !quest.rallied,
  };
}

// ---------- response shapes ----------

const playerOut = z.object({
  id: z.number(),
  name: z.string(),
  age: z.number(),
  color: z.string(),
  emoji: z.string(),
  equippedAvatar: z.string(),
  avatarEmoji: z.string(),
  avatarName: z.string(),
  avatarFrame: z.string(),
  weekPoints: z.number(),
  lifetimePoints: z.number(),
  balance: z.number(),
  streak: z.number(),
  todayCount: z.number(),
  tier: z.string(),
  tierMin: z.number(),
  nextTierAt: z.number().nullable(),
  crowns: z.number(),
  unopenedChests: z.number(),
  hearts: z.number(),
  maxHearts: z.number(),
  knockedOut: z.boolean(),
  grumblerHitDay: z.string().nullable(),
});

const stateResponse = z.object({
  today: z.string(),
  weekStart: z.string(),
  players: z.array(playerOut),
  chores: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      points: z.number(),
      cadence: z.enum(["daily", "weekly", "once"]),
      assignedPlayerId: z.number().nullable(),
      doneByPlayerIds: z.array(z.number()),
      pendingByPlayerIds: z.array(z.number()),
    }),
  ),
  // Chores tapped by a kid and waiting for a parent to check them.
  pendingVerifications: z.array(
    z.object({
      id: z.number(),
      playerId: z.number(),
      choreTitle: z.string(),
      points: z.number(),
      day: z.string(),
      createdAt: z.string(),
    }),
  ),
  rewards: z.array(
    z.object({ id: z.number(), title: z.string(), cost: z.number() }),
  ),
  redemptions: z.array(
    z.object({
      id: z.number(),
      rewardTitle: z.string(),
      cost: z.number(),
      playerId: z.number(),
      status: z.enum(["pending", "approved", "declined"]),
      createdAt: z.string(),
    }),
  ),
  quests: z.array(
    z.object({
      id: z.number(),
      playerId: z.number(),
      kind: z.enum(["comeback", "streak_save", "rally"]),
      title: z.string(),
      message: z.string(),
      targetChores: z.number(),
      bonusPoints: z.number(),
      progress: z.number(),
      deadlineDay: z.string(),
    }),
  ),
  boss: z.object({
    id: z.number(),
    name: z.string(),
    emoji: z.string(),
    taunt: z.string(),
    maxHp: z.number(),
    damage: z.number(),
    remaining: z.number(),
    defeated: z.boolean(),
  }),
  chests: z.array(
    z.object({
      id: z.number(),
      playerId: z.number(),
      tier: z.enum(["common", "epic", "legendary"]),
      createdAt: z.string(),
    }),
  ),
  avatarItems: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      emoji: z.string(),
      unlockAt: z.number(),
      frame: z.string(),
    }),
  ),
  lastWeekWinner: z
    .object({ playerId: z.number(), points: z.number(), weekStart: z.string() })
    .nullable(),
  recent: z.array(
    z.object({
      id: z.number(),
      playerId: z.number(),
      label: z.string(),
      points: z.number(),
      day: z.string(),
    }),
  ),
});

const okResponse = z.object({ ok: z.literal(true) });

// Result of a not-listening deduction: how many points came off and
// the player's weekly score afterwards (never below zero).
const penaltyResponse = z.object({
  ok: z.literal(true),
  deducted: z.number(),
  weekPoints: z.number(),
});

const chestResponse = z.object({
  ok: z.literal(true),
  rewardPoints: z.number(),
  rewardLabel: z.string(),
});

// A kid's tap: the chore is now waiting for a parent to check it and its
// points are held until verification.
const submitResponse = z.object({
  ok: z.literal(true),
  pending: z.literal(true),
});

const verifyResponse = z.object({
  ok: z.literal(true),
  approved: z.boolean(),
  // Points that landed (0 when the parent sent it back, or when the
  // player is knocked out and still rallying).
  points: z.number(),
  chestTier: z.enum(["common", "epic", "legendary"]).nullable(),
  questCompleted: z.boolean(),
  bossDefeated: z.boolean(),
  tierUp: z.string().nullable(),
  heartGained: z.boolean(),
  rallied: z.boolean(),
  knockedOut: z.boolean(),
});

const pinStatusResponse = z.object({
  hasPin: z.boolean(),
  locked: z.boolean(),
  lockSecondsRemaining: z.number(),
  attemptsRemaining: z.number(),
  maxAttempts: z.number(),
});

// Unlock attempts answer in-band (never throw) so the client can show
// "wrong PIN, N tries left" or the lockout countdown from real data.
const pinUnlockResponse = z.object({
  ok: z.boolean(),
  token: z.string().nullable(),
  message: z.string(),
  locked: z.boolean(),
  lockSecondsRemaining: z.number(),
  attemptsRemaining: z.number(),
});

const pinSessionCheckResponse = z.object({ ok: z.boolean() });

// Pending chores waiting for a parent to check them in the Grown-Up Zone.
async function buildState(ctx: ActionContext, userId: number, tz: string): Promise<z.infer<typeof stateResponse>> {
  const db = ctx.db;
  await housekeeping(db, userId, tz);

  const today = todayKey(tz);
  const weekStart = mondayOf(today);
  const playerRows = await db
    .select()
    .from(schema.players).where(eq(schema.players.userId, userId))
    .orderBy(asc(schema.players.id));
  const stats = new Map<number, PlayerStats>();
  for (const p of playerRows) stats.set(p.id, await loadStats(db, userId, p.id, tz));

  // Motivation engine: anyone drifting gets a quest.
  for (const p of playerRows) {
    const s = stats.get(p.id);
    if (!s) continue;
    const rivalBest = Math.max(
      0,
      ...playerRows.filter((r) => r.id !== p.id).map((r) => stats.get(r.id)?.weekPoints ?? 0),
    );
    await maybeCreateQuest(db, userId, p, s, rivalBest, tz);
  }

  // Boss battle: combined week points are the damage. Defeat pays out loot.
  const bossDamage = [...stats.values()].reduce((s, st) => s + st.weekPoints, 0);
  const bossRow = await maybeGrantBossLoot(db, userId, weekStart, bossDamage, tz);
  if (bossRow.lootGranted && bossDamage >= bossRow.maxHp) {
    // Boss bonus landed after stats were loaded — refresh them once.
    for (const p of playerRows) stats.set(p.id, await loadStats(db, userId, p.id, tz));
  }
  const finalBossDamage = [...stats.values()].reduce(
    (s, st) => s + st.weekPoints,
    0,
  );
  const chestRows = await db
    .select()
    .from(schema.lootChests)
    .where(and(eq(schema.lootChests.userId, userId), eq(schema.lootChests.status, "unopened")))
    .orderBy(desc(schema.lootChests.id));

  const winners = await db
    .select()
    .from(schema.weekWinners).where(eq(schema.weekWinners.userId, userId))
    .orderBy(desc(schema.weekWinners.weekStart));
  const crowns = new Map<number, number>();
  for (const w of winners) crowns.set(w.playerId, (crowns.get(w.playerId) ?? 0) + 1);
  const lastWinner = winners[0] ?? null;

  const choreRows = await db
    .select()
    .from(schema.chores)
    .where(and(eq(schema.chores.userId, userId), eq(schema.chores.active, true)))
    .orderBy(asc(schema.chores.id));
  const weekComps = await db
    .select()
    .from(schema.completions)
    .where(
      and(eq(schema.completions.userId, userId), 
        gte(schema.completions.day, weekStart),
        inArray(schema.completions.status, ["verified", "pending"]),
      ),
    );
  // doneMap = parent-verified for this period; pendingMap = tapped and
  // waiting for a parent check (shown as "waiting" on the kid's card).
  const doneMap = new Map<number, Set<number>>();
  const pendingMap = new Map<number, Set<number>>();
  for (const c of weekComps) {
    const chore = choreRows.find((ch) => ch.id === c.choreId);
    if (!chore) continue;
    const counts =
      chore.cadence === "daily"
        ? c.day === today
        : chore.cadence === "weekly"
          ? true
          : true;
    if (!counts) continue;
    const map = c.status === "verified" ? doneMap : pendingMap;
    if (!map.has(c.choreId)) map.set(c.choreId, new Set());
    map.get(c.choreId)?.add(c.playerId);
  }
  const pendingRows = await db
    .select()
    .from(schema.completions)
    .where(and(eq(schema.completions.userId, userId), eq(schema.completions.status, "pending")))
    .orderBy(asc(schema.completions.id));

  const rewardRows = await db
    .select()
    .from(schema.rewards)
    .where(and(eq(schema.rewards.userId, userId), eq(schema.rewards.active, true)))
    .orderBy(asc(schema.rewards.cost));
  const redemptionRows = await db
    .select()
    .from(schema.redemptions).where(eq(schema.redemptions.userId, userId))
    .orderBy(desc(schema.redemptions.id))
    .limit(30);

  const questRows = await db
    .select()
    .from(schema.quests)
    .where(and(eq(schema.quests.userId, userId), eq(schema.quests.status, "active")))
    .orderBy(asc(schema.quests.id));
  const todaysComps = await db
    .select()
    .from(schema.completions)
    .where(
      and(eq(schema.completions.userId, userId), 
        eq(schema.completions.day, today),
        eq(schema.completions.status, "verified"),
      ),
    );

  const recentComps = await db
    .select()
    .from(schema.completions)
    .where(and(eq(schema.completions.userId, userId), eq(schema.completions.status, "verified")))
    .orderBy(desc(schema.completions.id))
    .limit(12);
  const recentBons = await db
    .select()
    .from(schema.bonuses).where(eq(schema.bonuses.userId, userId))
    .orderBy(desc(schema.bonuses.id))
    .limit(6);
  const recentPens = await db
    .select()
    .from(schema.penalties).where(eq(schema.penalties.userId, userId))
    .orderBy(desc(schema.penalties.id))
    .limit(6);
  const recent = [
    ...recentComps.map((c) => ({
      id: c.id,
      playerId: c.playerId,
      label: c.choreTitle,
      points: c.points,
      day: c.day,
      sort: c.createdAt.getTime(),
    })),
    ...recentBons.map((b) => ({
      id: -b.id,
      playerId: b.playerId,
      label: b.label,
      points: b.points,
      day: b.day,
      sort: b.createdAt.getTime(),
    })),
    ...recentPens.map((pen) => ({
      // Large negative offset keeps penalty ids clear of bonus ids.
      id: -1000000 - pen.id,
      playerId: pen.playerId,
      label: pen.label,
      points: -pen.points,
      day: pen.day,
      sort: pen.createdAt.getTime(),
    })),
  ]
    .sort((a, b) => b.sort - a.sort)
    .slice(0, 12)
    .map(({ sort: _sort, ...rest }) => rest);

  return {
    today,
    weekStart,
    players: playerRows.map((p) => {
      const s = stats.get(p.id) ?? {
        weekPoints: 0,
        lifetimePoints: 0,
        balance: 0,
        streak: 0,
        todayCount: 0,
        lastActiveDay: null,
        daysSinceActive: null,
      };
      const tier = tierFor(s.lifetimePoints);
      const item = avatarItem(p.equippedAvatar);
      const unlocked = s.lifetimePoints >= (item?.unlockAt ?? 0);
      const shown = unlocked && item ? item : AVATAR_ITEMS[0]!;
      return {
        id: p.id,
        name: p.name,
        age: p.age,
        color: p.color,
        emoji: p.emoji,
        equippedAvatar: shown.key,
        avatarEmoji: shown.key === "starter" ? p.emoji : shown.emoji,
        avatarName: shown.name,
        avatarFrame: shown.frame || p.color,
        weekPoints: s.weekPoints,
        lifetimePoints: s.lifetimePoints,
        balance: s.balance,
        streak: s.streak,
        todayCount: s.todayCount,
        tier: tier.name,
        tierMin: tier.min,
        nextTierAt: tier.nextAt,
        crowns: crowns.get(p.id) ?? 0,
        unopenedChests: chestRows.filter((c) => c.playerId === p.id).length,
        hearts: p.hearts,
        maxHearts: MAX_HEARTS,
        knockedOut: p.hearts <= 0,
        grumblerHitDay: p.lastGrumblerHit ?? null,
      };
    }),
    boss: {
      id: bossRow.id,
      name: bossRow.name,
      emoji: bossRow.emoji,
      taunt: bossRow.taunt,
      maxHp: bossRow.maxHp,
      damage: Math.min(finalBossDamage, bossRow.maxHp),
      remaining: Math.max(0, bossRow.maxHp - finalBossDamage),
      defeated: finalBossDamage >= bossRow.maxHp,
    },
    chests: chestRows.map((c) => ({
      id: c.id,
      playerId: c.playerId,
      tier: c.tier,
      createdAt: c.createdAt.toISOString(),
    })),
    avatarItems: AVATAR_ITEMS.map((a) => ({
      key: a.key,
      name: a.name,
      emoji: a.emoji,
      unlockAt: a.unlockAt,
      frame: a.frame,
    })),
    chores: choreRows.map((c) => ({
      id: c.id,
      title: c.title,
      points: c.points,
      cadence: c.cadence,
      assignedPlayerId: c.assignedPlayerId ?? null,
      doneByPlayerIds: [...(doneMap.get(c.id) ?? new Set<number>())],
      pendingByPlayerIds: [...(pendingMap.get(c.id) ?? new Set<number>())],
    })),
    pendingVerifications: pendingRows.map((r) => ({
      id: r.id,
      playerId: r.playerId,
      choreTitle: r.choreTitle,
      points: r.points,
      day: r.day,
      createdAt: r.createdAt.toISOString(),
    })),
    rewards: rewardRows.map((r) => ({ id: r.id, title: r.title, cost: r.cost })),
    redemptions: redemptionRows.map((r) => ({
      id: r.id,
      rewardTitle: r.rewardTitle,
      cost: r.cost,
      playerId: r.playerId,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
    quests: questRows.map((q) => ({
      id: q.id,
      playerId: q.playerId,
      kind: q.kind,
      title: q.title,
      message: q.message,
      targetChores: q.targetChores,
      bonusPoints: q.bonusPoints,
      progress: todaysComps.filter((c) => c.playerId === q.playerId).length,
      deadlineDay: q.deadlineDay,
    })),
    lastWeekWinner: lastWinner
      ? {
          playerId: lastWinner.playerId,
          points: lastWinner.points,
          weekStart: lastWinner.weekStart,
        }
      : null,
    recent,
  };
}

// ---------- actions ----------

const authResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  id: z.number().optional(),
  user: z
    .object({ id: z.number(), email: z.string(), name: z.string() })
    .optional(),
});

// Forgot-password answers: the request always says the same thing
// whether or not the email has an account (no enumeration), and the
// reset itself answers ok true/false with a generic failure message.
const passwordResetRequestSchema = z.object({
  ok: z.literal(true),
  message: z.string(),
});

const passwordResetSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

/** Server-side daily reset: settles every account's finished days. */
export async function runDailyResetForAll(db: Db): Promise<void> {
  const users = await db
    .select({ id: schema.users.id, timezone: schema.users.timezone })
    .from(schema.users);
  for (const u of users) {
    const userId = u.id;
    const tz = u.timezone || DEFAULT_TZ;
    try {
      await housekeeping(db, userId, tz);
      const playerRows = await db
        .select()
        .from(schema.players)
        .where(eq(schema.players.userId, userId));
      for (const p of playerRows) {
        const stats = await loadStats(db, userId, p.id, tz);
        const rivals = await Promise.all(
          playerRows
            .filter((r) => r.id !== p.id)
            .map((r) => loadStats(db, userId, r.id, tz)),
        );
        const best = Math.max(0, ...rivals.map((r) => r.weekPoints));
        await maybeCreateQuest(db, userId, p, stats, best, tz);
      }
    } catch (err) {
      console.error(`[daily-reset] account ${userId} failed:`, err);
    }
  }
}

export const Actions = {
  getMe: defineAction({
    description: "Returns the signed-in account, or null when nobody is signed in.",
    request: z.object({}),
    response: z.object({
      user: z
        .object({
          id: z.number(),
          email: z.string(),
          name: z.string(),
          timezone: z.string(),
        })
        .nullable(),
    }),
    async handler(ctx) {
      const u = ctx.user;
      return {
        user: u
          ? { id: u.id, email: u.email, name: u.name, timezone: u.timezone }
          : null,
      };
    },
  }),

  signUp: defineAction({
    description: "Creates an account with an email and password and signs in. The new account starts with the 26 starter chores and 8 starter rewards and zero players or points — the family adds their own kids on first setup.",
    request: z.object({
      email: z.string().trim().max(120),
      name: z.string().trim().min(1).max(40),
      password: z.string().min(8).max(128),
      timezone: z.string().trim().max(64).optional(),
    }),
    response: authResultSchema,
    async handler(ctx, args): Promise<z.infer<typeof authResultSchema>> {
      if (!allow(`signup:ip:${ctx.ip}`, SIGNUPS_PER_IP_PER_HOUR, HOUR)) {
        return { ok: false, error: "Too many accounts created from here. Try again later." };
      }
      const email = args.email.toLowerCase();
      if (!isValidEmail(email)) {
        return { ok: false, error: "Enter a valid email address." };
      }
      const existing = await ctx.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      if (existing.length > 0) {
        return { ok: false, error: "An account with that email already exists. Sign in instead." };
      }
      const passwordHash = await hashPassword(args.password);
      const name = args.name.trim();
      const timezone = (args.timezone ?? "").trim() || DEFAULT_TZ;
      // Account + seeded board + session in one transaction, so a new
      // account never lands without its starting chores and rewards.
      const created = await ctx.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(schema.users)
          .values({ email, name, passwordHash, timezone })
          .returning({ id: schema.users.id });
        const row = inserted[0];
        if (!row) throw new Error("The account could not be created. Try again.");
        await seedBoardForUser(tx as unknown as Pick<Db, "insert" | "select">, row.id);
        const token = await createSession(tx as unknown as SessionStore, row.id);
        return { id: row.id, token };
      });
      ctx.cookies.push(sessionCookie(created.token));
      return {
        ok: true,
        id: created.id,
        user: { id: created.id, email, name },
      };
    },
  }),

  signIn: defineAction({
    description: "Signs in with an email and password.",
    request: z.object({
      email: z.string().trim().max(120),
      password: z.string().min(1).max(128),
    }),
    response: authResultSchema,
    async handler(ctx, args): Promise<z.infer<typeof authResultSchema>> {
      const email = args.email.toLowerCase();
      if (!allow(`signin:ip:${ctx.ip}`, SIGNIN_PER_IP_PER_15_MIN, 15 * MINUTE)) {
        return { ok: false, error: "Too many sign-in attempts from here. Try again in a little while." };
      }
      if (!allow(`signin:email:${email}`, SIGNIN_FAILURES_PER_EMAIL_PER_15_MIN, 15 * MINUTE)) {
        return { ok: false, error: "Too many sign-in attempts for this email. Try again in a little while." };
      }
      const wrong = { ok: false, error: "That email or password is not correct." } as const;
      const rows = await ctx.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      const user = rows[0];
      if (!user) return wrong;
      if (!(await verifyPassword(args.password, user.passwordHash))) return wrong;
      resetLimit(`signin:email:${email}`);
      const token = await createSession(ctx.db, user.id);
      ctx.cookies.push(sessionCookie(token));
      return {
        ok: true,
        id: user.id,
        user: { id: user.id, email: user.email, name: user.name },
      };
    },
  }),

  requestPasswordReset: defineAction({
    description:
      "Forgot-password request: enter the account email and, if an account uses it, a single-use reset link good for 1 hour goes out through Resend. The answer is always the same generic message whether or not the email has an account, so it never leaks which emails are registered. The raw token is never stored or logged — only its SHA-256 hash lives in the database.",
    request: z.object({
      email: z.string().trim().max(120),
    }),
    response: passwordResetRequestSchema,
    async handler(ctx, args): Promise<z.infer<typeof passwordResetRequestSchema>> {
      const generic =
        "If an account uses that email, a reset link is on its way — it works once and expires in 1 hour.";
      const email = args.email.toLowerCase();
      // Over the cap: still the generic message, so the cap never leaks
      // whether the email has an account.
      if (!allow(`resetreq:ip:${ctx.ip}`, RESET_REQUEST_PER_IP_PER_15_MIN, 15 * MINUTE)) {
        return { ok: true as const, message: generic };
      }
      if (!allow(`resetreq:email:${email}`, RESET_REQUEST_PER_EMAIL_PER_HOUR, HOUR)) {
        return { ok: true as const, message: generic };
      }
      if (!isValidEmail(email)) {
        return { ok: true as const, message: generic };
      }
      const rows = await ctx.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      const user = rows[0];
      if (!user) {
        return { ok: true as const, message: generic };
      }
      // One live token per account: a fresh request replaces any unused one.
      await ctx.db
        .delete(schema.passwordResets)
        .where(eq(schema.passwordResets.userId, user.id));
      const token = randomBytes(32).toString("hex");
      const now = new Date();
      await ctx.db.insert(schema.passwordResets).values({
        userId: user.id,
        tokenHash: hashToken(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
        usedAt: null,
      });
      const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
      const resetUrl = `${base}/reset-password?token=${token}`;
      await sendPasswordResetEmail({ to: email, resetUrl });
      return { ok: true as const, message: generic };
    },
  }),

  resetPassword: defineAction({
    description:
      "Completes a forgot-password reset: a valid, unused, unexpired token plus a new password (at least 8 characters). The token is single-use — it is consumed on success — and every session for the account is ended, so the new password is needed everywhere. A bad, reused, or expired token gets the same generic failure.",
    request: z.object({
      token: z.string().min(1).max(200),
      newPassword: z.string().min(8).max(128),
    }),
    response: passwordResetSchema,
    async handler(ctx, args): Promise<z.infer<typeof passwordResetSchema>> {
      const invalid = {
        ok: false,
        error:
          "That reset link is not valid or has expired. Ask for a new one from the sign-in screen.",
      } as const;
      if (!allow(`reset:ip:${ctx.ip}`, RESET_ATTEMPTS_PER_IP_PER_15_MIN, 15 * MINUTE)) {
        return invalid;
      }
      const rows = await ctx.db
        .select()
        .from(schema.passwordResets)
        .where(eq(schema.passwordResets.tokenHash, hashToken(args.token)))
        .limit(1);
      const record = rows[0];
      if (!record || record.usedAt) {
        return invalid;
      }
      if (record.expiresAt.getTime() < Date.now()) {
        return invalid;
      }
      const passwordHash = await hashPassword(args.newPassword);
      await ctx.db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        await t
          .update(schema.users)
          .set({ passwordHash })
          .where(eq(schema.users.id, record.userId));
        // Consume the token and end every session: the new password is
        // needed everywhere from here on.
        await t.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, record.userId));
        await t.delete(schema.sessions).where(eq(schema.sessions.userId, record.userId));
      });
      return { ok: true as const };
    },
  }),

  signOut: defineAction({
    description: "Signs out, ending the current session.",
    request: z.object({}),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx) {
      if (ctx.sessionToken) {
        await deleteSession(ctx.db, ctx.sessionToken);
      }
      ctx.cookies.push(clearSessionCookie());
      return { ok: true };
    },
  }),

  deleteAccount: defineAction({
    description:
      "Permanently deletes the signed-in account and every row that belongs to it — kids, chores, completions, points, prizes, quests, boss battles, crowns, the Grown-Up Zone PIN, and all sessions — then signs the user out. Irreversible. The account password is always required; when a Grown-Up Zone PIN is set, a live unlock token is required too, so the delete can only happen from inside the unlocked zone. Never touches another account's data: every delete is scoped to the signed-in account's own id.",
    request: z.object({
      password: z.string().min(1).max(128),
      pinToken: z.string().max(200).optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    }),
    async handler(ctx, args): Promise<{ ok: boolean; error?: string }> {
      if (!allow(`delete:ip:${ctx.ip}`, DELETE_PER_IP_PER_15_MIN, 15 * MINUTE)) {
        return { ok: false, error: "Too many delete attempts from here. Try again in a little while." };
      }
      const user = requireUser(ctx);
      const userId = user.id;
      if (
        !allow(
          `delete:email:${user.email}`,
          DELETE_FAILURES_PER_EMAIL_PER_15_MIN,
          15 * MINUTE,
        )
      ) {
        return { ok: false, error: "Too many delete attempts for this account. Try again in a little while." };
      }
      const rows = await ctx.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      const account = rows[0];
      if (!account) {
        return { ok: false, error: "That account is already gone." };
      }
      // A Grown-Up Zone PIN, when one is set, must be unlocked first —
      // the delete button only ever shows inside the unlocked zone, and
      // the live token is the proof. Accounts with no PIN skip this.
      const auth = await getAuthRow(ctx.db, userId);
      if (auth) {
        await requirePinSession(ctx.db, userId, args.pinToken ?? "");
      }
      if (!(await verifyPassword(args.password, account.passwordHash))) {
        return { ok: false, error: "That password is not correct." };
      }
      resetLimit(`delete:email:${user.email}`);
      // Children first, then the account itself — every delete scoped to
      // this account's id, in one transaction, so the account either
      // vanishes whole or not at all.
      await ctx.db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        await t.delete(schema.completions).where(eq(schema.completions.userId, userId));
        await t.delete(schema.bonuses).where(eq(schema.bonuses.userId, userId));
        await t.delete(schema.penalties).where(eq(schema.penalties.userId, userId));
        await t.delete(schema.quests).where(eq(schema.quests.userId, userId));
        await t.delete(schema.lootChests).where(eq(schema.lootChests.userId, userId));
        await t.delete(schema.redemptions).where(eq(schema.redemptions.userId, userId));
        await t.delete(schema.rewards).where(eq(schema.rewards.userId, userId));
        await t.delete(schema.chores).where(eq(schema.chores.userId, userId));
        await t.delete(schema.players).where(eq(schema.players.userId, userId));
        await t.delete(schema.bossBattles).where(eq(schema.bossBattles.userId, userId));
        await t.delete(schema.weekWinners).where(eq(schema.weekWinners.userId, userId));
        await t.delete(schema.grownupAuth).where(eq(schema.grownupAuth.userId, userId));
        await t.delete(schema.pinSessions).where(eq(schema.pinSessions.userId, userId));
        await t.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, userId));
        await t.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
        await t.delete(schema.users).where(eq(schema.users.id, userId));
      });
      ctx.cookies.push(clearSessionCookie());
      return { ok: true };
    },
  }),

  addPlayer: defineAction({
    description: "Adds a kid to this account's board. The public app starts with no players — the family adds their own kids on first setup, behind the Grown-Up Zone PIN.",
    request: z.object({
      name: z.string().trim().min(1).max(40),
      age: z.number().int().min(3).max(17),
      color: z.string().max(16),
      emoji: z.string().max(8),
      pinToken: z.string(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      playerId: z.number().optional(),
    }),
    async handler(ctx, args) {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);
      const inserted = await db
        .insert(schema.players)
        .values({
          userId,
          name: args.name.trim(),
          age: args.age,
          color: args.color,
          emoji: args.emoji,
        })
        .returning({ id: schema.players.id });
      const row = inserted[0];
      if (!row) throw new Error("The player could not be added.");
      return { ok: true, playerId: row.id };
    },
  }),

  getPinStatus: defineAction({
    description:
      "Reports the Grown-Up Zone PIN gate state: whether a parent has created a PIN yet, whether the gate is briefly locked after too many wrong tries, and how many tries remain. Never returns the PIN or any hash.",
    request: z.object({}),
    response: pinStatusResponse,
    async handler(ctx): Promise<z.infer<typeof pinStatusResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      const auth = await getAuthRow(db, userId);
      if (!auth) {
        return {
          hasPin: false,
          locked: false,
          lockSecondsRemaining: 0,
          attemptsRemaining: MAX_PIN_ATTEMPTS,
          maxAttempts: MAX_PIN_ATTEMPTS,
        };
      }
      const lockSeconds = pinLockSeconds(auth, new Date());
      return {
        hasPin: true,
        locked: lockSeconds > 0,
        lockSecondsRemaining: lockSeconds,
        attemptsRemaining: Math.max(
          0,
          MAX_PIN_ATTEMPTS - auth.failedAttempts,
        ),
        maxAttempts: MAX_PIN_ATTEMPTS,
      };
    },
  }),

  setupPin: defineAction({
    description:
      "First-time Grown-Up Zone setup: a parent creates their own 4-digit PIN (entered twice in the app) plus a recovery phrase only grown-ups know, used if the PIN is ever forgotten. Only salted hashes are stored. Refuses if a PIN already exists. Returns an unlock token so the zone opens right away.",
    request: z.object({
      pin: z.string().regex(PIN_FORMAT),
      recoveryPhrase: z.string().min(6).max(100),
    }),
    response: pinUnlockResponse,
    async handler(ctx, args): Promise<z.infer<typeof pinUnlockResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      const existing = await getAuthRow(db, userId);
      if (existing) {
        throw new Error(
          "A PIN is already set — unlock with it, or use the recovery phrase to reset it.",
        );
      }
      const pinSalt = randomHex(16);
      const recoverySalt = randomHex(16);
      const now = new Date();
      await db.insert(schema.grownupAuth).values({
        userId,
        pinHash: await hashSecret(args.pin, pinSalt),
        pinSalt,
        recoveryHash: await hashSecret(
          normalizeRecovery(args.recoveryPhrase),
          recoverySalt,
        ),
        recoverySalt,
        failedAttempts: 0,
        lockedUntil: null,
        createdAt: now,
        updatedAt: now,
      });
      const token = await mintPinSession(db, userId);      return {
        ok: true,
        token,
        message: "PIN created — the Grown-Up Zone is unlocked.",
        locked: false,
        lockSecondsRemaining: 0,
        attemptsRemaining: MAX_PIN_ATTEMPTS,
      };
    },
  }),

  verifyPin: defineAction({
    description:
      "Checks a 4-digit PIN entry for the Grown-Up Zone. A correct PIN mints a short-lived unlock token (it expires after a few idle minutes). Wrong tries count toward a brief lockout after several misses; the answer comes back in-band with tries remaining or lockout seconds.",
    request: z.object({ pin: z.string().max(8) }),
    response: pinUnlockResponse,
    async handler(ctx, args): Promise<z.infer<typeof pinUnlockResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      const auth = await getAuthRow(db, userId);
      if (!auth) {
        return {
          ok: false,
          token: null,
          message: "No PIN is set yet — a grown-up creates one first.",
          locked: false,
          lockSecondsRemaining: 0,
          attemptsRemaining: MAX_PIN_ATTEMPTS,
        };
      }
      const now = new Date();
      const lockSeconds = pinLockSeconds(auth, now);
      if (lockSeconds > 0) {
        return {
          ok: false,
          token: null,
          message: `Too many wrong tries — the PIN pad is locked for ${lockSeconds} more seconds.`,
          locked: true,
          lockSecondsRemaining: lockSeconds,
          attemptsRemaining: 0,
        };
      }
      const candidate = PIN_FORMAT.test(args.pin)
        ? await hashSecret(args.pin, auth.pinSalt)
        : "";
      if (candidate !== auth.pinHash) {
        const lockedFor = await registerFailedAttempt(db, userId, auth);
        if (lockedFor > 0) {
          return {
            ok: false,
            token: null,
            message: `Too many wrong tries — the PIN pad is locked for ${lockedFor} seconds.`,
            locked: true,
            lockSecondsRemaining: lockedFor,
            attemptsRemaining: 0,
          };
        }
        const remaining = MAX_PIN_ATTEMPTS - (auth.failedAttempts + 1);
        return {
          ok: false,
          token: null,
          message: `That PIN didn't match — ${remaining} ${remaining === 1 ? "try" : "tries"} left before a short lockout.`,
          locked: false,
          lockSecondsRemaining: 0,
          attemptsRemaining: remaining,
        };
      }
      await clearFailedAttempts(db, userId);
      const token = await mintPinSession(db, userId);
      return {
        ok: true,
        token,
        message: "Unlocked — welcome in, grown-up!",
        locked: false,
        lockSecondsRemaining: 0,
        attemptsRemaining: MAX_PIN_ATTEMPTS,
      };
    },
  }),

  resetPinWithRecovery: defineAction({
    description:
      "Forgotten-PIN reset, parent-only by knowledge: the parent must type the recovery phrase they chose when the PIN was created — there is no tap-through reset. A correct phrase clears the PIN (and every unlock session) so a new one can be created; wrong phrases count toward the same brief lockout as wrong PINs.",
    request: z.object({ recoveryPhrase: z.string().min(1).max(100) }),
    response: pinUnlockResponse,
    async handler(ctx, args): Promise<z.infer<typeof pinUnlockResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      const auth = await getAuthRow(db, userId);
      if (!auth) {
        return {
          ok: false,
          token: null,
          message: "No PIN is set yet — nothing to reset.",
          locked: false,
          lockSecondsRemaining: 0,
          attemptsRemaining: MAX_PIN_ATTEMPTS,
        };
      }
      const now = new Date();
      const lockSeconds = pinLockSeconds(auth, now);
      if (lockSeconds > 0) {
        return {
          ok: false,
          token: null,
          message: `The gate is locked for ${lockSeconds} more seconds — try again in a moment.`,
          locked: true,
          lockSecondsRemaining: lockSeconds,
          attemptsRemaining: 0,
        };
      }
      const candidate = await hashSecret(
        normalizeRecovery(args.recoveryPhrase),
        auth.recoverySalt,
      );
      if (candidate !== auth.recoveryHash) {
        const lockedFor = await registerFailedAttempt(db, userId, auth);
        if (lockedFor > 0) {
          return {
            ok: false,
            token: null,
            message: `That recovery phrase didn't match, and the gate is now locked for ${lockedFor} seconds.`,
            locked: true,
            lockSecondsRemaining: lockedFor,
            attemptsRemaining: 0,
          };
        }
        const remaining = MAX_PIN_ATTEMPTS - (auth.failedAttempts + 1);
        return {
          ok: false,
          token: null,
          message: `That recovery phrase didn't match — ${remaining} ${remaining === 1 ? "try" : "tries"} left before a short lockout. Only a grown-up who knows the phrase can reset the PIN.`,
          locked: false,
          lockSecondsRemaining: 0,
          attemptsRemaining: remaining,
        };
      }
      await db
        .delete(schema.grownupAuth)
        .where(and(eq(schema.grownupAuth.userId, userId)));
      await db.delete(schema.pinSessions).where(eq(schema.pinSessions.userId, userId));      return {
        ok: true,
        token: null,
        message:
          "Recovery phrase matched — the old PIN is cleared. Create a new PIN to open the zone.",
        locked: false,
        lockSecondsRemaining: 0,
        attemptsRemaining: MAX_PIN_ATTEMPTS,
      };
    },
  }),

  changePin: defineAction({
    description:
      "Changes the Grown-Up Zone PIN from inside the unlocked zone: requires a live unlock token, sets a new 4-digit PIN (and a new recovery phrase when one is given), and keeps the current session unlocked.",
    request: z.object({
      pinToken: z.string().max(200),
      pin: z.string().regex(PIN_FORMAT),
      recoveryPhrase: z.string().min(6).max(100).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);
      const auth = await getAuthRow(db, userId);
      if (!auth) throw new Error("No PIN is set yet.");
      const pinSalt = randomHex(16);
      const updates: Partial<AuthRow> = {
        pinHash: await hashSecret(args.pin, pinSalt),
        pinSalt,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      };
      if (args.recoveryPhrase) {
        const recoverySalt = randomHex(16);
        updates.recoveryHash = await hashSecret(
          normalizeRecovery(args.recoveryPhrase),
          recoverySalt,
        );
        updates.recoverySalt = recoverySalt;
      }
      await db
        .update(schema.grownupAuth)
        .set(updates)
        .where(and(eq(schema.grownupAuth.userId, userId)));      return { ok: true as const };
    },
  }),

  lockZone: defineAction({
    description:
      "Locks the Grown-Up Zone right away: deletes the caller's unlock session so the PIN is needed again. Called when a parent taps Lock, and by the app when it closes or sits idle.",
    request: z.object({ pinToken: z.string().max(200) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      if (args.pinToken) {
        const tokenHash = await sha256Hex(args.pinToken);
        await db
          .delete(schema.pinSessions)
          .where(and(eq(schema.pinSessions.userId, userId), eq(schema.pinSessions.tokenHash, tokenHash)));
      }
      return { ok: true as const };
    },
  }),

  checkPinSession: defineAction({
    description:
      "Checks whether a Grown-Up Zone unlock token is still live (used when the app reloads and restores an unlock from the same browser session). Answers in-band with ok true/false and never throws; a live check slides the session's idle expiry forward.",
    request: z.object({ pinToken: z.string().max(200) }),
    response: pinSessionCheckResponse,
    async handler(ctx, args): Promise<z.infer<typeof pinSessionCheckResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      if (!args.pinToken) return { ok: false };
      try {
        await requirePinSession(db, userId, args.pinToken);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  }),

  bootstrap: defineAction({
    description:
      "Runs the daily housekeeping for this account (grumbler check, weekly crown, stale quests). The starter board is seeded at signup, so this never creates data.",
    request: z.object({}),
    response: okResponse,
    async handler(ctx): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await housekeeping(db, userId, userTz(user));
      return { ok: true as const };
    },
  }),

  getState: defineAction({
    description:
      "Returns the full Chore Champions game state: players, scores, streaks, tiers, chores, rewards, quests, and recent activity.",
    request: z.object({}),
    response: stateResponse,
    async handler(ctx) {
      const user = requireUser(ctx);
      return buildState(ctx, user.id, userTz(user));
    },
  }),

  completeChore: defineAction({
    description:
      "A kid taps 'did it' on a chore: it goes to 'Waiting for a parent to check it' with its points held. No points land until a parent verifies it with verifyCompletion. The tap alone protects the player from the nightly grumbler.",
    request: z.object({ choreId: z.number(), playerId: z.number() }),
    response: submitResponse,
    async handler(ctx, args): Promise<z.infer<typeof submitResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;      const choreRows = await db
        .select()
        .from(schema.chores)
        .where(and(eq(schema.chores.userId, userId), eq(schema.chores.id, args.choreId), eq(schema.chores.active, true)));
      const chore = choreRows[0];
      if (!chore) throw new Error("That chore is no longer on the board.");
      if (chore.assignedPlayerId != null && chore.assignedPlayerId !== args.playerId) {
        throw new Error("That chore belongs to the other player.");
      }
      const today = todayKey(userTz(user));
      const weekStart = mondayOf(today);
      const prior = await db
        .select()
        .from(schema.completions)
        .where(
          and(eq(schema.completions.userId, userId), 
            eq(schema.completions.choreId, chore.id),
            eq(schema.completions.playerId, args.playerId),
            gte(schema.completions.day, chore.cadence === "daily" ? today : weekStart),
            inArray(schema.completions.status, ["pending", "verified"]),
          ),
        );
      const alreadyDone =
        chore.cadence === "once"
          ? prior.length > 0
          : prior.some((c) => (chore.cadence === "daily" ? c.day === today : true));
      if (alreadyDone) {
        const waiting = prior.some((c) => c.status === "pending");
        throw new Error(
          waiting
            ? "That one is already waiting for a parent to check it."
            : "That one is already done for this round.",
        );
      }

      const playerRows = await db
        .select()
        .from(schema.players)
        .where(and(eq(schema.players.userId, userId), eq(schema.players.id, args.playerId)));
      const player = playerRows[0];
      if (!player) throw new Error("That player isn't in the game.");

      await db.insert(schema.completions).values({
        userId,
        choreId: chore.id,
        playerId: args.playerId,
        choreTitle: chore.title,
        points: chore.points,
        day: today,
        status: "pending",
      });      return { ok: true as const, pending: true as const };
    },
  }),

  verifyCompletion: defineAction({
    description:
      "Parent verification from the PIN-locked Grown-Up Zone (requires a live unlock token): approving a pending chore awards its held points and settles quests, hearts, chests, and Monster Boss damage; rejecting it sends the chore back open with no points.",
    request: z.object({
      completionId: z.number(),
      approve: z.boolean(),
      pinToken: z.string().max(200),
    }),
    response: verifyResponse,
    async handler(ctx, args): Promise<z.infer<typeof verifyResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);      const rows = await db
        .select()
        .from(schema.completions)
        .where(
          and(eq(schema.completions.userId, userId), 
            eq(schema.completions.id, args.completionId),
            eq(schema.completions.status, "pending"),
          ),
        );
      const pending = rows[0];
      if (!pending) {
        throw new Error("That chore isn't waiting to be checked anymore.");
      }
      if (!args.approve) {
        await db
          .update(schema.completions)
          .set({ status: "rejected" })
          .where(and(eq(schema.completions.userId, userId), eq(schema.completions.id, pending.id)));
        return {
          ok: true as const,
          approved: false,
          points: 0,
          chestTier: null,
          questCompleted: false,
          bossDefeated: false,
          tierUp: null,
          heartGained: false,
          rallied: false,
          knockedOut: false,
        };
      }
      const settled = await settleVerification(db, userId, pending, userTz(user));      return { ok: true as const, approved: true, ...settled };
    },
  }),

  deductForNotListening: defineAction({
    description:
      "Grown-Up Zone only: a parent takes a chosen number of points (5, 10, 15, or 20) off a player's weekly score because they didn't listen the first time. Weekly points only — the spendable prize balance and lifetime points are untouched, the weekly score never drops below zero, and it has nothing to do with grumbler hearts. Shows in activity as 'Didn't listen the first time — N points off' with the amount taken.",
    request: z.object({
      playerId: z.number(),
      points: z.union([
        z.literal(5),
        z.literal(10),
        z.literal(15),
        z.literal(20),
      ]),
      pinToken: z.string().max(200),
    }),
    response: penaltyResponse,
    async handler(ctx, args): Promise<z.infer<typeof penaltyResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);      const playerRows = await db
        .select()
        .from(schema.players)
        .where(and(eq(schema.players.userId, userId), eq(schema.players.id, args.playerId)));
      const player = playerRows[0];
      if (!player) throw new Error("That player isn't in the game.");
      const requested: ListeningPenaltyAmount = args.points;
      // Cap at what the player actually has this week: the weekly
      // score can only drop to zero, so taking more than that would
      // overstate the deduction in the record, the label, and the
      // reply. Record, label, and return only what was really taken.
      const before = await loadStats(db, userId, args.playerId, userTz(user));
      const deducted = Math.min(requested, before.weekPoints);
      if (deducted > 0) {
        await db.insert(schema.penalties).values({
          userId,
          playerId: args.playerId,
          points: deducted,
          label: listeningPenaltyLabel(deducted),
          day: todayKey(userTz(user)),
        });
      }
      const stats = await loadStats(db, userId, args.playerId, userTz(user));      return {
        ok: true as const,
        deducted,
        weekPoints: stats.weekPoints,
      };
    },
  }),

  undoCompletion: defineAction({
    description: "Removes a player's most recent tap on a chore (fixes a mis-tap; also withdraws a chore still waiting for a parent check).",
    request: z.object({ choreId: z.number(), playerId: z.number() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      const rows = await db
        .select()
        .from(schema.completions)
        .where(
          and(eq(schema.completions.userId, userId), 
            eq(schema.completions.choreId, args.choreId),
            eq(schema.completions.playerId, args.playerId),
          ),
        )
        .orderBy(desc(schema.completions.id))
        .limit(1);
      const row = rows[0];
      if (row) {
        await db.delete(schema.completions).where(and(eq(schema.completions.userId, userId), eq(schema.completions.id, row.id)));
      }      return { ok: true as const };
    },
  }),

  addChore: defineAction({
    description: "Adds a new chore to the board. Grown-Up Zone only — requires a live PIN unlock token.",
    request: z.object({
      title: z.string().min(1).max(80),
      points: z.number().int().min(1).max(500),
      cadence: z.enum(["daily", "weekly", "once"]),
      assignedPlayerId: z.number().nullable(),
      pinToken: z.string().max(200),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);
      await db.insert(schema.chores).values({
        userId,
        title: args.title.trim(),
        points: args.points,
        cadence: args.cadence,
        assignedPlayerId: args.assignedPlayerId,
      });      return { ok: true as const };
    },
  }),

  updateChore: defineAction({
    description: "Edits a chore's title, points, cadence, or assignment. Grown-Up Zone only — requires a live PIN unlock token.",
    request: z.object({
      id: z.number(),
      title: z.string().min(1).max(80),
      points: z.number().int().min(1).max(500),
      cadence: z.enum(["daily", "weekly", "once"]),
      assignedPlayerId: z.number().nullable(),
      pinToken: z.string().max(200),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);
      await db
        .update(schema.chores)
        .set({
          title: args.title.trim(),
          points: args.points,
          cadence: args.cadence,
          assignedPlayerId: args.assignedPlayerId,
        })
        .where(and(eq(schema.chores.userId, userId), eq(schema.chores.id, args.id)));      return { ok: true as const };
    },
  }),

  deleteChore: defineAction({
    description: "Removes a chore from the board (history is kept). Grown-Up Zone only — requires a live PIN unlock token.",
    request: z.object({ id: z.number(), pinToken: z.string().max(200) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);
      await db
        .update(schema.chores)
        .set({ active: false })
        .where(and(eq(schema.chores.userId, userId), eq(schema.chores.id, args.id)));      return { ok: true as const };
    },
  }),

  addReward: defineAction({
    description: "Adds a new reward to the shop. Grown-Up Zone only — requires a live PIN unlock token.",
    request: z.object({
      title: z.string().min(1).max(80),
      cost: z.number().int().min(1).max(10000),
      pinToken: z.string().max(200),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);
      await db.insert(schema.rewards).values({ userId, title: args.title.trim(), cost: args.cost });      return { ok: true as const };
    },
  }),

  updateReward: defineAction({
    description: "Edits a reward's title or cost. Grown-Up Zone only — requires a live PIN unlock token.",
    request: z.object({
      id: z.number(),
      title: z.string().min(1).max(80),
      cost: z.number().int().min(1).max(10000),
      pinToken: z.string().max(200),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);
      await db
        .update(schema.rewards)
        .set({ title: args.title.trim(), cost: args.cost })
        .where(and(eq(schema.rewards.userId, userId), eq(schema.rewards.id, args.id)));      return { ok: true as const };
    },
  }),

  deleteReward: defineAction({
    description: "Removes a reward from the shop. Grown-Up Zone only — requires a live PIN unlock token.",
    request: z.object({ id: z.number(), pinToken: z.string().max(200) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);
      await db
        .update(schema.rewards)
        .set({ active: false })
        .where(and(eq(schema.rewards.userId, userId), eq(schema.rewards.id, args.id)));      return { ok: true as const };
    },
  }),

  redeemReward: defineAction({
    description: "A player spends points on a reward; it lands as pending until a grown-up approves it.",
    request: z.object({ rewardId: z.number(), playerId: z.number() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      const rewardRows = await db
        .select()
        .from(schema.rewards)
        .where(and(eq(schema.rewards.userId, userId), eq(schema.rewards.id, args.rewardId), eq(schema.rewards.active, true)));
      const reward = rewardRows[0];
      if (!reward) throw new Error("That reward is no longer in the shop.");
      const stats = await loadStats(db, userId, args.playerId, userTz(user));
      if (stats.balance < reward.cost) {
        throw new Error(
          `Not enough points yet — that takes ${reward.cost} and the balance is ${stats.balance}.`,
        );
      }
      await db.insert(schema.redemptions).values({
        userId,
        rewardId: reward.id,
        playerId: args.playerId,
        rewardTitle: reward.title,
        cost: reward.cost,
        status: "pending",
      });      return { ok: true as const };
    },
  }),

  resolveRedemption: defineAction({
    description: "A grown-up approves or declines a pending reward redemption (declining refunds the points). Requires a live PIN unlock token from the Grown-Up Zone, so kids can't approve their own prizes.",
    request: z.object({
      id: z.number(),
      approve: z.boolean(),
      pinToken: z.string().max(200),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);
      await db
        .update(schema.redemptions)
        .set({
          status: args.approve ? "approved" : "declined",
          resolvedAt: new Date(),
        })
        .where(
          and(eq(schema.redemptions.userId, userId), eq(schema.redemptions.id, args.id), eq(schema.redemptions.status, "pending")),
        );      return { ok: true as const };
    },
  }),

  updatePlayer: defineAction({
    description: "Edits a player's name, age, avatar emoji, or color. Grown-Up Zone only — requires a live PIN unlock token.",
    request: z.object({
      id: z.number(),
      name: z.string().min(1).max(30),
      age: z.number().int().min(1).max(18),
      emoji: z.string().min(1).max(8),
      color: z.string().min(4).max(16),
      pinToken: z.string().max(200),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await requirePinSession(db, userId, args.pinToken);
      await db
        .update(schema.players)
        .set({
          name: args.name.trim(),
          age: args.age,
          emoji: args.emoji,
          color: args.color,
        })
        .where(and(eq(schema.players.userId, userId), eq(schema.players.id, args.id)));      return { ok: true as const };
    },
  }),

  dismissQuest: defineAction({
    description: "Dismisses an active comeback or streak-save quest.",
    request: z.object({ id: z.number() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      await db
        .update(schema.quests)
        .set({ status: "dismissed" })
        .where(and(eq(schema.quests.userId, userId), eq(schema.quests.id, args.id), eq(schema.quests.status, "active")));      return { ok: true as const };
    },
  }),

  openChest: defineAction({
    description:
      "Opens one of a player's treasure chests: rolls its bonus points, banks them, and returns the reward so the client can celebrate.",
    request: z.object({ chestId: z.number(), playerId: z.number() }),
    response: chestResponse,
    async handler(ctx, args): Promise<z.infer<typeof chestResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      const rows = await db
        .select()
        .from(schema.lootChests)
        .where(
          and(eq(schema.lootChests.userId, userId), 
            eq(schema.lootChests.id, args.chestId),
            eq(schema.lootChests.playerId, args.playerId),
            eq(schema.lootChests.status, "unopened"),
          ),
        );
      const chest = rows[0];
      if (!chest) throw new Error("That chest is already open (or gone).");
      const ranges: Record<string, [number, number]> = {
        common: [10, 25],
        epic: [30, 60],
        legendary: [75, 150],
      };
      const [lo = 10, hi = 25] = ranges[chest.tier] ?? [10, 25];
      const rewardPoints = lo + Math.floor(Math.random() * (hi - lo + 1));
      const labels: Record<string, string> = {
        common: "Wooden chest",
        epic: "MAGIC chest",
        legendary: "CRYSTAL chest",
      };
      const rewardLabel = `${labels[chest.tier] ?? "Wooden chest"} opened!`;
      await db
        .update(schema.lootChests)
        .set({ status: "opened", rewardPoints, rewardLabel, openedAt: new Date() })
        .where(and(eq(schema.lootChests.userId, userId), eq(schema.lootChests.id, chest.id)));
      await db.insert(schema.bonuses).values({
        userId,
        playerId: args.playerId,
        points: rewardPoints,
        label: `⛏️ ${rewardLabel}`,
        day: todayKey(userTz(user)),
      });      return { ok: true as const, rewardPoints, rewardLabel };
    },
  }),

  equipAvatar: defineAction({
    description:
      "Equips an unlocked skin for a player (unlocks are earned with lifetime points).",
    request: z.object({ playerId: z.number(), avatarKey: z.string().min(1).max(24) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;
      const item = avatarItem(args.avatarKey);
      if (!item || item.key !== args.avatarKey) {
        throw new Error("That look doesn't exist.");
      }
      const stats = await loadStats(db, userId, args.playerId, userTz(user));
      if (stats.lifetimePoints < item.unlockAt) {
        throw new Error(
          `Locked! Earn ${item.unlockAt - stats.lifetimePoints} more lifetime points to unlock the ${item.name} style.`,
        );
      }
      await db
        .update(schema.players)
        .set({ equippedAvatar: item.key })
        .where(and(eq(schema.players.userId, userId), eq(schema.players.id, args.playerId)));      return { ok: true as const };
    },
  }),

  resetDaily: defineAction({
    description:
      "Daily reset: expires stale quests, crowns last week's Star Champion, runs the nightly grumbler check (a heart is lost for each finished day whose daily chores weren't all done; zero hearts knocks a player out until they finish a Rally Quest), and lines up fresh motivation quests. Daily chores reset on their own each new day.",
    request: z.object({}),
    response: okResponse,
    async handler(ctx): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const user = requireUser(ctx);
      const userId = user.id;      await housekeeping(db, userId, userTz(user));
      const playerRows = await db.select().from(schema.players).where(eq(schema.players.userId, userId));
      for (const p of playerRows) {
        const s = await loadStats(db, userId, p.id, userTz(user));
        const rivals = await Promise.all(
          playerRows.filter((r) => r.id !== p.id).map((r) => loadStats(db, userId, r.id, userTz(user))),
        );
        const best = Math.max(0, ...rivals.map((r) => r.weekPoints));
        await maybeCreateQuest(db, userId, p, s, best, userTz(user));
      }      return { ok: true as const };
    },
  }),
};
