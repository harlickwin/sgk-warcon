import { describe, expect, test } from 'bun:test';
import {
	countByRule,
	headshotReplay,
	hsEligible,
	judgeTrip,
	validateHeadshot,
	type HeadshotConfig,
	type HsKill
} from './headshot';

const CHEAT = '76561198000000901';
const LEGIT = '76561198000000902';
const cfg = (over: Record<string, unknown> = {}): HeadshotConfig => validateHeadshot(over);

let seq = 0;
/** One eligible kill `s` seconds into the stream. */
const k = (
	steamId: string,
	s: number,
	headshot: boolean,
	cause = 'Id.Item.AK74M',
	distanceM: number | null = 40
): HsKill => ({
	eventId: `e${++seq}`,
	at: s * 1000,
	steamId,
	name: steamId === CHEAT ? 'cheater' : 'legit',
	victim: 'v',
	victimSteamId: '76561198000000999',
	cause,
	distanceM,
	headshot
});

describe('validateHeadshot', () => {
	test('the brief’s defaults, all watch', () => {
		const c = cfg();
		expect(c.burst).toEqual({ mode: 'watch', kills: 5, seconds: 10 });
		expect(c.ratio).toEqual({ mode: 'watch', pct: 90, minKills: 15, windowMinutes: 5 });
		expect(c.repeat).toEqual({ mode: 'watch', windowHours: 24 });
		expect(c.range.classes.map((x) => x.name)).toEqual(['Pistol', 'SMG', 'Shotgun']);
	});
	test('enforce is refused until the watch period is over', () => {
		expect(() => cfg({ burst: { mode: 'enforce' } })).toThrow('not available yet');
	});
	test('an unknown mode is refused', () => {
		expect(() => cfg({ ratio: { mode: 'kick' } })).toThrow('mode must be');
	});
	test('the ratio sample cannot be set below the minimum', () => {
		expect(cfg({ ratio: { minKills: 3 } }).ratio.minKills).toBe(8);
	});
	test('all three checks off is refused', () => {
		expect(() =>
			cfg({ burst: { mode: 'off' }, ratio: { mode: 'off' }, range: { mode: 'off' } })
		).toThrow('at least one');
	});
	test('range causes accept a comma or newline list', () => {
		const c = cfg({
			range: {
				classes: [{ name: 'SMG', causes: 'Id.Item.MP5, Id.Item.UMP\nId.Item.MP5', maxM: 90 }]
			}
		});
		expect(c.range.classes).toEqual([
			{ name: 'SMG', causes: ['Id.Item.MP5', 'Id.Item.UMP'], maxM: 90 }
		]);
	});
});

describe('hsEligible', () => {
	const base = {
		killer: CHEAT,
		victim: LEGIT,
		suicide: false,
		teamKill: false,
		cause: 'Id.Item.AK74M',
		tags: ['Headshot']
	};
	test('a rifle kill of an enemy counts', () => expect(hsEligible(base)).toBe(true));
	test('team kills, suicides and environment deaths do not', () => {
		expect(hsEligible({ ...base, teamKill: true })).toBe(false);
		expect(hsEligible({ ...base, suicide: true })).toBe(false);
		expect(hsEligible({ ...base, killer: LEGIT })).toBe(false);
		expect(hsEligible({ ...base, killer: null })).toBe(false);
	});
	test('explosives, vehicles, buildables and melee do not', () => {
		for (const cause of [
			'Id.Item.M67Grenade',
			'Id.Item.C4Explosive',
			'Id.Item.RPG7',
			'Id.Vehicle.WeaponExtension.STN_02.MainCannon',
			'Vehicle.Variant.Land.Wheeled.Kodiak.MachineGun',
			'Id.Buildable.BarbedWire',
			'Id.Item.Defibrillator.Standard',
			'ID.Item.BuildTool.Hammer.Large'
		])
			expect(hsEligible({ ...base, cause })).toBe(false);
		expect(hsEligible({ ...base, tags: ['VehicleExplosion'] })).toBe(false);
		expect(hsEligible({ ...base, tags: ['WeaponMelee'] })).toBe(false);
		expect(hsEligible({ ...base, cause: null })).toBe(false);
	});
});

describe('HS_BURST', () => {
	test('5 headshot kills in 10 s trips once', () => {
		const trips = headshotReplay(
			cfg(),
			[0, 2, 4, 6, 8].map((s) => k(CHEAT, s, true))
		);
		expect(trips.map((t) => t.rule)).toEqual(['HS_BURST']);
		expect(trips[0].evidence).toHaveLength(5);
		expect(trips[0].verdict).toBe('5 headshot kills in 8 s');
	});
	test('4 in 10 s, or 5 spread over 15 s, do not', () => {
		expect(
			headshotReplay(
				cfg(),
				[0, 2, 4, 6].map((s) => k(CHEAT, s, true))
			)
		).toEqual([]);
		expect(
			headshotReplay(
				cfg(),
				[0, 3.5, 7, 10.5, 14].map((s) => k(CHEAT, s, true))
			)
		).toEqual([]);
	});
	test('a burst spends its kills: a sixth headshot right after is not a second trip', () => {
		const trips = headshotReplay(
			cfg(),
			[0, 1, 2, 3, 4, 5].map((s) => k(CHEAT, s, true))
		);
		expect(trips.filter((t) => t.rule === 'HS_BURST')).toHaveLength(1);
	});
	test('an LMG multi-kill on a group, body shots, does not trip', () => {
		const lmg = [0, 0.3, 0.6, 0.9, 1.2, 1.5].map((s) => k(LEGIT, s, false, 'Id.Item.MK22'));
		expect(headshotReplay(cfg(), lmg)).toEqual([]);
	});
	test('a grenade on a group never reaches the rule', () => {
		const blast = [0, 0, 0, 0, 0].map(() => ({
			killer: LEGIT,
			victim: CHEAT,
			suicide: false,
			teamKill: false,
			cause: 'Id.Item.M67Grenade',
			tags: ['Headshot']
		}));
		expect(blast.filter(hsEligible)).toHaveLength(0);
	});
});

