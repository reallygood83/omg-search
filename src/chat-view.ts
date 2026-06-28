import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, TFile, Modal, FuzzySuggestModal, App } from 'obsidian';
import GeminiSyncPlugin from './main';
import { ChatMessage, Citation } from './gemini-service';

type DashboardTab = 'chat' | 'agent' | 'budget' | 'workspace';

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
	private agentMessages: ChatMessage[] = [];
	private isLoading: boolean = false;
	private loadingTab: DashboardTab | null = null;
	private isComposing: boolean = false;
	private syncStatusEl: HTMLElement | null = null;
	private welcomeEl: HTMLElement | null = null;
	private tabBarEl: HTMLElement;
	private dashboardContentEl: HTMLElement;
	private activeTab: DashboardTab = 'chat';

	constructor(leaf: WorkspaceLeaf, plugin: GeminiSyncPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Master of Knowledge';
	}

	getIcon(): string {
		return 'brain-circuit';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('gemini-chat-container');

		// Header
		const header = container.createDiv({ cls: 'gemini-chat-header' });
		header.createEl('h4', { text: 'Master of Knowledge' });

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

		this.tabBarEl = container.createDiv({ cls: 'mok-tabs' });
		this.dashboardContentEl = container.createDiv({ cls: 'mok-content' });
		this.renderTabs();
		this.renderActiveTab();
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

	private renderTabs() {
		this.tabBarEl.empty();
		const tabs: Array<{ id: DashboardTab; label: string }> = [
			{ id: 'chat', label: 'Chat' },
			{ id: 'agent', label: 'Agent' },
			{ id: 'budget', label: 'Budget' },
			{ id: 'workspace', label: '_omg' }
		];

		for (const tab of tabs) {
			const button = this.tabBarEl.createEl('button', {
				cls: tab.id === this.activeTab ? 'mok-tab mok-tab-active' : 'mok-tab',
				text: tab.label
			});
			button.addEventListener('click', () => {
				this.activeTab = tab.id;
				this.renderTabs();
				this.renderActiveTab();
			});
		}
	}

	private renderActiveTab() {
		this.dashboardContentEl.empty();
		this.welcomeEl = null;

		if (this.activeTab === 'budget') {
			this.renderBudgetTab();
			return;
		}

		if (this.activeTab === 'workspace') {
			this.renderWorkspaceTab();
			return;
		}

		this.messagesContainer = this.dashboardContentEl.createDiv({ cls: 'gemini-chat-messages' });
		const list = this.activeTab === 'agent' ? this.agentMessages : this.messages;
		if (list.length === 0) {
			this.showWelcomeMessage();
		} else {
			for (const msg of list) this.renderMessage(msg);
		}

		this.inputContainer = this.dashboardContentEl.createDiv({ cls: 'gemini-chat-input-container' });
		if (this.activeTab === 'agent') {
			this.renderAgentModeBar(this.inputContainer);
		}
		this.inputEl = this.inputContainer.createEl('textarea', {
			cls: 'gemini-chat-input',
			placeholder: this.activeTab === 'agent'
				? 'Ask the Agent to research, compile, map, or write...'
				: 'Ask about your notes...'
		});

		this.inputEl.addEventListener('compositionstart', () => {
			this.isComposing = true;
		});

		this.inputEl.addEventListener('compositionend', () => {
			window.setTimeout(() => {
				this.isComposing = false;
			}, 0);
		});

		this.inputEl.addEventListener('keydown', (e) => {
			if (this.isComposing || e.isComposing) return;
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		this.inputEl.addEventListener('input', () => {
			this.inputEl.style.height = 'auto';
			this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + 'px';
		});

		this.sendButton = this.inputContainer.createEl('button', {
			cls: 'gemini-chat-send-btn',
			text: this.isLoading && this.loadingTab === this.activeTab ? '⏳' : '➤'
		});
		this.sendButton.disabled = this.isLoading;
		this.sendButton.addEventListener('click', () => this.sendMessage());

		if (this.isLoading && this.loadingTab === this.activeTab) {
			const loadingEl = this.messagesContainer.createDiv({ cls: 'gemini-chat-loading' });
			loadingEl.createEl('span', { cls: 'gemini-chat-loading-dots', text: '●●●' });
			loadingEl.createEl('span', {
				cls: 'gemini-chat-loading-label',
				text: this.activeTab === 'agent' ? 'Agent is still running...' : 'Thinking...'
			});
		}
	}

	private renderBudgetTab() {
		const panel = this.dashboardContentEl.createDiv({ cls: 'mok-panel' });
		panel.createEl('h3', { text: 'Budget Guard' });
		const budget = this.plugin.settings.monthlyBudgetUsd;
		const used = this.plugin.settings.estimatedMonthlySpendUsd;
		const month = this.plugin.settings.estimatedMonthlySpendMonth || this.plugin.getCurrentBudgetMonth();
		const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
		panel.createEl('p', { text: `Estimated ${month} usage: $${used.toFixed(4)} / $${budget.toFixed(2)} (${pct}%)` });
		const meter = panel.createDiv({ cls: 'mok-budget-meter' });
		meter.createDiv({ cls: 'mok-budget-fill' }).style.width = `${pct}%`;
		panel.createEl('p', { text: `Gemini API log: ${this.plugin.settings.workspaceFolder}/logs/budget-${month}.jsonl` });
		panel.createEl('p', { text: 'Cost is an estimate from Gemini token metadata when available. Agent/Antigravity CLI runs are not counted because they do not use this plugin API key.' });
		panel.createEl('p', { text: 'Default policy: Flash-Lite for classification, Flash for answers, Pro only after manual approval.' });
	}

	private renderWorkspaceTab() {
		const panel = this.dashboardContentEl.createDiv({ cls: 'mok-panel' });
		panel.createEl('h3', { text: `${this.plugin.settings.workspaceFolder} workspace` });
		panel.createEl('p', { text: 'Generated Agent reports, compiled notes, graph JSON, and logs are kept separate from your source notes.' });
		const folders = ['compiled', 'agent', 'graph', 'inbox', 'logs'];
		const list = panel.createEl('ul');
		for (const folder of folders) list.createEl('li', { text: `${this.plugin.settings.workspaceFolder}/${folder}` });
		const createBtn = panel.createEl('button', { cls: 'gemini-chat-action-btn', text: 'Create workspace folders' });
		createBtn.addEventListener('click', async () => {
			for (const folder of folders) await this.plugin.ensureWorkspaceFolder(folder);
			new Notice('Master of Knowledge workspace folders are ready.');
		});
	}

	private showWelcomeMessage() {
		this.welcomeEl = this.messagesContainer.createDiv({ cls: 'gemini-chat-welcome' });
		this.welcomeEl.createEl('div', { cls: 'gemini-chat-welcome-icon', text: this.activeTab === 'agent' ? '🧭' : '🧠' });
		this.welcomeEl.createEl('h3', { text: this.activeTab === 'agent' ? 'Agent Workspace' : 'Ask your knowledge base' });
		this.welcomeEl.createEl('p', { text: this.activeTab === 'agent' ? 'Run Antigravity/AGY work from Obsidian, then apply the result to notes with the same actions as chat.' : 'Ask questions about your synced notes. I\'ll help you find information and provide insights based on your personal knowledge base.' });

		const stats = this.plugin.syncEngine.getStats();
		if (stats.synced === 0) {
			this.welcomeEl.createEl('p', {
				cls: 'gemini-chat-welcome-warning',
				text: '⚠️ No notes synced yet. Configure sync in settings to get started.'
			});
		}

		// Example prompts
		if (this.activeTab === 'agent') return;

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

	private renderAgentModeBar(container: HTMLElement) {
		const modeBar = container.createDiv({ cls: 'mok-agent-mode-bar' });
		const webSearchButton = modeBar.createEl('button', {
			cls: this.plugin.settings.agentWebSearchEnabled
				? 'mok-agent-mode-toggle mok-agent-mode-toggle-active'
				: 'mok-agent-mode-toggle',
			text: this.plugin.settings.agentWebSearchEnabled ? 'Web Search On' : 'Web Search Off'
		});
		webSearchButton.setAttr('aria-pressed', String(this.plugin.settings.agentWebSearchEnabled));
		webSearchButton.addEventListener('click', async () => {
			this.plugin.settings.agentWebSearchEnabled = !this.plugin.settings.agentWebSearchEnabled;
			await this.plugin.saveSettings();
			this.renderActiveTab();
		});
		modeBar.createSpan({
			cls: 'mok-agent-mode-hint',
			text: this.plugin.settings.agentWebSearchEnabled
				? 'Agent may use current web sources.'
				: 'Agent stays focused on vault context unless asked.'
		});
	}

	private async sendMessage() {
		const text = this.inputEl.value.trim();
		if (!text || this.isLoading) return;
		const requestTab = this.activeTab;
		const requestContainer = this.messagesContainer;
		const requestInput = this.inputEl;
		const requestButton = this.sendButton;

		if (requestTab === 'chat' && !this.plugin.settings.apiKey) {
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
		const list = requestTab === 'agent' ? this.agentMessages : this.messages;
		list.push(userMessage);
		this.renderMessage(userMessage);

		// Clear input
		requestInput.value = '';
		requestInput.style.height = 'auto';

		// Show loading
		this.isLoading = true;
		this.loadingTab = requestTab;
		requestButton.disabled = true;
		requestButton.textContent = '⏳';

		const loadingEl = requestContainer.createDiv({ cls: 'gemini-chat-loading' });
		loadingEl.createEl('span', { cls: 'gemini-chat-loading-dots', text: '●●●' });
		const loadingLabel = loadingEl.createEl('span', {
			cls: 'gemini-chat-loading-label',
			text: requestTab === 'agent' ? 'Agent running 0s...' : 'Thinking...'
		});
		const startedAt = Date.now();
		const loadingTimer = requestTab === 'agent'
			? window.setInterval(() => {
				const seconds = Math.floor((Date.now() - startedAt) / 1000);
				loadingLabel.setText(`Agent running ${seconds}s...`);
			}, 1000)
			: null;

		// Scroll to bottom
		this.scrollToBottom();

		try {
			const response = requestTab === 'agent'
				? await this.runAgentMessage(text)
				: await this.plugin.geminiService.chat(text);

			list.push(response);
		} catch (error) {
			const errorMessage: ChatMessage = {
				role: 'model',
				content: `Error: ${error instanceof Error ? error.message : 'Failed to get response'}`
			};
			list.push(errorMessage);
		} finally {
			if (loadingTimer !== null) window.clearInterval(loadingTimer);
			loadingEl.remove();
			this.isLoading = false;
			this.loadingTab = null;

			if (this.activeTab === requestTab) {
				this.renderActiveTab();
			}
		}
	}

	private async runAgentMessage(text: string): Promise<ChatMessage> {
		const result = await this.plugin.agentService.run(text);
		const sourcePath = `${this.plugin.settings.workspaceFolder}/agent`;
		return {
			role: 'model',
			content: [
				result.content,
				'',
				'---',
				`Agent command: \`${result.command}\``,
				`Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
				result.exitCode === 0 ? '' : `Exit code: ${result.exitCode ?? 'unknown'}`
			].filter(Boolean).join('\n'),
			citations: [{
				sourceId: 'agent-workspace',
				sourcePath,
				content: ''
			}]
		};
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
				this.renderCitationPreview(citationsEl, citation);
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

	private renderCitationPreview(container: HTMLElement, citation: Citation) {
		const card = container.createDiv({ cls: 'gemini-chat-citation-card' });
		const file = this.resolveCitationFile(citation.sourcePath);
		const title = file?.basename || this.getCitationTitle(citation.sourcePath);

		const header = card.createDiv({ cls: 'gemini-chat-citation-header' });
		header.createEl('div', { cls: 'gemini-chat-citation-title', text: title });
		header.createEl('div', {
			cls: 'gemini-chat-citation-path',
			text: file?.path || citation.sourcePath
		});

		const excerptEl = card.createEl('p', {
			cls: 'gemini-chat-citation-excerpt',
			text: file ? 'Loading preview...' : 'Source note was not found in this vault.'
		});

		const actions = card.createDiv({ cls: 'gemini-chat-citation-actions' });
		const openButton = actions.createEl('button', {
			cls: 'gemini-chat-citation-open',
			text: file ? 'Open note' : 'Find note'
		});
		openButton.addEventListener('click', () => this.openNote(citation.sourcePath));

		if (!file) return;

		this.app.vault.read(file)
			.then(content => {
				excerptEl.setText(this.makeExcerpt(content));
			})
			.catch(() => {
				excerptEl.setText('Preview could not be loaded.');
			});
	}

	private resolveCitationFile(path: string): TFile | null {
		const candidates = this.getCitationPathCandidates(path);
		for (const candidate of candidates) {
			const file = this.app.vault.getAbstractFileByPath(candidate);
			if (file instanceof TFile) return file;
		}

		const normalizedCandidates = new Set(candidates.map(candidate => this.normalizeCitationPath(candidate)));
		return this.app.vault.getMarkdownFiles().find(file => {
			const normalizedPath = this.normalizeCitationPath(file.path);
			const normalizedName = this.normalizeCitationPath(file.name);
			return normalizedCandidates.has(normalizedPath) ||
				normalizedCandidates.has(normalizedName) ||
				Array.from(normalizedCandidates).some(candidate =>
					normalizedPath.endsWith(candidate) || normalizedName === candidate
				);
		}) || null;
	}

	private getCitationPathCandidates(path: string): string[] {
		const cleaned = path
			.trim()
			.replace(/^\[\[/, '')
			.replace(/\]\]$/, '')
			.replace(/^["']|["']$/g, '')
			.split('|')[0]
			.trim();
		if (!cleaned) return [];
		const candidates = [cleaned];
		if (!cleaned.endsWith('.md')) candidates.push(`${cleaned}.md`);
		return Array.from(new Set(candidates));
	}

	private normalizeCitationPath(path: string): string {
		return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
	}

	private getCitationTitle(path: string): string {
		const cleaned = this.getCitationPathCandidates(path)[0] || path;
		return cleaned.split('/').pop()?.replace(/\.md$/i, '') || cleaned;
	}

	private makeExcerpt(content: string): string {
		const stripped = content
			.replace(/^---[\s\S]*?---/, '')
			.replace(/```[\s\S]*?```/g, '')
			.replace(/!\[[^\]]*]\([^)]+\)/g, '')
			.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			.replace(/[#>*_`~-]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		if (!stripped) return 'This source note has no previewable text.';
		return stripped.length > 220 ? `${stripped.slice(0, 220).trim()}...` : stripped;
	}

	private clearChat() {
		if (this.activeTab === 'agent') {
			this.agentMessages = [];
		} else {
			this.messages = [];
			this.plugin.geminiService.clearChatHistory();
		}
		this.messagesContainer.empty();
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
			{ text: '📂 Select Note...', action: () => this.selectNoteToApply(message.content, message.citations) },
			{ text: `🧠 Save to ${this.plugin.settings.workspaceFolder}`, action: () => this.saveToWorkspace(message.content, message.citations) }
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

		const label = this.activeTab === 'agent' ? 'Agent Result' : 'Gemini Response';
		let result = `\n\n---\n*🤖 ${label} (${dateStr})*\n\n${content}`;

		if (citations && citations.length > 0) {
			result += '\n\n**Sources:**\n';
			for (const citation of citations) {
				result += `- [[${citation.sourcePath}]]\n`;
			}
		}

		result += '\n---\n';
		return result;
	}

	private async saveToWorkspace(content: string, citations?: Citation[]) {
		const folder = await this.plugin.ensureWorkspaceFolder(this.activeTab === 'agent' ? 'agent' : 'compiled');
		const now = new Date();
		const dateStr = now.toISOString().slice(0, 10);
		const timeStr = now.toTimeString().slice(0, 5).replace(':', '-');
		const fileName = `${folder}/Master of Knowledge ${dateStr} ${timeStr}.md`;
		const formattedContent = this.formatContentWithMetadata(content, citations);
		try {
			const file = await this.app.vault.create(fileName, formattedContent);
			await this.app.workspace.openLinkText(file.path, '', true);
			new Notice(`✅ Saved to ${file.path}`);
		} catch (error) {
			new Notice('Failed to save workspace note.');
			console.error('Workspace save error:', error);
		}
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
