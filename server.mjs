#!/usr/bin/env node
/**
 * Daisan Agent — HTTP service (Stage 2).
 * Wraps the Claude Agent SDK as a deployable web service so daisan.ai can call it:
 *   POST /api/generate { prompt }     -> Server-Sent Events: start | text | tool | done | error
 *   GET  /preview/:jobId/*            -> serves the generated static site (live preview)
 *   GET  /health                      -> { ok, hasKey }
 *
 * Runs on any Node 18+ host (Railway / Render / Fly / a VPS / Cloudflare Container).
 * Needs ANTHROPIC_API_KEY in the environment.
 */
import express from 'express';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_INSTRUCTIONS, DEFAULT_MODEL } from './instructions.mjs';

// ── load .env (dependency-free) ───────────────────────────────────────────────
if (existsSync('.env')) {
	for (const line of readFileSync('.env', 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		// .env wins over an inherited empty/placeholder var (the parent shell may export an
		// empty ANTHROPIC_API_KEY). Only override when .env actually has a non-empty value.
		if (m) {
			const val = m[2].replace(/^["']|["']$/g, '').trim();
			if (val) process.env[m[1]] = val;
		}
	}
}

// Make startup crash-proof + visible: a bad SDK install/binary must NOT silently kill the
// process at import (that produced Render 502s with no app logs). Lazy-load the SDK per request
// so the server always binds, /health works, and any SDK error surfaces per-request instead.
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

let _query;
async function getQuery() {
	if (!_query) _query = (await import('@anthropic-ai/claude-agent-sdk')).query;
	return _query;
}

const PORT = Number(process.env.PORT) || 8787;
const WORKSPACES = join(process.cwd(), 'workspaces');
mkdirSync(WORKSPACES, { recursive: true });

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS — allow the daisan.ai frontend (any origin) to call this service.
app.use((req, res, next) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') return res.status(204).end();
	next();
});

app.get('/', (_req, res) => res.json({ service: 'daisan-agent', ok: true }));
app.get('/health', (_req, res) => res.json({ ok: true, hasKey: !!process.env.ANTHROPIC_API_KEY }));

// Serve generated sites. NOTE: user-generated content — the daisan.ai frontend should embed
// this in a sandboxed iframe, and for production it should live on a separate origin.
app.use('/preview', express.static(WORKSPACES, { index: 'index.html', extensions: ['html'] }));

app.post('/api/generate', async (req, res) => {
	const prompt = String(req.body?.prompt || '').trim();
	if (!prompt) return res.status(400).json({ error: 'prompt required' });
	if (prompt.length > 4000) return res.status(400).json({ error: 'prompt too long' });
	if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

	const jobId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(36).slice(2, 7)}`;
	const workspace = join(WORKSPACES, jobId);
	mkdirSync(workspace, { recursive: true });

	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders?.();
	const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

	send('start', { jobId });
	let tools = 0;
	try {
		const query = await getQuery();
		for await (const message of query({
			prompt: `${BUILD_INSTRUCTIONS}\n\nUser's idea: ${prompt}`,
			options: {
				cwd: workspace,
				model: DEFAULT_MODEL,
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
				env: process.env,
			},
		})) {
			if (message.type === 'assistant') {
				for (const block of message.message?.content ?? []) {
					if (block.type === 'text' && block.text?.trim()) send('text', { text: block.text });
					else if (block.type === 'tool_use') {
						tools++;
						send('tool', { name: block.name, detail: block.input?.file_path || block.input?.path || block.input?.command || '' });
					}
				}
			} else if (message.type === 'result') {
				send('done', {
					jobId,
					previewUrl: `/preview/${jobId}/index.html`,
					ok: message.subtype === 'success',
					tools,
					turns: message.num_turns ?? null,
					cost: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
				});
			}
		}
	} catch (err) {
		send('error', { message: err?.message || String(err) });
	} finally {
		res.end();
	}
});

app.listen(PORT, '0.0.0.0', () => {
	console.log(`\n⚡ Daisan Agent service → http://localhost:${PORT}`);
	console.log(`   ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'set ✓' : 'MISSING ✗ (đặt trong .env)'}`);
	console.log(`   POST /api/generate · GET /preview/:jobId/ · GET /health\n`);
});
