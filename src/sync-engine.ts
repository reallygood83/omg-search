import { TFile, Notice, debounce } from 'obsidian';
import GeminiSyncPlugin from './main';
import { GeminiService } from './gemini-service';
import { FileSyncData } from './settings';

export class SyncEngine {
	private plugin: GeminiSyncPlugin;
	private geminiService: GeminiService;
	private syncQueue: Map<string, TFile> = new Map();
	private isSyncing: boolean = false;
	private debouncedProcessQueue: () => void;

	constructor(plugin: GeminiSyncPlugin, geminiService: GeminiService) {
		this.plugin = plugin;
		this.geminiService = geminiService;

		// Debounced queue processor
		this.debouncedProcessQueue = debounce(
			() => this.processQueue(),
			this.plugin.settings.syncDebounceMs,
			true
		);
	}

	// ==================== Hash Utilities ====================

	private async calculateHash(content: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(content);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	// ==================== File Event Handlers ====================

	async handleFileCreate(file: TFile) {
		if (!this.plugin.settings.autoSync) return;

		console.log(`[SyncEngine] File created: ${file.path}`);
		this.addToQueue(file);
	}

	async handleFileModify(file: TFile) {
		if (!this.plugin.settings.autoSync) return;

		console.log(`[SyncEngine] File modified: ${file.path}`);
		this.addToQueue(file);
	}

	async handleFileDelete(file: TFile) {
		console.log(`[SyncEngine] File deleted: ${file.path}`);

		const fileData = this.plugin.settings.files[file.path];
		if (fileData && fileData.uri) {
			this.plugin.updateStatusBar('Deleting...');

			const success = await this.geminiService.deleteDocument(fileData.uri);
			if (success) {
				delete this.plugin.settings.files[file.path];
				await this.plugin.saveSettings();
				console.log(`[SyncEngine] Successfully deleted from Gemini: ${file.path}`);
			} else {
				console.error(`[SyncEngine] Failed to delete from Gemini: ${file.path}`);
			}

			this.plugin.updateStatusBar('Ready');
		}
	}

	async handleFileRename(file: TFile, oldPath: string) {
		console.log(`[SyncEngine] File renamed: ${oldPath} -> ${file.path}`);

		const oldFileData = this.plugin.settings.files[oldPath];

		// If old file was synced, delete from Gemini
		if (oldFileData && oldFileData.uri) {
			await this.geminiService.deleteDocument(oldFileData.uri);
			delete this.plugin.settings.files[oldPath];
		}

		// If new path is in sync folder, sync it
		if (this.plugin.shouldSync(file)) {
			this.addToQueue(file);
		}

		await this.plugin.saveSettings();
	}

	// ==================== Queue Management ====================

	private addToQueue(file: TFile) {
		this.syncQueue.set(file.path, file);
		this.debouncedProcessQueue();
	}

	private async processQueue() {
		if (this.isSyncing || this.syncQueue.size === 0) return;

		this.isSyncing = true;
		this.plugin.updateStatusBar(`Syncing (${this.syncQueue.size})...`);
		const syncApiKey = this.plugin.settings.apiKey;

		// Get corpus (create if needed)
		const corpusName = await this.geminiService.getOrCreateCorpus();
		if (!corpusName) {
			const detail = this.geminiService.lastError;
			console.error('[SyncEngine] Failed to get/create corpus', detail);
			new Notice(
				detail
					? `File Search store failed: ${detail.slice(0, 200)}`
					: 'Failed to create/access File Search store. Verify API key (models + File Search) and remove key restrictions.',
				10000
			);
			this.isSyncing = false;
			this.plugin.updateStatusBar('Error');
			return;
		}

		// Process each file in queue
		const entries = Array.from(this.syncQueue.entries());
		this.syncQueue.clear();

		let successCount = 0;
		let errorCount = 0;
		let stoppedForKeyChange = false;

		for (let index = 0; index < entries.length; index++) {
			const [path, file] = entries[index];
			try {
				if (this.plugin.settings.apiKey !== syncApiKey) {
					this.syncQueue.set(path, file);
					for (const [, remainingFile] of entries.slice(index + 1)) {
						this.syncQueue.set(remainingFile.path, remainingFile);
					}
					new Notice('API key changed during sync. Sync stopped; run Sync Now with the new key.');
					this.plugin.updateStatusBar('Stopped');
					stoppedForKeyChange = true;
					break;
				}
				if (!this.plugin.shouldSync(file)) {
					console.log(`[SyncEngine] Skipping ${path} - no longer in selected sync folders`);
					continue;
				}
				const success = await this.syncFile(file, corpusName, syncApiKey);
				if (this.plugin.settings.apiKey !== syncApiKey) {
					for (const [, remainingFile] of entries.slice(index + 1)) {
						this.syncQueue.set(remainingFile.path, remainingFile);
					}
					new Notice('API key changed during sync. Sync stopped; run Sync Now with the new key.');
					stoppedForKeyChange = true;
					break;
				}
				if (success) {
					successCount++;
				} else {
					errorCount++;
				}
			} catch (error) {
				console.error(`[SyncEngine] Error syncing ${path}:`, error);
				errorCount++;
			}

			// Small delay between API calls to avoid rate limiting
			await this.delay(200);
		}

		this.isSyncing = false;

		if (stoppedForKeyChange) {
			this.plugin.updateChatViewSyncStatus();
			return;
		}

		if (errorCount > 0) {
			this.plugin.updateStatusBar(`Done (${errorCount} errors)`);
			const detail = this.geminiService.lastError;
			if (detail) {
				new Notice(`Sync finished with ${errorCount} error(s): ${detail.slice(0, 220)}`, 12000);
			}
			setTimeout(() => this.plugin.updateStatusBar('Ready'), 3000);
		} else {
			this.plugin.updateStatusBar('Ready');
		}

		// Update chat view sync status
		this.plugin.updateChatViewSyncStatus();

		console.log(`[SyncEngine] Queue processed: ${successCount} success, ${errorCount} errors`);
	}

	// ==================== File Sync Logic ====================

	private async syncFile(file: TFile, corpusName: string, syncApiKey: string): Promise<boolean> {
		try {
			// Read file content
			const content = await this.plugin.app.vault.read(file);
			const newHash = await this.calculateHash(content);

			// Check existing sync data
			const existingData = this.plugin.settings.files[file.path];

			// If hash is same, skip sync
			if (existingData && existingData.hash === newHash) {
				console.log(`[SyncEngine] Skipping ${file.path} - no changes`);
				return true;
			}

			// Update or create document
			if (existingData && existingData.uri) {
				if (this.plugin.settings.apiKey !== syncApiKey) {
					return false;
				}
				// Update existing document
				console.log(`[SyncEngine] Updating ${file.path}`);
				const success = await this.geminiService.updateDocument(existingData.uri, content);

				if (success) {
					if (this.plugin.settings.apiKey !== syncApiKey) {
						return false;
					}
					this.plugin.settings.files[file.path] = {
						...existingData,
						hash: newHash,
						lastSynced: Date.now(),
						status: 'synced'
					};
					await this.plugin.saveSettings();
					return true;
				} else {
					if (this.plugin.settings.apiKey !== syncApiKey) {
						return false;
					}
					// Mark as error
					this.plugin.settings.files[file.path] = {
						...existingData,
						status: 'error'
					};
					await this.plugin.saveSettings();
					return false;
				}
			} else {
				if (this.plugin.settings.apiKey !== syncApiKey) {
					return false;
				}
				// Create new document
				console.log(`[SyncEngine] Uploading ${file.path}`);
				const document = await this.geminiService.uploadDocument(corpusName, file.path, content);

				if (document) {
					if (this.plugin.settings.apiKey !== syncApiKey) {
						return false;
					}
					this.plugin.settings.files[file.path] = {
						uri: document.name,
						hash: newHash,
						lastSynced: Date.now(),
						status: 'synced'
					};
					await this.plugin.saveSettings();
					return true;
				} else {
					if (this.plugin.settings.apiKey !== syncApiKey) {
						return false;
					}
					this.plugin.settings.files[file.path] = {
						uri: '',
						hash: '',
						lastSynced: Date.now(),
						status: 'error'
					};
					await this.plugin.saveSettings();
					if (this.geminiService.lastError) {
						console.error(`[SyncEngine] Upload failed for ${file.path}:`, this.geminiService.lastError);
					}
					return false;
				}
			}
		} catch (error) {
			console.error(`[SyncEngine] Error syncing ${file.path}:`, error);
			return false;
		}
	}

	// ==================== Bulk Sync Operations ====================

	async initialSync() {
		console.log('[SyncEngine] Starting initial sync...');

		if (this.plugin.settings.syncFolders.length === 0) {
			console.log('[SyncEngine] No sync folders configured');
			return;
		}

		const files = this.getFilesInSyncFolder();
		console.log(`[SyncEngine] Found ${files.length} files to check`);

		// Add unsynced files to queue
		for (const file of files) {
			const existingData = this.plugin.settings.files[file.path];
			if (!existingData || existingData.status !== 'synced') {
				this.addToQueue(file);
			}
		}

		this.pruneLocalSyncEntries();
		await this.plugin.saveSettings();
	}

	async fullSync() {
		console.log('[SyncEngine] Starting full sync...');
		new Notice('Starting full sync...');

		if (this.plugin.settings.syncFolders.length === 0) {
			new Notice('Please configure at least one sync folder first');
			return;
		}

		const files = this.getFilesInSyncFolder();
		console.log(`[SyncEngine] Found ${files.length} files to sync`);

		this.pruneLocalSyncEntries();

		// Reset selected file statuses and add to queue
		for (const file of files) {
			const existingData = this.plugin.settings.files[file.path];
			if (existingData) {
				existingData.status = 'pending';
			}
		}
		await this.plugin.saveSettings();

		// Add all files to queue
		for (const file of files) {
			this.syncQueue.set(file.path, file);
		}

		// Process immediately (bypass debounce)
		await this.processQueue();

		new Notice(`Sync complete: ${files.length} files processed`);
	}

	// ==================== Utilities ====================

	private getFilesInSyncFolder(): TFile[] {
		if (this.plugin.settings.syncFolders.length === 0) return [];

		const files: TFile[] = [];
		const allFiles = this.plugin.app.vault.getMarkdownFiles();

		for (const file of allFiles) {
			if (this.plugin.isInSyncFolder(file.path)) {
				files.push(file);
			}
		}

		return files;
	}

	private pruneLocalSyncEntries() {
		for (const path in this.plugin.settings.files) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!file || !this.plugin.isInSyncFolder(path)) {
				console.log(`[SyncEngine] Removing untracked sync entry: ${path}`);
				delete this.plugin.settings.files[path];
			}
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	getStats(): { total: number; synced: number; pending: number; error: number } {
		const files = this.plugin.settings.files;
		let synced = 0;
		let pending = 0;
		let error = 0;

		for (const path in files) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || !this.plugin.isInSyncFolder(path)) continue;
			const status = files[path].status;
			if (status === 'synced') synced++;
			else if (status === 'pending') pending++;
			else if (status === 'error') error++;
		}

		return {
			total: Object.keys(files).length,
			synced,
			pending,
			error
		};
	}
}
