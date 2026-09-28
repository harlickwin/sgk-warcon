// SGK: the Headshot anti-cheat rule as the worker runs it on each kill-feed batch. Per-player
// windows live in memory, and are rebuilt from the kills and hs_trips tables the first time a rule
// runs in this process (or after its settings change), so a restart or deploy loses nothing. Every
// trip is logged to hs_trips; the ones outside the alert cooldown become an outbox flag, which the
// audit trail records and the Discord "anti-cheat" channels receive with the evidence.
import { and, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Env } from './env';
import { hsTrips, kills, playerSessions, type TriggerRow } from './db/schema';
import { enabledTriggers, type Evaluation } from './triggers';
import { killTimes } from './kill-rate';
import { eligibleFromRows, KILL_COLUMNS } from './headshot-replay';
import { applyTriggerUpdates, enqueueIntents, wakeDelivery } from './outbox';
import { withOwnedTransaction } from './leadership';
import {
	alertKey,
	HEADSHOT_FLAG,
	headshotStep,
	hsEligible,
	judgeTrip,
	keepMs,
	pruneHsTracks,
	type HeadshotConfig,
	type HsKill,
	type HsMemory,
	type HsTracks,
	type HsTrip
} from './headshot';
import type { EvidenceKill, SessionStats } from './headshot-embed';
import { causeLabel } from '$lib/causes';
import type { KillView } from '$lib/types';

/** The kills a Discord card lists; hs_trips keeps up to EVIDENCE_KEEP. */
const EVIDENCE_ALERT = 25;
const EVIDENCE_KEEP = 200;

interface RuleState {
	serverId: string;
	/** the settings this state was built for; a change rebuilds it */
	key: string;
	tracks: HsTracks;
	mem: HsMemory;
}
const states = new Map<string, RuleState>();

/** Test-only: forget every rule's windows, as a restart would. */
export function resetHeadshotState(): void {
	states.clear();
}

/** Rebuilds a rule's windows and memory from the tables, leaving out the batch being judged. */
async function hydrate(
	env: Env,
	serverId: string,
	cfg: HeadshotConfig,
	exclude: Set<string>
): Promise<{ tracks: HsTracks; mem: HsMemory }> {
	const now = Date.now();
	const rows = await env.db
		.select(KILL_COLUMNS)
		.from(kills)
		.where(
			and(
				eq(kills.serverId, serverId),
				isNotNull(kills.killerSteamId),
				gte(kills.ts, new Date(now - keepMs(cfg) - 60_000))
			)
		)
		.orderBy(kills.ts);
	const tracks: HsTracks = new Map();
	for (const k of eligibleFromRows(rows.filter((r) => !exclude.has(r.eventId)))) {
		let t = tracks.get(k.steamId);
		if (!t)
			tracks.set(k.steamId, (t = { kills: [], burstAfter: -Infinity, ratioAfter: -Infinity }));
		t.kills.push(k);
	}
	const since = new Date(
		now - Math.max(cfg.repeat.windowHours * 3600_000, cfg.alertCooldownMinutes * 60_000)
	);
	const trips = await env.db
		.select({
			ts: hsTrips.ts,
			rule: hsTrips.rule,
			steamId: hsTrips.steamId,
			repeat: hsTrips.repeat,
			alerted: hsTrips.alerted
		})
		.from(hsTrips)
		.where(and(eq(hsTrips.serverId, serverId), gte(hsTrips.ts, since)))
		.orderBy(hsTrips.ts);
	const mem: HsMemory = { lastTrip: new Map(), lastAlert: new Map() };
	for (const t of trips) {
		const at = t.ts.getTime();
		mem.lastTrip.set(t.steamId, at);
		if (t.alerted) mem.lastAlert.set(alertKey(t.steamId, t.repeat ? 'REPEAT' : t.rule), at);
		const track = tracks.get(t.steamId);
		if (track && t.rule === 'HS_BURST') track.burstAfter = at;
		if (track && t.rule === 'HS_RATIO') track.ratioAfter = at;
	}
	return { tracks, mem };
}

/** The player's session so far on this server: the scoreboard's kills and deaths, the feed's headshots. */
async function sessionStats(env: Env, serverId: string, steamId: string): Promise<SessionStats> {
	const [open] = await env.db
		.select({
			joinedAt: playerSessions.joinedAt,
			kills: playerSessions.kills,
			deaths: playerSessions.deaths
		})
		.from(playerSessions)
		.where(
			and(
				eq(playerSessions.serverId, serverId),
				eq(playerSessions.steamId, steamId),
				isNull(playerSessions.leftAt)
			)
		)
		.orderBy(sql`${playerSessions.id} DESC`)
		.limit(1);
	const since = open?.joinedAt ?? new Date(Date.now() - 3600_000);
	const [row] = await env.db
		.select({
			kills: sql<number>`COUNT(*) FILTER (WHERE NOT ${kills.teamKill} AND NOT ${kills.suicide})`,
			headshots: sql<number>`COUNT(*) FILTER (WHERE ${kills.headshot} AND NOT ${kills.teamKill})`,
			eligible: sql<number>`COUNT(*) FILTER (WHERE ${kills.cause} LIKE 'Id.Item.%' AND NOT ${kills.teamKill} AND NOT ${kills.suicide})`
		})
		.from(kills)
		.where(
			and(eq(kills.serverId, serverId), eq(kills.killerSteamId, steamId), gte(kills.ts, since))
		);
	return {
		kills: open?.kills ?? Number(row?.kills ?? 0),
		deaths: open?.deaths ?? 0,
		headshots: Number(row?.headshots ?? 0),
		eligible: Number(row?.eligible ?? 0),
		minutes: open ? Math.max(0, Math.round((Date.now() - open.joinedAt.getTime()) / 60_000)) : null
	};
}

