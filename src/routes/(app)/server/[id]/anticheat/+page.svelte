<script lang="ts">
	// SGK: every Headshot anti-cheat trip on this server, counts per rule, and a replay of the rule
	// over stored kills, for reviewing false positives and tuning thresholds during the watch period.
	import { api, qs, errorMessage } from '$lib/api';
	import { fmtNum, fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { HS_RULES, HS_RULE_LABELS, type HsRule } from '$lib/headshot';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let api_ = $derived(`/api/servers/${encodeURIComponent(id)}/anticheat`);

	interface Evidence {
		eventId: string;
		at: number;
		victim: string;
		weapon: string;
		distanceM: number | null;
		headshot: boolean;
	}
	interface Trip {
		id: number;
		ts: string;
		rule: string;
		steamId: string;
		name: string;
		mode: string;
		repeat: boolean;
		alerted: boolean;
		verdict: string;
		evidence: Evidence[];
	}
	type Counts = Record<HsRule, { trips: number; alerts: number; players: number }>;

	let days = $state(7);
	let rule = $state('');
	let player = $state('');
	let trips = $state<Trip[]>([]);
	let counts = $state<Counts | null>(null);
	let more = $state(false);
	let loading = $state(false);
	let open = $state<number | null>(null);
	let seq = 0;

	async function load(append = false) {
		const my = ++seq;
		loading = true;
		try {
			const r = await api<{ counts: Counts; trips: Trip[]; more: boolean }>(
				'GET',
				`${api_}${qs({ days, rule, player, before: append ? trips[trips.length - 1]?.id : '' })}`
			);
			if (my !== seq) return;
			counts = r.counts;
			trips = append ? [...trips, ...r.trips] : r.trips;
			more = r.more;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			if (my === seq) loading = false;
		}
	}
	$effect(() => {
		void [days, rule, player, api_];
		const t = setTimeout(() => void load(), 250);
		return () => clearTimeout(t);
	});

	interface ReplayTrip {
		at: string;
		rule: string;
		steamId: string;
		name: string;
		verdict: string;
		repeat: boolean;
		alert: boolean;
		kills: number;
	}
	interface Replay {
		from: string;
		to: string;
		kills: number;
		eligible: number;
		truncated: boolean;
		counts: Record<HsRule, number>;
		alerts: number;
		trips: ReplayTrip[];
	}
	let replayDays = $state(7);
	let replay = $state<Replay | null>(null);
	let replaying = $state(false);
	async function runReplay() {
		replaying = true;
		try {
			const r = await api<{ result: Replay }>('POST', api_, { days: replayDays });
			replay = r.result;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			replaying = false;
		}
	}

	const dossier = (steamId: string) =>
		`/server/${encodeURIComponent(id)}/players/${encodeURIComponent(steamId)}`;
	const secs = (e: Evidence[], i: number) => `+${((e[i].at - e[0].at) / 1000).toFixed(1)} s`;
</script>

<div class="space-y-4">
	{#if !data.rule}
		<div class="callout">
			No Headshot anti-cheat rule on this server yet. Add one under
			<a href="/server/{encodeURIComponent(id)}/automation" class="text-accent hover:underline"
				>Automation</a
			>{data.feed ? '.' : ', after turning on the kill feed under Config.'}
		</div>
	{:else if !data.rule.enabled}
		<div class="callout">The Headshot anti-cheat rule is saved but switched off.</div>
	{/if}

	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
		{#each HS_RULES as r (r)}
			<button
				type="button"
				class="cursor-pointer panel text-left {rule === r ? 'ring-1 ring-accent' : ''}"
				onclick={() => (rule = rule === r ? '' : r)}
				title="Show only {HS_RULE_LABELS[r]} trips"
			>
				<div class="label-sm">{r} · {HS_RULE_LABELS[r]}</div>
				<div class="stat-big">{counts ? fmtNum(counts[r].trips) : '—'}</div>
				<div class="text-[12.5px] text-mist-600">
					{#if counts && r !== 'REPEAT'}{fmtNum(counts[r].alerts)} alerted ·
						{fmtNum(counts[r].players)} player{counts[r].players === 1
							? ''
							: 's'}{:else if counts}trips marked repeat{/if}
					· last {days} d
				</div>
			</button>
		{/each}
	</div>

	<div class="panel">
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<select class="input w-36" bind:value={days} aria-label="Span">
				{#each [1, 7, 14, 30, 90] as d (d)}<option value={d}
						>Last {d} day{d === 1 ? '' : 's'}</option
					>{/each}
			</select>
			<select class="input w-48" bind:value={rule} aria-label="Rule">
				<option value="">Every rule</option>
				{#each HS_RULES as r (r)}<option value={r}>{r} · {HS_RULE_LABELS[r]}</option>{/each}
			</select>
			<input
				class="input w-64"
				type="search"
				placeholder="Player: name or SteamID"
				aria-label="Filter by player"
				bind:value={player}
			/>
			<span class="ml-auto text-[12.5px] text-mist-600"
				>newest first · click a row for the kills</span
			>
		</div>
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>When</th><th>Player</th><th>Rule</th><th>Why</th><th>Status</th></tr>
				</thead>
				<tbody>
					{#each trips as t (t.id)}
						<tr class="cursor-pointer" onclick={() => (open = open === t.id ? null : t.id)}>
							<td class="font-mono text-[12px] whitespace-nowrap text-mist-400">{fmtTime(t.ts)}</td>
							<td>
								<a
									href={dossier(t.steamId)}
									class="hover:text-accent hover:underline"
									onclick={(e) => e.stopPropagation()}>{t.name}</a
								>
								<span class="block font-mono text-[11px] text-mist-600">{t.steamId}</span>
							</td>
							<td class="whitespace-nowrap">{t.rule}</td>
							<td class="text-mist-200">{t.verdict}</td>
							<td class="whitespace-nowrap">
								<span class="chip">{t.mode}</span>
								{#if t.repeat}<span class="chip text-warn">repeat</span>{/if}
								{#if !t.alerted}<span class="chip" title="Inside the alert cooldown">log only</span
									>{/if}
							</td>
						</tr>
						{#if open === t.id}
							<tr>
								<td colspan="5" class="bg-black/10">
									<table class="w-full text-[12.5px]">
										<thead>
											<tr
												><th>After first</th><th>Victim</th><th>Weapon</th><th class="num"
													>Distance</th
												><th></th></tr
											>
										</thead>
										<tbody>
											{#each t.evidence as e, i (e.eventId)}
												<tr>
													<td class="font-mono">{secs(t.evidence, i)}</td>
													<td>{e.victim}</td>
													<td>{e.weapon}</td>
													<td class="num"
														>{e.distanceM === null ? '—' : `${Math.round(e.distanceM)} m`}</td
													>
													<td
														>{#if e.headshot}<span class="chip">headshot</span>{/if}</td
													>
												</tr>
											{/each}
										</tbody>
									</table>
								</td>
							</tr>
						{/if}
					{:else}
						<tr
							><td colspan="5" class="py-6 text-center text-mist-600"
								>{loading ? 'Loading…' : 'No trips in this span.'}</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
		{#if more}
			<button class="mt-3 btn" onclick={() => load(true)} disabled={loading}>
				{loading ? 'Loading…' : 'Load older trips'}
			</button>
		{/if}
	</div>

	<div class="panel">
		<h2 class="field-label">Replay</h2>
		<p class="note mb-3">
			Runs the saved rule's settings over the stored kills of the last few days, as if it had been
			on, and shows what would have tripped. Nothing is logged, sent or kicked. Change thresholds
			under Automation, then replay again to compare.
		</p>
		<div class="flex flex-wrap items-center gap-2">
			Last
			<input
				class="input w-20 text-right"
				type="number"
				min="1"
				max="90"
				bind:value={replayDays}
				aria-label="Replay days"
			/>
			days
			<button class="btn btn-primary" onclick={runReplay} disabled={replaying}>
				{replaying ? 'Replaying…' : 'Run replay'}
			</button>
		</div>
		{#if replay}
			<p class="mt-3 text-[13px]">
				{fmtNum(replay.kills)} kills read, {fmtNum(replay.eligible)} judged ·
				{#each HS_RULES as r, i (r)}{i ? ' · ' : ''}{r}
					<b>{replay.counts[r]}</b>{/each}
				· {replay.alerts} would alert{replay.truncated ? ' · the span was cut short' : ''}
			</p>
			{#if replay.trips.length}
				<div class="mt-2 table-wrap">
					<table>
						<thead>
							<tr><th>When</th><th>Player</th><th>Rule</th><th>Why</th><th></th></tr>
						</thead>
						<tbody>
							{#each replay.trips as t, i (i)}
								<tr>
									<td class="font-mono text-[12px] whitespace-nowrap text-mist-400"
										>{fmtTime(t.at)}</td
									>
									<td
										><a href={dossier(t.steamId)} class="hover:text-accent hover:underline"
											>{t.name}</a
										></td
									>
									<td>{t.rule}</td>
									<td class="text-mist-200">{t.verdict}</td>
									<td class="whitespace-nowrap">
										{#if t.repeat}<span class="chip text-warn">repeat</span>{/if}
										{#if !t.alert}<span class="chip">log only</span>{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{/if}
	</div>
</div>
