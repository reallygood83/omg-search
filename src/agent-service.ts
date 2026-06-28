import { Notice } from 'obsidian';
import { execFile } from 'child_process';
import GeminiSyncPlugin from './main';

export interface AgentRunResult {
	content: string;
	command: string;
	exitCode: number | null;
	durationMs: number;
}

export class AgentService {
	constructor(private plugin: GeminiSyncPlugin) {}

	async run(prompt: string): Promise<AgentRunResult> {
		const started = Date.now();
		const command = this.plugin.settings.agentCliPath.trim() || 'agy';
		const args = ['--print', this.buildPrompt(prompt)];

		try {
			const { stdout, stderr } = await this.exec(command, args);
			const output = [stdout.trim(), stderr.trim() ? `\n\n---\nAgent stderr:\n${stderr.trim()}` : '']
				.join('')
				.trim();
			return {
				content: output || 'Agent completed without text output.',
				command: `${command} --print`,
				exitCode: 0,
				durationMs: Date.now() - started
			};
		} catch (error: any) {
			const stdout = String(error?.stdout || '').trim();
			const stderr = String(error?.stderr || '').trim();
			const message = stderr || stdout || error?.message || 'Unknown agent error';
			new Notice('Agent run failed. Check the result card for details.');
			return {
				content: `Agent run failed.\n\n${message}`,
				command: `${command} --print`,
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

		return [
			'You are running inside the Master of Knowledge Obsidian plugin.',
			`Trust mode: ${trustMode}.`,
			`Workspace folder for generated artifacts: ${workspaceFolder}.`,
			`Selected knowledge folders: ${scope}.`,
			activeFile ? `Active note path: ${activeFile.path}.` : 'No active note is open.',
			'Return markdown with clear sources when you use web or vault evidence.',
			'Do not modify user notes directly unless the prompt explicitly asks for it. Prefer a preview-ready result.',
			'',
			'User request:',
			prompt
		].join('\n');
	}

	private exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			execFile(
				command,
				args,
				{
					cwd: this.plugin.getVaultPath(),
					env: {
						...process.env,
						...this.parseEnv(this.plugin.settings.agentEnvironment)
					},
					timeout: Math.max(30_000, this.plugin.settings.agentTimeoutSeconds * 1000),
					maxBuffer: 1024 * 1024 * 8
				},
				(error, stdout, stderr) => {
					if (error) {
						reject(Object.assign(error, { stdout, stderr }));
						return;
					}
					resolve({ stdout, stderr });
				}
			);
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
}
