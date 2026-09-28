// SGK: the Discord card for a Headshot anti-cheat trip. Built from the audit row's detail, which
// carries the evidence the live rule attached (headshot-live.ts), so the alert says why without
// anyone opening the panel: who, which rule, the kills, and the player's session so far.
import type { AuditRow } from './db/schema';
import type { Embed, EmbedField } from './webhook-delivery';
import { HS_RULE_LABELS, type HsRule } from '$lib/headshot';

const COLOR = 0xe0643a;
const REPEAT_COLOR = 0xd23b3b;

export interface EvidenceKill {
	at: number;
	victim: string;
	weapon: string;
	distanceM: number | null;
	headshot: boolean;
}
export interface SessionStats {
	kills: number;
	deaths: number;
	headshots: number;
	eligible: number;
	minutes: number | null;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** Text safe inside a Discord code block and on one line. */
const plain = (s: string) => s.replace(/[`\r\n]/g, "'");

/** The evidence as a fixed-width table: seconds after the first kill, victim, weapon, range, HS. */
export function evidenceTable(kills: EvidenceKill[], max = 1000): string {
	if (!kills.length) return '';
	const t0 = kills[0].at;
	const rows = kills.map((k) => {
		const dt = `+${((k.at - t0) / 1000).toFixed(1)}s`.padStart(7);
		const dist = k.distanceM === null ? '   — ' : `${Math.round(k.distanceM)}m`.padStart(5);
		return `${dt} ${clip(plain(k.victim), 16).padEnd(16)} ${clip(plain(k.weapon), 12).padEnd(12)} ${dist} ${k.headshot ? 'HS' : '  '}`;
	});
	const out: string[] = [];
	let len = 8;
	for (const [i, r] of rows.entries()) {
		if (len + r.length + 1 > max - 30) {
			out.push(`… and ${rows.length - i} more`);
			break;
		}
		out.push(r);
		len += r.length + 1;
	}
	return '```\n' + out.join('\n') + '\n```';
}

export function sessionLine(s: SessionStats): string {
	const pct = s.eligible ? ` (${Math.round((100 * s.headshots) / s.eligible)}% of gun kills)` : '';
	const time = s.minutes === null ? '' : ` · on for ${s.minutes} min`;
	return `${s.kills} kills / ${s.deaths} deaths · ${s.headshots} headshots${pct}${time}`;
}

export function buildHeadshotEmbed(appName: string, row: AuditRow, url?: string): Embed {
	const d = (row.detail ?? {}) as Record<string, unknown>;
	const rule = (typeof d.rule === 'string' ? d.rule : 'HS') as HsRule;
	const repeat = d.repeat === true;
	const name = typeof d.name === 'string' ? d.name : row.target;
	const lines = [
		`**${clip(name, 60)}** · \`${row.target}\``,
		typeof d.verdict === 'string' ? d.verdict : row.message,
		row.serverName ? `Server: ${clip(row.serverName, 80)}` : '',
		`Mode: **${d.mode === 'enforce' ? 'enforce' : 'watch'}** (${d.mode === 'enforce' ? 'action taken in game' : 'alert only, nobody was kicked'})`,
		repeat ? '**Repeat:** tripped a headshot rule earlier inside the repeat window.' : ''
	].filter(Boolean);
	const fields: EmbedField[] = [];
	const evidence = Array.isArray(d.evidence) ? (d.evidence as EvidenceKill[]) : [];
	if (evidence.length)
		fields.push({
			name: `Evidence (${evidence.length} kill${evidence.length === 1 ? '' : 's'})`,
			value: evidenceTable(evidence)
		});
	if (d.session && typeof d.session === 'object')
		fields.push({ name: 'This session', value: sessionLine(d.session as SessionStats) });
	if (url) fields.push({ name: 'Review', value: `[Open the player in Warcon](${url})` });
	return {
		title: clip(
			`${repeat ? 'REPEAT · ' : ''}${rule} · ${HS_RULE_LABELS[rule] ?? 'Headshot rule'}`,
			200
		),
		description: clip(lines.join('\n'), 2000),
		color: repeat ? REPEAT_COLOR : COLOR,
		timestamp: row.ts.toISOString(),
		url,
		fields,
		footer: { text: `${appName} · anti-cheat` }
	};
}