const evidenceOf = (k: HsKill): EvidenceKill & Record<string, unknown> => ({
	eventId: k.eventId,
	at: k.at,
	victim: k.victim,
	victimSteamId: k.victimSteamId,
	weapon: causeLabel(k.cause) || k.cause || '?',
	cause: k.cause,
	distanceM: k.distanceM === null ? null : Math.round(k.distanceM * 10) / 10,
	headshot: k.headshot
});

export async function actOnHeadshots(env: Env, serverId: string, batch: KillView[]): Promise<void> {
	const rows = (await enabledTriggers(env, serverId)).filter((r) => r.kind === 'headshot');
	const live = new Set(rows.map((r) => r.id));
	for (const [id, s] of states) if (s.serverId === serverId && !live.has(id)) states.delete(id);
	if (!rows.length || !batch.length) return;
	const times = killTimes(
		Date.parse(batch[0].ts),
		batch.map((k) => k.eventTime)
	);
	const eligible: HsKill[] = [];
	batch.forEach((k, i) => {
		if (
			!hsEligible({
				killer: k.killer?.steamId,
				victim: k.victim.steamId,
				suicide: k.suicide,
				teamKill: k.teamKill,
				cause: k.cause,
				tags: k.tags
			})
		)
			return;
		eligible.push({
			eventId: k.eventId,
			at: times[i],
			steamId: k.killer!.steamId,
			name: k.killer!.name,
			victim: k.victim.name,
			victimSteamId: k.victim.steamId,
			cause: k.cause,
			distanceM: k.distanceM,
			headshot: k.headshot
		});
	});
	eligible.sort((a, b) => a.at - b.at);
	const batchIds = new Set(batch.map((k) => k.eventId));
	for (const row of rows) await actOnRule(env, serverId, row, eligible, batchIds);
}

async function actOnRule(
	env: Env,
	serverId: string,
	row: TriggerRow,
	eligible: HsKill[],
	batchIds: Set<string>
): Promise<void> {
	const cfg = row.config as HeadshotConfig;
	const key = JSON.stringify(cfg);
	let state = states.get(row.id);
	if (!state || state.key !== key) {
		state = { serverId, key, ...(await hydrate(env, serverId, cfg, batchIds)) };
		states.set(row.id, state);
	}
	const found: HsTrip[] = [];
	for (const k of eligible) found.push(...headshotStep(cfg, state.tracks, k));
	pruneHsTracks(cfg, state.tracks, Date.now());
	if (!found.length) return;

	const before: HsMemory = {
		lastTrip: new Map(state.mem.lastTrip),
		lastAlert: new Map(state.mem.lastAlert)
	};
	const judged = found.map((t) => ({ ...t, ...judgeTrip(cfg, state.mem, t) }));
	const modeOf = (rule: HsTrip['rule']) =>
		rule === 'HS_BURST' ? cfg.burst.mode : rule === 'HS_RATIO' ? cfg.ratio.mode : cfg.range.mode;
	const out: Evaluation = { intents: [], updates: [] };
	for (const t of judged) {
		if (!t.alert) continue;
		const session = await sessionStats(env, serverId, t.steamId);
		const last = t.evidence[t.evidence.length - 1];
		out.intents.push({
			trigger: row,
			action: HEADSHOT_FLAG,
			params: {},
			target: t.steamId,
			okMessage: `Flagged ${t.name}: ${t.repeat ? 'REPEAT · ' : ''}${t.rule} ${t.verdict}`,
			detail: {
				name: t.name,
				rule: t.rule,
				verdict: t.verdict,
				repeat: t.repeat,
				mode: modeOf(t.rule),
				evidence: t.evidence.slice(-EVIDENCE_ALERT).map(evidenceOf),
				session
			},
			steamId: t.steamId,
			dedupeKey: [row.id, t.steamId, t.rule, last?.eventId ?? t.at].join(':')
		});
		out.updates.push({
			id: row.id,
			lastFiredAt: new Date(),
			lastResult: `Flagging ${t.name}: ${t.rule} ${t.verdict}`
		});
	}
	let queued = 0;
	try {
		await withOwnedTransaction(env, async (tx) => {
			await tx.insert(hsTrips).values(
				judged.map((t) => ({
					serverId,
					triggerId: row.id,
					rule: t.rule,
					steamId: t.steamId,
					name: t.name,
					mode: modeOf(t.rule),
					repeat: t.repeat,
					alerted: t.alert,
					verdict: t.verdict,
					killIds: t.evidence.map((k) => k.eventId),
					evidence: t.evidence.slice(-EVIDENCE_KEEP).map(evidenceOf)
				}))
			);
			if (out.intents.length) queued = await enqueueIntents(tx, serverId, out.intents);
			if (out.updates.length) await applyTriggerUpdates(tx, out.updates);
		});
	} catch (err) {
		// Not written, so not remembered: the next worker to own the feed judges these players afresh.
		state.mem = before;
		throw err;
	}
	if (queued) wakeDelivery();
}
