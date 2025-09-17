import * as vscode from 'vscode';
import { GoAllocationsProvider } from './goAllocationsProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Go Allocations extension is now active!');
    console.log('Workspace folders:', vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath));
    vscode.window.showInformationMessage('Go Allocations extension activated!');

    // Create the provider
    const provider = new GoAllocationsProvider();

    // Register the tree data provider
    console.log('Creating tree view...');
    try {
        const treeView = vscode.window.createTreeView('goAllocationsExplorer', {
            treeDataProvider: provider,
            showCollapseAll: true
        });
        console.log('Tree view created successfully:', treeView);

        // Add the tree view to subscriptions
        context.subscriptions.push(treeView);
        console.log('Tree view added to subscriptions');
    } catch (error) {
        console.error('Error creating tree view:', error);
        vscode.window.showErrorMessage('Error creating tree view: ' + (error as Error).message);
    }

    // Register commands
    const refreshCommand = vscode.commands.registerCommand('goAllocations.refresh', () => {
        provider.refresh();
    });

    const runBenchmarksCommand = vscode.commands.registerCommand('goAllocations.runBenchmarks', async () => {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        const terminal = vscode.window.createTerminal('Go Benchmarks');
        terminal.show();
        terminal.sendText(`cd "${workspaceFolder.uri.fsPath}" && go test -bench=. -benchmem`);
    });

    const runBenchmarksWithMemprofileCommand = vscode.commands.registerCommand('goAllocations.runBenchmarksWithMemprofile', async () => {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        const terminal = vscode.window.createTerminal('Go Benchmarks with Memory Profiling');
        terminal.show();
        terminal.sendText(`cd "${workspaceFolder.uri.fsPath}" && go test -bench=. -benchmem -memprofile=memprofile.pb.gz`);
    });

    const openFileCommand = vscode.commands.registerCommand('goAllocations.openFile', (item) => {
        if (item && item.filePath) {
            vscode.window.showTextDocument(vscode.Uri.file(item.filePath));
        }
    });

    const openFileAtLineCommand = vscode.commands.registerCommand('goAllocations.openFileAtLine', async (filePath: string, lineNumber: number) => {
        if (filePath && lineNumber) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const editor = await vscode.window.showTextDocument(document);
            const position = new vscode.Position(lineNumber - 1, 0); // Convert to 0-based line number
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
    });

    context.subscriptions.push(refreshCommand, runBenchmarksCommand, runBenchmarksWithMemprofileCommand, openFileCommand, openFileAtLineCommand);
}

export function deactivate() { }
