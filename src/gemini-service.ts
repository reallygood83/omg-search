import { GoogleGenerativeAI, GenerativeModel, Content } from '@google/generative-ai';
import { TFile } from 'obsidian';
import GeminiSyncPlugin from './main';

const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

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
	private chatHistory: Content[] = [];

	constructor(plugin: GeminiSyncPlugin) {
		this.plugin = plugin;
		this.initializeClient();
	}

	private initializeClient() {
		if (this.plugin.settings.apiKey) {
			this.genAI = new GoogleGenerativeAI(this.plugin.settings.apiKey);
			this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
		}
	}

	refreshClient() {
		this.initializeClient();
	}

	async verifyApiKey(): Promise<boolean> {
		try {
			if (!this.plugin.settings.apiKey) return false;

			// Try a simple API call to verify the key
			const response = await fetch(
				`${API_BASE_URL}/models?key=${this.plugin.settings.apiKey}`
			);

			return response.ok;
		} catch (error) {
			console.error('API key verification failed:', error);
			return false;
		}
	}

	// ==================== Corpus Management ====================

	async createCorpus(displayName: string): Promise<CorpusInfo | null> {
		try {
			const response = await fetch(
				`${API_BASE_URL}/corpora?key=${this.plugin.settings.apiKey}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						displayName: displayName
					})
				}
			);

			if (!response.ok) {
				const error = await response.json();
				console.error('Failed to create corpus:', error);
				return null;
			}

			return await response.json();
		} catch (error) {
			console.error('Create corpus error:', error);
			return null;
		}
	}

	async listCorpora(): Promise<CorpusInfo[]> {
		try {
			const response = await fetch(
				`${API_BASE_URL}/corpora?key=${this.plugin.settings.apiKey}`
			);

			if (!response.ok) {
				console.error('Failed to list corpora');
				return [];
			}

			const data = await response.json();
			return data.corpora || [];
		} catch (error) {
			console.error('List corpora error:', error);
			return [];
		}
	}

	async getOrCreateCorpus(): Promise<string | null> {
		// If we already have a corpus, return it
		if (this.plugin.settings.corpusName) {
			return this.plugin.settings.corpusName;
		}

		// Try to find existing corpus with same display name
		const corpora = await this.listCorpora();
		const existing = corpora.find(
			c => c.displayName === this.plugin.settings.corpusDisplayName
		);

		if (existing) {
			this.plugin.settings.corpusName = existing.name;
			await this.plugin.saveSettings();
			return existing.name;
		}

		// Create new corpus
		const newCorpus = await this.createCorpus(this.plugin.settings.corpusDisplayName);
		if (newCorpus) {
			this.plugin.settings.corpusName = newCorpus.name;
			await this.plugin.saveSettings();
			return newCorpus.name;
		}

		return null;
	}

	// ==================== Document Management ====================

	async uploadDocument(
		corpusName: string,
		filePath: string,
		content: string
	): Promise<DocumentInfo | null> {
		try {
			// Create document with inline content
			const response = await fetch(
				`${API_BASE_URL}/${corpusName}/documents?key=${this.plugin.settings.apiKey}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						displayName: filePath,
						customMetadata: [
							{ key: 'path', stringValue: filePath },
							{ key: 'source', stringValue: 'obsidian' }
						]
					})
				}
			);

			if (!response.ok) {
				const error = await response.json();
				console.error('Failed to create document:', error);
				return null;
			}

			const document = await response.json();

			// Now add the content as a chunk
			const chunkResponse = await fetch(
				`${API_BASE_URL}/${document.name}/chunks?key=${this.plugin.settings.apiKey}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						data: {
							stringValue: content
						}
					})
				}
			);

			if (!chunkResponse.ok) {
				console.error('Failed to add chunk to document');
				// Try to delete the empty document
				await this.deleteDocument(document.name);
				return null;
			}

			return document;
		} catch (error) {
			console.error('Upload document error:', error);
			return null;
		}
	}

	async updateDocument(
		documentName: string,
		content: string
	): Promise<boolean> {
		try {
			// Delete existing chunks and add new one
			// First, list existing chunks
			const listResponse = await fetch(
				`${API_BASE_URL}/${documentName}/chunks?key=${this.plugin.settings.apiKey}`
			);

			if (listResponse.ok) {
				const data = await listResponse.json();
				const chunks = data.chunks || [];

				// Delete each chunk
				for (const chunk of chunks) {
					await fetch(
						`${API_BASE_URL}/${chunk.name}?key=${this.plugin.settings.apiKey}`,
						{ method: 'DELETE' }
					);
				}
			}

			// Add new chunk with updated content
			const chunkResponse = await fetch(
				`${API_BASE_URL}/${documentName}/chunks?key=${this.plugin.settings.apiKey}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						data: {
							stringValue: content
						}
					})
				}
			);

			return chunkResponse.ok;
		} catch (error) {
			console.error('Update document error:', error);
			return false;
		}
	}

	async deleteDocument(documentName: string): Promise<boolean> {
		try {
			const response = await fetch(
				`${API_BASE_URL}/${documentName}?key=${this.plugin.settings.apiKey}`,
				{ method: 'DELETE' }
			);

			return response.ok;
		} catch (error) {
			console.error('Delete document error:', error);
			return false;
		}
	}

	async listDocuments(corpusName: string): Promise<DocumentInfo[]> {
		try {
			const response = await fetch(
				`${API_BASE_URL}/${corpusName}/documents?key=${this.plugin.settings.apiKey}`
			);

			if (!response.ok) {
				console.error('Failed to list documents');
				return [];
			}

			const data = await response.json();
			return data.documents || [];
		} catch (error) {
			console.error('List documents error:', error);
			return [];
		}
	}

	// ==================== Chat / RAG ====================

	async chat(userMessage: string): Promise<ChatMessage> {
		if (!this.model) {
			this.initializeClient();
		}

		if (!this.model) {
			return {
				role: 'model',
				content: 'Error: Gemini API not configured. Please set your API key in settings.'
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
2. When referencing information from a note, cite it using the format [Source: filename.md].
3. If the information is not in the notes, you can provide general knowledge but clearly state that it's not from the notes.
4. Be concise and helpful.`;

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
						parts: [{ text: 'I understand. I will help answer questions based on your Obsidian notes and cite sources when referencing specific information.' }]
					},
					...this.chatHistory.slice(0, -1) // Previous history without current message
				]
			});

			const result = await chat.sendMessage(userMessage);
			const response = await result.response;
			const text = response.text();

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
				content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`
			};
		}
	}

	private async buildContext(): Promise<string> {
		const files = this.plugin.settings.files;
		const contexts: string[] = [];

		for (const path in files) {
			if (files[path].status === 'synced') {
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
		// Match patterns like [Source: filename.md] or [[filename.md]]
		const pattern = /\[Source:\s*([^\]]+)\]|\[\[([^\]]+)\]\]/g;
		let match;

		while ((match = pattern.exec(text)) !== null) {
			const sourcePath = match[1] || match[2];
			if (sourcePath && !citations.find(c => c.sourcePath === sourcePath)) {
				citations.push({
					sourceId: sourcePath,
					sourcePath: sourcePath.trim(),
					content: ''
				});
			}
		}

		return citations;
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
			const response = await fetch(
				`${API_BASE_URL}/${this.plugin.settings.corpusName}:query?key=${this.plugin.settings.apiKey}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						query: query,
						resultsCount: 5
					})
				}
			);

			if (!response.ok) {
				console.error('Query corpus failed');
				return { results: [] };
			}

			return await response.json();
		} catch (error) {
			console.error('Query corpus error:', error);
			return { results: [] };
		}
	}
}
