import { GoogleGenerativeAI, GenerativeModel, Content } from '@google/generative-ai';
import { TFile, requestUrl, RequestUrlParam } from 'obsidian';
import GeminiSyncPlugin from './main';

const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const UPLOAD_BASE_URL = 'https://generativelanguage.googleapis.com/upload/v1beta';
/** Default embedding model for new File Search stores when the API accepts it. */
const DEFAULT_EMBEDDING_MODEL = 'models/gemini-embedding-001';

export interface CorpusInfo {
	name: string;
	displayName: string;
	createTime: string;
}

export interface DocumentInfo {
	name: string;
	displayName: string;
	createTime: string;
	updateTime: string;
}

export interface ChatMessage {
	role: 'user' | 'model';
	content: string;
	citations?: Citation[];
	isStreaming?: boolean;
	logPath?: string;
	savedNotePath?: string;
}

export interface Citation {
	sourceId: string;
	sourcePath: string;
	content: string;
}

export interface FileSearchDiagnosticResult {
	ok: boolean;
	stage: 'missing_api_key' | 'models' | 'file_search_store' | 'files_upload' | 'import_file' | 'complete';
	keyFamily: 'AQ' | 'AIza' | 'other';
	status?: number;
	message: string;
	detail?: string;
	recommendation?: string;
}

/**
 * Multi-step API key verification.
 * Models-only success is NOT enough for sync — File Search must also work.
 */
export type ApiKeyVerifyStatus =
	| 'valid'
	| 'missing'
	| 'invalid'
	| 'file_search_denied'
	| 'restricted'
	| 'network_error';

export interface ApiKeyVerifyResult {
	ok: boolean;
	status: ApiKeyVerifyStatus;
	message: string;
	httpStatus?: number;
	detail?: string;
}

export class GeminiService {
	private plugin: GeminiSyncPlugin;
	private genAI: GoogleGenerativeAI | null = null;
	private model: GenerativeModel | null = null;
	private modelName: string | null = null;
	private chatHistory: Content[] = [];
	/** Last structured API error for UI / notices (never contains raw full secrets if redacted). */
	lastError: string | null = null;

	constructor(plugin: GeminiSyncPlugin) {
		this.plugin = plugin;
		this.initializeClient();
	}

	private redact(urlOrText: string): string {
		const key = this.plugin.settings.apiKey;
		if (!key) return urlOrText;
		let out = urlOrText.split(key).join('API_KEY');
		// Also redact trimmed AIza/AQ-looking substrings that may appear in exception text
		out = out.replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza…REDACTED');
		out = out.replace(/\bAQ[0-9A-Za-z_-]{10,}\b/g, 'AQ…REDACTED');
		return out;
	}

	private extractGoogleError(data: any): string {
		if (!data) return '';
		if (typeof data === 'string') return this.redact(data).slice(0, 500);
		const err = data.error || data;
		const message = err.message || err.status || JSON.stringify(err);
		return this.redact(String(message)).slice(0, 500);
	}

	private operationToDocumentInfo(
		operation: any,
		displayName: string,
		fallbackName?: string
	): DocumentInfo | null {
		const document =
			operation?.response?.document ||
			operation?.response ||
			operation?.document ||
			operation;
		const name = document?.name || fallbackName;

		if (!name || String(name).includes('/operations/')) {
			return null;
		}

		return {
			name: String(name),
			displayName: document?.displayName || displayName || '',
			createTime: document?.createTime || new Date().toISOString(),
			updateTime: document?.updateTime || new Date().toISOString()
		};
	}

	private initializeClient() {
		if (this.plugin.settings.apiKey) {
			this.genAI = new GoogleGenerativeAI(this.plugin.settings.apiKey);
			this.model = this.genAI.getGenerativeModel({ model: this.plugin.settings.model });
			this.modelName = this.plugin.settings.model;
		} else {
			this.genAI = null;
			this.model = null;
			this.modelName = null;
		}
	}

	refreshClient() {
		this.initializeClient();
	}

	private ensureCurrentModel() {
		if (!this.plugin.settings.apiKey) {
			this.genAI = null;
			this.model = null;
			this.modelName = null;
			return;
		}

		if (!this.genAI || !this.model || this.modelName !== this.plugin.settings.model) {
			this.initializeClient();
		}
	}

	// Helper method to make API requests using Obsidian's requestUrl (bypasses CORS)
	private async apiRequest(
		url: string,
		method: string = 'GET',
		body?: object
	): Promise<{ ok: boolean; status: number; data: any; headers?: Record<string, string> }> {
		try {
			console.log(`[Gemini API] Request: ${method} ${this.redact(url)}`);
			const params: RequestUrlParam = {
				url: url,
				method: method,
				headers: { 'Content-Type': 'application/json' }
			};

			if (body) {
				params.body = JSON.stringify(body);
			}

			const response = await requestUrl(params);

			return {
				ok: response.status >= 200 && response.status < 300,
				status: response.status,
				data: response.json,
				headers: response.headers
			};
		} catch (error: any) {
			console.error('API request error:', this.redact(String(error?.message || error)));
			const status = error.status || error.response?.status || 500;
			let data: any = { error: { message: error.message } };
			try {
				if (error.json) data = error.json;
				else if (error.response) data = error.response;
				else if (typeof error.text === 'string') {
					try { data = JSON.parse(error.text); } catch { /* keep message */ }
				}
			} catch { /* ignore */ }

			return {
				ok: false,
				status,
				data
			};
		}
	}

	/**
	 * Legacy boolean verify. Prefer verifyApiKeyDetailed() — models alone are not enough for sync.
	 */
	async verifyApiKey(): Promise<boolean> {
		const result = await this.verifyApiKeyDetailed();
		return result.ok;
	}

