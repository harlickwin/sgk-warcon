// The Headshot anti-cheat rule's pure part (SGK). Four checks on the kill feed, each with its own
// mode: HS_BURST (many headshot kills in seconds), HS_RATIO (a headshot share over a real sample),
// HS_RANGE (a headshot beyond what a pistol, SMG or shotgun should reach) and REPEAT (any of them
// again soon after an earlier trip). The feed has no aim or input data, so a trip is evidence for
// staff to review, never proof. No database, no game server: the live path (headshot-live.ts), the
// dry run and the replay tool all run the same step.
import { ApiError, int, str } from './http';
import { causeKind } from '$lib/causes';

import {
	DEFAULT_RANGE_CLASSES,
	type HeadshotConfig,
	type HsMode,
	type HsRule,
	type RangeClass
} from '$lib/headshot';

export {
	DEFAULT_RANGE_CLASSES,
	HS_RULE_LABELS,
	HS_RULES,
	type HeadshotConfig,
	type HsMode,
	type HsRule,
	type RangeClass
} from '$lib/headshot';

/** The outbox action of a watch-mode trip: a panel action, nothing is sent to the game. */
export const HEADSHOT_FLAG = 'headshot_flag';

const MODES: HsMode[] = ['off', 'watch', 'enforce'];

/** The smallest sample the ratio check may judge: 3/3 headshots must never trip it. */
export const RATIO_MIN_SAMPLE = 8;

const obj = (v: unknown): Record<string, unknown> =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function mode(v: unknown, fallback: HsMode, what: string): HsMode {
	if (v === undefined || v === null || v === '') return fallback;
	if (!MODES.includes(v as HsMode))
		throw new ApiError(400, `${what}: mode must be off, watch or enforce.`);
	// Kicks and bans come after the watch period has been reviewed; until then a rule only alerts.
	if (v === 'enforce')
		throw new ApiError(
			400,
			`${what}: enforce is not available yet. Use watch while thresholds are tuned.`
		);
	return v as HsMode;
}

function rangeClasses(v: unknown): RangeClass[] {
	if (!Array.isArray(v)) return DEFAULT_RANGE_CLASSES.map((c) => ({ ...c, causes: [...c.causes] }));
	if (v.length > 20) throw new ApiError(400, 'Impossible range: at most 20 weapon classes.');
	return v.map((raw, i) => {
		const c = obj(raw);
		const name = str(c.name, 40) || `Class ${i + 1}`;
		const list = Array.isArray(c.causes)
			? c.causes
			: typeof c.causes === 'string'
				? c.causes.split(/[\s,]+/)
				: [];
		const causes = [...new Set(list.map((s) => str(s, 120)).filter(Boolean))].slice(0, 50);
		return { name, causes, maxM: int(c.maxM, 100, 5, 2000) };
	});
}

export function validateHeadshot(c: Record<string, unknown>): HeadshotConfig {
	const burst = obj(c.burst);
	const ratio = obj(c.ratio);
	const range = obj(c.range);
	const repeat = obj(c.repeat);
	const cfg: HeadshotConfig = {
		burst: {
			mode: mode(burst.mode, 'watch', 'Headshot burst'),
			kills: int(burst.kills, 8, 2, 50),
			seconds: int(burst.seconds, 10, 1, 120)
		},
		ratio: {
			mode: mode(ratio.mode, 'watch', 'Headshot ratio'),
			pct: int(ratio.pct, 90, 50, 100),
			minKills: int(ratio.minKills, 15, RATIO_MIN_SAMPLE, 500),
			windowMinutes: int(ratio.windowMinutes, 5, 1, 60)
		},
		range: {
			mode: mode(range.mode, 'watch', 'Impossible range'),
			classes: rangeClasses(range.classes)
		},
		repeat: {
			mode: mode(repeat.mode, 'watch', 'Repeat offender'),
			windowHours: int(repeat.windowHours, 24, 1, 24 * 14)
		},
		alertCooldownMinutes: int(c.alertCooldownMinutes, 10, 1, 24 * 60)
	};
	if (cfg.burst.mode === 'off' && cfg.ratio.mode === 'off' && cfg.range.mode === 'off')
		throw new ApiError(400, 'Turn on at least one of burst, ratio or range.');
	return cfg;
}

