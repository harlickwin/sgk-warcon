import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireServerCap } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { triggers } from '$lib/server/db/schema';

/** SGK: the Anti-cheat tab. Checked here as well as in the layout (see the Automation page). */
export const load: PageServerLoad = async ({ locals, params }) => {
	const env = getEnv();
	try {
		const { server } = await requireServerCap(env, locals, params.id, 'automation.manage');
		const rules = await env.db
			.select({ id: triggers.id, enabled: triggers.enabled, config: triggers.config })
			.from(triggers)
			.where(and(eq(triggers.serverId, server.id), eq(triggers.kind, 'headshot')));
		return {
			feed: !!server.feedTokenHash,
			rule: rules.find((r) => r.enabled) ?? rules[0] ?? null
		};
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
};
