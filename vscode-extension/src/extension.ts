import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

// ── Constants ───────────────────────────────────────────────────────────────

const MEMORY_TEMPLATE = `# PROJECT MEMORY — {projectName}

## Identity
- Project: {projectName}
- Purpose: (describe what this project does)

## Environment
- Language: (e.g., Python 3.11, TypeScript 5, Go 1.22)
- Package manager: (e.g., pip, uv, pnpm, cargo)
- Framework: (e.g., FastAPI, Next.js, none)
- Runtime: (e.g., CPython, Node.js 20, PyPy)

## Critical Requirements
### (Category — e.g., Package Manager)
- REQUIRED: (what must be used)
- FORBIDDEN: (what must NOT be used)
- Reason: (why)

## Forbidden Patterns
- (list things the AI should never suggest)

## Common Mistakes
| Wrong | Correct | Why |
|-------|---------|-----|
| \`(wrong command)\` | \`(correct command)\` | (reason) |
`;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("aisanity");
}

function getMcpServerPath(): string {
    return path.join(__dirname, "..", "python", "mcp_server.py");
}

function getMemoryFileName(): string {
    return getConfig().get<string>("memoryFile", ".ai-memory.md");
}

/** Check if a .ai-memory.md file exists in any workspace folder. */
function findMemoryFile(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
        return undefined;
    }
    const memoryFileName = getMemoryFileName();
    for (const folder of folders) {
        const memoryPath = path.join(folder.uri.fsPath, memoryFileName);
        if (fs.existsSync(memoryPath)) {
            return memoryPath;
        }
    }
    return undefined;
}

// ── MCP Server Provider ─────────────────────────────────────────────────────

class AisanityMcpProvider
    implements vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition>
{
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

    provideMcpServerDefinitions(
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.McpStdioServerDefinition[]> {
        const config = getConfig();
        const ollamaUrl = config.get<string>("ollamaUrl", "http://192.168.86.45:11434");
        const ollamaModel = config.get<string>("ollamaModel", "devstral:24b");
        const githubModel = config.get<string>("githubModel", "openai/gpt-4o-mini");
        const memoryFile = getMemoryFileName();

        const mcpServerPath = getMcpServerPath();
        if (!fs.existsSync(mcpServerPath)) {
            vscode.window.showErrorMessage(
                `aisanity: MCP server not found at ${mcpServerPath}`
            );
            return [];
        }

        const args = [
            mcpServerPath,
            "--ollama-url", ollamaUrl,
            "--ollama-model", ollamaModel,
            "--github-model", githubModel,
            "--memory", memoryFile,
        ];

        const env: Record<string, string | null> = {};
        const githubToken = process.env.GITHUB_TOKEN;
        if (githubToken) {
            env["GITHUB_TOKEN"] = githubToken;
        }

        const server = new vscode.McpStdioServerDefinition(
            "aisanity",
            "python3",
            args,
            env,
            "0.1.0"
        );

        return [server];
    }

    resolveMcpServerDefinition(
        server: vscode.McpStdioServerDefinition,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.McpStdioServerDefinition> {
        // Set cwd to the workspace folder so .ai-memory.md is found
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            (server as any).cwd = folders[0].uri.fsPath;
        }
        return server;
    }

    refresh(): void {
        this._onDidChange.fire();
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

async function initProject(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage("aisanity: No workspace folder open");
        return;
    }

    // Pick folder if multi-root
    let folder: vscode.WorkspaceFolder;
    if (folders.length === 1) {
        folder = folders[0];
    } else {
        const picked = await vscode.window.showWorkspaceFolderPick({
            placeHolder: "Select workspace folder to initialize aisanity in",
        });
        if (!picked) {
            return;
        }
        folder = picked;
    }

    const memoryFileName = getMemoryFileName();
    const memoryPath = path.join(folder.uri.fsPath, memoryFileName);
    const projectName = path.basename(folder.uri.fsPath);

    if (fs.existsSync(memoryPath)) {
        vscode.window.showInformationMessage(
            `aisanity: ${memoryFileName} already exists in ${projectName}`
        );
    } else {
        const content = MEMORY_TEMPLATE.replace(/{projectName}/g, projectName);
        fs.writeFileSync(memoryPath, content, "utf-8");
        vscode.window.showInformationMessage(
            `aisanity: Created ${memoryFileName} in ${projectName}`
        );
        // Open the file for editing
        const doc = await vscode.workspace.openTextDocument(memoryPath);
        await vscode.window.showTextDocument(doc);
    }
}

async function showMemory(): Promise<void> {
    const memoryPath = findMemoryFile();
    if (!memoryPath) {
        const action = await vscode.window.showWarningMessage(
            "aisanity: No .ai-memory.md found. Create one?",
            "Init Project"
        );
        if (action === "Init Project") {
            await initProject();
        }
        return;
    }
    const doc = await vscode.workspace.openTextDocument(memoryPath);
    await vscode.window.showTextDocument(doc);
}

async function validateSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage("aisanity: No active editor");
        return;
    }

    const selection = editor.selection;
    const text = selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);

    if (!text.trim()) {
        vscode.window.showWarningMessage("aisanity: No text selected or file is empty");
        return;
    }

    // Use the terminal to run validation
    const config = getConfig();
    const guardianPath = path.join(__dirname, "..", "python", "guardian.py");
    const ollamaUrl = config.get<string>("ollamaUrl", "http://192.168.86.45:11434");
    const ollamaModel = config.get<string>("ollamaModel", "devstral:24b");

    const terminal = vscode.window.createTerminal("aisanity");
    terminal.show();

    // Escape the text for shell
    const escaped = text.replace(/'/g, "'\\''");
    terminal.sendText(
        `echo '${escaped}' | python3 "${guardianPath}" --check ` +
        `--ollama-url "${ollamaUrl}" --ollama-model "${ollamaModel}" --fix`
    );
}

