// Validate ANTHROPIC_API_KEY + find a working model slug against the Messages API.
import { existsSync, readFileSync } from 'node:fs';
if (existsSync('.env')) {
	for (const line of readFileSync('.env', 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m) { const v = m[2].replace(/^["']|["']$/g, '').trim(); if (v) process.env[m[1]] = v; }
	}
}
const KEY = process.env.ANTHROPIC_API_KEY;
console.log('key present:', !!KEY, 'prefix-ok:', KEY?.startsWith('sk-ant-'), 'len:', KEY?.length);
const MODELS = ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5', 'claude-3-5-sonnet-20241022', 'claude-sonnet-4-20250514'];
for (const model of MODELS) {
	try {
		const r = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
			body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with just: OK' }] }),
		});
		const j = await r.json();
		if (r.ok) { console.log(`✅ ${model} → HTTP ${r.status} · text="${j.content?.[0]?.text}" · usage=${JSON.stringify(j.usage)}`); break; }
		else console.log(`❌ ${model} → HTTP ${r.status} · ${j.error?.type}: ${j.error?.message?.slice(0,90)}`);
	} catch (e) { console.log(`❌ ${model} → ${e.message}`); }
}
