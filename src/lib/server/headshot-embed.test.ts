import { describe, expect, test } from 'bun:test';
import { buildHeadshotEmbed, evidenceTable, sessionLine } from './headshot-embed';
import { classify } from './webhook-delivery';
import type { AuditRow } from './db/schema';

const row = (detail: Record<string, unknown>): AuditRow => ({
	id: 1,
	ts: new Date('2026-09-28T12:00:00Z'),
	actorId: null,
	actorName: 'trigger: Headshot anti-cheat',
	serverId: 's1',
	serverName: 'SGK KOTH',
	orgId: 'o1',
	category: 'trigger',
	action: 'trigger.headshot',
	target: '76561198000000901',
	detail,
	outcome: 'ok',
	status: 200,
	message: 'Flagged x',
	userAgent: '',
	durationMs: null
});

const ev = (s: number, victim = 'bob') => ({
	at: s * 1000,
	victim,
	weapon: 'AK-74M',
	distanceM: 42.4,
	headshot: true
});

describe('headshot alert card', () => {
	test('goes to the anti-cheat channels, not the general automation ones', () => {
		expect(classify({ category: 'trigger', action: 'trigger.headshot' })).toBe('anticheat');
		expect(classify({ category: 'trigger', action: 'trigger.kill_rate' })).toBe('triggers');
	});

	test('names the player, rule, evidence, session and review link', () => {
		const e = buildHeadshotEmbed(
			'Warcon',
			row({
				name: 'aimbotter',
				rule: 'HS_BURST',
				verdict: '5 headshot kills in 4 s',
				repeat: false,
				mode: 'watch',
				evidence: [0, 1, 2, 3, 4].map((s) => ev(s)),
				session: { kills: 20, deaths: 2, headshots: 18, eligible: 19, minutes: 12 }
			}),
			'https://panel/server/s1/players/76561198000000901'
		);
		expect(e.title).toBe('HS_BURST · Headshot burst');
		expect(e.description).toContain('**aimbotter** · `76561198000000901`');
		expect(e.description).toContain('alert only, nobody was kicked');
		expect(e.url).toBe('https://panel/server/s1/players/76561198000000901');
		expect(e.fields?.map((f) => f.name)).toEqual(['Evidence (5 kills)', 'This session', 'Review']);
		expect(e.fields?.[0].value).toContain('+4.0s');
		expect(e.fields?.[1].value).toBe(
			'20 kills / 2 deaths · 18 headshots (95% of gun kills) · on for 12 min'
		);
	});

	test('a repeat is marked in the title', () => {
		const e = buildHeadshotEmbed('Warcon', row({ rule: 'HS_RANGE', repeat: true, evidence: [] }));
		expect(e.title).toBe('REPEAT · HS_RANGE · Impossible range');
	});

	test('the evidence table stays inside a Discord field and cannot break its code block', () => {
		const many = Array.from({ length: 200 }, (_, i) => ev(i, 'na`me\nwith junk'));
		const t = evidenceTable(many);
		expect(t.length).toBeLessThanOrEqual(1024);
		expect(t).toContain('more');
		expect(t.slice(3, -3)).not.toContain('`');
	});

	test('session line without an open session', () => {
		expect(sessionLine({ kills: 3, deaths: 0, headshots: 0, eligible: 0, minutes: null })).toBe(
			'3 kills / 0 deaths · 0 headshots'
		);
	});
});
