import { App, PluginSettingTab, Setting, Notice, TFolder } from 'obsidian';
import GeminiSyncPlugin from './main';

export interface FileSyncData {
	uri: string;
	hash: string;
	lastSynced: number;
	status: 'synced' | 'pending' | 'error';
}

export interface GeminiSyncSettings {
	apiKey: string;
	model: string;
	syncFolders: string[];
	syncFolder?: string; // Legacy setting migrated on load.
	workspaceFolder: string;
	monthlyBudgetUsd: number;
	estimatedMonthlySpendUsd: number;
	agentCliPath: string;
	agentPermissionMode: 'review' | 'auto' | 'yolo';
	agentTimeoutSeconds: number;
	agentEnvironment: string;
	corpusName: string;
	corpusDisplayName: string;
	autoSync: boolean;
	syncDebounceMs: number;
	files: Record<string, FileSyncData>;
	// Apply to Note settings
	includeMetadata: boolean;
}

export const DEFAULT_SETTINGS: GeminiSyncSettings = {
	apiKey: '',
	model: 'gemini-2.5-flash',
	syncFolders: [],
	workspaceFolder: '_omg',
	monthlyBudgetUsd: 7,
	estimatedMonthlySpendUsd: 0,
	agentCliPath: 'agy',
	agentPermissionMode: 'review',
	agentTimeoutSeconds: 180,
	agentEnvironment: '',
	corpusName: '',
	corpusDisplayName: 'Obsidian Vault',
	autoSync: true,
	syncDebounceMs: 3000,
	files: {},
	// Apply to Note settings
	includeMetadata: true
};

export class GeminiSyncSettingTab extends PluginSettingTab {
	plugin: GeminiSyncPlugin;