	/**
	 * Multi-step verification:
	 * 1) GET /models — basic key validity
	 * 2) GET /fileSearchStores — File Search authorization (common user failure point)
	 */
	async verifyApiKeyDetailed(): Promise<ApiKeyVerifyResult> {
		this.lastError = null;

		if (!this.plugin.settings.apiKey) {
			return {
				ok: false,
				status: 'missing',
				message: 'API key is empty. Paste a key from Google AI Studio.'
			};
		}

		const key = this.plugin.settings.apiKey.trim();
		if (key.length < 20) {
			return {
				ok: false,
				status: 'invalid',
				message: 'API key looks too short. Copy the full key from Google AI Studio.'
			};
		}

		const models = await this.apiRequest(`${API_BASE_URL}/models?key=${key}`);
		if (!models.ok) {
			const detail = this.extractGoogleError(models.data);
			this.lastError = detail;
			const status: ApiKeyVerifyStatus =
				models.status === 401 || models.status === 403 ? 'invalid' : 'network_error';
			return {
				ok: false,
				status,
				httpStatus: models.status,
				detail,
				message:
					models.status === 401 || models.status === 403
						? `API key rejected by Gemini (HTTP ${models.status}). Create a new key at aistudio.google.com/apikey with Application restrictions = None.`
						: `Could not reach Gemini models API (HTTP ${models.status}). Check network and try again.`
			};
		}

		const stores = await this.apiRequest(`${API_BASE_URL}/fileSearchStores?key=${key}`);
		if (!stores.ok) {
			const detail = this.extractGoogleError(stores.data);
			this.lastError = detail;
			const code = (stores.data?.error?.status || '').toString().toUpperCase();
			const isAuth =
				stores.status === 401 ||
				stores.status === 403 ||
				code === 'UNAUTHENTICATED' ||
				code === 'PERMISSION_DENIED';

			if (isAuth) {
				const restrictedHint =
					/referer|referrer|ip|restriction|application/i.test(detail)
						? 'restricted'
						: 'file_search_denied';
				return {
					ok: false,
					status: restrictedHint as ApiKeyVerifyStatus,
					httpStatus: stores.status,
					detail,
					message:
						`API key can list models, but File Search is denied (HTTP ${stores.status} ${code || ''}). ` +
						`Remove Application restrictions, ensure Generative Language API is enabled, and use an unrestricted AI Studio key. ` +
						`Detail: ${detail || 'UNAUTHENTICATED'}`
				};
			}

			return {
				ok: false,
				status: 'network_error',
				httpStatus: stores.status,
				detail,
				message: `File Search probe failed (HTTP ${stores.status}). ${detail}`
			};
		}

		return {
			ok: true,
			status: 'valid',
			message: 'API key is valid for models and File Search Store access.'
		};
	}

	async diagnoseFileSearchUpload(): Promise<FileSearchDiagnosticResult> {
		const keyFamily = this.getApiKeyFamily();
		if (!this.plugin.settings.apiKey) {
			return {
				ok: false,
				stage: 'missing_api_key',
				keyFamily,
				message: 'Gemini API key is missing.',
				recommendation: 'Add a Gemini API key in plugin settings first.'
			};
		}

		const modelsResponse = await this.apiRequest(
			`${API_BASE_URL}/models?key=${this.plugin.settings.apiKey}`
		);
		if (!modelsResponse.ok) {
			return this.buildDiagnosticFailure(
				'models',
				keyFamily,
				modelsResponse.status,
				modelsResponse.data,
				'The key could not list Gemini models.',
				'Create a valid Gemini API key in Google AI Studio and make sure the Gemini API is enabled for the project.'
			);
		}

		const storeName = await this.getDiagnosticStoreName(keyFamily);
		if (!storeName) {
			const storesResponse = await this.apiRequest(
				`${API_BASE_URL}/fileSearchStores?key=${this.plugin.settings.apiKey}`
			);
			return this.buildDiagnosticFailure(
				'file_search_store',
				keyFamily,
				storesResponse.status,
				storesResponse.data,
				'The key can call Gemini models, but cannot create or list File Search stores.',
				this.getFileSearchRecommendation(keyFamily)
			);
		}

		const upload = await this.uploadDiagnosticFile();
		if (!upload.ok || !upload.data?.file?.name) {
			return this.buildDiagnosticFailure(
				'files_upload',
				keyFamily,
				upload.status,
				upload.data,
				'The key can access File Search stores, but Files API upload failed.',
				this.getFileSearchRecommendation(keyFamily)
			);
		}

		const fileName = upload.data.file.name;
		const imported = await this.importDiagnosticFile(storeName, fileName);
		if (!imported.ok) {
			return this.buildDiagnosticFailure(
				'import_file',
				keyFamily,
				imported.status,
				imported.data,
				'The key uploaded a file, but File Search import failed.',
				this.getFileSearchRecommendation(keyFamily)
			);
		}

		return {
			ok: true,
			stage: 'complete',
			keyFamily,
			status: imported.status,
			message: 'File Search upload diagnostics passed. This key can create stores, upload files, and import them for sync.',
			detail: `Diagnostic store: ${storeName}`
		};
	}

	private async getDiagnosticStoreName(keyFamily: FileSearchDiagnosticResult['keyFamily']): Promise<string | null> {
		const displayName = `${this.plugin.settings.corpusDisplayName || 'Obsidian Vault'} Diagnostics`;
		const listResponse = await this.apiRequest(
			`${API_BASE_URL}/fileSearchStores?key=${this.plugin.settings.apiKey}`
		);
		if (listResponse.ok) {
			const existing = (listResponse.data.fileSearchStores || []).find((store: CorpusInfo) => store.displayName === displayName);
			if (existing?.name) return existing.name;
		} else if (listResponse.status === 403 && keyFamily === 'AQ') {
			return null;
		}

		const createResponse = await this.apiRequest(
			`${API_BASE_URL}/fileSearchStores?key=${this.plugin.settings.apiKey}`,
			'POST',
			{ displayName }
		);
		return createResponse.ok && createResponse.data?.name ? createResponse.data.name : null;
	}

	private async uploadDiagnosticFile(): Promise<{ ok: boolean; status: number; data: any }> {
		const boundary = '----MOKDiagnosticBoundary' + Math.random().toString(36).substring(2);
		const displayName = '_mok-diagnostics-api-key-upload-test.md';
		const content = [
			'# Master of Knowledge File Search Diagnostic',
			'',
			'This tiny file verifies that the current API key can upload Markdown content to Gemini Files API.'
		].join('\n');
		const metadata = JSON.stringify({
			file: {
				displayName,
				mimeType: 'text/markdown'
			}
		});
		let body = '';
		body += `--${boundary}\r\n`;
		body += 'Content-Disposition: form-data; name="metadata"\r\n';
		body += 'Content-Type: application/json\r\n\r\n';
		body += `${metadata}\r\n`;
		body += `--${boundary}\r\n`;
		body += `Content-Disposition: form-data; name="file"; filename="${displayName}"\r\n`;
		body += 'Content-Type: text/markdown\r\n\r\n';
		body += `${content}\r\n`;
		body += `--${boundary}--`;

		return this.requestUrlDiagnostic({
			url: `${UPLOAD_BASE_URL}/files?uploadType=multipart&key=${this.plugin.settings.apiKey}`,
			method: 'POST',
			headers: {
				'Content-Type': `multipart/form-data; boundary=${boundary}`
			},
			body
		});
	}