/** Causes that kill several people at once or by blast: never evidence of aim. */
const EXPLOSIVE = /grenade|c4|rpg|explosive|mine|claymore|launcher|mortar|artillery|rocket/i;
/** Melee tools and anything the player does not aim. */
const NOT_AIMED = /defibrillator|buildtool|hammer|knife|melee/i;
/** Tags that mean the kill was not a bullet from the killer's own weapon. */
const EXCLUDED_TAGS = ['VehicleExplosion', 'RoadKill', 'Falling', 'WeaponMelee', 'Suicide'];

export interface HsKillInput {
	killer: string | null | undefined;
	victim: string;
	suicide: boolean;
	teamKill: boolean;
	cause: string | null;
	tags: string[];
}

/**
 * A kill the rule judges: one player shooting another of the other side with a hand-held gun.
 * Team kills, suicides, environment deaths, vehicles and their guns, buildables, explosives and
 * melee are all left out.
 */
export function hsEligible(k: HsKillInput): boolean {
	if (!k.killer || k.suicide || k.teamKill || k.killer === k.victim) return false;
	if (causeKind(k.cause) !== 'weapon' || !k.cause) return false;
	if (EXPLOSIVE.test(k.cause) || NOT_AIMED.test(k.cause)) return false;
	return !k.tags.some((t) => EXCLUDED_TAGS.includes(t));
}

/** One eligible kill as the rule keeps it, and as a trip's evidence lists it. */
export interface HsKill {
	eventId: string;
	/** ms: receipt time spaced out by the match clock (killTimes) */
	at: number;
	steamId: string;
	name: string;
	victim: string;
	victimSteamId: string;
	cause: string | null;
	distanceM: number | null;
	headshot: boolean;
}

export interface HsTrip {
	rule: Exclude<HsRule, 'REPEAT'>;
	steamId: string;
	name: string;
	at: number;
	verdict: string;
	evidence: HsKill[];
}

/**
 * One player's eligible kills over the longest window (oldest first), and where each windowed
 * check was last used up: a trip spends the kills it was judged on, so the same kills never trip
 * the same check twice.
 */
export interface HsTrack {
	kills: HsKill[];
	burstAfter: number;
	ratioAfter: number;
}
export type HsTracks = Map<string, HsTrack>;

/** How far back a player's kills are kept. */
export const keepMs = (cfg: HeadshotConfig) =>
	Math.max(cfg.ratio.windowMinutes * 60_000, cfg.burst.seconds * 1000);

export function rangeClassOf(cfg: HeadshotConfig, cause: string | null): RangeClass | null {
	if (!cause) return null;
	return cfg.range.classes.find((c) => c.causes.includes(cause)) ?? null;
}

/** Adds one eligible kill to its killer's track and returns the trips it causes. */
export function headshotStep(cfg: HeadshotConfig, tracks: HsTracks, k: HsKill): HsTrip[] {
	let t = tracks.get(k.steamId);
	if (!t) {
		t = { kills: [], burstAfter: -Infinity, ratioAfter: -Infinity };
		tracks.set(k.steamId, t);
	}
	let i = t.kills.length;
	while (i > 0 && t.kills[i - 1].at > k.at) i--;
	t.kills.splice(i, 0, k);
	const newest = t.kills[t.kills.length - 1].at;
	while (t.kills.length && t.kills[0].at <= newest - keepMs(cfg)) t.kills.shift();
	const trips: HsTrip[] = [];
	const trip = (rule: HsTrip['rule'], verdict: string, evidence: HsKill[]) =>
		trips.push({ rule, steamId: k.steamId, name: k.name, at: newest, verdict, evidence });

	if (cfg.burst.mode !== 'off' && k.headshot) {
		const from = Math.max(newest - cfg.burst.seconds * 1000, t.burstAfter);
		const heads = t.kills.filter((x) => x.headshot && x.at > from);
		if (heads.length >= cfg.burst.kills) {
			const span = Math.max(1, Math.round((heads[heads.length - 1].at - heads[0].at) / 1000));
			trip('HS_BURST', `${heads.length} headshot kills in ${span} s`, heads);
			t.burstAfter = newest;
		}
	}
	if (cfg.ratio.mode !== 'off') {
		const from = Math.max(newest - cfg.ratio.windowMinutes * 60_000, t.ratioAfter);
		const inWindow = t.kills.filter((x) => x.at > from);
		const n = inWindow.length;
		if (n >= Math.max(cfg.ratio.minKills, RATIO_MIN_SAMPLE)) {
			const heads = inWindow.filter((x) => x.headshot).length;
			const pct = (100 * heads) / n;
			if (pct >= cfg.ratio.pct) {
				trip(
					'HS_RATIO',
					`${Math.round(pct)}% headshots (${heads}/${n}) in ${cfg.ratio.windowMinutes} min`,
					inWindow
				);
				t.ratioAfter = newest;
			}
		}
	}
	if (cfg.range.mode !== 'off' && k.headshot && k.distanceM !== null) {
		const cls = rangeClassOf(cfg, k.cause);
		if (cls && k.distanceM > cls.maxM)
			trip(
				'HS_RANGE',
				`${cls.name} headshot at ${Math.round(k.distanceM)} m (limit ${cls.maxM} m)`,
				[k]
			);
	}
	return trips;
}

