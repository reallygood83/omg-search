import { GoogleGenerativeAI, GenerativeModel, Content } from '@google/generative-ai';
import { TFile, requestUrl, RequestUrlParam } from 'obsidian';
import GeminiSyncPlugin from './main';

const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const UPLOAD_BASE_URL = 'https://generativelanguage.googleapis.com/upload/v1beta';

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

export class GeminiService {
	private plugin: GeminiSyncPlugin;
	private genAI: GoogleGenerativeAI | null = null;
	private model: GenerativeModel | null = null;
	private modelName: string | null = null;
	private chatHistory: Content[] = [];

	constructor(plugin: GeminiSyncPlugin) {
		this.plugin = plugin;
		this.initializeClient();
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
	): Promise<{ ok: boolean; status: number; data: any }> {
		try {
			console.log(`[Gemini API] Request: ${method} ${url}`);
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
				data: response.json
			};
		} catch (error: any) {
			console.error('API request error:', error);
			// Try to extract error data if available
			if (error.response) {
				return {
					ok: false,
					status: error.status || 500,
					data: error.response
				};
			}
			return {
				ok: false,
				status: 500,
				data: { error: error.message }
			};
		}
	}

	async verifyApiKey(): Promise<boolean> {
		try {
			if (!this.plugin.settings.apiKey) return false;

			const response = await this.apiRequest(
				`${API_BASE_URL}/models?key=${this.plugin.settings.apiKey}`
			);

			return response.ok;
		} catch (error) {
			console.error('API key verification failed:', error);
			return false;
		}
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
		return text.length > 900 ? `${text.slice(0, 900)}...` : text;
	}

	private getApiKeyFamily(): FileSearchDiagnosticResult['keyFamily'] {
		const key = this.plugin.settings.apiKey.trim();
		if (key.startsWith('AQ')) return 'AQ';
		if (key.startsWith('AIza')) return 'AIza';
		return 'other';
	}

	private getFileSearchRecommendation(keyFamily: FileSearchDiagnosticResult['keyFamily']): string {
		if (keyFamily === 'AQ') {
			return 'This looks like a new AQ Auth key. If model verification works but File Search upload/import returns 403, try an older AIza key if available or create a fresh Google Cloud project/key while Google resolves AQ File Search compatibility.';
		}
		return 'Check that this key is allowed to use Gemini File Search and Files API endpoints. If API restrictions are enabled, allow the Gemini API and try a fresh key/project.';
	}

	// ==================== Corpus Management (FileSearchStores) ====================

	async createCorpus(displayName: string): Promise<CorpusInfo | null> {
		try {
			const response = await this.apiRequest(
				`${API_BASE_URL}/fileSearchStores?key=${this.plugin.settings.apiKey}`,
				'POST',
				{ displayName: displayName }
			);

			if (!response.ok) {
				console.error('Failed to create fileSearchStore:', response.data);
				return null;
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
				console.error('Failed to list fileSearchStores');
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

		// If we already have a corpus, verify it exists
		if (this.plugin.settings.corpusName) {
			console.log(`Verifying corpus: ${this.plugin.settings.corpusName}`);
			try {
				const response = await this.apiRequest(
					`${API_BASE_URL}/${this.plugin.settings.corpusName}?key=${this.plugin.settings.apiKey}`
				);

				if (response.ok) {
					console.log('Corpus verified.');
					return this.plugin.settings.corpusName;
				} else if (response.status === 404) {
					console.warn('Corpus not found (404), clearing setting to recreate.');
					this.plugin.settings.corpusName = '';
					await this.plugin.saveSettings();
				} else {
					console.error('Error verifying corpus:', response.data);
					// If other error (e.g. 403), maybe return null or retry? 
					// For now, let's assume if verification fails heavily, we might want to try recreating or fail.
					// But safe to just fall through if 404.
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
	 * Upload document using two-step workflow:
	 * 1. Upload to Files API with uploadType=multipart
	 * 2. Import to FileSearchStore using importFile
	 */
	async uploadDocument(
		corpusName: string,
		filePath: string,
		content: string
	): Promise<DocumentInfo | null> {
		try {
			console.log(`[Gemini API] Uploading document: ${filePath} to ${corpusName}`);

			// Step 1: Upload to Files API
			const fileResult = await this.uploadToFilesApi(filePath, content);
			if (!fileResult) {
				console.error('[Gemini API] Failed to upload to Files API');
				return null;
			}

			console.log(`[Gemini API] File uploaded: ${fileResult.name}`);

			// Step 2: Import to FileSearchStore
			const documentInfo = await this.importFileToStore(corpusName, fileResult.name, filePath);
			return documentInfo;

		} catch (error: any) {
			console.error('Upload document error:', error);
			if (error.response) {
				console.error('Error response:', error.response);
			}
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

			console.log(`[Gemini API] Files API URL: ${url.replace(this.plugin.settings.apiKey, 'API_KEY')}`);
			console.log(`[Gemini API] Content length: ${content.length} bytes`);

			const response = await requestUrl({
				url: url,
				method: 'POST',
				headers: {
					'Content-Type': `multipart/form-data; boundary=${boundary}`
				},
				body: body
			});

			console.log(`[Gemini API] Files API response status: ${response.status}`);

			if (response.status < 200 || response.status >= 300) {
				console.error('[Gemini API] Files API error:', response.json || response.text);
				return null;
			}

			const result = response.json;
			console.log(`[Gemini API] Files API response:`, JSON.stringify(result));

			if (result.file && result.file.name) {
				return { name: result.file.name };
			}

			console.error('[Gemini API] Unexpected Files API response format');
			return null;

		} catch (error: any) {
			console.error('[Gemini API] Files API upload error:', error);
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

			const response = await requestUrl({
				url: url,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					fileName: fileName
				})
			});

			console.log(`[Gemini API] Import response status: ${response.status}`);

			if (response.status < 200 || response.status >= 300) {
				console.error('[Gemini API] Import error:', response.json || response.text);
				return null;
			}

			const operation = response.json;
			console.log(`[Gemini API] Import operation:`, JSON.stringify(operation));

			// Import returns an operation - wait for it if not done
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

			// If already done or immediate response
			return {
				name: operation.name || fileName.replace('files/', `${corpusName}/documents/`),
				displayName: displayName,
				createTime: new Date().toISOString(),
				updateTime: new Date().toISOString()
			};

		} catch (error: any) {
			console.error('[Gemini API] Import file error:', error);
			return null;
		}
	}

	/**
	 * Wait for a long-running operation to complete
	 */
	private async waitForOperation(operationName: string, maxRetries: number = 10): Promise<DocumentInfo | null> {
		console.log(`[Gemini API] Waiting for operation: ${operationName}`);

		for (let i = 0; i < maxRetries; i++) {
			// Wait before checking (exponential backoff)
			const waitTime = Math.min(1000 * Math.pow(1.5, i), 10000);
			await new Promise(resolve => setTimeout(resolve, waitTime));

			try {
				const response = await this.apiRequest(
					`${API_BASE_URL}/${operationName}?key=${this.plugin.settings.apiKey}`
				);

				if (!response.ok) {
					console.error('Failed to get operation status:', response.data);
					continue;
				}

				const operation = response.data;
				console.log(`[Gemini API] Operation status (attempt ${i + 1}):`, operation.done);

				if (operation.done) {
					if (operation.error) {
						console.error('Operation failed:', operation.error);
						return null;
					}

					// Extract document info from response
					const docResponse = operation.response;
					return {
						name: docResponse?.name || operationName.replace('/operations/', '/documents/'),
						displayName: docResponse?.displayName || '',
						createTime: docResponse?.createTime || new Date().toISOString(),
						updateTime: docResponse?.updateTime || new Date().toISOString()
					};
				}
			} catch (error) {
				console.error(`Error checking operation status (attempt ${i + 1}):`, error);
			}
		}

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
