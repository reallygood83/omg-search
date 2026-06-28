import { Notice, TFile } from 'obsidian';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, isAbsolute, join } from 'path';
import GeminiSyncPlugin from './main';

export interface AgentRunResult {
	content: string;
	command: string;
	exitCode: number | null;
	durationMs: number;
	logPath?: string;
	agyLogPath?: string;
	contextStats?: AgentContextStats;
}

interface AgentLogRef {
	vaultPath: string;
	agyVaultPath: string;
	agyAbsolutePath: string;
}

export interface AgentContextStats {
	totalSyncedNotes: number;
	loadedExcerptNotes: number;
	contextChars: number;
	truncatedByBudget: boolean;
	loadedPaths: string[];
}

export class AgentService {
	private activeChild: ChildProcessWithoutNullStreams | null = null;
	private stopWasRequested = false;
	private lastContextStats: AgentContextStats | null = null;

	constructor(private plugin: GeminiSyncPlugin) {}

	stop() {
		if (!this.activeChild) return false;
		this.stopWasRequested = true;
		this.activeChild.kill();
		this.activeChild = null;
		return true;
	}

	async run(prompt: string, onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void): Promise<AgentRunResult> {
		const started = Date.now();
		const command = this.plugin.settings.agentCliPath.trim() || 'agy';
		const agentPrompt = await this.buildPrompt(prompt);
		const timeoutSeconds = Math.max(30, this.plugin.settings.agentTimeoutSeconds || 60);
		const resolvedCommand = this.resolveCommand(command);
		const logRef = await this.createAgentLog(prompt, resolvedCommand || command, timeoutSeconds);
		const args = this.buildArgs(agentPrompt, timeoutSeconds, logRef.agyAbsolutePath);
		await this.appendAgentLog(logRef.vaultPath, {
			event: 'command',
			command: resolvedCommand || command,
			args: this.redactArgsForLog(args),
			vaultPath: this.plugin.getVaultPath()
		});

		try {
			if (!resolvedCommand) {
				throw Object.assign(new Error(this.getMissingCommandMessage(command)), {
					code: 'ENOENT'
				});
			}
			const { stdout, stderr } = await this.exec(resolvedCommand, args, logRef.vaultPath, onChunk);
			const output = [stdout.trim(), stderr.trim() ? `\n\n---\nAgent stderr:\n${stderr.trim()}` : '']
				.join('')
				.trim();
			await this.appendAgentLog(logRef.vaultPath, {
				event: 'complete',
				exitCode: 0,
				durationMs: Date.now() - started
			});
			return {
				content: output || 'Agent completed without text output.',
				command: `${resolvedCommand} --print`,
				exitCode: 0,
				durationMs: Date.now() - started,
				logPath: logRef.vaultPath,
				agyLogPath: logRef.agyVaultPath,
				contextStats: this.lastContextStats || undefined
			};
		} catch (error: any) {
			if (error?.code === 'EAGENTSTOPPED') {
				await this.appendAgentLog(logRef.vaultPath, {
					event: 'stopped',
					durationMs: Date.now() - started
				});
				return {
					content: 'Agent run stopped by user.',
					command: `${resolvedCommand || command} --print`,
					exitCode: null,
					durationMs: Date.now() - started,
					logPath: logRef.vaultPath,
					agyLogPath: logRef.agyVaultPath,
					contextStats: this.lastContextStats || undefined
				};
			}
			const stdout = String(error?.stdout || '').trim();
			const stderr = String(error?.stderr || '').trim();
			const message = stderr || stdout || error?.message || 'Unknown agent error';
			await this.appendAgentLog(logRef.vaultPath, {
				event: 'failed',
				errorCode: error?.code ?? null,
				message,
				durationMs: Date.now() - started
			});
			new Notice('Agent run failed. Check the result card for details.');
			return {
				content: `Agent run failed.\n\n${message}`,
				command: `${resolvedCommand || command} --print`,
				exitCode: typeof error?.code === 'number' ? error.code : null,
				durationMs: Date.now() - started,
				logPath: logRef.vaultPath,
				agyLogPath: logRef.agyVaultPath,
				contextStats: this.lastContextStats || undefined
			};
		}
	}

