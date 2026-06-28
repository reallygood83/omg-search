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
}

export interface Citation {
	sourceId: string;
	sourcePath: string;
	content: string;
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

		if (!this.model) {
			return {
				role: 'model',
				content: 'Gemini API 키가 설정되어 있지 않습니다. 설정에서 API 키를 입력해 주세요.'
			};
		}

		try {
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
7. Be concise and helpful.`;

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

			// Add assistant response to history
			this.chatHistory.push({
				role: 'model',
				parts: [{ text }]
			});

			// Extract citations from response
			const citations = this.extractCitations(text);

			return {
				role: 'model',
				content: text,
				citations
			};
		} catch (error) {
			console.error('Chat error:', error);
			return {
				role: 'model',
				content: this.formatChatError(error)
			};
		}
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
