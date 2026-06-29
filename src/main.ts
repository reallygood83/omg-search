import { Plugin, WorkspaceLeaf, TFile, TAbstractFile, Notice } from 'obsidian';
import { GeminiSyncSettings, DEFAULT_SETTINGS, GeminiSyncSettingTab } from './settings';
import { GeminiService } from './gemini-service';
import { SyncEngine } from './sync-engine';
import { ChatView, CHAT_VIEW_TYPE } from './chat-view';
import { AgentService } from './agent-service';

export interface BudgetUsageEvent {
	type: 'chat';
	model: string;
	inputTokens: number;
	outputTokens: number;
	estimatedCostUsd: number;
	success?: boolean;
}

export default class GeminiSyncPlugin extends Plugin {
	settings: GeminiSyncSettings;
	geminiService: GeminiService;
	syncEngine: SyncEngine;
	agentService: AgentService;
	statusBarItem: HTMLElement;

	async onload() {
		console.log('Loading Master of Knowledge Plugin');

		// Load settings
		await this.loadSettings();

		// Initialize services
		this.geminiService = new GeminiService(this);
		this.syncEngine = new SyncEngine(this, this.geminiService);
		this.agentService = new AgentService(this);
		await this.ensureDefaultWorkspaceFolders();

		// Register chat view
		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf) => new ChatView(leaf, this)
		);

		// Add ribbon icon for chat
		this.addRibbonIcon('brain-circuit', 'Open Master of Knowledge', () => {
			this.activateChatView();
		});

		// Add settings tab
		this.addSettingTab(new GeminiSyncSettingTab(this.app, this));

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar('Ready');

		// Register file events immediately so auto-sync starts working after
		// the user configures an API key without requiring a plugin reload.
		this.registerFileEvents();

		// Add command to open chat
		this.addCommand({
			id: 'open-gemini-chat',
			name: 'Open Master of Knowledge',
			callback: () => {
				this.activateChatView();
			}
		});

		// Add command to force sync
		this.addCommand({
			id: 'force-sync-all',
			name: 'Force Sync All Files',
			callback: async () => {
				if (!this.settings.apiKey) {
					new Notice('Please configure your Gemini API key first');
					return;
				}
				await this.syncEngine.fullSync();
			}
		});

		// Initial sync on load (if configured)
		if (this.settings.apiKey && this.settings.syncFolders.length > 0) {
			// Delay initial sync to let vault fully load
			setTimeout(() => {
				this.syncEngine.initialSync();
			}, 2000);
		}
	}

	onunload() {
		console.log('Unloading Master of Knowledge Plugin');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		const configuredFolders = Array.isArray(this.settings.syncFolders)
			? this.settings.syncFolders
			: [];
		this.settings.syncFolders = Array.from(new Set([
			...(this.settings.syncFolder ? [this.settings.syncFolder] : []),
			...configuredFolders
		].filter(folder => folder.trim().length > 0))).sort();
		delete this.settings.syncFolder;
		this.settings.workspaceFolder = this.normalizeFolder(
			this.settings.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder,
			DEFAULT_SETTINGS.workspaceFolder
		);
		this.settings.agentOutputFolder = this.normalizeFolder(
			this.settings.agentOutputFolder || `${this.settings.workspaceFolder}/agent`,
			`${this.settings.workspaceFolder}/agent`
		);
		this.settings.monthlyBudgetUsd = Number.isFinite(this.settings.monthlyBudgetUsd) ? this.settings.monthlyBudgetUsd : DEFAULT_SETTINGS.monthlyBudgetUsd;
		this.settings.estimatedMonthlySpendUsd = Number.isFinite(this.settings.estimatedMonthlySpendUsd) ? this.settings.estimatedMonthlySpendUsd : DEFAULT_SETTINGS.estimatedMonthlySpendUsd;
		this.settings.estimatedMonthlySpendMonth = this.settings.estimatedMonthlySpendMonth || this.getCurrentBudgetMonth();
		if (this.settings.estimatedMonthlySpendMonth !== this.getCurrentBudgetMonth()) {
			this.settings.estimatedMonthlySpendMonth = this.getCurrentBudgetMonth();
			this.settings.estimatedMonthlySpendUsd = 0;
		}
		this.settings.agentCliPath = this.settings.agentCliPath || DEFAULT_SETTINGS.agentCliPath;
		this.settings.agentModel = this.settings.agentModel || DEFAULT_SETTINGS.agentModel;
		this.settings.agentPermissionMode = this.settings.agentPermissionMode || DEFAULT_SETTINGS.agentPermissionMode;
		this.settings.agentTimeoutSeconds = this.settings.agentTimeoutSeconds || DEFAULT_SETTINGS.agentTimeoutSeconds;
		this.settings.agentEnvironment = this.settings.agentEnvironment || DEFAULT_SETTINGS.agentEnvironment;
		this.settings.agentWebSearchEnabled = typeof this.settings.agentWebSearchEnabled === 'boolean'
			? this.settings.agentWebSearchEnabled
			: DEFAULT_SETTINGS.agentWebSearchEnabled;
		this.settings.agentUseObsidianSkill = typeof this.settings.agentUseObsidianSkill === 'boolean'
			? this.settings.agentUseObsidianSkill
			: DEFAULT_SETTINGS.agentUseObsidianSkill;
		this.settings.agentObsidianSkillPath = this.normalizeFolder(
			this.settings.agentObsidianSkillPath || DEFAULT_SETTINGS.agentObsidianSkillPath,
			DEFAULT_SETTINGS.agentObsidianSkillPath
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Update chat view if it's open
		this.updateChatViewSyncStatus();
	}

	async recordBudgetUsage(event: BudgetUsageEvent) {
		const month = this.getCurrentBudgetMonth();
		if (this.settings.estimatedMonthlySpendMonth !== month) {
			this.settings.estimatedMonthlySpendMonth = month;
			this.settings.estimatedMonthlySpendUsd = 0;
		}

		this.settings.estimatedMonthlySpendUsd = Number((
			(this.settings.estimatedMonthlySpendUsd || 0) + event.estimatedCostUsd
		).toFixed(6));
		await this.saveSettings();

		const logEntry = {
			timestamp: new Date().toISOString(),
			month,
			...event,
			monthlyBudgetUsd: this.settings.monthlyBudgetUsd,
			estimatedMonthlySpendUsd: this.settings.estimatedMonthlySpendUsd
		};

		try {
			const folder = await this.ensureWorkspaceFolder('logs');
			const filePath = `${folder}/budget-${month}.jsonl`;
			const line = `${JSON.stringify(logEntry)}\n`;
			const existing = this.app.vault.getAbstractFileByPath(filePath);
			if (existing instanceof TFile) {
				await this.app.vault.append(existing, line);
			} else {
				await this.app.vault.create(filePath, line);
			}
		} catch (error) {
			console.warn('Failed to write budget usage log:', error);
		}
	}

	estimateGeminiCost(model: string, inputTokens: number, outputTokens: number): number {
		const rates = this.getEstimatedGeminiRates(model);
		return Number((
			(inputTokens / 1_000_000) * rates.inputUsdPerMillion +
			(outputTokens / 1_000_000) * rates.outputUsdPerMillion
		).toFixed(6));
	}

	estimateTokens(text: string): number {
		return Math.max(1, Math.ceil(text.length / 4));
	}

	getCurrentBudgetMonth(): string {
		return new Date().toISOString().slice(0, 7);
	}

	private getEstimatedGeminiRates(model: string): { inputUsdPerMillion: number; outputUsdPerMillion: number } {
		if (model.includes('lite')) return { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
		if (model.includes('pro')) return { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 };
		return { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 };
	}

	// Update sync status in chat view if it's open
	updateChatViewSyncStatus() {
		const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		if (leaves.length > 0) {
			const chatView = leaves[0].view as ChatView;
			if (chatView && typeof chatView.updateSyncStatus === 'function') {
				chatView.updateSyncStatus();
			}
		}
	}

	registerFileEvents() {
		// File created
		this.registerEvent(
			this.app.vault.on('create', async (file: TAbstractFile) => {
				if (this.settings.apiKey && file instanceof TFile && this.shouldSync(file)) {
					console.log('File created:', file.path);
					await this.syncEngine.handleFileCreate(file);
				}
			})
		);

		// File modified
		this.registerEvent(
			this.app.vault.on('modify', async (file: TAbstractFile) => {
				if (this.settings.apiKey && file instanceof TFile && this.shouldSync(file)) {
					console.log('File modified:', file.path);
					await this.syncEngine.handleFileModify(file);
				}
			})
		);

		// File deleted
		this.registerEvent(
			this.app.vault.on('delete', async (file: TAbstractFile) => {
				if (this.settings.apiKey && file instanceof TFile && this.shouldSync(file)) {
					console.log('File deleted:', file.path);
					await this.syncEngine.handleFileDelete(file);
				}
			})
		);

		// File renamed/moved
		this.registerEvent(
			this.app.vault.on('rename', async (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile) {
					const wasInSyncFolder = this.isInSyncFolder(oldPath);
					const isInSyncFolder = this.shouldSync(file);

					if (this.settings.apiKey && (wasInSyncFolder || isInSyncFolder)) {
						console.log('File renamed:', oldPath, '->', file.path);
						await this.syncEngine.handleFileRename(file, oldPath);
					}
				}
			})
		);
	}

	shouldSync(file: TFile): boolean {
		if (this.settings.syncFolders.length === 0) return false;
		if (file.extension !== 'md') return false;
		return this.isInSyncFolder(file.path);
	}

	isInSyncFolder(path: string): boolean {
		return this.settings.syncFolders.some(folder =>
			path === folder || path.startsWith(`${folder}/`)
		);
	}

	updateStatusBar(status: string) {
		this.statusBarItem.setText(`MoK: ${status}`);
	}

	getVaultPath(): string {
		const adapter = this.app.vault.adapter as { basePath?: string };
		return adapter.basePath || '/';
	}

	normalizeFolder(folder: string, fallback = '_omg'): string {
		const fallbackPath = (fallback || '_omg')
			.replace(/\\/g, '/')
			.replace(/^\/+|\/+$/g, '') || '_omg';
		let cleaned = (folder || fallbackPath).trim().replace(/\\/g, '/');

		try {
			if (cleaned.startsWith('file://')) {
				cleaned = decodeURIComponent(new URL(cleaned).pathname).replace(/\\/g, '/');
			}
		} catch {
			cleaned = fallbackPath;
		}

		const vaultRoot = this.getVaultPath().replace(/\\/g, '/').replace(/\/+$/g, '');
		if (vaultRoot && cleaned.startsWith(`${vaultRoot}/`)) {
			cleaned = cleaned.slice(vaultRoot.length + 1);
		} else if (cleaned === vaultRoot || cleaned.startsWith('/') || /^[A-Za-z]:\//.test(cleaned)) {
			cleaned = fallbackPath;
		}

		const parts = cleaned
			.replace(/^\/+|\/+$/g, '')
			.split('/')
			.filter(part => part && part !== '.' && part !== '..');
		return parts.join('/') || fallbackPath;
	}

	async ensureWorkspaceFolder(subfolder?: string): Promise<string> {
		const root = this.normalizeFolder(this.settings.workspaceFolder, DEFAULT_SETTINGS.workspaceFolder);
		const path = subfolder ? `${root}/${subfolder}` : root;
		return this.ensureVaultFolder(path);
	}

	async ensureDefaultWorkspaceFolders() {
		await this.ensureWorkspaceFolder('compiled');
		await this.ensureVaultFolder(this.settings.agentOutputFolder || `${this.settings.workspaceFolder}/agent`);
		await this.ensureWorkspaceFolder('graph');
		await this.ensureWorkspaceFolder('inbox');
		await this.ensureWorkspaceFolder('logs');
		await this.ensureWorkspaceFolder('skills');
	}

	async ensureVaultFolder(folder: string): Promise<string> {
		const path = this.normalizeFolder(folder);
		const parts = path.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
		return path;
	}

	async installObsidianWritingSkill(): Promise<string> {
		const skillPath = this.normalizeFolder(
			this.settings.agentObsidianSkillPath || DEFAULT_SETTINGS.agentObsidianSkillPath,
			DEFAULT_SETTINGS.agentObsidianSkillPath
		);
		const folder = skillPath.split('/').slice(0, -1).join('/');
		if (folder) await this.ensureVaultFolder(folder);

		const content = [
			'# Obsidian Writing Skill',
			'',
			'Use this skill whenever the user asks the Agent to write, compile, summarize, or create an Obsidian note.',
			'',
			'## Output Contract',
			'- Write valid Markdown that opens cleanly in Obsidian.',
			'- Prefer clear headings, short paragraphs, tables only when they improve scanning, and actionable checklists.',
			'- Use wiki links like [[Note Title]] only when the target note exists or when creating a deliberate new note.',
			'- Keep generated notes inside the configured Agent output folder.',
			'- When a note file is created, return its vault-relative path and a markdown link to that path.',
			'- Do not claim a file was saved unless the file was actually written.',
			'',
			'## Source Discipline',
			'- Cite vault note paths when using synced note evidence.',
			'- Separate note-grounded claims from general suggestions.',
			'- If evidence is weak or missing, say so plainly.',
			'',
			'## Korean Notes',
			'- If the user writes Korean, answer in natural Korean.',
			'- Avoid stiff translation tone; write as a practical Obsidian note the user can keep.'
		].join('\n');

		const existing = this.app.vault.getAbstractFileByPath(skillPath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(skillPath, content);
		}

		this.settings.agentObsidianSkillPath = skillPath;
		this.settings.agentUseObsidianSkill = true;
		await this.saveSettings();
		return skillPath;
	}

	openPluginSettings() {
		const setting = (this.app as any).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById?.(this.manifest.id);
	}

	async activateChatView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}
}