	private async importDiagnosticFile(storeName: string, fileName: string): Promise<{ ok: boolean; status: number; data: any }> {
		return this.requestUrlDiagnostic({
			url: `${API_BASE_URL}/${storeName}:importFile?key=${this.plugin.settings.apiKey}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ fileName })
		});
	}

	private async requestUrlDiagnostic(params: RequestUrlParam): Promise<{ ok: boolean; status: number; data: any }> {
		try {
			const response = await requestUrl(params);
			return {
				ok: response.status >= 200 && response.status < 300,
				status: response.status,
				data: response.json || response.text
			};
		} catch (error: any) {
			const status = Number(error?.status || error?.response?.status || 500);
			return {
				ok: false,
				status,
				data: error?.response || error?.message || String(error)
			};
		}
	}

	private buildDiagnosticFailure(
		stage: FileSearchDiagnosticResult['stage'],
		keyFamily: FileSearchDiagnosticResult['keyFamily'],
		status: number,
		data: any,
		message: string,
		recommendation: string
	): FileSearchDiagnosticResult {
		return {
			ok: false,
			stage,
			keyFamily,
			status,
			message,
			detail: this.summarizeDiagnosticData(data),
			recommendation
		};
	}

	private summarizeDiagnosticData(data: any): string {
		if (!data) return '';
		const text = typeof data === 'string' ? data : JSON.stringify(data);
		const redacted = this.redact(text);
		return redacted.length > 900 ? `${redacted.slice(0, 900)}...` : redacted;
	}

	private getApiKeyFamily(): FileSearchDiagnosticResult['keyFamily'] {
		const key = this.plugin.settings.apiKey.trim();
		if (key.startsWith('AQ')) return 'AQ';
		if (key.startsWith('AIza')) return 'AIza';
		return 'other';
	}

	private getFileSearchRecommendation(keyFamily: FileSearchDiagnosticResult['keyFamily']): string {
		if (keyFamily === 'AQ') {
			return 'This looks like a new AQ Auth key. If model verification works but File Search upload/import returns 401/403, try an unrestricted AIza key from AI Studio, or create a fresh Google Cloud project/key while Google resolves AQ File Search compatibility. Also clear Application restrictions and use Reset store after changing keys.';
		}
		return 'Use an unrestricted Google AI Studio key (Application restrictions = None). Ensure Generative Language API is enabled. If you changed keys/projects, click Reset store then Sync Now. Models-only Verify is not enough — use multi-step Verify or Diagnose File Search.';
	}

	// ==================== Corpus Management (FileSearchStores) ====================

	async createCorpus(displayName: string): Promise<CorpusInfo | null> {
		try {
			const response = await this.apiRequest(
				`${API_BASE_URL}/fileSearchStores?key=${this.plugin.settings.apiKey}`,
				'POST',
				{
					displayName: displayName,
					embeddingModel: DEFAULT_EMBEDDING_MODEL
				}
			);

			if (!response.ok) {
				// Older backends may reject embeddingModel — retry displayName-only
				const fallback = await this.apiRequest(
					`${API_BASE_URL}/fileSearchStores?key=${this.plugin.settings.apiKey}`,
					'POST',
					{ displayName: displayName }
				);
				if (!fallback.ok) {
					const detail = this.extractGoogleError(fallback.data);
					this.lastError = detail;
					console.error('Failed to create fileSearchStore:', detail);
					return null;
				}
				return fallback.data;
			}

			return response.data;
		} catch (error) {
			console.error('Create fileSearchStore error:', error);
			return null;
		}
	}

	async listCorpora(): Promise<CorpusInfo[]> {
		try {
			const response = await this.apiRequest(
				`${API_BASE_URL}/fileSearchStores?key=${this.plugin.settings.apiKey}`
			);

			if (!response.ok) {
				const detail = this.extractGoogleError(response.data);
				this.lastError = detail;
				console.error('Failed to list fileSearchStores:', detail);
				return [];
			}

			return response.data.fileSearchStores || [];
		} catch (error) {
			console.error('List fileSearchStores error:', error);
			return [];
		}
	}

	async getOrCreateCorpus(): Promise<string | null> {
		// Migration: If we have a legacy 'corpora/' name, clear it to force recreation
		if (this.plugin.settings.corpusName && this.plugin.settings.corpusName.startsWith('corpora/')) {
			console.log('Migrating from legacy corpus to fileSearchStore...');
			this.plugin.settings.corpusName = '';
			await this.plugin.saveSettings();
		}

		// If we already have a corpus, verify it exists under THIS key
		if (this.plugin.settings.corpusName) {
			console.log(`Verifying corpus: ${this.plugin.settings.corpusName}`);
			try {
				const response = await this.apiRequest(
					`${API_BASE_URL}/${this.plugin.settings.corpusName}?key=${this.plugin.settings.apiKey}`
				);

				if (response.ok) {
					console.log('Corpus verified.');
					return this.plugin.settings.corpusName;
				} else if (
					response.status === 404 ||
					response.status === 401 ||
					response.status === 403
				) {
					// Stale store from another key/project — recreate
					console.warn(
						`Corpus not accessible (${response.status}), clearing setting to recreate.`
					);
					this.plugin.settings.corpusName = '';
					await this.plugin.saveSettings();
				} else {
					const detail = this.extractGoogleError(response.data);
					this.lastError = detail;
					console.error('Error verifying corpus:', detail);
				}
			} catch (error) {
				console.error('Error checking corpus existence:', error);
			}
		}

		// If cleared or empty, try to find existing or create new
		// Try to find existing corpus with same display name
		const corpora = await this.listCorpora();
		const existing = corpora.find(
			c => c.displayName === this.plugin.settings.corpusDisplayName
		);

		if (existing) {
			console.log(`Found existing corpus: ${existing.name}`);
			this.plugin.settings.corpusName = existing.name;
			await this.plugin.saveSettings();
			return existing.name;
		}

		// Create new corpus
		console.log(`Creating new corpus: ${this.plugin.settings.corpusDisplayName}`);
		const newCorpus = await this.createCorpus(this.plugin.settings.corpusDisplayName);
		if (newCorpus) {
			this.plugin.settings.corpusName = newCorpus.name;
			await this.plugin.saveSettings();
			return newCorpus.name;
		}

		return null;
	}

	// ==================== Document Management ====================

	/**
	 * Upload document:
	 * Preferred: direct uploadToFileSearchStore (modern File Search API)
	 * Fallback: Files API multipart + importFile (legacy two-step)
	 */
	async uploadDocument(
		corpusName: string,
		filePath: string,
		content: string
	): Promise<DocumentInfo | null> {
		try {
			console.log(`[Gemini API] Uploading document: ${filePath} to ${corpusName}`);
			this.lastError = null;

			const direct = await this.uploadToFileSearchStore(corpusName, filePath, content);
			if (direct) {
				return direct;
			}

			console.warn('[Gemini API] Direct upload failed; falling back to Files API + importFile');

			const fileResult = await this.uploadToFilesApi(filePath, content);
			if (!fileResult) {
				console.error('[Gemini API] Failed to upload to Files API');
				return null;
			}

			console.log(`[Gemini API] File uploaded: ${fileResult.name}`);
			const documentInfo = await this.importFileToStore(corpusName, fileResult.name, filePath);
			return documentInfo;

		} catch (error: any) {
			console.error('Upload document error:', error);
			this.lastError = this.redact(error?.message || String(error));
			if (error.response) {
				console.error('Error response:', error.response);
			}
			return null;
		}
	}

	/**
	 * Modern path: resumable upload directly into FileSearchStore.
	 * See: https://ai.google.dev/gemini-api/docs/file-search
	 */
	private async uploadToFileSearchStore(
		corpusName: string,
		displayName: string,
		content: string
	): Promise<DocumentInfo | null> {
		try {
			console.log(`[Gemini API] Direct uploadToFileSearchStore for ${displayName}`);

			const contentBytes = new TextEncoder().encode(content);
			const numBytes = contentBytes.byteLength;
			const startUrl =
				`${UPLOAD_BASE_URL}/${corpusName}:uploadToFileSearchStore` +
				`?key=${this.plugin.settings.apiKey}`;

			let startResponse;
			try {
				startResponse = await requestUrl({
					url: startUrl,
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Goog-Upload-Protocol': 'resumable',
						'X-Goog-Upload-Command': 'start',
						'X-Goog-Upload-Header-Content-Length': String(numBytes),
						'X-Goog-Upload-Header-Content-Type': 'text/markdown'
					},
					body: JSON.stringify({ displayName })
				});
			} catch (error: any) {
				const status = error.status || 500;
				const detail = this.extractGoogleError(error.json || error);
				this.lastError = `uploadToFileSearchStore start HTTP ${status}: ${detail}`;
				console.error('[Gemini API]', this.lastError);
				return null;
			}

			if (startResponse.status < 200 || startResponse.status >= 300) {
				const detail = this.extractGoogleError(startResponse.json);
				this.lastError = `uploadToFileSearchStore start HTTP ${startResponse.status}: ${detail}`;
				console.error('[Gemini API]', this.lastError);
				return null;
			}

			const headers = startResponse.headers || {};
			const uploadUrl =
				headers['x-goog-upload-url'] ||
				headers['X-Goog-Upload-URL'] ||
				headers['X-Goog-Upload-Url'] ||
				Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-goog-upload-url')?.[1];

			if (!uploadUrl) {
				console.warn('[Gemini API] No x-goog-upload-url header; cannot complete direct upload');
				this.lastError = 'uploadToFileSearchStore: missing x-goog-upload-url header';
				return null;
			}

			let finalizeResponse;
			try {
				finalizeResponse = await requestUrl({
					url: uploadUrl,
					method: 'POST',
					headers: {
						'Content-Length': String(numBytes),
						'X-Goog-Upload-Offset': '0',
						'X-Goog-Upload-Command': 'upload, finalize',
						'Content-Type': 'text/markdown'
					},
					body: content
				});
			} catch (error: any) {
				const status = error.status || 500;
				const detail = this.extractGoogleError(error.json || error);
				this.lastError = `uploadToFileSearchStore finalize HTTP ${status}: ${detail}`;
				console.error('[Gemini API]', this.lastError);
				return null;
			}

			console.log(`[Gemini API] Direct upload status: ${finalizeResponse.status}`);

			if (finalizeResponse.status < 200 || finalizeResponse.status >= 300) {
				const detail = this.extractGoogleError(finalizeResponse.json);
				this.lastError = `uploadToFileSearchStore finalize HTTP ${finalizeResponse.status}: ${detail}`;
				console.error('[Gemini API]', this.lastError);
				return null;
			}

			const operation = finalizeResponse.json;
			if (operation && operation.done === false && operation.name) {
				const result = await this.waitForOperation(operation.name);
				if (result) {
					return { ...result, displayName };
				}
				return null;
			}

			return this.operationToDocumentInfo(operation, displayName);
		} catch (error: any) {
			this.lastError = this.redact(error?.message || String(error));
			console.error('[Gemini API] uploadToFileSearchStore error:', this.lastError);
			return null;
		}
	}

	/**
	 * Upload file to Google Files API using multipart/form-data format
	 */
	private async uploadToFilesApi(
		displayName: string,
		content: string
	): Promise<{ name: string } | null> {
		try {
			console.log(`[Gemini API] Step 1: Uploading to Files API...`);

			// Build multipart/form-data body manually for Obsidian's requestUrl
			const boundary = '----GeminiSyncBoundary' + Math.random().toString(36).substring(2);

			// Metadata JSON
			const metadata = JSON.stringify({
				file: {
					displayName: displayName,
					mimeType: 'text/markdown'
				}
			});

			// Build multipart/form-data body
			// Note: Use \r\n for all line breaks as per HTTP spec
			let body = '';
			body += `--${boundary}\r\n`;
			body += `Content-Disposition: form-data; name="metadata"\r\n`;
			body += `Content-Type: application/json\r\n\r\n`;
			body += metadata + '\r\n';
			body += `--${boundary}\r\n`;
			body += `Content-Disposition: form-data; name="file"; filename="${displayName}"\r\n`;
			body += `Content-Type: text/markdown\r\n\r\n`;
			body += content + '\r\n';
			body += `--${boundary}--`;

			const url = `${UPLOAD_BASE_URL}/files?uploadType=multipart&key=${this.plugin.settings.apiKey}`;

			console.log(`[Gemini API] Files API URL: ${this.redact(url)}`);
			console.log(`[Gemini API] Content length: ${content.length} bytes`);

			let response;
			try {
				response = await requestUrl({
					url: url,
					method: 'POST',
					headers: {
						'Content-Type': `multipart/form-data; boundary=${boundary}`
					},
					body: body
				});
			} catch (error: any) {
				const status = error.status || 500;
				const detail = this.extractGoogleError(error.json || error);
				this.lastError = `Files API error HTTP ${status}: ${detail || error.message}`;
				console.error('[Gemini API]', this.lastError);
				return null;
			}

			console.log(`[Gemini API] Files API response status: ${response.status}`);

			if (response.status < 200 || response.status >= 300) {
				const detail = this.extractGoogleError(response.json);
				this.lastError = `Files API HTTP ${response.status}: ${detail}`;
				console.error('[Gemini API] Files API error:', detail);
				return null;
			}

			const result = response.json;
			if (result.file && result.file.name) {
				return { name: result.file.name };
			}

			console.error('[Gemini API] Unexpected Files API response format');
			this.lastError = 'Unexpected Files API response format';
			return null;

		} catch (error: any) {
			this.lastError = this.redact(error?.message || String(error));
			console.error('[Gemini API] Files API upload error:', this.lastError);
			return null;
		}
	}

	/**
	 * Import a file from Files API to FileSearchStore
	 */
	private async importFileToStore(
		corpusName: string,
		fileName: string,
		displayName: string
	): Promise<DocumentInfo | null> {
		try {
			console.log(`[Gemini API] Step 2: Importing ${fileName} to ${corpusName}...`);

			const url = `${API_BASE_URL}/${corpusName}:importFile?key=${this.plugin.settings.apiKey}`;

			let response;
			try {
				response = await requestUrl({
					url: url,
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						fileName: fileName
					})
				});
			} catch (error: any) {
				const status = error.status || 500;
				const detail = this.extractGoogleError(error.json || error);
				const code = (error.json?.error?.status || '').toString();
				this.lastError =
					`importFile HTTP ${status} ${code}: ${detail}. ` +
					`Models/upload may work while importFile returns UNAUTHENTICATED if the key is restricted ` +
					`or the File Search store belongs to another project. Reset store after changing keys.`;
				console.error('[Gemini API]', this.lastError);
				return null;
			}

			console.log(`[Gemini API] Import response status: ${response.status}`);

			if (response.status < 200 || response.status >= 300) {
				const detail = this.extractGoogleError(response.json);
				const code = (response.json?.error?.status || '').toString();
				this.lastError =
					`importFile HTTP ${response.status} ${code}: ${detail}. ` +
					`If status is 401 UNAUTHENTICATED: use an unrestricted Google AI Studio key and clear ` +
					`Application restrictions; after key change, Reset store then Sync Now.`;
				console.error('[Gemini API] Import error:', this.lastError);
				return null;
			}

			const operation = response.json;
			console.log(`[Gemini API] Import operation:`, JSON.stringify(operation)?.slice(0, 500));

			if (operation.done === false && operation.name) {
				const result = await this.waitForOperation(operation.name);
				if (result) {
					return {
						...result,
						displayName: displayName
					};
				}
				return null;
			}

			return this.operationToDocumentInfo(
				operation,
				displayName,
				fileName.replace('files/', `${corpusName}/documents/`)
			);

		} catch (error: any) {
			this.lastError = this.redact(error?.message || String(error));
			console.error('[Gemini API] Import file error:', this.lastError);
			return null;
		}
	}

	/**
	 * Wait for a long-running operation to complete
	 */
	private async waitForOperation(operationName: string, maxRetries: number = 10): Promise<DocumentInfo | null> {
		console.log(`[Gemini API] Waiting for operation: ${operationName}`);

		for (let i = 0; i < maxRetries; i++) {
			const waitTime = Math.min(1000 * Math.pow(1.5, i), 10000);
			await new Promise(resolve => setTimeout(resolve, waitTime));

			try {
				const response = await this.apiRequest(
					`${API_BASE_URL}/${operationName}?key=${this.plugin.settings.apiKey}`
				);

				if (!response.ok) {
					console.error('Failed to get operation status:', this.extractGoogleError(response.data));
					continue;
				}

				const operation = response.data;
				console.log(`[Gemini API] Operation status (attempt ${i + 1}):`, operation.done);

				if (operation.done) {
					if (operation.error) {
						const detail = this.extractGoogleError(operation);
						this.lastError = `Operation failed: ${detail}`;
						console.error('Operation failed:', operation.error);
						return null;
					}

					return this.operationToDocumentInfo(operation, '');
				}
			} catch (error) {
				console.error(
					`Error checking operation status (attempt ${i + 1}):`,
					this.redact(String(error))
				);
			}
		}

		this.lastError = 'Operation timed out waiting for File Search indexing';
		console.error('Operation timed out');
		return null;
	}

	async updateDocument(
		documentName: string,
		content: string
	): Promise<boolean> {
		try {
			console.log(`[Gemini API] Updating document: ${documentName}`);

			// Validation
			const parts = documentName.split('/');
			if (parts.length < 4) {
				console.error('Invalid document name format:', documentName);
				return false;
			}

			const corpusName = `${parts[0]}/${parts[1]}`;

			// Try to get existing doc info to preserve displayName
			let displayName = 'updated_file.md';
			const getResponse = await this.apiRequest(
				`${API_BASE_URL}/${documentName}?key=${this.plugin.settings.apiKey}`
			);

			if (getResponse.ok && getResponse.data.displayName) {
				displayName = getResponse.data.displayName;
			}

			// Delete the existing document
			await this.deleteDocument(documentName);

			// Re-create as new document with same display name
			const newDoc = await this.uploadDocument(corpusName, displayName, content);

			return !!newDoc;
		} catch (error) {
			console.error('Update document error:', error);
			return false;
		}
	}

	async deleteDocument(documentName: string): Promise<boolean> {
		try {
			const response = await this.apiRequest(
				`${API_BASE_URL}/${documentName}?key=${this.plugin.settings.apiKey}`,
				'DELETE'
			);

			return response.ok;
		} catch (error) {
			console.error('Delete document error:', error);
			return false;
		}
	}

	async listDocuments(corpusName: string): Promise<DocumentInfo[]> {
		try {
			const response = await this.apiRequest(
				`${API_BASE_URL}/${corpusName}/documents?key=${this.plugin.settings.apiKey}`
			);

			if (!response.ok) {
				console.error('Failed to list documents');
				return [];
			}

			return response.data.documents || [];
		} catch (error) {
			console.error('List documents error:', error);
			return [];
		}
	}

	// ==================== Chat / RAG ====================

	async chat(userMessage: string): Promise<ChatMessage> {
		this.ensureCurrentModel();
		const logPath = await this.createChatLog(userMessage);

		if (!this.plugin.settings.apiKey) {
			await this.appendChatLog(logPath, {
				event: 'failed',
				reason: 'missing_api_key'
			});
			return {
				role: 'model',
				content: 'Gemini API 키가 설정되어 있지 않습니다. 설정에서 API 키를 입력해 주세요.',
				logPath
			};
		}

		try {
			const fileSearchResponse = await this.chatWithFileSearch(userMessage, logPath);
			if (fileSearchResponse) {
				return fileSearchResponse;
			}

			if (!this.model) {
				await this.appendChatLog(logPath, {
					event: 'failed',
					reason: 'model_not_initialized'
				});
				return {
					role: 'model',
					content: 'Gemini API 키가 설정되어 있지 않습니다. 설정에서 API 키를 입력해 주세요.',
					logPath
				};
			}

			await this.appendChatLog(logPath, {
				event: 'fallback_context_start',
				reason: 'file_search_unavailable',
				syncedFileCount: this.getSyncedFileCount()
			});

			// Build context from synced files
			const context = await this.buildContext();

			// Create system prompt with context
			const systemPrompt = `You are a helpful assistant that answers questions based on the user's personal notes from their Obsidian vault.

Here are the relevant notes for context:

${context}

Instructions:
1. Answer questions based primarily on the provided notes.
2. When referencing information from a note, cite it using the exact full vault path from the note header, using the format [Source: folder/note.md].
3. If the information is not in the notes, you can provide general knowledge but clearly state that it's not from the notes.
4. Answer in the same language as the user's latest message.
5. If the user's latest message is Korean, answer naturally in Korean even when source notes contain English terms or titles.
6. Preserve technical terms, product names, note titles, and quoted source phrases in their original language when needed.
7. Never expose raw File Search IDs, opaque document IDs, random-looking source IDs, or internal URIs.
8. Produce a complete, practical artifact rather than a thin outline. For lesson plans, include audience, goals, time plan, activity flow, teacher script, hands-on tasks, materials, and follow-up prompts.
9. Be specific and useful. Avoid generic summaries when the user asks for a deliverable.`;

			// Add to chat history
			this.chatHistory.push({
				role: 'user',
				parts: [{ text: userMessage }]
			});

			// Use the model with context
			const chat = this.model.startChat({
				history: [
					{
						role: 'user',
						parts: [{ text: systemPrompt }]
					},
					{
						role: 'model',
						parts: [{ text: '알겠습니다. 사용자의 최신 질문 언어에 맞춰 답하고, 특정 노트를 참조할 때는 출처를 표시하겠습니다.' }]
					},
					...this.chatHistory.slice(0, -1) // Previous history without current message
				]
			});

			const result = await this.sendMessageWithRetry(chat, userMessage);
			const response = await result.response;
			const text = response.text();
			const usage = (response as any).usageMetadata || {};
			const outputTokens = Number(usage.candidatesTokenCount || this.plugin.estimateTokens(text));
			const inputTokens = Number(
				usage.promptTokenCount ||
				Math.max(1, this.plugin.estimateTokens(`${systemPrompt}\n${userMessage}`))
			);
			await this.plugin.recordBudgetUsage({
				type: 'chat',
				model: this.plugin.settings.model,
				inputTokens,
				outputTokens,
				estimatedCostUsd: this.plugin.estimateGeminiCost(this.plugin.settings.model, inputTokens, outputTokens),
				success: true
			});

			const cleanedText = this.cleanGeneratedSourceNoise(text);
			const citations = await this.recoverSyncedCitations(
				userMessage,
				text,
				this.extractCitations(text)
			);
			await this.appendChatLog(logPath, {
				event: 'fallback_context_success',
				inputTokens,
				outputTokens,
				estimatedCostUsd: this.plugin.estimateGeminiCost(this.plugin.settings.model, inputTokens, outputTokens),
				citationCount: citations.length,
				sourcePaths: citations.map(citation => citation.sourcePath),
				responsePreview: this.preview(cleanedText, 1000)
			});

			// Add assistant response to history
			this.chatHistory.push({
				role: 'model',
				parts: [{ text: cleanedText }]
			});

			return {
				role: 'model',
				content: cleanedText,
				citations,
				logPath
			};
		} catch (error) {
			console.error('Chat error:', error);
			await this.appendChatLog(logPath, {
				event: 'failed',
				message: error instanceof Error ? error.message : String(error)
			});
			return {
				role: 'model',
				content: this.formatChatError(error),
				logPath
			};
		}
	}

	private async chatWithFileSearch(userMessage: string, logPath: string): Promise<ChatMessage | null> {
		const corpusName = this.plugin.settings.corpusName || await this.getOrCreateCorpus();
		if (!corpusName) {
			await this.appendChatLog(logPath, {
				event: 'file_search_skipped',
				reason: 'missing_file_search_store'
			});
			return null;
		}

		const input = this.buildFileSearchPrompt(userMessage);
		await this.appendChatLog(logPath, {
			event: 'file_search_start',
			corpusName,
			inputTokensEstimate: this.plugin.estimateTokens(input)
		});

		try {
			const response = await this.apiRequest(
				`${API_BASE_URL}/interactions?key=${this.plugin.settings.apiKey}`,
				'POST',
				{
					model: this.plugin.settings.model,
					input: [{ type: 'text', text: input }],
					tools: [{
						type: 'file_search',
						file_search_store_names: [corpusName]
					}]
				}
			);

			if (!response.ok) {
				console.warn('File Search interaction failed, falling back to local context:', response.data);
				await this.appendChatLog(logPath, {
					event: 'file_search_failed',
					status: response.status,
					errorPreview: this.preview(JSON.stringify(response.data), 1000)
				});
				return null;
			}

			const { text, citations } = this.extractInteractionOutput(response.data);
			if (!text.trim()) {
				await this.appendChatLog(logPath, {
					event: 'file_search_empty',
					status: response.status
				});
				return null;
			}
			const recoveredCitations = await this.recoverSyncedCitations(
				userMessage,
				text,
				citations
			);
			const cleanedText = this.cleanGeneratedSourceNoise(text);

			const usage = response.data?.usageMetadata || response.data?.usage_metadata || {};
			const outputTokens = Number(usage.candidatesTokenCount || usage.outputTokenCount || this.plugin.estimateTokens(cleanedText));
			const inputTokens = Number(usage.promptTokenCount || usage.inputTokenCount || this.plugin.estimateTokens(input));
			await this.plugin.recordBudgetUsage({
				type: 'chat',
				model: this.plugin.settings.model,
				inputTokens,
				outputTokens,
				estimatedCostUsd: this.plugin.estimateGeminiCost(this.plugin.settings.model, inputTokens, outputTokens),
				success: true
			});

			this.chatHistory.push({
				role: 'user',
				parts: [{ text: userMessage }]
			});
			this.chatHistory.push({
				role: 'model',
				parts: [{ text: cleanedText }]
			});
			await this.appendChatLog(logPath, {
				event: 'file_search_success',
				inputTokens,
				outputTokens,
				estimatedCostUsd: this.plugin.estimateGeminiCost(this.plugin.settings.model, inputTokens, outputTokens),
				annotationCitationCount: citations.length,
				recoveredCitationCount: recoveredCitations.length,
				sourcePaths: recoveredCitations.map(citation => citation.sourcePath),
				rawResponsePreview: this.preview(text, 1000),
				cleanedResponsePreview: this.preview(cleanedText, 1000)
			});

			return {
				role: 'model',
				content: cleanedText,
				citations: recoveredCitations,
				logPath
			};
		} catch (error) {
			console.warn('File Search interaction error, falling back to local context:', error);
			await this.appendChatLog(logPath, {
				event: 'file_search_error',
				message: error instanceof Error ? error.message : String(error)
			});
			return null;
		}
	}

	private async createChatLog(userMessage: string): Promise<string> {
		const folder = await this.plugin.ensureWorkspaceFolder('logs');
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const path = `${folder}/chat-${stamp}.jsonl`;
		const initial = {
			event: 'start',
			timestamp: new Date().toISOString(),
			model: this.plugin.settings.model,
			corpusName: this.plugin.settings.corpusName || '',
			syncFolders: this.plugin.settings.syncFolders,
			syncedFileCount: this.getSyncedFileCount(),
			promptPreview: this.preview(userMessage, 500)
		};
		await this.plugin.app.vault.create(path, `${JSON.stringify(initial)}\n`);
		return path;
	}

	private async appendChatLog(path: string, event: Record<string, unknown>) {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			await this.plugin.app.vault.append(file, `${JSON.stringify({
				timestamp: new Date().toISOString(),
				...event
			})}\n`);
		} catch (error) {
			console.warn('Failed to append Chat log:', error);
		}
	}

	private preview(value: string, maxLength: number): string {
		return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated]` : value;
	}

	private getSyncedFileCount(): number {
		return Object.keys(this.plugin.settings.files).filter(path => {
			const syncData = this.plugin.settings.files[path];
			return syncData?.status === 'synced' && this.plugin.isInSyncFolder(path);
		}).length;
	}

	private buildFileSearchPrompt(userMessage: string): string {
		return [
			'You are Master of Knowledge, an Obsidian knowledge assistant.',
			'Use the File Search tool as the primary source of truth for the user\'s synced Obsidian notes.',
			'Answer in the same language as the user\'s latest message. If the user writes Korean, answer naturally in Korean.',
			'Never expose raw File Search IDs, opaque document IDs, random-looking source IDs, or internal URIs.',
			'Do not add a manual "Source notes" section with opaque IDs. The app will render source note buttons separately.',
			'When citing inside the prose, cite only real note titles or real vault paths. If the real title/path is not available, omit the citation from the prose.',
			'When the File Search result does not support the answer, say that clearly instead of guessing.',
			'Produce a complete, practical artifact rather than a thin outline. For lesson plans, include audience, goals, time plan, activity flow, teacher script, hands-on tasks, materials, and follow-up prompts.',
			'Ground recommendations in the retrieved notes, then add clearly labeled general suggestions only when useful.',
			'',
			'User request:',
			userMessage
		].join('\n');
	}

	private extractInteractionOutput(data: any): { text: string; citations: Citation[] } {
		const texts: string[] = [];
		const citations: Citation[] = [];
		const steps = Array.isArray(data?.steps) ? data.steps : [];

		for (const step of steps) {
			if (step?.type !== 'model_output') continue;
			const contentBlocks = Array.isArray(step.content) ? step.content : [];
			for (const block of contentBlocks) {
				if (block?.type === 'text' && typeof block.text === 'string') {
					texts.push(block.text);
				}
				const annotations = Array.isArray(block?.annotations) ? block.annotations : [];
				for (const annotation of annotations) {
					const citation = this.citationFromFileSearchAnnotation(annotation);
					if (citation && !citations.find(existing => existing.sourcePath === citation.sourcePath)) {
						citations.push(citation);
					}
				}
			}
		}

		return { text: texts.join('\n\n').trim(), citations };
	}

	private citationFromFileSearchAnnotation(annotation: any): Citation | null {
		if (!annotation || annotation.type !== 'file_citation') return null;
		const candidates = [
			annotation.file_name,
			annotation.fileName,
			annotation.source,
			annotation.uri,
			annotation.document_name,
			annotation.documentName
		].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

		for (const candidate of candidates) {
			const path = this.resolveSyncedCitationPath(candidate);
			if (path) {
				return {
					sourceId: path,
					sourcePath: path,
					content: ''
				};
			}

			const byUri = this.resolveSyncedCitationUri(candidate);
			if (byUri) {
				return {
					sourceId: byUri,
					sourcePath: byUri,
					content: ''
				};
			}
		}

		return null;
	}

	private resolveSyncedCitationUri(uri: string): string | null {
		const normalizedUri = this.normalizeCitationPath(uri);
		const uriTail = normalizedUri.split('/').pop() || normalizedUri;
		for (const path in this.plugin.settings.files) {
			const syncData = this.plugin.settings.files[path];
			if (syncData.status !== 'synced') continue;
			if (!this.plugin.isInSyncFolder(path)) continue;
			const normalizedSyncUri = this.normalizeCitationPath(syncData.uri || '');
			if (!normalizedSyncUri) continue;
			const syncUriTail = normalizedSyncUri.split('/').pop() || normalizedSyncUri;
			if (syncData.uri === uri ||
				uri.includes(syncData.uri) ||
				normalizedUri.includes(normalizedSyncUri) ||
				(!!uriTail && uriTail === syncUriTail) ||
				(!!syncUriTail && normalizedUri.includes(syncUriTail))) {
				return path;
			}
		}
		return null;
	}

	private cleanGeneratedSourceNoise(text: string): string {
		const lines = text.split('\n');
		const cleaned: string[] = [];
		let skippingGeneratedSources = false;

		for (const line of lines) {
			const trimmed = line.trim();
			const startsGeneratedSourceBlock =
				/^#{1,4}\s*(활용한\s*)?(source|sources|출처|참고\s*노트|source\s*노트|source\s*notes?|노트\s*정보)/i.test(trimmed) ||
				/^[-*]\s*`?[a-z0-9]{8,}`?\s*(\/|:|,)/i.test(trimmed);

			if (startsGeneratedSourceBlock) {
				skippingGeneratedSources = true;
				continue;
			}

			if (skippingGeneratedSources) {
				if (/^#{1,3}\s+\S/.test(trimmed) || /^---+$/.test(trimmed)) {
					skippingGeneratedSources = false;
				} else if (!trimmed || /^[-*]\s*`?[a-z0-9]{8,}`?/i.test(trimmed)) {
					continue;
				} else if (/`?[a-z0-9]{8,}`?\s*(\/|,)/i.test(trimmed) && !trimmed.includes('.md')) {
					continue;
				} else {
					skippingGeneratedSources = false;
				}
			}

			cleaned.push(line);
		}

		return cleaned
			.join('\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}

	private async recoverSyncedCitations(
		userMessage: string,
		text: string,
		parsedCitations: Citation[]
	): Promise<Citation[]> {
		const citations = [...parsedCitations];
		const explicit = this.extractCitations(text);
		for (const citation of explicit) {
			if (!citations.find(existing => existing.sourcePath === citation.sourcePath)) {
				citations.push(citation);
			}
		}

		const opaqueIds = this.extractOpaqueSourceIds(text);
		for (const id of opaqueIds) {
			const byUri = this.resolveSyncedCitationUri(id);
			const byPath = this.resolveSyncedCitationPath(id);
			const sourcePath = byUri || byPath;
			if (sourcePath && !citations.find(existing => existing.sourcePath === sourcePath)) {
				citations.push({ sourceId: sourcePath, sourcePath, content: '' });
			}
		}

		const scored = await this.rankSyncedNotes(`${userMessage}\n${text}`, 5);
		for (const sourcePath of scored) {
			if (!citations.find(existing => existing.sourcePath === sourcePath)) {
				citations.push({ sourceId: sourcePath, sourcePath, content: '' });
			}
			if (citations.length >= 5) break;
		}

		return citations;
	}

	private extractOpaqueSourceIds(text: string): string[] {
		const ids = new Set<string>();
		const patterns = [
			/`([a-z0-9]{8,})`/gi,
			/\b([a-z0-9]{10,})\b/gi
		];

		for (const pattern of patterns) {
			let match: RegExpExecArray | null;
			while ((match = pattern.exec(text)) !== null) {
				const value = match[1];
				if (value && !/^\d+$/.test(value)) ids.add(value);
			}
		}

		return Array.from(ids);
	}

	private async rankSyncedNotes(query: string, limit: number): Promise<string[]> {
		const tokens = this.tokenizeForSearch(query);
		if (tokens.length === 0) return [];

		const scored: { path: string; score: number }[] = [];
		for (const path in this.plugin.settings.files) {
			const syncData = this.plugin.settings.files[path];
			if (syncData.status !== 'synced') continue;
			if (!this.plugin.isInSyncFolder(path)) continue;

			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || file.extension !== 'md') continue;

			try {
				const content = await this.plugin.app.vault.read(file);
				const haystack = `${file.basename}\n${file.path}\n${content.slice(0, 5000)}`.toLowerCase();
				let score = 0;
				for (const token of tokens) {
					if (file.basename.toLowerCase().includes(token)) score += 8;
					if (file.path.toLowerCase().includes(token)) score += 5;
					const matches = haystack.split(token).length - 1;
					score += Math.min(matches, 6);
				}
				if (score > 0) scored.push({ path: file.path, score });
			} catch (error) {
				console.warn(`Failed to rank synced note: ${path}`, error);
			}
		}

		return scored
			.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
			.slice(0, limit)
			.map(item => item.path);
	}

	private tokenizeForSearch(text: string): string[] {
		const tokens = new Set<string>();
		const normalized = text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, ' ');

		for (const raw of normalized.split(/\s+/)) {
			const token = raw.trim();
			if (token.length < 2) continue;
			if (/^\d+$/.test(token)) continue;
			if (this.isStopToken(token)) continue;
			tokens.add(token);
			if (tokens.size >= 32) break;
		}

		return Array.from(tokens);
	}

	private isStopToken(token: string): boolean {
		return new Set([
			'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'your',
			'are', 'was', 'were', 'have', 'has', 'not', 'can', 'will',
			'대한', '관련', '작성', '내용', '노트', '활용', '사용자', '초안',
			'있습니다', '합니다', '위한', '에게', '에서', '으로', '그리고'
		]).has(token);
	}

	private async sendMessageWithRetry(chat: any, userMessage: string) {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await chat.sendMessage(userMessage);
			} catch (error) {
				lastError = error;
				if (!this.isRetryableGeminiError(error) || attempt === 2) break;
				await new Promise(resolve => setTimeout(resolve, 600 * Math.pow(2, attempt)));
			}
		}
		throw lastError;
	}

