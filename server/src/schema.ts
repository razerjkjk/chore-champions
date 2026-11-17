// Chore Champions schema (public edition).
//
// Every family's game lives in its own account. `users` and `sessions`
// are the accounts; every other table carries `userId` and every query
// is scoped to the signed-in account, so one family can never see or
// touch another family's kids, chores, points, or PIN.
//
// players      — the kids in this account, added by a grown-up.
// chores       — chore catalog; cadence daily | weekly | once.
// completions  — one row per tapped chore; points and day are snapshotted
//                so later edits to a chore never rewrite history. A tap is
//                "pending" until a parent verifies it ("verified") or sends
//                it back ("rejected"); only verified rows score points.
// rewards      — reward shop catalog.
// redemptions  — reward requests; pending -> approved | declined (refund).
// bonuses      — extra points granted by quests / streak saves / comebacks.
// penalties    — weekly-only point deductions (e.g. not listening the
//                first time). They lower weekPoints only — never the
//                lifetime total or the spendable prize balance — and
//                weekPoints never drops below zero.
// quests       — comeback quests and streak saves with a target + deadline.
// week_winners — one row per finished week naming the champion.
// grownup_auth — the account's Grown-Up Zone PIN record (salted hashes only).
// pin_sessions — hashed, short-lived unlock tokens for the zone.

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Accounts. Passwords are stored only as argon2id hashes (Bun.password). */
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Lowercased on signup; unique. */
    email: text("email").notNull(),
    /** First name, shown in the header once signed in. */
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** IANA timezone the family plays in (day boundaries, weekly crowns,
     *  and the nightly grumbler check all run in this zone). */
    timezone: text("timezone").notNull().default("America/Chicago"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

/** Cookie sessions. Only a SHA-256 hash of the token is stored; the raw
 *  token lives only in the user's HttpOnly cookie. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_idx").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
  ],
);

export const passwordResets = sqliteTable(
  "password_resets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    /** SHA-256 hash of the reset token. The raw token is only ever in
     *  the email link — never stored, never logged. */
    tokenHash: text("token_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Single-use links live 1 hour. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("password_resets_token_hash_idx").on(t.tokenHash),
    index("password_resets_user_id_idx").on(t.userId),
  ],
);

export const players = sqliteTable(
  "players",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    name: text("name").notNull(),
    age: integer("age").notNull(),
    color: text("color").notNull(),
    emoji: text("emoji").notNull().default("⭐"),
    // Key of the equipped avatar look (see AVATAR_ITEMS in actions.ts).
    equippedAvatar: text("equipped_avatar").notNull().default("starter"),
    // Hearts (lives). A grumbler takes one for each finished day where
    // the player didn't complete all of their daily chores. At zero the
    // player is knocked out until they finish a Rally Quest.
    hearts: integer("hearts").notNull().default(5),
    // Watermark: the last day (YYYY-MM-DD) the nightly grumbler check
    // has settled for this player. Null = never settled.
    lastGrumblerDay: text("last_grumbler_day"),
    // Most recent day a grumbler actually took a heart (for the alert banner).
    lastGrumblerHit: text("last_grumbler_hit"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("players_user_id_idx").on(t.userId)],
);

export const chores = sqliteTable(
  "chores",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    title: text("title").notNull(),
    points: integer("points").notNull(),
    cadence: text("cadence", { enum: ["daily", "weekly", "once"] })
      .notNull()
      .default("daily"),
    // null = open to either kid (first tap claims it for that period)
    assignedPlayerId: integer("assigned_player_id").references(() => players.id),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("chores_user_id_idx").on(t.userId)],
);

export const completions = sqliteTable(
  "completions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    choreId: integer("chore_id")
      .notNull()
      .references(() => chores.id),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    choreTitle: text("chore_title").notNull(),
    points: integer("points").notNull(),
    // Local calendar day the chore counts for: YYYY-MM-DD.
    day: text("day").notNull(),
    // Parent verification: a kid's tap lands as "pending" with its points
    // held. Only "verified" rows count toward scores, streaks, and the
    // boss. "rejected" sends the chore back open with no points. A pending
    // row still counts as done for the nightly grumbler check (the
    // grumbler only takes a heart for chores never tapped).
    status: text("status", { enum: ["pending", "verified", "rejected"] })
      .notNull()
      .default("verified"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("completions_user_id_idx").on(t.userId)],
);