	private buildArgs(agentPrompt: string, timeoutSeconds: number, agyLogPath: string): string[] {
		const args = [
			'--add-dir',
			this.plugin.getVaultPath(),
			'--log-file',
			agyLogPath,
			'--print-timeout',
			`${timeoutSeconds}s`
		];

		if (this.plugin.settings.agentPermissionMode === 'auto' ||
			this.plugin.settings.agentPermissionMode === 'yolo') {
			args.push('--dangerously-skip-permissions');
		}

		args.push('--print', agentPrompt);
		return args;
	}

	private async buildPrompt(prompt: string): Promise<string> {
		const activeFile = this.plugin.app.workspace.getActiveFile();
		const workspaceFolder = this.plugin.settings.workspaceFolder;
		const trustMode = this.plugin.settings.agentPermissionMode;
		const scope = this.plugin.settings.syncFolders.join(', ') || 'No sync folders selected';
		const webSearch = this.plugin.settings.agentWebSearchEnabled;
		const syncedNotes = await this.buildSyncedNotesContext(prompt);
		this.lastContextStats = syncedNotes.stats;
		let activeNoteContent = '';
		if (activeFile) {
			try {
				const content = await this.plugin.app.vault.read(activeFile);
				activeNoteContent = content.length > 6000
					? `${content.slice(0, 6000)}\n...[active note truncated]`
					: content;
			} catch {
				activeNoteContent = '';
			}
		}

		return [
			'You are running inside the Master of Knowledge Obsidian plugin.',
			`Vault workspace path: ${this.plugin.getVaultPath()}.`,
			`Trust mode: ${trustMode}.`,
			`Web search mode: ${webSearch ? 'enabled' : 'disabled'}.`,
			`Workspace folder for generated artifacts: ${workspaceFolder}.`,
			`Selected knowledge folders: ${scope}.`,
			activeFile ? `Active note path: ${activeFile.path}.` : 'No active note is open.',
			activeNoteContent ? `Active note content excerpt:\n${activeNoteContent}` : '',
			`Total synced notes available in selected folders: ${syncedNotes.stats.totalSyncedNotes}.`,
			`Direct excerpts loaded into this prompt: ${syncedNotes.stats.loadedExcerptNotes}.`,
			'The excerpts below are a relevance-ranked working set, not the complete knowledge base. Do not describe the total knowledge base as only the excerpt count.',
			'Use the loaded excerpts first, and use the vault workspace path plus selected knowledge folders when you need to inspect more notes.',
			'Synced note excerpts loaded for this request. Cite note paths when you use them:',
			syncedNotes.context,
			webSearch
				? 'Use web search when current external information would improve the answer, and return markdown with clear web and vault sources.'
				: 'Do not use web search unless the user explicitly asks for it in the prompt. Prefer vault evidence.',
			'Answer primarily from the synced notes context. If the answer is not supported by synced notes, say so clearly.',
			'Do not modify user notes directly unless the prompt explicitly asks for it. Prefer a preview-ready result.',
			'',
			'User request:',
			prompt
		].join('\n');
	}

	private async buildSyncedNotesContext(prompt: string): Promise<{ context: string; stats: AgentContextStats }> {
		const contexts: string[] = [];
		let totalLength = 0;
		const maxTotalLength = 24000;
		const candidates = await this.getRankedSyncedFiles(prompt);
		let truncatedByBudget = false;

		for (const file of candidates) {
			try {
				const content = await this.plugin.app.vault.read(file);
				const truncated = content.length > 1800
					? `${content.slice(0, 1800)}...[truncated]`
					: content;
				const block = `--- ${file.path} ---\n${truncated}\n`;
				if (totalLength + block.length > maxTotalLength) {
					truncatedByBudget = true;
					break;
				}
				contexts.push(block);
				totalLength += block.length;
			} catch (error) {
				console.warn(`Failed to read synced note for Agent context: ${file.path}`, error);
			}
		}

		const stats = {
			totalSyncedNotes: candidates.length,
			loadedExcerptNotes: contexts.length,
			contextChars: totalLength,
			truncatedByBudget,
			loadedPaths: contexts
				.map(block => block.match(/^--- (.+?) ---/)?.[1])
				.filter((path): path is string => !!path)
		};

		return {
			context: contexts.join('\n') || 'No synced notes are available in the selected sync folders.',
			stats
		};
	}

