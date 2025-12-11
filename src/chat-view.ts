import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, TFile, Modal, FuzzySuggestModal, App } from 'obsidian';
import GeminiSyncPlugin from './main';
import { ChatMessage, Citation } from './gemini-service';

// Modal for selecting a note to apply content
class NoteSelectorModal extends FuzzySuggestModal<TFile> {
	private onSelect: (file: TFile) => void;

	constructor(app: App, onSelect: (file: TFile) => void) {
		super(app);
		this.onSelect = onSelect;
		this.setPlaceholder('Select a note to apply content...');
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
		this.onSelect(item);
	}
}

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

		// Content wrapper - contains content, citations, and actions vertically stacked
		const contentWrapper = msgEl.createDiv({ cls: 'gemini-chat-content-wrapper' });

		// Content
		const contentEl = contentWrapper.createDiv({ cls: 'gemini-chat-content' });

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
			const citationsEl = contentWrapper.createDiv({ cls: 'gemini-chat-citations' });
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

		// Add Apply/Copy buttons for model responses
		if (message.role === 'model') {
			this.renderActionButtons(contentWrapper, message);
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

	// Render action buttons (Apply, Copy) for AI responses
	private renderActionButtons(msgEl: HTMLElement, message: ChatMessage) {
		const actionsEl = msgEl.createDiv({ cls: 'gemini-chat-actions' });

		// Apply button with dropdown
		const applyContainer = actionsEl.createDiv({ cls: 'gemini-chat-apply-container' });

		const applyBtn = applyContainer.createEl('button', {
			cls: 'gemini-chat-action-btn gemini-chat-apply-btn',
			text: '📝 Apply'
		});

		// Dropdown arrow
		const dropdownArrow = applyContainer.createEl('button', {
			cls: 'gemini-chat-dropdown-arrow',
			text: '▼'
		});

		// Dropdown menu
		const dropdownMenu = applyContainer.createDiv({ cls: 'gemini-chat-dropdown-menu' });
		dropdownMenu.style.display = 'none';

		const menuItems = [
			{ text: '📍 Insert at Cursor', action: () => this.insertAtCursor(message.content, message.citations) },
			{ text: '📎 Append to Current Note', action: () => this.appendToCurrentNote(message.content, message.citations) },
			{ text: '📄 Create New Note', action: () => this.createNewNote(message.content, message.citations) },
			{ text: '📂 Select Note...', action: () => this.selectNoteToApply(message.content, message.citations) }
		];

		for (const item of menuItems) {
			const menuItem = dropdownMenu.createEl('div', {
				cls: 'gemini-chat-dropdown-item',
				text: item.text
			});
			menuItem.addEventListener('click', (e) => {
				e.stopPropagation();
				dropdownMenu.style.display = 'none';
				item.action();
			});
		}

		// Close dropdown when clicking outside
		const closeDropdown = (e: MouseEvent) => {
			if (!applyContainer.contains(e.target as Node)) {
				dropdownMenu.style.display = 'none';
				document.removeEventListener('click', closeDropdown);
			}
		};

		// Toggle dropdown on arrow click (single unified handler)
		dropdownArrow.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();

			const isCurrentlyVisible = dropdownMenu.style.display === 'block';

			if (isCurrentlyVisible) {
				// Close dropdown
				dropdownMenu.style.display = 'none';
				document.removeEventListener('click', closeDropdown);
			} else {
				// Open dropdown
				dropdownMenu.style.display = 'block';
				// Add outside click listener after a small delay
				setTimeout(() => {
					document.addEventListener('click', closeDropdown);
				}, 0);
			}
		});

		// Default apply action (Insert at Cursor)
		applyBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.insertAtCursor(message.content, message.citations);
		});

		// Copy button
		const copyBtn = actionsEl.createEl('button', {
			cls: 'gemini-chat-action-btn gemini-chat-copy-btn',
			text: '📋 Copy'
		});

		copyBtn.addEventListener('click', async () => {
			await navigator.clipboard.writeText(message.content);
			copyBtn.textContent = '✓ Copied!';
			setTimeout(() => {
				copyBtn.textContent = '📋 Copy';
			}, 2000);
		});
	}

	// Format content with optional metadata
	private formatContentWithMetadata(content: string, citations?: Citation[]): string {
		if (!this.plugin.settings.includeMetadata) {
			return content;
		}

		const now = new Date();
		const dateStr = now.toLocaleDateString('ko-KR', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});

		let result = `\n\n---\n*🤖 Gemini Response (${dateStr})*\n\n${content}`;

		if (citations && citations.length > 0) {
			result += '\n\n**Sources:**\n';
			for (const citation of citations) {
				result += `- [[${citation.sourcePath}]]\n`;
			}
		}

		result += '\n---\n';
		return result;
	}

	// Insert at cursor position in active editor
	private async insertAtCursor(content: string, citations?: Citation[]) {
		const activeView = this.app.workspace.getActiveViewOfType(ItemView);

		// Get the active markdown editor
		const markdownView = this.app.workspace.getActiveFile();
		if (!markdownView) {
			new Notice('No active note. Please open a note first.');
			return;
		}

		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf) {
			new Notice('No active editor found.');
			return;
		}

		// @ts-ignore - accessing editor from view
		const editor = leaf.view?.editor;
		if (!editor) {
			new Notice('No editor found. Please open a note in edit mode.');
			return;
		}

		const formattedContent = this.formatContentWithMetadata(content, citations);
		editor.replaceSelection(formattedContent);
		new Notice('✅ Content inserted at cursor!');
	}

	// Append to current note
	private async appendToCurrentNote(content: string, citations?: Citation[]) {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active note. Please open a note first.');
			return;
		}

		const formattedContent = this.formatContentWithMetadata(content, citations);
		await this.app.vault.append(activeFile, formattedContent);
		new Notice(`✅ Content appended to ${activeFile.name}!`);
	}

	// Create new note with content
	private async createNewNote(content: string, citations?: Citation[]) {
		const now = new Date();
		const dateStr = now.toISOString().slice(0, 10);
		const timeStr = now.toTimeString().slice(0, 5).replace(':', '-');
		const fileName = `Gemini Response ${dateStr} ${timeStr}.md`;

		const formattedContent = this.formatContentWithMetadata(content, citations);

		try {
			const newFile = await this.app.vault.create(fileName, formattedContent);
			await this.app.workspace.openLinkText(newFile.path, '', true);
			new Notice(`✅ Created new note: ${fileName}`);
		} catch (error) {
			new Notice('Failed to create note. Please try again.');
			console.error('Create note error:', error);
		}
	}

	// Open note selector modal
	private selectNoteToApply(content: string, citations?: Citation[]) {
		const modal = new NoteSelectorModal(this.app, async (file: TFile) => {
			const formattedContent = this.formatContentWithMetadata(content, citations);
			await this.app.vault.append(file, formattedContent);
			new Notice(`✅ Content appended to ${file.name}!`);
		});
		modal.open();
	}

	private scrollToBottom() {
		setTimeout(() => {
			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		}, 50);
	}
}