export const rewards = sqliteTable(
  "rewards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    title: text("title").notNull(),
    cost: integer("cost").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("rewards_user_id_idx").on(t.userId)],
);

export const redemptions = sqliteTable(
  "redemptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    rewardId: integer("reward_id")
      .notNull()
      .references(() => rewards.id),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    rewardTitle: text("reward_title").notNull(),
    cost: integer("cost").notNull(),
    status: text("status", { enum: ["pending", "approved", "declined"] })
      .notNull()
      .default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("redemptions_user_id_idx").on(t.userId)],
);

export const bonuses = sqliteTable(
  "bonuses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    points: integer("points").notNull(),
    label: text("label").notNull(),
    day: text("day").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("bonuses_user_id_idx").on(t.userId)],
);

export const penalties = sqliteTable(
  "penalties",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    // Always positive: the number of points taken off the week's score.
    points: integer("points").notNull(),
    label: text("label").notNull(),
    // Local calendar day the deduction happened: YYYY-MM-DD.
    day: text("day").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("penalties_user_id_idx").on(t.userId)],
);

export const quests = sqliteTable(
  "quests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    kind: text("kind", { enum: ["comeback", "streak_save", "rally"] }).notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    targetChores: integer("target_chores").notNull(),
    bonusPoints: integer("bonus_points").notNull(),
    // Local day the quest must be finished by (inclusive): YYYY-MM-DD.
    deadlineDay: text("deadline_day").notNull(),
    status: text("status", {
      enum: ["active", "completed", "expired", "dismissed"],
    })
      .notNull()
      .default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("quests_user_id_idx").on(t.userId)],
);

export const bossBattles = sqliteTable(
  "boss_battles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    name: text("name").notNull(),
    emoji: text("emoji").notNull(),
    taunt: text("taunt").notNull(),
    maxHp: integer("max_hp").notNull(),
    // Monday of the week this boss rules: YYYY-MM-DD.
    weekStart: text("week_start").notNull(),
    lootGranted: integer("loot_granted", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    defeatedAt: integer("defeated_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("boss_battles_user_id_idx").on(t.userId),
    uniqueIndex("boss_battles_user_week_idx").on(t.userId, t.weekStart),
  ],
);

export const lootChests = sqliteTable(
  "loot_chests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    tier: text("tier", { enum: ["common", "epic", "legendary"] })
      .notNull()
      .default("common"),
    status: text("status", { enum: ["unopened", "opened"] })
      .notNull()
      .default("unopened"),
    rewardPoints: integer("reward_points"),
    rewardLabel: text("reward_label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("loot_chests_user_id_idx").on(t.userId)],
);

// Grown-Up Zone PIN gate, one row per account. The row holds a salted
// hash of the parent's 4-digit PIN and a salted hash of their recovery
// phrase — never the PIN or phrase themselves. failedAttempts /
// lockedUntil drive the brief lockout after several wrong tries.
// pinSessions holds hashed unlock tokens: unlocking mints one, it slides
// forward on each protected action, and it expires after a few idle
// minutes so the zone re-locks on its own. Deleting the auth row
// (recovery reset) clears it.
export const grownupAuth = sqliteTable(
  "grownup_auth",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    pinHash: text("pin_hash").notNull(),
    pinSalt: text("pin_salt").notNull(),
    recoveryHash: text("recovery_hash").notNull(),
    recoverySalt: text("recovery_salt").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("grownup_auth_user_id_idx").on(t.userId)],
);

export const pinSessions = sqliteTable(
  "pin_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("pin_sessions_user_id_idx").on(t.userId)],
);

export const weekWinners = sqliteTable(
  "week_winners",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    // Monday of the finished week: YYYY-MM-DD.
    weekStart: text("week_start").notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.id),
    points: integer("points").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("week_winners_user_id_idx").on(t.userId),
    uniqueIndex("week_winners_user_week_idx").on(t.userId, t.weekStart),
  ],
);
