import * as vscode from 'vscode';
import { GoAllocationsProvider } from './goAllocationsProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Go Allocations extension is now active!');
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

    const openFileCommand = vscode.commands.registerCommand('goAllocations.openFile', (item) => {
        if (item && item.filePath) {
            vscode.window.showTextDocument(vscode.Uri.file(item.filePath));
        }
    });

    const runSingleBenchmarkCommand = vscode.commands.registerCommand('goAllocations.runSingleBenchmark', async (item) => {
        if (!item || !item.filePath) {
            vscode.window.showErrorMessage('No benchmark selected');
            return;
        }

        const terminal = vscode.window.createTerminal(`Go Benchmark: ${item.label}`);
        terminal.show();
        terminal.sendText(`cd "${item.filePath}" && go test -bench=^${item.label}$ -benchmem`);
    });

    // Add a simple test command
    const testCommand = vscode.commands.registerCommand('goAllocations.test', () => {
        vscode.window.showInformationMessage('Test command works!');
    });

    context.subscriptions.push(refreshCommand, runBenchmarksCommand, openFileCommand, runSingleBenchmarkCommand, testCommand);
}

export function deactivate() { }