/** Forgets players with nothing left in the window, so memory follows who is fighting. */
export function pruneHsTracks(cfg: HeadshotConfig, tracks: HsTracks, now: number): void {
	const from = now - keepMs(cfg);
	for (const [id, t] of tracks) {
		const last = t.kills.length ? t.kills[t.kills.length - 1].at : -Infinity;
		if (last <= from) tracks.delete(id);
	}
}

/**
 * What happens to one trip after it is found: whether it is a repeat (an earlier trip by the same
 * player inside the repeat window) and whether it may alert (not inside the per-player, per-rule
 * cooldown). Both maps are updated. `lastTrip` is per player, `lastAlert` per player and rule.
 */
export interface HsMemory {
	lastTrip: Map<string, number>;
	lastAlert: Map<string, number>;
}
export const alertKey = (steamId: string, rule: string) => `${steamId}:${rule}`;

export function judgeTrip(
	cfg: HeadshotConfig,
	mem: HsMemory,
	trip: HsTrip
): { repeat: boolean; alert: boolean } {
	const prev = mem.lastTrip.get(trip.steamId);
	const repeat =
		cfg.repeat.mode !== 'off' &&
		prev !== undefined &&
		trip.at - prev < cfg.repeat.windowHours * 3600_000;
	mem.lastTrip.set(trip.steamId, Math.max(prev ?? -Infinity, trip.at));
	// A repeat alerts under its own key, so a second offence is never swallowed by the first's cooldown.
	const key = alertKey(trip.steamId, repeat ? 'REPEAT' : trip.rule);
	const last = mem.lastAlert.get(key);
	const alert = last === undefined || trip.at - last >= cfg.alertCooldownMinutes * 60_000;
	if (alert) mem.lastAlert.set(key, trip.at);
	return { repeat, alert };
}

export type ReplayedTrip = HsTrip & { repeat: boolean; alert: boolean };

/** The trips the rule would have found over `kills` (eligible kills, any order). */
export function headshotReplay(
	cfg: HeadshotConfig,
	kills: HsKill[],
	mem: HsMemory = { lastTrip: new Map(), lastAlert: new Map() }
): ReplayedTrip[] {
	const tracks: HsTracks = new Map();
	const out: ReplayedTrip[] = [];
	for (const k of [...kills].sort((a, b) => a.at - b.at))
		for (const t of headshotStep(cfg, tracks, k)) out.push({ ...t, ...judgeTrip(cfg, mem, t) });
	return out;
}

/** Trip counts per rule; REPEAT counts the trips marked as repeats. */
export function countByRule(trips: { rule: string; repeat: boolean }[]): Record<HsRule, number> {
	const c: Record<HsRule, number> = { HS_BURST: 0, HS_RATIO: 0, HS_RANGE: 0, REPEAT: 0 };
	for (const t of trips) {
		if (t.rule in c) c[t.rule as HsRule]++;
		if (t.repeat) c.REPEAT++;
	}
	return c;
}
