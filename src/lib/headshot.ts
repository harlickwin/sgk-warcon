// SGK: what the Headshot anti-cheat rule shares between the panel and the server: rule names,
// default weapon classes, and the Automation form's shape. The rule itself is
// $lib/server/headshot.ts.

export const HS_RULES = ['HS_BURST', 'HS_RATIO', 'HS_RANGE', 'REPEAT'] as const;
export type HsRule = (typeof HS_RULES)[number];
export const HS_RULE_LABELS: Record<HsRule, string> = {
	HS_BURST: 'Headshot burst',
	HS_RATIO: 'Headshot ratio',
	HS_RANGE: 'Impossible range',
	REPEAT: 'Repeat offender'
};

/** off: not checked · watch: alert only · enforce: act in game (not available yet). */
export type HsMode = 'off' | 'watch' | 'enforce';

/** A class of weapons with the furthest headshot it should land. */
export interface RangeClass {
	name: string;
	/** exact causes as the feed sends them, e.g. Id.Item.Glock17 */
	causes: string[];
	maxM: number;
}

/**
 * The default range classes. The feed names few weapons yet: the M500 is the only shotgun and the
 * Glock 17 the only pistol seen so far, and no SMG has shown up. Add causes as they appear.
 */
export const DEFAULT_RANGE_CLASSES: RangeClass[] = [
	{ name: 'Pistol', causes: ['Id.Item.Glock17'], maxM: 80 },
	{ name: 'SMG', causes: [], maxM: 120 },
	{ name: 'Shotgun', causes: ['Id.Item.M500'], maxM: 60 }
];

export interface HeadshotConfig {
	burst: { mode: HsMode; kills: number; seconds: number };
	ratio: { mode: HsMode; pct: number; minKills: number; windowMinutes: number };
	range: { mode: HsMode; classes: RangeClass[] };
	repeat: { mode: HsMode; windowHours: number };
	/** one alert per player per rule this often; trips inside it are still logged */
	alertCooldownMinutes: number;
}

/** The Automation form: the config with each class's causes as editable text. */
export type HeadshotForm = Omit<HeadshotConfig, 'range'> & {
	range: { mode: HsMode; classes: { name: string; causes: string; maxM: number }[] };
};

const rec = (v: unknown): Record<string, unknown> =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const md = (v: unknown, d: HsMode): HsMode =>
	v === 'off' || v === 'watch' || v === 'enforce' ? v : d;

export function headshotFormOf(config: unknown): HeadshotForm {
	const c = rec(config);
	const b = rec(c.burst);
	const r = rec(c.ratio);
	const g = rec(c.range);
	const p = rec(c.repeat);
	const classes = Array.isArray(g.classes) ? (g.classes as RangeClass[]) : DEFAULT_RANGE_CLASSES;
	return {
		burst: { mode: md(b.mode, 'watch'), kills: num(b.kills, 5), seconds: num(b.seconds, 10) },
		ratio: {
			mode: md(r.mode, 'watch'),
			pct: num(r.pct, 90),
			minKills: num(r.minKills, 15),
			windowMinutes: num(r.windowMinutes, 5)
		},
		range: {
			mode: md(g.mode, 'watch'),
			classes: classes.map((x) => ({
				name: x.name,
				causes: (x.causes ?? []).join('\n'),
				maxM: x.maxM
			}))
		},
		repeat: { mode: md(p.mode, 'watch'), windowHours: num(p.windowHours, 24) },
		alertCooldownMinutes: num(c.alertCooldownMinutes, 10)
	};
}

export function headshotConfigOf(f: HeadshotForm): HeadshotConfig {
	return {
		burst: { mode: f.burst.mode, kills: Number(f.burst.kills), seconds: Number(f.burst.seconds) },
		ratio: {
			mode: f.ratio.mode,
			pct: Number(f.ratio.pct),
			minKills: Number(f.ratio.minKills),
			windowMinutes: Number(f.ratio.windowMinutes)
		},
		range: {
			mode: f.range.mode,
			classes: f.range.classes.map((x) => ({
				name: x.name,
				causes: x.causes
					.split(/[\s,]+/)
					.map((s) => s.trim())
					.filter(Boolean),
				maxM: Number(x.maxM)
			}))
		},
		repeat: { mode: f.repeat.mode, windowHours: Number(f.repeat.windowHours) },
		alertCooldownMinutes: Number(f.alertCooldownMinutes)
	};
}

/** One line for the rule list. */
export function headshotSummary(config: unknown): string {
	const f = headshotFormOf(config);
	const on = (m: HsMode, s: string) => (m === 'off' ? '' : m === 'watch' ? s : `${s} (enforce)`);
	return [
		on(f.burst.mode, `burst ${f.burst.kills} HS in ${f.burst.seconds} s`),
		on(
			f.ratio.mode,
			`ratio ${f.ratio.pct}% over ${f.ratio.minKills}+ kills in ${f.ratio.windowMinutes} min`
		),
		on(
			f.range.mode,
			`range ${f.range.classes.filter((c) => c.causes.trim()).length} weapon classes`
		),
		on(f.repeat.mode, `repeat within ${f.repeat.windowHours} h`)
	]
		.filter(Boolean)
		.join(' · ')
		.concat(` · alerts only · again after ${f.alertCooldownMinutes} min`);
}
