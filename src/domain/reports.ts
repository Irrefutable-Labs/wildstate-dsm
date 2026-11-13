/**
 * The reports a beta tester files from the game: a game bug, and the week's game missions. Each is
 * a GitHub issue on the game's repository, its body built here from what the tester ticked and
 * typed plus the game details the screen attaches. The wallet's half of a tester's week (its
 * missions and its bugs) is filed from the DSM wallet's own Report a problem, never from here.
 * Web2 game data: not a DSM encoding and not DSM state.
 */
import type { Mission } from './missions';

/** Where game reports go: the game's public repository. */
export const GAME_REPO = 'Irrefutable-Labs/wildstate-dsm';
/** The issue templates the bodies below fill (.github/ISSUE_TEMPLATE in the game's repository). */
export const BUG_TEMPLATE = 'game-bug.md';
export const MISSIONS_TEMPLATE = 'weekly-game-missions.md';
/** GitHub reads a new-issue link of about 8,000 characters; the body is kept under this. */
export const BODY_MAX = 6000;

/** How a tester's week is split: told on the report screen, and in every body. */
export const SPLIT_NOTE = 'Your weekly report has two halves. Wallet missions (M) and wallet bugs: send them from the DSM wallet, Settings → Report a problem. Wildstate missions (G) and game bugs: send them from here. Send both halves every week.';

/** Quick checks a game bug can tick, as the report reads them. */
export const BUG_CHECKS = [
  'It happened in a battle or an arena match',
  'HP, a creature or an item looked wrong',
  'WILD or an object in the wallet looked wrong',
  'Glitch: flicker, screen jump or a wrong screen for a moment',
  'Freeze, or the game closed by itself',
  'Error message (its exact words below)',
  'Something was confusing or unclear',
] as const;
/** Quick checks a mission can tick. */
export const MISSION_CHECKS = ['Worked the first time', 'Felt slow', 'Glitch', 'Freeze or crash', 'Error message', 'Confusing'] as const;

export type HowOften = 'every-time' | 'sometimes' | 'once';
export const HOW_OFTEN: Record<HowOften, string> = { 'every-time': 'Every time', sometimes: 'Sometimes', once: 'Once so far' };

/** The game details the screen attaches to every report, so a report can be followed up. */
export type GameDetails = {
  version: string;
  protocol: number;
  server: string;
  wallet: string;
  screen: string;
  battle: string | null;
  device: string;
  at: string;
};

type BugReport = {
  summary: string;
  checks: string[];
  happened: string;
  steps: string;
  expected: string;
  often: HowOften;
};

export type MissionResult = 'done' | 'failed' | 'not-tried';
export const RESULT_LABEL: Record<MissionResult, string> = { done: 'Done', failed: "Couldn't finish", 'not-tried': 'Not tried' };
export type MissionEntry = { mission: Mission; result: MissionResult; checks: string[]; comment: string; bugs: string };
type MissionsReport = { week: number | null; title: string; entries: MissionEntry[]; overall: string };

/** The week's game missions a tester reports on: the starter set's in week 1, then that week's own. */
export type ReportList = { week: number | null; title: string; missions: Mission[] };

const line = (text: string) => text.trim().length > 0 ? text.trim() : '_(none)_';
const box = (on: boolean, label: string) => `- [${on ? 'x' : ' '}] ${label}`;
function details(d: GameDetails): string {
  return [
    '**Game details** (attached by the game)',
    `- Wildstate ${d.version} · protocol ${d.protocol} · server ${d.server}`,
    `- Wallet: ${d.wallet}`,
    `- Screen: ${d.screen}${d.battle ? ` · ${d.battle}` : ''}`,
    `- Device: ${d.device}`,
    `- Time: ${d.at}`,
  ].join('\n');
}
/** A body cut to `BODY_MAX`, saying so when it was; COPY ALL still carries the whole of it. */
export function fit(body: string): string {
  if (body.length <= BODY_MAX) return body;
  const note = '\n\n_(Cut to fit the link. Paste the full report from the game’s COPY button below this line.)_';
  return body.slice(0, BODY_MAX - note.length) + note;
}

export function bugTitle(r: BugReport): string {
  const s = r.summary.trim().replace(/\s+/g, ' ');
  return `[GAME BUG] ${s.length > 0 ? s.slice(0, 90) : 'Something went wrong'}`;
}
export function bugBody(r: BugReport, d: GameDetails): string {
  return [
    `**What went wrong:** ${line(r.summary)}`,
    '',
    '**Quick checks**',
    ...BUG_CHECKS.map((c) => box(r.checks.includes(c), c)),
    '',
    `**What happened:** ${line(r.happened)}`,
    '',
    `**Steps:**\n${line(r.steps)}`,
    '',
    `**Expected:** ${line(r.expected)}`,
    '',
    `**How often:** ${HOW_OFTEN[r.often]}`,
    '',
    details(d),
    '',
    '**Screenshots:** drag them into this issue (never include your recovery phrase).',
  ].join('\n');
}

export function missionsTitle(r: MissionsReport): string {
  return r.week === null ? '[MISSIONS] Starter game missions' : `[MISSIONS] Week ${r.week} game missions`;
}
export function missionsBody(r: MissionsReport, d: GameDetails): string {
  const done = r.entries.filter((e) => e.result === 'done').length;
  return [
    `**Week:** ${r.week === null ? 'starter set' : `${r.week} · ${r.title}`} · ${done} of ${r.entries.length} game missions done`,
    '',
    ...r.entries.flatMap((e) => [
      `### ${e.mission.id} · ${e.mission.title}: ${RESULT_LABEL[e.result]}`,
      ...MISSION_CHECKS.map((c) => box(e.checks.includes(c), c)),
      `**Explain:** ${line(e.comment)}`,
      `**Bug reports for this mission:** ${line(e.bugs)}`,
      '',
    ]),
    `**Overall:** ${line(r.overall)}`,
    '',
    details(d),
    '',
    `_${SPLIT_NOTE}_`,
  ].join('\n');
}

/** A new-issue link on the game's repository, its template filled with this title and body. */
export function issueUrl(template: string, title: string, body: string): string {
  const q = new URLSearchParams({ template, title, body: fit(body) });
  return `https://github.com/${GAME_REPO}/issues/new?${q.toString()}`;
}
