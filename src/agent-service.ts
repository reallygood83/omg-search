import { Notice } from 'obsidian';
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
}

export class AgentService {
	private activeChild: ChildProcessWithoutNullStreams | null = null;
	private stopWasRequested = false;

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
		const agentPrompt = this.buildPrompt(prompt);
		const timeoutSeconds = Math.max(30, this.plugin.settings.agentTimeoutSeconds || 60);
		const args = ['--print-timeout', `${timeoutSeconds}s`, '--print', agentPrompt];
		const resolvedCommand = this.resolveCommand(command);

		try {
			if (!resolvedCommand) {
				throw Object.assign(new Error(this.getMissingCommandMessage(command)), {
					code: 'ENOENT'
				});
			}
			const { stdout, stderr } = await this.exec(resolvedCommand, args, onChunk);
			const output = [stdout.trim(), stderr.trim() ? `\n\n---\nAgent stderr:\n${stderr.trim()}` : '']
				.join('')
				.trim();
			return {
				content: output || 'Agent completed without text output.',
				command: `${resolvedCommand} --print`,
				exitCode: 0,
				durationMs: Date.now() - started
			};
		} catch (error: any) {
			if (error?.code === 'EAGENTSTOPPED') {
				return {
					content: 'Agent run stopped by user.',
					command: `${resolvedCommand || command} --print`,
					exitCode: null,
					durationMs: Date.now() - started
				};
			}
			const stdout = String(error?.stdout || '').trim();
			const stderr = String(error?.stderr || '').trim();
			const message = stderr || stdout || error?.message || 'Unknown agent error';
			new Notice('Agent run failed. Check the result card for details.');
			return {
				content: `Agent run failed.\n\n${message}`,
				command: `${resolvedCommand || command} --print`,
				exitCode: typeof error?.code === 'number' ? error.code : null,
				durationMs: Date.now() - started
			};
		}
	}

	private buildPrompt(prompt: string): string {
		const activeFile = this.plugin.app.workspace.getActiveFile();
		const workspaceFolder = this.plugin.settings.workspaceFolder;
		const trustMode = this.plugin.settings.agentPermissionMode;
		const scope = this.plugin.settings.syncFolders.join(', ') || 'No sync folders selected';
		const webSearch = this.plugin.settings.agentWebSearchEnabled;

		return [
			'You are running inside the Master of Knowledge Obsidian plugin.',
			`Trust mode: ${trustMode}.`,
			`Web search mode: ${webSearch ? 'enabled' : 'disabled'}.`,
			`Workspace folder for generated artifacts: ${workspaceFolder}.`,
			`Selected knowledge folders: ${scope}.`,
			activeFile ? `Active note path: ${activeFile.path}.` : 'No active note is open.',
			webSearch
				? 'Use web search when current external information would improve the answer, and return markdown with clear web and vault sources.'
				: 'Do not use web search unless the user explicitly asks for it in the prompt. Prefer vault evidence.',
			'Do not modify user notes directly unless the prompt explicitly asks for it. Prefer a preview-ready result.',
			'',
			'User request:',
			prompt
		].join('\n');
	}

	private exec(
		command: string,
		args: string[],
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

			const timer = window.setTimeout(() => {
				settled = true;
				child.kill();
				if (this.activeChild === child) this.activeChild = null;
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
				if (stdout.length + stderr.length > maxBuffer) child.kill();
			});

			child.stderr?.on('data', (data: Buffer) => {
				const chunk = data.toString();
				stderr += chunk;
				onChunk?.(chunk, 'stderr');
				if (stdout.length + stderr.length > maxBuffer) child.kill();
			});

			child.on('error', (error) => {
				if (settled) return;
				settled = true;
				if (this.activeChild === child) this.activeChild = null;
				window.clearTimeout(timer);
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
