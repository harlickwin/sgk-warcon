// SGK: the Headshot anti-cheat rule's record for the Anti-cheat tab.
// GET ?days=7&rule=HS_BURST&player=<steamId or name>&before=<id>: trips newest first (100 a page),
// and counts per rule over the span. POST {days, config?}: replays the span's stored kills against
// the given settings (default: this server's saved rule, else the defaults) and acts on nobody.
// Reading trips needs Kick, kill, move (the moderators who act on them, and the Discord bot's key);
// the replay runs rule settings, so it stays with Automation.
import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, int, param, readJson, route, str } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { hsTrips, triggers } from '$lib/server/db/schema';
import { HS_RULES, validateHeadshot, type HsRule } from '$lib/server/headshot';
import { replayHeadshots } from '$lib/server/headshot-replay';

const PAGE = 100;

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'players.moderate'
	);
	const q = event.url.searchParams;
	const days = int(q.get('days'), 7, 1, 365);
	const since = new Date(Date.now() - days * 86_400_000);
	const rule = q.get('rule') || '';
	if (rule && !HS_RULES.includes(rule as HsRule)) throw new ApiError(400, 'Unknown rule.');
	const player = str(q.get('player'), 80);
	const before = int(q.get('before'), 0, 0);

	const span: SQL[] = [eq(hsTrips.serverId, server.id), gte(hsTrips.ts, since)];
	if (player)
		span.push(
			or(
				eq(hsTrips.steamId, player),
				ilike(hsTrips.name, `%${player.replace(/[%_\\]/g, '\\$&')}%`)
			)!
		);
	const where: SQL[] = [...span];
	if (rule === 'REPEAT') where.push(eq(hsTrips.repeat, true));
	else if (rule) where.push(eq(hsTrips.rule, rule));
	if (before) where.push(lt(hsTrips.id, before));

	const [rows, counts] = await Promise.all([
		env.db
			.select()
			.from(hsTrips)
			.where(and(...where))
			.orderBy(desc(hsTrips.id))
			.limit(PAGE),
		env.db
			.select({
				rule: hsTrips.rule,
				trips: sql<number>`COUNT(*)`,
				alerts: sql<number>`COUNT(*) FILTER (WHERE ${hsTrips.alerted})`,
				repeats: sql<number>`COUNT(*) FILTER (WHERE ${hsTrips.repeat})`,
				players: sql<number>`COUNT(DISTINCT ${hsTrips.steamId})`
			})
			.from(hsTrips)
			.where(and(...span))
			.groupBy(hsTrips.rule)
	]);
	const byRule = Object.fromEntries(
		HS_RULES.map((r) => [r, { trips: 0, alerts: 0, players: 0 }])
	) as Record<HsRule, { trips: number; alerts: number; players: number }>;
	for (const c of counts) {
		if (c.rule in byRule) {
			byRule[c.rule as HsRule].trips += Number(c.trips);
			byRule[c.rule as HsRule].alerts += Number(c.alerts);
			byRule[c.rule as HsRule].players += Number(c.players);
		}
		byRule.REPEAT.trips += Number(c.repeats);
	}
	return apiJson({
		ok: true,
		days,
		counts: byRule,
		trips: rows.map((r) => ({ ...r, ts: r.ts.toISOString() })),
		more: rows.length === PAGE
	});
});

export const POST = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'automation.manage'
	);
	const body = await readJson(event.request);
	const days = int(body.days, 7, 1, 90);
	let raw = body.config as Record<string, unknown> | undefined;
	if (!raw) {
		const [saved] = await env.db
			.select({ config: triggers.config })
			.from(triggers)
			.where(and(eq(triggers.serverId, server.id), eq(triggers.kind, 'headshot')))
			.orderBy(desc(triggers.enabled), desc(triggers.updatedAt))
			.limit(1);
		raw = (saved?.config as Record<string, unknown>) ?? {};
	}
	const cfg = validateHeadshot(raw);
	const to = new Date();
	const r = await replayHeadshots(
		env,
		server.id,
		cfg,
		new Date(to.getTime() - days * 86_400_000),
		to
	);
	return apiJson({
		ok: true,
		result: {
			...r,
			// the newest 200 trips, their evidence trimmed to what the table shows
			trips: r.trips
				.slice(-200)
				.reverse()
				.map((t) => ({
					at: new Date(t.at).toISOString(),
					rule: t.rule,
					steamId: t.steamId,
					name: t.name,
					verdict: t.verdict,
					repeat: t.repeat,
					alert: t.alert,
					kills: t.evidence.length
				}))
		}
	});
});
