#!/usr/bin/env node
/**
 * Daisan Agent — Stage 1 CLI.
 * Uses the REAL Claude Agent SDK (the engine behind Claude Code) to build a complete
 * website from an idea: Claude creates/edits files, iterates, and self-corrects in an
 * isolated workspace. No Cloudflare gateway, no container — just Node + your Anthropic key.
 *
 * Usage:  npm run gen -- "Landing quán cà phê specialty, có menu và đặt bàn"
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
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

const idea = process.argv.slice(2).join(' ').trim();
if (!idea) {
	console.error('Cách dùng:  npm run gen -- "ý tưởng web của bạn"');
	process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
	console.error('❌ Thiếu ANTHROPIC_API_KEY. Tạo file .env (copy từ .env.example) và dán key.');
	process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const workspace = join(process.cwd(), 'workspaces', stamp);
mkdirSync(workspace, { recursive: true });

console.log('\n⚡ Daisan Agent — engine Claude Code thật');
console.log(`💡 Ý tưởng: ${idea}`);
console.log(`📁 Workspace: ${workspace}\n${'─'.repeat(64)}`);

const INSTRUCTIONS = `${BUILD_INSTRUCTIONS}\n\nUser's idea: ${idea}`;

let toolCount = 0;
try {
	for await (const message of query({
		prompt: INSTRUCTIONS,
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
				if (block.type === 'text' && block.text?.trim()) {
					process.stdout.write(block.text);
				} else if (block.type === 'tool_use') {
					toolCount++;
					const detail = block.input?.file_path || block.input?.path || block.input?.command || '';
					console.log(`\n  🔧 ${block.name}${detail ? ': ' + String(detail).slice(0, 80) : ''}`);
				}
			}
		} else if (message.type === 'result') {
			const cost = typeof message.total_cost_usd === 'number' ? `$${message.total_cost_usd.toFixed(4)}` : '?';
			console.log(`\n${'─'.repeat(64)}`);
			console.log(message.subtype === 'success' ? '✅ HOÀN TẤT' : `⚠️  Kết thúc (${message.subtype})`);
			console.log(`   Tool calls: ${toolCount} · Lượt: ${message.num_turns ?? '?'} · Chi phí: ${cost}`);
			console.log(`\n👉 Mở trong trình duyệt:\n   ${join(workspace, 'index.html')}\n`);
		}
	}
} catch (err) {
	console.error('\n❌ Lỗi:', err?.message || err);
	process.exit(1);
}
