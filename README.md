# Master of Knowledge

Turn your Obsidian vault into a Gemini File Search and Agent-powered knowledge workspace. Ask your notes, inspect sources, run Antigravity/AGY jobs from inside Obsidian, and apply the result back into notes.

## Features

### Master Dashboard
- Chat, Agent, Budget, and `_omg` workspace tabs in one Obsidian sidebar
- Shared Sources, Apply, and Copy actions for both Gemini answers and Agent results
- Agent results can be saved into the `_omg` workspace without touching source notes

### Folder-based Auto-Sync
- Automatically sync markdown files from one or more designated folders (including subfolders) to Gemini
- File changes (create/modify/delete/rename) are tracked and synced in real-time
- Content-based change detection using SHA-256 hashing to minimize API calls

### Chat with Your Notes (RAG)
- Dedicated chat interface in the right sidebar
- AI answers are grounded in your synced notes
- **Citations**: Clickable links to source notes mentioned in responses
- Chat history maintained during session

### Agent Workspace
- Run Antigravity/AGY from the dashboard using the Agent tab
- Active vault context, selected sync folders, trust mode, and `_omg` workspace are passed to the agent prompt
- Agent output uses the same Apply, Copy, Create Note, Select Note, and Save to `_omg` actions as chat

### Budget Guard
- Monthly USD budget setting
- Dashboard budget meter for Gemini and Agent workflows
- Designed for future live token accounting and model fallback policy

### Smart Status Management
- **Status Bar**: Shows sync status at a glance
- **Settings Dashboard**: View total synced files, pending uploads, and errors
- Debounced sync to reduce API calls during rapid edits

## Installation

### From Source
1. Clone this repository into your vault's `.obsidian/plugins/` directory
2. Run `npm install` to install dependencies
3. Run `npm run build` to build the plugin
4. Enable "Master of Knowledge" in Obsidian's Community Plugins settings

### Manual
1. Download the latest release (`main.js`, `manifest.json`, `styles.css`)
2. Create a folder `.obsidian/plugins/master-of-knowledge` in your vault
3. Copy the downloaded files into the folder
4. Enable the plugin in Obsidian settings

> Note: version `2.0.0` changes the plugin ID to `master-of-knowledge` for official Obsidian Community Plugin submission compatibility. If you installed an older BRAT build under `obsidian-gemini-sync`, install this release into the new folder name and copy your settings if needed.

## Setup

1. **Get a Gemini API Key**
   - Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
   - Create a new API key
   - Copy the key

2. **Configure the Plugin**
   - Open Obsidian Settings > Master of Knowledge
   - Paste your API key and click "Verify"
   - Select one or more folders to sync (e.g., "Notes" and "Knowledge")
   - Click "Sync Now" for initial synchronization

3. **Start Chatting**
   - Click the chat icon in the left ribbon (or use the command palette)
   - Ask questions about your notes!

## Usage

### Chat Commands
- **Open Dashboard**: Click the ribbon icon or use `Ctrl/Cmd + P` > "Open Master of Knowledge"
- **Clear Chat**: Click the trash icon in the chat header
- **Force Sync**: Settings > Actions > "Sync Now"
- **Run Agent**: Open the Agent tab and enter an Antigravity/AGY task

### Example Prompts
- "What are the main topics in my notes?"
- "Summarize my notes about [topic]"
- "Find connections between [topic A] and [topic B]"
- "What did I write about [specific subject]?"

## Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| API Key | Your Google Gemini API key | Required |
| Sync Folders | Folders to sync with Gemini | None |
| Corpus Display Name | Name for your knowledge base | "Obsidian Vault" |
| Auto Sync | Automatically sync on file changes | Enabled |
| Sync Debounce | Wait time before syncing (ms) | 3000 |

## Important Notes

### API Key Security
- Your API key is stored locally in the plugin's data file
- Never share your `data.json` file as it contains your API key

### Cost Considerations
- Google Gemini API has usage-based pricing
- Free tier available but heavy usage may incur costs
- Monitor your usage in Google Cloud Console

### Limitations
- Desktop only (Mac/Windows)
- Markdown files only
- Large vaults may take time for initial sync
- Context length limits may affect very large notes

## Troubleshooting

### "API key is invalid"
- Verify your API key in Google AI Studio
- Make sure the Gemini API is enabled in your Google Cloud project

### "Sync not working"
- Check if the sync folder is correctly selected
- Look at the status dashboard for error messages
- Try "Force Sync" in settings

### "Chat not responding"
- Verify your API key is still valid
- Check your internet connection
- Look for errors in the developer console (Ctrl+Shift+I)

## Development

```bash
# Install dependencies
npm install

# Development mode (watch)
npm run dev

# Production build
npm run build
```

## License

MIT

## Credits

- Built with [Obsidian Plugin API](https://github.com/obsidianmd/obsidian-api)
- Powered by [Google Gemini API](https://ai.google.dev/)