// ── Status Bar ──────────────────────────────────────────────────────────────

function createStatusBarItem(): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    item.command = "aisanity.showMemory";

    const memoryPath = findMemoryFile();
    if (memoryPath) {
        item.text = "$(shield) aisanity";
        item.tooltip = "aisanity active — click to view project memory";
        item.backgroundColor = undefined;
    } else {
        item.text = "$(shield) aisanity (no memory)";
        item.tooltip = "No .ai-memory.md found — click to create one";
        item.backgroundColor = new vscode.ThemeColor(
            "statusBarItem.warningBackground"
        );
    }

    item.show();
    return item;
}

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    // Register MCP server provider
    const mcpProvider = new AisanityMcpProvider();
    context.subscriptions.push(
        vscode.lm.registerMcpServerDefinitionProvider(
            "aisanity.mcp-server",
            mcpProvider
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand("aisanity.init", initProject),
        vscode.commands.registerCommand("aisanity.showMemory", showMemory),
        vscode.commands.registerCommand("aisanity.validate", validateSelection)
    );

    // Status bar
    const statusBar = createStatusBarItem();
    context.subscriptions.push(statusBar);

    // Watch for .ai-memory.md changes to update status bar
    const watcher = vscode.workspace.createFileSystemWatcher(
        `**/${getMemoryFileName()}`
    );
    const updateStatusBar = () => {
        const memoryPath = findMemoryFile();
        if (memoryPath) {
            statusBar.text = "$(shield) aisanity";
            statusBar.tooltip = "aisanity active — click to view project memory";
            statusBar.backgroundColor = undefined;
        } else {
            statusBar.text = "$(shield) aisanity (no memory)";
            statusBar.tooltip = "No .ai-memory.md found — click to create one";
            statusBar.backgroundColor = new vscode.ThemeColor(
                "statusBarItem.warningBackground"
            );
        }
        mcpProvider.refresh();
    };

    watcher.onDidCreate(updateStatusBar);
    watcher.onDidDelete(updateStatusBar);
    context.subscriptions.push(watcher);

    // Refresh MCP when settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("aisanity")) {
                mcpProvider.refresh();
                updateStatusBar();
            }
        })
    );
}

export function deactivate(): void {
    // cleanup handled by disposables
}
