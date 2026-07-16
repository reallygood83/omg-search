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
	agentOutputFolder: string;
	monthlyBudgetUsd: number;
	estimatedMonthlySpendUsd: number;
	estimatedMonthlySpendMonth: string;
	agentCliPath: string;
	agentModel: string;
	agentPermissionMode: 'review' | 'auto' | 'yolo';
	agentTimeoutSeconds: number;
	agentEnvironment: string;
	agentWebSearchEnabled: boolean;
	agentUseObsidianSkill: boolean;
	agentObsidianSkillPath: string;
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
	agentOutputFolder: '_omg/agent',
	monthlyBudgetUsd: 7,
	estimatedMonthlySpendUsd: 0,
	estimatedMonthlySpendMonth: '',
	agentCliPath: 'agy',
	agentModel: '',
	agentPermissionMode: 'review',
	agentTimeoutSeconds: 60,
	agentEnvironment: '',
	agentWebSearchEnabled: false,
	agentUseObsidianSkill: true,
	agentObsidianSkillPath: '_omg/skills/obsidian-writing-skill.md',
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
			.setDesc('Google AI Studio key (often AIza…). Leave Application restrictions = None. Verify checks models AND File Search.')
			.addText(text => text
				.setPlaceholder('Enter your API key')
				.setValue(this.plugin.settings.apiKey ? '••••••••••••••••' : '')
				.onChange(async (value) => {
					if (value && !value.includes('•')) {
						const previous = this.plugin.settings.apiKey;
						const next = value.trim();
						if (next && next !== previous) {
							this.plugin.settings.apiKey = next;
							this.plugin.settings.corpusName = '';
							for (const path of Object.keys(this.plugin.settings.files)) {
								const entry = this.plugin.settings.files[path];
								this.plugin.settings.files[path] = {
									...entry,
									uri: '',
									status: 'pending'
								};
							}
							await this.plugin.saveSettings();
							this.plugin.geminiService.refreshClient();
							new Notice('API key updated. File Search store binding cleared — run Verify, then Sync Now.');
						} else {
							this.plugin.settings.apiKey = next;
							await this.plugin.saveSettings();
							this.plugin.geminiService.refreshClient();
						}
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
					const result = await this.plugin.geminiService.verifyApiKeyDetailed();
					if (result.ok) {
						new Notice(result.message);
						button.setButtonText('Verified ✓');
					} else {
						console.error('[Master of Knowledge] API verify failed:', result);
						new Notice(result.message.slice(0, 280), 12000);
						button.setButtonText('Verify');
					}
				})
			);

		new Setting(containerEl)
			.setName('Reset File Search store binding')
			.setDesc('Clears the saved store id and local sync URIs. Use after changing Google projects/keys or if importFile returns 401.')
			.addButton(button => button
				.setButtonText('Reset store')
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.corpusName = '';
					for (const path of Object.keys(this.plugin.settings.files)) {
						const entry = this.plugin.settings.files[path];
						this.plugin.settings.files[path] = {
							...entry,
							uri: '',
							status: 'pending'
						};
					}
					await this.plugin.saveSettings();
					this.display();
					new Notice('Store binding reset. Run Sync Now to recreate under the current API key.');
				})
			);

		const fileSearchDiagnosticEl = containerEl.createDiv({ cls: 'mok-file-search-diagnostic' });

		new Setting(containerEl)
			.setName('File Search Upload Diagnostic')
			.setDesc('Checks model access, File Search store access, Files API upload, and File Search import. Use this when Sync Dashboard only shows error files.')
			.addButton(button => button
				.setButtonText('Diagnose File Search')
				.onClick(async () => {
					if (!this.plugin.settings.apiKey) {
						new Notice('Please enter an API key first');
						return;
					}
					button.setButtonText('Diagnosing...');
					button.setDisabled(true);
					fileSearchDiagnosticEl.empty();
					fileSearchDiagnosticEl.createEl('p', { text: 'Running File Search upload diagnostic...' });
					try {
						const result = await this.plugin.geminiService.diagnoseFileSearchUpload();
						fileSearchDiagnosticEl.empty();
						fileSearchDiagnosticEl.createEl('strong', {
							text: result.ok ? 'File Search diagnostic passed' : 'File Search diagnostic failed'
						});
						fileSearchDiagnosticEl.createEl('p', {
							text: `Stage: ${result.stage} | Key type: ${result.keyFamily}${result.status ? ` | HTTP ${result.status}` : ''}`
						});
						fileSearchDiagnosticEl.createEl('p', { text: result.message });
						if (result.recommendation) {
							fileSearchDiagnosticEl.createEl('p', { text: `Recommendation: ${result.recommendation}` });
						}
						if (result.detail) {
							fileSearchDiagnosticEl.createEl('pre', { text: result.detail });
						}
						new Notice(result.ok ? 'File Search upload diagnostic passed.' : `File Search diagnostic failed at ${result.stage}.`);
					} catch (error) {
						fileSearchDiagnosticEl.empty();
						fileSearchDiagnosticEl.createEl('strong', { text: 'File Search diagnostic failed unexpectedly' });
						fileSearchDiagnosticEl.createEl('pre', { text: error instanceof Error ? error.message : String(error) });
						new Notice('File Search diagnostic failed. Check the settings panel for details.');
					} finally {
						button.setButtonText('Diagnose File Search');
						button.setDisabled(false);
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

		new Setting(containerEl)
			.setName('Sync Folders')
			.setDesc('Select one or more folders to sync with Gemini. Markdown files in selected folders, including subfolders, will be synced.');

		this.renderSyncFolderPicker(containerEl, folders);

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
					this.plugin.settings.workspaceFolder = this.plugin.normalizeFolder(value.trim() || '_omg', '_omg');
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Agent Output Folder')
			.setDesc('Agent-generated notes are saved here when you use Create New Note or Save from the Agent tab.')
			.addText(text => text
				.setPlaceholder('_omg/agent')
				.setValue(this.plugin.settings.agentOutputFolder)
				.onChange(async (value) => {
					this.plugin.settings.agentOutputFolder = this.plugin.normalizeFolder(value.trim() || '_omg/agent', '_omg/agent');
					await this.plugin.saveSettings();
				})
			)
			.addButton(button => button
				.setButtonText('Create')
				.onClick(async () => {
					await this.plugin.ensureVaultFolder(this.plugin.settings.agentOutputFolder);
					new Notice(`Agent output folder is ready: ${this.plugin.settings.agentOutputFolder}`);
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
			.setDesc('Path or command used by the Agent tab. Use a full path if Obsidian cannot find agy from your shell PATH.')
			.addText(text => text
				.setPlaceholder(process.platform === 'win32' ? 'agy.exe' : '/Users/you/.local/bin/agy')
				.setValue(this.plugin.settings.agentCliPath)
				.onChange(async (value) => {
					this.plugin.settings.agentCliPath = value.trim() || 'agy';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Find Antigravity CLI')
			.setDesc('Auto-detect agy from PATH and common macOS/Windows install locations.')
			.addButton(button => button
				.setButtonText('Auto-detect')
				.onClick(async () => {
					const found = this.plugin.agentService.detectAgentCliPath();
					if (!found) {
						new Notice('Could not find agy. Install Antigravity CLI or set the full path manually.');
						return;
					}
					this.plugin.settings.agentCliPath = found;
					await this.plugin.saveSettings();
					new Notice(`Antigravity CLI found: ${found}`);
					this.display();
				})
			);

		new Setting(containerEl)
			.setName('AGY Model')
			.setDesc('Model passed to agy with --model. Leave Auto to use the AGY default.')
			.addDropdown(dropdown => {
				dropdown.addOption('', 'Auto / AGY default');
				dropdown.addOption('Gemini 3.5 Flash (Medium)', 'Gemini 3.5 Flash (Medium)');
				dropdown.addOption('Gemini 3.5 Flash (High)', 'Gemini 3.5 Flash (High)');
				dropdown.addOption('Gemini 3.5 Flash (Low)', 'Gemini 3.5 Flash (Low)');
				dropdown.addOption('Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (High)');
				dropdown.addOption('Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (Low)');
				dropdown.addOption('Claude Sonnet 4.6 (Thinking)', 'Claude Sonnet 4.6 (Thinking)');
				dropdown.addOption('Claude Opus 4.6 (Thinking)', 'Claude Opus 4.6 (Thinking)');
				dropdown.addOption('GPT-OSS 120B (Medium)', 'GPT-OSS 120B (Medium)');
				dropdown.setValue(this.plugin.settings.agentModel || '');
				dropdown.onChange(async (value) => {
					this.plugin.settings.agentModel = value;
					await this.plugin.saveSettings();
				});
			});

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
			.setName('Use Obsidian Writing Skill')
			.setDesc('Inject a vault-local Obsidian writing skill into Agent prompts by default.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.agentUseObsidianSkill)
				.onChange(async (value) => {
					this.plugin.settings.agentUseObsidianSkill = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Obsidian Skill File')
			.setDesc('Vault-relative skill file used for Markdown note writing instructions.')
			.addText(text => text
				.setPlaceholder('_omg/skills/obsidian-writing-skill.md')
				.setValue(this.plugin.settings.agentObsidianSkillPath)
				.onChange(async (value) => {
					this.plugin.settings.agentObsidianSkillPath = this.plugin.normalizeFolder(value.trim() || '_omg/skills/obsidian-writing-skill.md', '_omg/skills/obsidian-writing-skill.md');
					await this.plugin.saveSettings();
				})
			)
			.addButton(button => button
				.setButtonText('Install skill')
				.onClick(async () => {
					const path = await this.plugin.installObsidianWritingSkill();
					new Notice(`Obsidian writing skill installed: ${path}`);
					this.display();
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

	private renderSyncFolderPicker(containerEl: HTMLElement, folders: string[]) {
		const pickerEl = containerEl.createDiv({ cls: 'mok-folder-picker' });
		const selectedFolders = this.plugin.settings.syncFolders;
		const selectedSet = new Set(selectedFolders);
		const availableFolders = folders.filter(folder => !selectedSet.has(folder));

		const controlsEl = pickerEl.createDiv({ cls: 'mok-folder-picker-controls' });
		const selectEl = controlsEl.createEl('select', { cls: 'dropdown mok-folder-select' });
		selectEl.createEl('option', {
			text: availableFolders.length > 0 ? 'Choose a folder to add...' : 'No more folders available',
			value: ''
		});

		for (const folder of availableFolders) {
			selectEl.createEl('option', { text: folder, value: folder });
		}

		const addButton = controlsEl.createEl('button', {
			cls: 'mod-cta mok-folder-add-button',
			text: 'Add'
		});
		addButton.disabled = availableFolders.length === 0;
		addButton.addEventListener('click', async () => {
			const folder = selectEl.value;
			if (!folder) {
				new Notice('Choose a folder first.');
				return;
			}
			await this.updateSyncFolders([...selectedFolders, folder]);
		});

		if (selectedFolders.length > 0) {
			const clearButton = controlsEl.createEl('button', {
				cls: 'mok-folder-clear-button',
				text: 'Clear'
			});
			clearButton.addEventListener('click', async () => {
				await this.updateSyncFolders([]);
			});
		}

		const summaryEl = pickerEl.createDiv({
			cls: 'mok-folder-picker-summary',
			text: selectedFolders.length === 0
				? 'No folders selected.'
				: `${selectedFolders.length} folder${selectedFolders.length === 1 ? '' : 's'} selected.`
		});

		const chipsEl = pickerEl.createDiv({ cls: 'mok-folder-chip-list' });
		for (const folder of selectedFolders) {
			const chipEl = chipsEl.createDiv({ cls: 'mok-folder-chip' });
			chipEl.createSpan({ cls: 'mok-folder-chip-label', text: folder });
			const removeButton = chipEl.createEl('button', {
				cls: 'mok-folder-chip-remove',
				text: 'x',
				attr: { 'aria-label': `Remove ${folder}` }
			});
			removeButton.addEventListener('click', async () => {
				await this.updateSyncFolders(selectedFolders.filter(item => item !== folder));
			});
		}

		if (folders.length === 0) {
			summaryEl.setText('No folders found in this vault.');
		}
	}

	private async updateSyncFolders(folders: string[]) {
		this.plugin.settings.syncFolders = Array.from(new Set(
			folders.map(folder => folder.trim()).filter(Boolean)
		)).sort();
		await this.plugin.saveSettings();
		this.display();
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