	constructor(app: App, plugin: GeminiSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h1', { text: 'Master of Knowledge Settings' });

		// API Key Section
		containerEl.createEl('h2', { text: 'API Configuration' });

		new Setting(containerEl)
			.setName('Gemini API Key')
			.setDesc('Enter your Google Gemini API key. Get one from Google AI Studio.')
			.addText(text => text
				.setPlaceholder('Enter your API key')
				.setValue(this.plugin.settings.apiKey ? '••••••••••••••••' : '')
				.onChange(async (value) => {
					if (value && !value.includes('•')) {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}
				})
				.inputEl.type = 'password'
			)
			.addButton(button => button
				.setButtonText('Verify')
				.onClick(async () => {
					if (!this.plugin.settings.apiKey) {
						new Notice('Please enter an API key first');
						return;
					}
					button.setButtonText('Verifying...');
					const isValid = await this.plugin.geminiService.verifyApiKey();
					if (isValid) {
						new Notice('API key is valid!');
						button.setButtonText('Verified ✓');
					} else {
						new Notice('Invalid API key. Please check and try again.');
						button.setButtonText('Verify');
					}
				})
			);

		new Setting(containerEl)
			.setName('Gemini Model')
			.setDesc('Select the Gemini model to use for chat. Gemini 3.5 Flash is recommended for best performance.')
			.addDropdown(dropdown => {
				dropdown.addOption('gemini-3.5-flash', 'Gemini 3.5 Flash (Recommended)');
				dropdown.addOption('gemini-3-flash-preview', 'Gemini 3 Flash Preview');
				dropdown.addOption('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview');
				dropdown.addOption('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite');
				dropdown.addOption('gemini-2.5-flash', 'Gemini 2.5 Flash');
				dropdown.addOption('gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite');
				dropdown.addOption('gemini-2.5-pro', 'Gemini 2.5 Pro');

				dropdown.setValue(this.plugin.settings.model);
				dropdown.onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
					// Refresh Gemini client with new model
					this.plugin.geminiService.refreshClient();
					new Notice(`Model changed to ${value}`);
				});
			});

		// Sync Folder Section
		containerEl.createEl('h2', { text: 'Sync Configuration' });

		const folders = this.getAllFolders();
		const selectedFolders = new Set(this.plugin.settings.syncFolders);

		new Setting(containerEl)
			.setName('Sync Folders')
			.setDesc('Select one or more folders to sync with Gemini. Markdown files in selected folders, including subfolders, will be synced.');

		for (const folder of folders) {
			new Setting(containerEl)
				.setName(folder)
				.addToggle(toggle => toggle
					.setValue(selectedFolders.has(folder))
					.onChange(async (value) => {
						const next = new Set(this.plugin.settings.syncFolders);
						if (value) {
							next.add(folder);
						} else {
							next.delete(folder);
						}
						this.plugin.settings.syncFolders = Array.from(next).sort();
						await this.plugin.saveSettings();
						this.display(); // Refresh to update dashboard
					})
				);
		}

		new Setting(containerEl)
			.setName('Corpus Display Name')
			.setDesc('A friendly name for your knowledge base in Gemini.')
			.addText(text => text
				.setPlaceholder('My Obsidian Vault')
				.setValue(this.plugin.settings.corpusDisplayName)
				.onChange(async (value) => {
					this.plugin.settings.corpusDisplayName = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl('h2', { text: 'Workspace & Budget' });

		new Setting(containerEl)
			.setName('Workspace Folder')
			.setDesc('Generated agent reports, compiled notes, graphs, and logs are saved under this vault folder.')
			.addText(text => text
				.setPlaceholder('_omg')
				.setValue(this.plugin.settings.workspaceFolder)
				.onChange(async (value) => {
					this.plugin.settings.workspaceFolder = value.trim() || '_omg';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Monthly Budget (USD)')
			.setDesc('Soft guardrail shown in the dashboard before larger Gemini or Agent workflows.')
			.addText(text => text
				.setPlaceholder('7')
				.setValue(String(this.plugin.settings.monthlyBudgetUsd))
				.onChange(async (value) => {
					const num = parseFloat(value);
					if (!isNaN(num) && num >= 0) {
						this.plugin.settings.monthlyBudgetUsd = num;
						await this.plugin.saveSettings();
					}
				})
			);

		containerEl.createEl('h2', { text: 'Agent Workspace' });

		new Setting(containerEl)
			.setName('Antigravity CLI Path')
			.setDesc('Path or command used by the Agent tab. Defaults to agy.')
			.addText(text => text
				.setPlaceholder('agy')
				.setValue(this.plugin.settings.agentCliPath)
				.onChange(async (value) => {
					this.plugin.settings.agentCliPath = value.trim() || 'agy';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Agent Permission Mode')
			.setDesc('Review is preview-first. Auto and Yolo are reserved for trusted vault workflows.')
			.addDropdown(dropdown => {
				dropdown.addOption('review', 'Safe / Review');
				dropdown.addOption('auto', 'Auto');
				dropdown.addOption('yolo', 'Yolo');
				dropdown.setValue(this.plugin.settings.agentPermissionMode);
				dropdown.onChange(async (value: 'review' | 'auto' | 'yolo') => {
					this.plugin.settings.agentPermissionMode = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Agent Timeout (seconds)')
			.setDesc('Maximum time to wait for a single agent run.')
			.addText(text => text
				.setPlaceholder('180')
				.setValue(String(this.plugin.settings.agentTimeoutSeconds))
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num >= 30) {
						this.plugin.settings.agentTimeoutSeconds = num;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName('Auto Sync')
			.setDesc('Automatically sync files when they are created, modified, or deleted.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Sync Debounce (ms)')
			.setDesc('Wait time before syncing after a file change. Helps reduce API calls during rapid edits.')
			.addText(text => text
				.setPlaceholder('3000')
				.setValue(String(this.plugin.settings.syncDebounceMs))
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num >= 0) {
						this.plugin.settings.syncDebounceMs = num;
						await this.plugin.saveSettings();
					}
				})
			);

		// Dashboard Section
		containerEl.createEl('h2', { text: 'Sync Dashboard' });

		const dashboardEl = containerEl.createDiv({ cls: 'gemini-sync-dashboard' });
		this.renderDashboard(dashboardEl);

		// Sync Actions
		containerEl.createEl('h2', { text: 'Actions' });

		new Setting(containerEl)
			.setName('Force Full Sync')
			.setDesc('Re-sync all files in the sync folder. Use this if sync status seems incorrect.')
			.addButton(button => button
				.setButtonText('Sync Now')
				.setCta()
				.onClick(async () => {
					if (!this.plugin.settings.apiKey) {
						new Notice('Please configure your API key first');
						return;
					}
					if (this.plugin.settings.syncFolders.length === 0) {
						new Notice('Please select at least one sync folder first');
						return;
					}
					button.setButtonText('Syncing...');
					button.setDisabled(true);
					try {
						await this.plugin.syncEngine.fullSync();
						new Notice('Full sync completed!');
						this.display(); // Refresh dashboard
					} catch (error) {
						new Notice('Sync failed. Check console for details.');
						console.error('Sync error:', error);
					} finally {
						button.setButtonText('Sync Now');
						button.setDisabled(false);
					}
				})
			);

		new Setting(containerEl)
			.setName('Clear Sync Data')
			.setDesc('Remove all local sync mappings. Does NOT delete files from Gemini.')
			.addButton(button => button
				.setButtonText('Clear')
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.files = {};
					this.plugin.settings.corpusName = '';
					await this.plugin.saveSettings();
					new Notice('Sync data cleared');
					this.display();
				})
			);

		// Apply to Note Section
		containerEl.createEl('h2', { text: 'Apply to Note' });

		new Setting(containerEl)
			.setName('Include Metadata')
			.setDesc('Add date and source information when inserting AI responses into notes.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.includeMetadata)
				.onChange(async (value) => {
					this.plugin.settings.includeMetadata = value;
					await this.plugin.saveSettings();
				})
			);

		// Help Section
		containerEl.createEl('h2', { text: 'Help' });

		const helpEl = containerEl.createDiv({ cls: 'gemini-sync-help' });
		helpEl.createEl('p', {
			text: 'Master of Knowledge combines Gemini File Search, an Obsidian-native dashboard, and optional Antigravity agent workflows.'
		});
		helpEl.createEl('p', {
			text: '⚠️ Note: Using this plugin may incur costs on your Google Cloud account depending on usage.'
		});
		helpEl.createEl('a', {
			text: 'Get API Key from Google AI Studio',
			href: 'https://aistudio.google.com/app/apikey'
		});
	}

	getAllFolders(): string[] {
		const folders: string[] = [];
		const rootFolder = this.app.vault.getRoot();

		const collectFolders = (folder: TFolder, path: string = '') => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					const fullPath = path ? `${path}/${child.name}` : child.name;
					folders.push(fullPath);
					collectFolders(child, fullPath);
				}
			}
		};

		collectFolders(rootFolder);
		folders.sort();
		return folders;
	}

	renderDashboard(container: HTMLElement) {
		const files = this.plugin.settings.files;
		const fileCount = Object.keys(files).length;

		let syncedCount = 0;
		let pendingCount = 0;
		let errorCount = 0;

		for (const path in files) {
			const status = files[path].status;
			if (status === 'synced') syncedCount++;
			else if (status === 'pending') pendingCount++;
			else if (status === 'error') errorCount++;
		}

		const statsEl = container.createDiv({ cls: 'sync-stats' });

		statsEl.createEl('div', {
			cls: 'sync-stat',
			text: `📁 Total Files: ${fileCount}`
		});
		statsEl.createEl('div', {
			cls: 'sync-stat sync-stat-success',
			text: `🟢 Synced: ${syncedCount}`
		});
		statsEl.createEl('div', {
			cls: 'sync-stat sync-stat-pending',
			text: `🟡 Pending: ${pendingCount}`
		});
		statsEl.createEl('div', {
			cls: 'sync-stat sync-stat-error',
			text: `🔴 Errors: ${errorCount}`
		});

		if (this.plugin.settings.corpusName) {
			container.createEl('div', {
				cls: 'sync-corpus-info',
				text: `Corpus: ${this.plugin.settings.corpusDisplayName}`
			});
		}

		// Show sync folder info
		if (this.plugin.settings.syncFolders.length > 0) {
			const folders = this.plugin.settings.syncFolders;
			const folderText = folders.length > 5
				? `${folders.slice(0, 5).join(', ')} +${folders.length - 5} more`
				: folders.join(', ');
			container.createEl('div', {
				cls: 'sync-folder-info',
				text: `Watching: ${folderText}`
			});
		}
	}
}
