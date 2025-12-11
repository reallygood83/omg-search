import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, TFile } from 'obsidian';
import GeminiSyncPlugin from './main';
import { ChatMessage, Citation } from './gemini-service';

export const CHAT_VIEW_TYPE = 'gemini-chat-view';

export class ChatView extends ItemView {
	private plugin: GeminiSyncPlugin;
	private messagesContainer: HTMLElement;
	private inputContainer: HTMLElement;
	private inputEl: HTMLTextAreaElement;
	private sendButton: HTMLButtonElement;
	private messages: ChatMessage[] = [];
	private isLoading: boolean = false;
	private syncStatusEl: HTMLElement | null = null;
	private welcomeEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: GeminiSyncPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Gemini Chat';
	}

	getIcon(): string {
		return 'message-square';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('gemini-chat-container');

		// Header
		const header = container.createDiv({ cls: 'gemini-chat-header' });
		header.createEl('h4', { text: '💬 Chat with your Notes' });

		const headerActions = header.createDiv({ cls: 'gemini-chat-header-actions' });

		// Clear chat button
		const clearBtn = headerActions.createEl('button', {
			cls: 'gemini-chat-clear-btn',
			text: '🗑️ Clear'
		});
		clearBtn.addEventListener('click', () => this.clearChat());

		// Sync status indicator
		const stats = this.plugin.syncEngine.getStats();
		this.syncStatusEl = headerActions.createEl('span', {
			cls: 'gemini-chat-sync-status',
			text: `📚 ${stats.synced} notes synced`
		});

		// Messages container
		this.messagesContainer = container.createDiv({ cls: 'gemini-chat-messages' });

		// Welcome message
		if (this.messages.length === 0) {
			this.showWelcomeMessage();
		} else {
			// Restore previous messages
			for (const msg of this.messages) {
				this.renderMessage(msg);
			}
		}

		// Input container
		this.inputContainer = container.createDiv({ cls: 'gemini-chat-input-container' });

		this.inputEl = this.inputContainer.createEl('textarea', {
			cls: 'gemini-chat-input',
			placeholder: 'Ask about your notes...'
		});

		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		// Auto-resize textarea
		this.inputEl.addEventListener('input', () => {
			this.inputEl.style.height = 'auto';
			this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + 'px';
		});

		this.sendButton = this.inputContainer.createEl('button', {
			cls: 'gemini-chat-send-btn',
			text: '➤'
		});
		this.sendButton.addEventListener('click', () => this.sendMessage());
	}

	async onClose() {
		// Save messages for session persistence (optional)
	}

	// Public method to update sync status - can be called from outside
	updateSyncStatus() {
		const stats = this.plugin.syncEngine.getStats();

		// Update header sync status
		if (this.syncStatusEl) {
			this.syncStatusEl.textContent = `📚 ${stats.synced} notes synced`;
		}

		// Update welcome message warning
		if (this.welcomeEl) {
			// Remove existing warning if it exists
			const existingWarning = this.welcomeEl.querySelector('.gemini-chat-welcome-warning');
			if (existingWarning) {
				existingWarning.remove();
			}

			// Add warning if no notes are synced
			if (stats.synced === 0) {
				// Find the position to insert warning (after the main description)
				const paragraphs = this.welcomeEl.querySelectorAll('p');
				if (paragraphs.length > 0) {
					const warningEl = this.welcomeEl.createEl('p', {
						cls: 'gemini-chat-welcome-warning',
						text: '⚠️ No notes synced yet. Configure sync in settings to get started.'
					});
					// Insert after first paragraph
					paragraphs[0].after(warningEl);
				}
			}
		}
	}

	private showWelcomeMessage() {
		this.welcomeEl = this.messagesContainer.createDiv({ cls: 'gemini-chat-welcome' });
		this.welcomeEl.createEl('div', { cls: 'gemini-chat-welcome-icon', text: '🤖' });
		this.welcomeEl.createEl('h3', { text: 'Welcome to Gemini Chat!' });
		this.welcomeEl.createEl('p', { text: 'Ask questions about your synced notes. I\'ll help you find information and provide insights based on your personal knowledge base.' });

		const stats = this.plugin.syncEngine.getStats();
		if (stats.synced === 0) {
			this.welcomeEl.createEl('p', {
				cls: 'gemini-chat-welcome-warning',
				text: '⚠️ No notes synced yet. Configure sync in settings to get started.'
			});
		}

		// Example prompts
		const examplesEl = this.welcomeEl.createDiv({ cls: 'gemini-chat-examples' });
		examplesEl.createEl('p', { text: 'Try asking:' });

		const examples = [
			'What are the main topics in my notes?',
			'Summarize my notes about [topic]',
			'Find connections between [topic A] and [topic B]'
		];

		for (const example of examples) {
			const exampleBtn = examplesEl.createEl('button', {
				cls: 'gemini-chat-example-btn',
				text: example
			});
			exampleBtn.addEventListener('click', () => {
				this.inputEl.value = example;
				this.inputEl.focus();
			});
		}
	}

	private async sendMessage() {
		const text = this.inputEl.value.trim();
		if (!text || this.isLoading) return;

		// Check API key
		if (!this.plugin.settings.apiKey) {
			new Notice('Please configure your Gemini API key in settings');
			return;
		}

		// Clear welcome message
		const welcomeEl = this.messagesContainer.querySelector('.gemini-chat-welcome');
		if (welcomeEl) {
			welcomeEl.remove();
		}

		// Add user message
		const userMessage: ChatMessage = {
			role: 'user',
			content: text
		};
		this.messages.push(userMessage);
		this.renderMessage(userMessage);

		// Clear input
		this.inputEl.value = '';
		this.inputEl.style.height = 'auto';

		// Show loading
		this.isLoading = true;
		this.sendButton.disabled = true;
		this.sendButton.textContent = '⏳';

		const loadingEl = this.messagesContainer.createDiv({ cls: 'gemini-chat-loading' });
		loadingEl.createEl('span', { cls: 'gemini-chat-loading-dots', text: '●●●' });

		// Scroll to bottom
		this.scrollToBottom();

		try {
			// Get response from Gemini
			const response = await this.plugin.geminiService.chat(text);

			// Remove loading
			loadingEl.remove();

			// Add response
			this.messages.push(response);
			this.renderMessage(response);

		} catch (error) {
			loadingEl.remove();

			const errorMessage: ChatMessage = {
				role: 'model',
				content: `Error: ${error instanceof Error ? error.message : 'Failed to get response'}`
			};
			this.messages.push(errorMessage);
			this.renderMessage(errorMessage);
		}

		// Reset loading state
		this.isLoading = false;
		this.sendButton.disabled = false;
		this.sendButton.textContent = '➤';

		this.scrollToBottom();
	}

	private renderMessage(message: ChatMessage) {
		const msgEl = this.messagesContainer.createDiv({
			cls: `gemini-chat-message gemini-chat-message-${message.role}`
		});

		// Avatar
		const avatarEl = msgEl.createDiv({ cls: 'gemini-chat-avatar' });
		avatarEl.textContent = message.role === 'user' ? '👤' : '🤖';

		// Content
		const contentEl = msgEl.createDiv({ cls: 'gemini-chat-content' });

		// Render markdown content
		MarkdownRenderer.renderMarkdown(
			message.content,
			contentEl,
			'',
			this
		);

		// Process citation links
		this.processCitationLinks(contentEl);

		// Render citations if present
		if (message.citations && message.citations.length > 0) {
			const citationsEl = msgEl.createDiv({ cls: 'gemini-chat-citations' });
			citationsEl.createEl('div', { cls: 'gemini-chat-citations-label', text: '📎 Sources:' });

			for (const citation of message.citations) {
				const citationCard = citationsEl.createDiv({ cls: 'gemini-chat-citation-card' });
				const citationLink = citationCard.createEl('a', {
					cls: 'gemini-chat-citation-link',
					text: `📄 ${citation.sourcePath}`
				});

				citationLink.addEventListener('click', (e) => {
					e.preventDefault();
					this.openNote(citation.sourcePath);
				});
			}
		}

		this.scrollToBottom();
	}

	private processCitationLinks(container: HTMLElement) {
		// Find all [Source: filename.md] patterns and make them clickable
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];

		while (walker.nextNode()) {
			textNodes.push(walker.currentNode as Text);
		}

		for (const textNode of textNodes) {
			const text = textNode.textContent || '';
			const pattern = /\[Source:\s*([^\]]+)\]/g;
			let match: RegExpExecArray | null;
			let lastIndex = 0;
			const fragments: (string | HTMLElement)[] = [];

			while ((match = pattern.exec(text)) !== null) {
				// Add text before match
				if (match.index > lastIndex) {
					fragments.push(text.slice(lastIndex, match.index));
				}

				// Create clickable link
				const sourcePath = match[1];
				const link = document.createElement('a');
				link.className = 'gemini-chat-inline-citation';
				link.textContent = `📄 ${sourcePath}`;
				link.href = '#';
				link.addEventListener('click', (e) => {
					e.preventDefault();
					this.openNote(sourcePath);
				});
				fragments.push(link);

				lastIndex = match.index + match[0].length;
			}

			// Add remaining text
			if (lastIndex < text.length) {
				fragments.push(text.slice(lastIndex));
			}

			// Replace text node if we found matches
			if (fragments.length > 1) {
				const span = document.createElement('span');
				for (const fragment of fragments) {
					if (typeof fragment === 'string') {
						span.appendChild(document.createTextNode(fragment));
					} else {
						span.appendChild(fragment);
					}
				}
				textNode.parentNode?.replaceChild(span, textNode);
			}
		}
	}

	private async openNote(path: string) {
		// Clean up the path
		let cleanPath = path.trim();

		// Remove .md extension if checking for file
		if (!cleanPath.endsWith('.md')) {
			cleanPath += '.md';
		}

		// Try to find the file in the vault
		const file = this.app.vault.getAbstractFileByPath(cleanPath);

		if (file instanceof TFile) {
			// Open the file
			await this.app.workspace.openLinkText(cleanPath, '', true);
		} else {
			// Try to find by name only (without path)
			const fileName = cleanPath.split('/').pop() || cleanPath;
			const files = this.app.vault.getMarkdownFiles();
			const matchingFile = files.find(f =>
				f.name === fileName || f.path.endsWith(cleanPath)
			);

			if (matchingFile) {
				await this.app.workspace.openLinkText(matchingFile.path, '', true);
			} else {
				new Notice(`Note not found: ${path}`);
			}
		}
	}

	private clearChat() {
		this.messages = [];
		this.messagesContainer.empty();
		this.plugin.geminiService.clearChatHistory();
		this.showWelcomeMessage();
	}

	private scrollToBottom() {
		setTimeout(() => {
			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		}, 50);
	}
}
