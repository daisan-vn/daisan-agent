#!/usr/bin/env node
/**
 * Daisan Agent — HTTP service.
 * Engine: Anthropic Messages API (direct), streamed. Headless-safe — no subprocess,
 * no TTY (the full Claude Code agent SDK needs an interactive terminal and hangs as a
 * detached service, so the service uses the API directly; the agentic CLI lives in generate.mjs).
 *
 *   POST /api/generate { prompt }  -> SSE: start | delta | done | error
 *                                     done = { jobId, html, previewUrl, inputTokens, outputTokens, cost }
 *   GET  /preview/:jobId/          -> serves the generated static site
 *   GET  /health                   -> { ok, hasKey }
 */
import express from 'express';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_PROMPT, EDIT_SYSTEM_PROMPT, MULTI_SYSTEM_PROMPT, API_MODEL, cleanHtml, parseMultiFiles } from './instructions.mjs';

// ── load .env (dependency-free) ───────────────────────────────────────────────
if (existsSync('.env')) {
	for (const line of readFileSync('.env', 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		// .env wins over an inherited empty/placeholder var. Only override with a non-empty value.
		if (m) { const v = m[2].replace(/^["']|["']$/g, '').trim(); if (v) process.env[m[1]] = v; }
	}
}

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const PORT = Number(process.env.PORT) || 8787;
const WORKSPACES = join(process.cwd(), 'workspaces');
mkdirSync(WORKSPACES, { recursive: true });

// Sonnet 4.5 pricing per million tokens (USD).
const PRICE_IN = 3, PRICE_OUT = 15;
// Cap output for speed (a focused landing page fits comfortably). Override via env.
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 12000;
// Multi-page sites need more room (several full documents in one response).
const MAX_TOKENS_MULTI = Number(process.env.MAX_TOKENS_MULTI) || 16000;

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS — allow the daisan.ai frontend (any origin) to call this service.
app.use((req, res, next) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Daisan-Token');
	if (req.method === 'OPTIONS') return res.status(204).end();
	next();
});

app.get('/', (_req, res) => res.json({ service: 'daisan-agent', ok: true }));
app.get('/health', (_req, res) => res.json({ ok: true, hasKey: !!process.env.ANTHROPIC_API_KEY }));

// Serve generated sites. NOTE: user-generated content — the frontend embeds it in a
// sandboxed iframe; this lives on a separate origin (agent.daisan.ai) for isolation.
app.use('/preview', express.static(WORKSPACES, { index: 'index.html', extensions: ['html'] }));

app.post('/api/generate', async (req, res) => {
	const prompt = String(req.body?.prompt || '').trim();
	if (!prompt) return res.status(400).json({ error: 'prompt required' });
	if (prompt.length > 4000) return res.status(400).json({ error: 'prompt too long' });
	if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

	// Shared-token gate (only when configured): the daisan.ai worker proxies with this token.
	// Blocks direct abuse of the public endpoint (each call costs Anthropic credits).
	const requiredToken = process.env.DAISAN_API_TOKEN;
	if (requiredToken && req.get('X-Daisan-Token') !== requiredToken) {
		return res.status(401).json({ error: 'unauthorized' });
	}

	// Iterative edit: when the client sends the current page HTML, treat `prompt` as a change request.
	const baseHtml = typeof req.body?.html === 'string' ? req.body.html : '';
	const isEdit = baseHtml.trim().length > 50;
	// Multi-page: generate several linked .html files instead of one.
	const isMulti = !isEdit && req.body?.mode === 'multi';

	const jobId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(36).slice(2, 7)}`;

	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders?.();
	const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

	send('start', { jobId });

	// Client disconnect → abort the upstream call (stop burning tokens).
	// NOTE: use res 'close' (real disconnect), not req 'close' which fires as soon as the
	// POST body is read — that would abort the upstream immediately.
	const controller = new AbortController();
	res.on('close', () => controller.abort());

	try {
		const upstream = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': process.env.ANTHROPIC_API_KEY,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: API_MODEL,
				max_tokens: isMulti ? MAX_TOKENS_MULTI : MAX_TOKENS,
				stream: true,
				system: isEdit ? EDIT_SYSTEM_PROMPT : (isMulti ? MULTI_SYSTEM_PROMPT : SYSTEM_PROMPT),
				messages: [{
					role: 'user',
					content: isEdit
						? `HTML hiện tại của trang:\n\n${baseHtml}\n\nYêu cầu chỉnh sửa: ${prompt}`
						: `Ý tưởng của người dùng: ${prompt}`,
				}],
			}),
			signal: controller.signal,
		});

		if (!upstream.ok || !upstream.body) {
			const errText = await upstream.text().catch(() => '');
			send('error', { message: `API ${upstream.status}: ${errText.slice(0, 200)}` });
			return res.end();
		}

		let full = '', inTok = 0, outTok = 0, buf = '', stopReason = null;
		const reader = upstream.body.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl;
			while ((nl = buf.indexOf('\n\n')) !== -1) {
				const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
				const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
				if (!dataLine) continue;
				const payload = dataLine.slice(5).trim();
				if (!payload || payload === '[DONE]') continue;
				let evt; try { evt = JSON.parse(payload); } catch { continue; }
				if (evt.type === 'message_start') inTok = evt.message?.usage?.input_tokens ?? 0;
				else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
					full += evt.delta.text;
					send('delta', { text: evt.delta.text });
				} else if (evt.type === 'message_delta') { outTok = evt.usage?.output_tokens ?? outTok; stopReason = evt.delta?.stop_reason ?? stopReason; }
				else if (evt.type === 'error') send('error', { message: evt.error?.message || 'stream error' });
			}
		}

		const workspace = join(WORKSPACES, jobId);
		mkdirSync(workspace, { recursive: true });
		const cost = inTok / 1e6 * PRICE_IN + outTok / 1e6 * PRICE_OUT;
		let html, pages = 1, fileNames = ['index.html'];

		if (isMulti) {
			const files = parseMultiFiles(full);
			if (!files.length) {
				send('error', { message: 'Không tạo được nhiều trang — thử lại.' });
				return res.end();
			}
			for (const f of files) writeFileSync(join(workspace, f.name), f.content, 'utf8');
			html = (files.find((f) => f.name === 'index.html') || files[0]).content;
			pages = files.length;
			fileNames = files.map((f) => f.name);
		} else {
			html = cleanHtml(full);
			if (!html || !html.toLowerCase().includes('<')) {
				send('error', { message: 'Không nhận được HTML hợp lệ — thử lại.' });
				return res.end();
			}
			writeFileSync(join(workspace, 'index.html'), html, 'utf8');
		}

		send('done', {
			jobId, html, pages, fileNames,
			previewUrl: `/preview/${jobId}/index.html`,
			inputTokens: inTok, outputTokens: outTok,
			cost: Number(cost.toFixed(4)),
			stopReason,
		});
	} catch (err) {
		if (!controller.signal.aborted) send('error', { message: err?.message || String(err) });
	} finally {
		res.end();
	}
});

app.listen(PORT, '0.0.0.0', () => {
	console.log(`\n⚡ Daisan Agent service → http://localhost:${PORT}`);
	console.log(`   engine: Anthropic Messages API · model: ${API_MODEL}`);
	console.log(`   ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'set ✓' : 'MISSING ✗ (đặt trong .env)'}`);
	console.log(`   POST /api/generate · GET /preview/:jobId/ · GET /health\n`);
});
