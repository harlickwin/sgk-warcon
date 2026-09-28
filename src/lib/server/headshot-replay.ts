// SGK: the Headshot anti-cheat rule run over stored kills: the Automation dry run (last 24 h) and
// the Anti-cheat tab's replay (any number of days). Same eligibility, same step, same cooldown and
// repeat judgement as the live rule, and touches nobody.
import { and, eq, gte, isNotNull, lt } from 'drizzle-orm';
import type { Env } from './env';
import { kills } from './db/schema';
import { killTimes } from './kill-rate';
import {
	countByRule,
	headshotReplay,
	hsEligible,
	type HeadshotConfig,
	type HsKill,
	type HsRule,
	type ReplayedTrip
} from './headshot';

/** The most kills one replay reads. */
export const HS_REPLAY_MAX = 300_000;

export interface KillRow {
	ts: Date;
	eventId: string;
	eventTime: number;
	killerSteamId: string | null;
	killerName: string | null;
	victimSteamId: string;
	victimName: string;
	cause: string | null;
	distanceM: number | null;
	headshot: boolean;
	suicide: boolean;
	teamKill: boolean;
	tags: unknown;
}

export const KILL_COLUMNS = {
	ts: kills.ts,
	eventId: kills.eventId,
	eventTime: kills.eventTime,
	killerSteamId: kills.killerSteamId,
	killerName: kills.killerName,
	victimSteamId: kills.victimSteamId,
	victimName: kills.victimName,
	cause: kills.cause,
	distanceM: kills.distanceM,
	headshot: kills.headshot,
	suicide: kills.suicide,
	teamKill: kills.teamKill,
	tags: kills.tags
};

/** Stored kills (receipt order) as the rule's eligible kills, each batch spaced out by the match clock. */
export function eligibleFromRows(rows: KillRow[]): HsKill[] {
	const out: HsKill[] = [];
	for (let i = 0; i < rows.length;) {
		const received = new Date(rows[i].ts).getTime();
		let j = i;
		while (j < rows.length && new Date(rows[j].ts).getTime() === received) j++;
		const batch = rows.slice(i, j);
		const times = killTimes(
			received,
			batch.map((r) => Number(r.eventTime))
		);
		batch.forEach((r, n) => {
			if (
				!hsEligible({
					killer: r.killerSteamId,
					victim: r.victimSteamId,
					suicide: !!r.suicide,
					teamKill: !!r.teamKill,
					cause: r.cause,
					tags: Array.isArray(r.tags) ? (r.tags as string[]) : []
				})
			)
				return;
			out.push({
				eventId: r.eventId,
				at: times[n],
				steamId: r.killerSteamId!,
				name: r.killerName || r.killerSteamId!,
				victim: r.victimName,
				victimSteamId: r.victimSteamId,
				cause: r.cause,
				distanceM: r.distanceM === null ? null : Number(r.distanceM),
				headshot: !!r.headshot
			});
		});
		i = j;
	}
	return out;
}

export interface HsReplayResult {
	from: string;
	to: string;
	/** kills read, and how many of them the rule judges */
	kills: number;
	eligible: number;
	truncated: boolean;
	counts: Record<HsRule, number>;
	alerts: number;
	trips: ReplayedTrip[];
}

export async function replayHeadshots(
	env: Env,
	serverId: string,
	cfg: HeadshotConfig,
	from: Date,
	to: Date
): Promise<HsReplayResult> {
	const rows = await env.db
		.select(KILL_COLUMNS)
		.from(kills)
		.where(
			and(
				eq(kills.serverId, serverId),
				isNotNull(kills.killerSteamId),
				gte(kills.ts, from),
				lt(kills.ts, to)
			)
		)
		.orderBy(kills.ts)
		.limit(HS_REPLAY_MAX);
	const eligible = eligibleFromRows(rows);
	const trips = headshotReplay(cfg, eligible);
	return {
		from: from.toISOString(),
		to: to.toISOString(),
		kills: rows.length,
		eligible: eligible.length,
		truncated: rows.length >= HS_REPLAY_MAX,
		counts: countByRule(trips),
		alerts: trips.filter((t) => t.alert).length,
		trips
	};
}