	private isRetryableGeminiError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return /\[(500|502|503|504)\]/.test(message) || /internal error|overloaded|unavailable/i.test(message);
	}

	private formatChatError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error || 'Unknown error occurred');
		const model = this.plugin.settings.model;
		if (this.isRetryableGeminiError(error)) {
			return [
				`Gemini 모델 호출이 일시적으로 실패했습니다. 현재 모델: \`${model}\`.`,
				'Google API에서 500/일시 장애 응답을 반환했습니다. 플러그인이 자동 재시도했지만 실패했습니다.',
				'잠시 후 다시 시도하거나, 급하면 설정에서 다른 모델로 바꿔 주세요.',
				'',
				`원본 오류: ${message}`
			].join('\n');
		}
		return `Gemini 요청 실패. 현재 모델: \`${model}\`.\n\n${message}`;
	}

	private async buildContext(): Promise<string> {
		const files = this.plugin.settings.files;
		const contexts: string[] = [];

		for (const path in files) {
			if (files[path].status === 'synced' && this.plugin.isInSyncFolder(path)) {
				try {
					const file = this.plugin.app.vault.getAbstractFileByPath(path);
					if (file && file instanceof TFile && file.extension === 'md') {
						const content = await this.plugin.app.vault.read(file);
						// Truncate if too long
						const truncated = content.length > 2000
							? content.substring(0, 2000) + '...[truncated]'
							: content;
						contexts.push(`--- ${path} ---\n${truncated}\n`);
					}
				} catch (e) {
					console.error(`Failed to read file ${path}:`, e);
				}
			}
		}

		// Limit total context size
		let totalContext = contexts.join('\n');
		if (totalContext.length > 30000) {
			totalContext = totalContext.substring(0, 30000) + '\n...[context truncated due to length]';
		}

		return totalContext || 'No synced notes available.';
	}

	private extractCitations(text: string): Citation[] {
		const citations: Citation[] = [];
		// Only explicit source markers are treated as citations. Regular wiki links
		// in generated advice should not become source cards.
		const pattern = /\[Source:\s*([^\]]+)\]/g;
		let match;

		while ((match = pattern.exec(text)) !== null) {
			const sourcePath = this.resolveSyncedCitationPath(match[1] || '');
			if (sourcePath && !citations.find(c => c.sourcePath === sourcePath)) {
				citations.push({
					sourceId: sourcePath,
					sourcePath,
					content: ''
				});
			}
		}

		return citations;
	}

	private resolveSyncedCitationPath(rawPath: string): string | null {
		const cleaned = rawPath
			.trim()
			.replace(/^["']|["']$/g, '')
			.split('|')[0]
			.trim();
		if (!cleaned) return null;

		const candidates = [cleaned];
		if (!cleaned.endsWith('.md')) candidates.push(`${cleaned}.md`);
		const normalizedCandidates = new Set(candidates.map(path => this.normalizeCitationPath(path)));

		for (const path in this.plugin.settings.files) {
			if (this.plugin.settings.files[path].status !== 'synced') continue;
			if (!this.plugin.isInSyncFolder(path)) continue;
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			const normalizedPath = this.normalizeCitationPath(file.path);
			const normalizedName = this.normalizeCitationPath(file.name);
			if (normalizedCandidates.has(normalizedPath) ||
				normalizedCandidates.has(normalizedName) ||
				Array.from(normalizedCandidates).some(candidate => normalizedPath.endsWith(candidate))) {
				return file.path;
			}
		}

		return null;
	}

	private normalizeCitationPath(path: string): string {
		return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
	}

	clearChatHistory() {
		this.chatHistory = [];
	}

	// ==================== Semantic Retrieval (Alternative approach) ====================

	async queryCorpus(query: string): Promise<{ results: any[] }> {
		if (!this.plugin.settings.corpusName) {
			return { results: [] };
		}

		try {
			const response = await this.apiRequest(
				`${API_BASE_URL}/${this.plugin.settings.corpusName}:query?key=${this.plugin.settings.apiKey}`,
				'POST',
				{
					query: query,
					resultsCount: 5
				}
			);

			if (!response.ok) {
				console.error('Query corpus failed');
				return { results: [] };
			}

			return response.data;
		} catch (error) {
			console.error('Query corpus error:', error);
			return { results: [] };
		}
	}
}
