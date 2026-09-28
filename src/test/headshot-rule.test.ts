// SGK: the Headshot anti-cheat rule as the worker runs it. A trip is logged to hs_trips with its
// evidence, an alert is an outbox flag that sends nothing to the game, and a restart rebuilds each
// player's window from the kills table so a burst spanning it is still caught.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { hsTrips, kills, outbox, triggers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { onKillsIngested } from '$lib/server/feed-events';
import { resetHeadshotState } from '$lib/server/headshot-live';
import { HEADSHOT_FLAG } from '$lib/server/headshot';
import { dryRun } from '$lib/server/triggers';
import { newId } from '$lib/server/http';
import type { KillView } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const CHEAT = '76561198000000501';
const SPLIT = '76561198000000502';
const GRENADIER = '76561198000000503';
const VICTIM = '76561198000000599';

const kill = (
	killer: string,
	eventTime: number,
	o: Partial<KillView> = {},
	receivedAt = new Date()
): KillView => ({
	eventId: newId(),
	ts: receivedAt.toISOString(),
	map: 'Kavkazi',
	eventTime,
	killer: { steamId: killer, name: `p${killer.slice(-3)}`, faction: null },
	victim: { steamId: VICTIM, name: 'victim', faction: null },
	cause: 'Id.Item.AK74M',
	distanceM: 40,
	headshot: true,
	suicide: false,
	teamKill: false,
	tags: ['Headshot'],
	...o
});

/** The row the feed would have stored for a kill. */
const stored = (serverId: string, k: KillView) => ({
	ts: new Date(k.ts),
	serverId,
	eventId: k.eventId,
	instanceId: 'i',
	matchId: 'm',
	eventTime: k.eventTime,
	map: k.map,
	killerSteamId: k.killer?.steamId ?? null,
	killerName: k.killer?.name ?? null,
	victimSteamId: k.victim.steamId,
	victimName: k.victim.name,
	cause: k.cause,
	distanceM: k.distanceM,
	headshot: k.headshot,
	suicide: k.suicide,
	teamKill: k.teamKill,
	tags: k.tags
});

describe.skipIf(!hasTestDb)('Headshot anti-cheat rule, live', () => {
	let env: Env;
	let w: World;
	let rule: string;

	const ingest = async (batch: KillView[]) => {
		await env.db.insert(kills).values(batch.map((k) => stored(w.server.id, k)));
		await onKillsIngested(env, w.server.id, batch);
	};
	const flagsOf = (steamId: string) =>
		env.db
			.select()
			.from(outbox)
			.where(eq(outbox.target, steamId))
			.then((rows) => rows.filter((r) => r.triggerId === rule));
	const tripsOf = (steamId: string) =>
		env.db.select().from(hsTrips).where(eq(hsTrips.steamId, steamId));

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'headshot test')).toBe(true);
		rule = newId();
		await env.db.insert(triggers).values({
			id: rule,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'headshot',
			name: 'Headshot anti-cheat',
			enabled: true,
			config: {
				burst: { mode: 'watch', kills: 5, seconds: 10 },
				ratio: { mode: 'watch', pct: 90, minKills: 15, windowMinutes: 5 },
				range: {
					mode: 'watch',
					classes: [{ name: 'Pistol', causes: ['Id.Item.Glock17'], maxM: 80 }]
				},
				repeat: { mode: 'watch', windowHours: 24 },
				alertCooldownMinutes: 10
			}
		});
	});
	afterAll(() => releaseOwnership(env));

	test('five headshots in five seconds: one trip, one flag with the evidence', async () => {
		await ingest([0, 1, 2, 3, 4].map((t) => kill(CHEAT, t)));
		const flags = await flagsOf(CHEAT);
		expect(flags).toHaveLength(1);
		expect(flags[0]).toMatchObject({ action: HEADSHOT_FLAG, steamId: CHEAT, state: 'pending' });
		const d = flags[0].detail as Record<string, unknown>;
		expect(d).toMatchObject({ rule: 'HS_BURST', repeat: false, mode: 'watch' });
		expect(d.evidence as unknown[]).toHaveLength(5);
		expect(d.session).toBeDefined();
		const trips = await tripsOf(CHEAT);
		expect(trips).toHaveLength(1);
		expect(trips[0]).toMatchObject({ rule: 'HS_BURST', alerted: true, repeat: false });
		expect(trips[0].killIds as string[]).toHaveLength(5);
	});

	test('a second offence is a repeat and still alerts', async () => {
		await ingest([kill(CHEAT, 20, { cause: 'Id.Item.Glock17', distanceM: 150 })]);
		const trips = await tripsOf(CHEAT);
		expect(trips.map((t) => [t.rule, t.repeat, t.alerted]).sort()).toEqual([
			['HS_BURST', false, true],
			['HS_RANGE', true, true]
		]);
		expect(await flagsOf(CHEAT)).toHaveLength(2);
	});

	test('a burst split by a restart is still caught', async () => {
		const early = new Date(Date.now() - 3000);
		await ingest([0, 1, 2].map((t) => kill(SPLIT, t, {}, early)));
		expect(await tripsOf(SPLIT)).toHaveLength(0);
		resetHeadshotState();
		await ingest([3, 4].map((t) => kill(SPLIT, t)));
		const trips = await tripsOf(SPLIT);
		expect(trips.map((t) => t.rule)).toEqual(['HS_BURST']);
		expect(trips[0].killIds as string[]).toHaveLength(5);
	});

	test('a grenade on a group, tagged headshot, is not judged', async () => {
		await ingest(
			[0, 0, 0, 0, 0, 0].map((t) => kill(GRENADIER, t, { cause: 'Id.Item.M67Grenade' }))
		);
		expect(await tripsOf(GRENADIER)).toHaveLength(0);
	});

	test('the dry run replays the stored kills with the same result', async () => {
		const server = { ...w.server, name: 'one' } as Parameters<typeof dryRun>[1];
		const [row] = await env.db.select().from(triggers).where(eq(triggers.id, rule));
		const r = await dryRun(env, server, 'headshot', row.config);
		const text = r.items.map((i) => i.text).join('\n');
		expect(text).toContain(`(${CHEAT}): HS_BURST`);
		expect(text).toContain(`(${SPLIT}): HS_BURST`);
		expect(text).not.toContain(GRENADIER);
	});
});
