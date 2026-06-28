import { Plugin, WorkspaceLeaf, TFile, TAbstractFile, Notice } from 'obsidian';
import { GeminiSyncSettings, DEFAULT_SETTINGS, GeminiSyncSettingTab } from './settings';
import { GeminiService } from './gemini-service';
import { SyncEngine } from './sync-engine';
import { ChatView, CHAT_VIEW_TYPE } from './chat-view';
import { AgentService } from './agent-service';

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
		this.settings.workspaceFolder = this.normalizeFolder(this.settings.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder);
		this.settings.monthlyBudgetUsd = Number.isFinite(this.settings.monthlyBudgetUsd) ? this.settings.monthlyBudgetUsd : DEFAULT_SETTINGS.monthlyBudgetUsd;
		this.settings.estimatedMonthlySpendUsd = Number.isFinite(this.settings.estimatedMonthlySpendUsd) ? this.settings.estimatedMonthlySpendUsd : DEFAULT_SETTINGS.estimatedMonthlySpendUsd;
		this.settings.agentCliPath = this.settings.agentCliPath || DEFAULT_SETTINGS.agentCliPath;
		this.settings.agentPermissionMode = this.settings.agentPermissionMode || DEFAULT_SETTINGS.agentPermissionMode;
		this.settings.agentTimeoutSeconds = this.settings.agentTimeoutSeconds || DEFAULT_SETTINGS.agentTimeoutSeconds;
		this.settings.agentEnvironment = this.settings.agentEnvironment || DEFAULT_SETTINGS.agentEnvironment;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Update chat view if it's open
		this.updateChatViewSyncStatus();
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

	normalizeFolder(folder: string): string {
		return (folder || '_omg').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '_omg';
	}

	async ensureWorkspaceFolder(subfolder?: string): Promise<string> {
		const root = this.normalizeFolder(this.settings.workspaceFolder);
		const path = subfolder ? `${root}/${subfolder}` : root;
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
