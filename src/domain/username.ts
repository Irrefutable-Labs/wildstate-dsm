/**
 * Player identity in the lobby. The DSM wallet identity (its Base32 account id) is the canonical
 * key: profile, rating, history, match eligibility and stakes all hang off it. A username is a
 * plain, unique, human-friendly label bound to that identity; it can change without touching any
 * of them. Lookups accept either: a name resolves to its identity, an exact identity resolves to
 * itself.
 */
const USERNAME = /^[a-z0-9_]{3,16}$/;
/** Names of the game's own characters and brands, never given to players. */
const RESERVED = new Set(['kade', 'nessa', 'mira', 'rowan', 'bramble', 'admin', 'wildstate', 'dsm', 'system', 'game']);
/** A player may take a new name once a day. */
export const RENAME_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const HISTORY_MAX = 20;

export interface MatchSummary {
  matchId: string;
  opponent: string;
  stake: number;
  result: 'win' | 'loss' | 'void';
  ratingDelta: number;
  at: number;
}
export interface PlayerProfile {
  username: string | null;
  renamedAt: number;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  history: MatchSummary[];
  /**
   * The players this one keeps in FRIENDS, by identity, newest first: everyone they found,
   * challenged or played, so they never search for them again. Absent from records made before.
   */
  friends?: string[];
}
/** The lobby's directory: profiles by identity, and the username index into them. */
export interface Directory {
  players: Record<string, PlayerProfile>;
  usernames: Record<string, string>;
}

type UsernameError = 'invalid-username' | 'reserved-username' | 'username-taken' | 'rename-cooldown';

export const freshProfile = (): PlayerProfile => ({ username: null, renamedAt: 0, rating: 1200, games: 0, wins: 0, losses: 0, history: [], friends: [] });

/** The most friends one player keeps; past it the one they met longest ago drops off. */
export const FRIENDS_MAX = 200;

/** `wallet` keeps `friend` in FRIENDS, at the top. Never themselves. */
export function befriend(dir: Directory, wallet: string, friend: string): void {
  if (wallet === friend) return;
  const p = (dir.players[wallet] ??= freshProfile());
  p.friends = [friend, ...(p.friends ?? []).filter((f) => f !== friend)].slice(0, FRIENDS_MAX);
}

/** `wallet` drops `friend` from FRIENDS. */
export function unfriend(dir: Directory, wallet: string, friend: string): void {
  const p = dir.players[wallet];
  if (p) p.friends = (p.friends ?? []).filter((f) => f !== friend);
}

/** Usernames compare case-insensitively; this is the stored form. */
const normalize = (name: string) => name.trim().toLowerCase();

export function validateUsername(name: string): UsernameError | null {
  const n = normalize(name);
  if (!USERNAME.test(n)) return 'invalid-username';
  if (RESERVED.has(n)) return 'reserved-username';
  return null;
}

/**
 * Binds `name` to `wallet`, freeing the name it held before. Returns the error, or null once the
 * directory holds the binding. Synchronous, so two claims for one name cannot interleave.
 */
export function claimUsername(dir: Directory, wallet: string, name: string, now: number): UsernameError | null {
  const invalid = validateUsername(name);
  if (invalid) return invalid;
  const n = normalize(name);
  const owner = dir.usernames[n];
  if (owner !== undefined && owner !== wallet) return 'username-taken';
  const profile = (dir.players[wallet] ??= freshProfile());
  if (profile.username === n) return null;
  if (profile.username !== null && now - profile.renamedAt < RENAME_COOLDOWN_MS) return 'rename-cooldown';
  if (profile.username !== null) delete dir.usernames[profile.username];
  dir.usernames[n] = wallet;
  profile.username = n;
  profile.renamedAt = now;
  return null;
}

/** Finds a player by exact DSM identity or by username; the identity is the answer either way. */
export function resolvePlayer(dir: Directory, query: string): string | null {
  const q = query.trim();
  if (!q) return null;
  const id = q.toUpperCase();
  if (dir.players[id] !== undefined) return id;
  return dir.usernames[normalize(q.replace(/^@/, ''))] ?? null;
}

/** How a player is shown: their name, or a short form of their identity until they pick one. */
export const shownName = (dir: Directory, wallet: string) => dir.players[wallet]?.username ?? `${wallet.slice(0, 8)}…`;
