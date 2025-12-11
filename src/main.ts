import { Plugin, WorkspaceLeaf, TFile, TAbstractFile, Notice } from 'obsidian';
import { GeminiSyncSettings, DEFAULT_SETTINGS, GeminiSyncSettingTab } from './settings';
import { GeminiService } from './gemini-service';
import { SyncEngine } from './sync-engine';
import { ChatView, CHAT_VIEW_TYPE } from './chat-view';

export default class GeminiSyncPlugin extends Plugin {
	settings: GeminiSyncSettings;
	geminiService: GeminiService;
	syncEngine: SyncEngine;
	statusBarItem: HTMLElement;

	async onload() {
		console.log('Loading Gemini Sync Plugin');

		// Load settings
		await this.loadSettings();

		// Initialize services
		this.geminiService = new GeminiService(this);
		this.syncEngine = new SyncEngine(this, this.geminiService);

		// Register chat view
		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf) => new ChatView(leaf, this)
		);

		// Add ribbon icon for chat
		this.addRibbonIcon('message-square', 'Open Gemini Chat', () => {
			this.activateChatView();
		});

		// Add settings tab
		this.addSettingTab(new GeminiSyncSettingTab(this.app, this));

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar('Ready');

		// Register file events if API key is configured
		if (this.settings.apiKey) {
			this.registerFileEvents();
		}

		// Add command to open chat
		this.addCommand({
			id: 'open-gemini-chat',
			name: 'Open Gemini Chat',
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
		if (this.settings.apiKey && this.settings.syncFolder) {
			// Delay initial sync to let vault fully load
			setTimeout(() => {
				this.syncEngine.initialSync();
			}, 2000);
		}
	}

	onunload() {
		console.log('Unloading Gemini Sync Plugin');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	registerFileEvents() {
		// File created
		this.registerEvent(
			this.app.vault.on('create', async (file: TAbstractFile) => {
				if (file instanceof TFile && this.shouldSync(file)) {
					console.log('File created:', file.path);
					await this.syncEngine.handleFileCreate(file);
				}
			})
		);

		// File modified
		this.registerEvent(
			this.app.vault.on('modify', async (file: TAbstractFile) => {
				if (file instanceof TFile && this.shouldSync(file)) {
					console.log('File modified:', file.path);
					await this.syncEngine.handleFileModify(file);
				}
			})
		);

		// File deleted
		this.registerEvent(
			this.app.vault.on('delete', async (file: TAbstractFile) => {
				if (file instanceof TFile && this.shouldSync(file)) {
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

					if (wasInSyncFolder || isInSyncFolder) {
						console.log('File renamed:', oldPath, '->', file.path);
						await this.syncEngine.handleFileRename(file, oldPath);
					}
				}
			})
		);
	}

	shouldSync(file: TFile): boolean {
		if (!this.settings.syncFolder) return false;
		if (file.extension !== 'md') return false;
		return this.isInSyncFolder(file.path);
	}

	isInSyncFolder(path: string): boolean {
		if (!this.settings.syncFolder) return false;
		return path.startsWith(this.settings.syncFolder);
	}

	updateStatusBar(status: string) {
		this.statusBarItem.setText(`Gemini: ${status}`);
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