	private async getRankedSyncedFiles(prompt: string): Promise<TFile[]> {
		const files = this.getSyncedMarkdownFiles();
		const tokens = this.tokenize(prompt);
		if (tokens.length === 0) return files;

		const scored: { file: TFile; score: number }[] = [];
		for (const file of files) {
			try {
				const content = await this.plugin.app.vault.read(file);
				const haystack = `${file.basename}\n${file.path}\n${content.slice(0, 4000)}`.toLowerCase();
				let score = 0;
				for (const token of tokens) {
					if (file.basename.toLowerCase().includes(token)) score += 10;
					if (file.path.toLowerCase().includes(token)) score += 6;
					score += Math.min(haystack.split(token).length - 1, 8);
				}
				scored.push({ file, score });
			} catch {
				scored.push({ file, score: 0 });
			}
		}

		return scored
			.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
			.map(item => item.file);
	}

	private getSyncedMarkdownFiles(): TFile[] {
		const files: TFile[] = [];
		for (const path in this.plugin.settings.files) {
			const syncData = this.plugin.settings.files[path];
			if (syncData.status !== 'synced') continue;
			if (!this.plugin.isInSyncFolder(path)) continue;

			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === 'md') {
				files.push(file);
			}
		}
		return files;
	}

	private tokenize(text: string): string[] {
		const stopTokens = new Set([
			'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'your',
			'are', 'was', 'were', 'have', 'has', 'not', 'can', 'will',
			'대한', '관련', '작성', '내용', '노트', '활용', '사용자', '초안',
			'있습니다', '합니다', '위한', '에게', '에서', '으로', '그리고'
		]);
		const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
		const tokens = new Set<string>();
		for (const raw of normalized.split(/\s+/)) {
			const token = raw.trim();
			if (token.length < 2) continue;
			if (/^\d+$/.test(token)) continue;
			if (stopTokens.has(token)) continue;
			tokens.add(token);
			if (tokens.size >= 32) break;
		}
		return Array.from(tokens);
	}

	private exec(
		command: string,
		args: string[],
		logPath: string,
		onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void
	): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			let stdout = '';
			let stderr = '';
			let settled = false;
			const maxBuffer = 1024 * 1024 * 8;
			const timeoutMs = Math.max(30_000, this.plugin.settings.agentTimeoutSeconds * 1000);
			const child = spawn(command, args, {
				cwd: this.plugin.getVaultPath(),
				env: {
					...process.env,
					...this.parseEnv(this.plugin.settings.agentEnvironment)
				},
				shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
				windowsHide: true
			});
			this.activeChild = child;
			child.stdin.end();
			void this.appendAgentLog(logPath, {
				event: 'spawn',
				pid: child.pid ?? null,
				stdinClosed: true
			});

			const timer = window.setTimeout(() => {
				settled = true;
				child.kill();
				if (this.activeChild === child) this.activeChild = null;
				void this.appendAgentLog(logPath, {
					event: 'timeout',
					timeoutMs,
					stdoutLength: stdout.length,
					stderrLength: stderr.length
				});
				reject(Object.assign(new Error(`Agent timed out after ${Math.round(timeoutMs / 1000)}s`), {
					code: 'ETIMEDOUT',
					stdout,
					stderr
				}));
			}, timeoutMs);

			child.stdout?.on('data', (data: Buffer) => {
				const chunk = data.toString();
				stdout += chunk;
				onChunk?.(chunk, 'stdout');
				void this.appendAgentLog(logPath, { event: 'stdout', chunk });
				if (stdout.length + stderr.length > maxBuffer) {
					void this.appendAgentLog(logPath, { event: 'max_buffer', maxBuffer });
					child.kill();
				}
			});

			child.stderr?.on('data', (data: Buffer) => {
				const chunk = data.toString();
				stderr += chunk;
				onChunk?.(chunk, 'stderr');
				void this.appendAgentLog(logPath, { event: 'stderr', chunk });
				if (stdout.length + stderr.length > maxBuffer) {
					void this.appendAgentLog(logPath, { event: 'max_buffer', maxBuffer });
					child.kill();
				}
			});

			child.on('error', (error) => {
				if (settled) return;
				settled = true;
				if (this.activeChild === child) this.activeChild = null;
				window.clearTimeout(timer);
				void this.appendAgentLog(logPath, {
					event: 'error',
					message: error.message,
					stdoutLength: stdout.length,
					stderrLength: stderr.length
				});
				if (this.stopWasRequested) {
					this.stopWasRequested = false;
					reject(Object.assign(new Error('Agent run stopped by user.'), {
						code: 'EAGENTSTOPPED',
						stdout,
						stderr
					}));
					return;
				}
				reject(Object.assign(error, { stdout, stderr }));
			});

			child.on('close', (code) => {
				if (settled) return;
				settled = true;
				if (this.activeChild === child) this.activeChild = null;
				window.clearTimeout(timer);
				void this.appendAgentLog(logPath, {
					event: 'close',
					exitCode: code,
					stdoutLength: stdout.length,
					stderrLength: stderr.length
				});
				if (this.stopWasRequested) {
					this.stopWasRequested = false;
					reject(Object.assign(new Error('Agent run stopped by user.'), {
						code: 'EAGENTSTOPPED',
						stdout,
						stderr
					}));
					return;
				}
				if (code === 0) {
					resolve({ stdout, stderr });
					return;
				}
				reject(Object.assign(new Error(`Agent exited with code ${code ?? 'unknown'}`), {
					code,
					stdout,
					stderr
				}));
			});
		});
	}

	private async createAgentLog(prompt: string, command: string, timeoutSeconds: number): Promise<AgentLogRef> {
		const folder = await this.plugin.ensureWorkspaceFolder('logs');
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const vaultPath = `${folder}/agent-${stamp}.jsonl`;
		const agyVaultPath = `${folder}/agent-${stamp}.agy.log`;
		const agyAbsolutePath = join(this.plugin.getVaultPath(), agyVaultPath);
		const initial = {
			event: 'start',
			timestamp: new Date().toISOString(),
			command,
			timeoutSeconds,
			permissionMode: this.plugin.settings.agentPermissionMode,
			webSearchEnabled: this.plugin.settings.agentWebSearchEnabled,
			syncFolders: this.plugin.settings.syncFolders,
			contextStats: this.lastContextStats,
			promptPreview: prompt.length > 500 ? `${prompt.slice(0, 500)}...[truncated]` : prompt,
			agyLogPath: agyVaultPath
		};

		await this.plugin.app.vault.create(vaultPath, `${JSON.stringify(initial)}\n`);
		return { vaultPath, agyVaultPath, agyAbsolutePath };
	}

	private async appendAgentLog(path: string, event: Record<string, unknown>) {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			await this.plugin.app.vault.append(file, `${JSON.stringify({
				timestamp: new Date().toISOString(),
				...event
			})}\n`);
		} catch (error) {
			console.warn('Failed to append Agent log:', error);
		}
	}

	private redactArgsForLog(args: string[]): string[] {
		const redacted = [...args];
		const printIndex = redacted.findIndex(arg => arg === '--print' || arg === '-p' || arg === '--prompt');
		if (printIndex >= 0 && printIndex + 1 < redacted.length) {
			redacted[printIndex + 1] = `[prompt omitted: ${redacted[printIndex + 1].length} chars]`;
		}
		return redacted;
	}

	private parseEnv(raw: string): Record<string, string> {
		const env: Record<string, string> = {};
		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const idx = trimmed.indexOf('=');
			if (idx <= 0) continue;
			env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
		}
		return env;
	}

	private resolveCommand(command: string): string | null {
		if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
			return existsSync(command) ? command : null;
		}

		const paths = [
			...(process.env.PATH || '').split(delimiter),
			join(homedir(), '.local', 'bin'),
			join(homedir(), '.antigravity', 'antigravity', 'bin'),
			join(homedir(), '.antigravity-ide', 'antigravity-ide', 'bin'),
			'/opt/homebrew/bin',
			'/usr/local/bin',
			'/usr/bin',
			'/bin'
		].filter(Boolean);
		const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];

		for (const dir of paths) {
			for (const ext of extensions) {
				const candidate = join(dir, `${command}${ext}`);
				if (existsSync(candidate)) return candidate;
			}
		}
		return null;
	}

	private getMissingCommandMessage(command: string): string {
		return [
			`Could not find the Agent CLI command "${command}".`,
			'If Obsidian was opened from Finder, Dock, or Start Menu, it may not inherit your shell PATH.',
			'Open Settings > Master of Knowledge > Agent Workspace and set Antigravity CLI Path to the full command path.',
			`On this Mac it is often: ${homedir()}/.local/bin/agy`
		].join('\n');
	}
}