describe('HS_RATIO', () => {
	test('3/3 headshots never trips', () => {
		expect(
			headshotReplay(
				cfg(),
				[0, 20, 40].map((s) => k(CHEAT, s, true))
			)
		).toEqual([]);
	});
	test('14/15 (93%) in 5 min trips at the 15th kill', () => {
		const kills = Array.from({ length: 15 }, (_, i) => k(CHEAT, i * 15, i !== 7));
		const trips = headshotReplay(cfg({ burst: { mode: 'off' } }), kills);
		expect(trips.map((t) => t.rule)).toEqual(['HS_RATIO']);
		expect(trips[0].verdict).toBe('93% headshots (14/15) in 5 min');
		expect(trips[0].evidence).toHaveLength(15);
	});
	test('12/15 (80%) does not', () => {
		const kills = Array.from({ length: 15 }, (_, i) => k(LEGIT, i * 15, i % 5 !== 0));
		expect(headshotReplay(cfg(), kills)).toEqual([]);
	});
	test('a legit sniper streak: 10 headshots over 8 minutes does not trip', () => {
		const kills = Array.from({ length: 10 }, (_, i) =>
			k(LEGIT, i * 48, true, 'Id.Item.SV98', 250 + i * 10)
		);
		expect(headshotReplay(cfg(), kills)).toEqual([]);
	});
});

describe('HS_RANGE', () => {
	test('a pistol headshot at 150 m trips; at 30 m, or a body shot at 150 m, does not', () => {
		const trips = headshotReplay(cfg(), [
			k(CHEAT, 0, true, 'Id.Item.Glock17', 150),
			k(LEGIT, 100, true, 'Id.Item.Glock17', 30),
			k(LEGIT, 200, false, 'Id.Item.Glock17', 150)
		]);
		expect(trips.map((t) => [t.rule, t.steamId, t.verdict])).toEqual([
			['HS_RANGE', CHEAT, 'Pistol headshot at 150 m (limit 80 m)']
		]);
	});
	test('a rifle headshot at 300 m is not a range trip', () => {
		expect(headshotReplay(cfg(), [k(LEGIT, 0, true, 'Id.Item.SV98', 300)])).toEqual([]);
	});
	test('a shotgun headshot beyond 60 m trips', () => {
		const trips = headshotReplay(cfg(), [k(CHEAT, 0, true, 'Id.Item.M500', 75)]);
		expect(trips[0]?.rule).toBe('HS_RANGE');
	});
	test('a kill without a distance is not judged', () => {
		expect(headshotReplay(cfg(), [k(CHEAT, 0, true, 'Id.Item.Glock17', null)])).toEqual([]);
	});
});

describe('REPEAT and the alert cooldown', () => {
	test('a second trip within 24 h is a repeat, and alerts despite the cooldown', () => {
		const trips = headshotReplay(cfg(), [
			k(CHEAT, 0, true, 'Id.Item.Glock17', 150),
			k(CHEAT, 60, true, 'Id.Item.Glock17', 160)
		]);
		expect(trips.map((t) => [t.repeat, t.alert])).toEqual([
			[false, true],
			[true, true]
		]);
		expect(countByRule(trips)).toEqual({ HS_BURST: 0, HS_RATIO: 0, HS_RANGE: 2, REPEAT: 1 });
	});
	test('a third trip inside the cooldown is logged but does not alert', () => {
		const trips = headshotReplay(
			cfg(),
			[0, 60, 120].map((s) => k(CHEAT, s, true, 'Id.Item.Glock17', 150))
		);
		expect(trips.map((t) => t.alert)).toEqual([true, true, false]);
	});
	test('a trip 25 h after the last is not a repeat', () => {
		const c = cfg();
		const mem = { lastTrip: new Map([[CHEAT, 0]]), lastAlert: new Map() };
		const t = {
			rule: 'HS_RANGE' as const,
			steamId: CHEAT,
			name: 'c',
			at: 25 * 3600_000,
			verdict: '',
			evidence: []
		};
		expect(judgeTrip(c, mem, t)).toEqual({ repeat: false, alert: true });
	});
	test('REPEAT off never marks a repeat', () => {
		const trips = headshotReplay(cfg({ repeat: { mode: 'off' } }), [
			k(CHEAT, 0, true, 'Id.Item.Glock17', 150),
			k(CHEAT, 60, true, 'Id.Item.Glock17', 160)
		]);
		expect(trips.map((t) => t.repeat)).toEqual([false, false]);
	});
	test('players are judged separately', () => {
		const kills = [0, 1, 2, 3].flatMap((s) => [k(CHEAT, s, true), k(LEGIT, s, true)]);
		expect(headshotReplay(cfg(), kills)).toEqual([]);
	});
});
