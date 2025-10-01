import * as vscode from 'vscode';
import * as path from 'path';
import { Provider, Item, BenchmarkItem, AllocationItem } from './provider';

export async function activate(context: vscode.ExtensionContext) {
    const provider = new Provider();

    let options: vscode.TreeViewOptions<Item> = {
        treeDataProvider: provider,
        showCollapseAll: true
    }
    let treeView = vscode.window.createTreeView<Item>('goAllocationsExplorer', options);
    context.subscriptions.push(treeView);

    // Handle clicks on allocation lines
    treeView.onDidChangeSelection(async (e) => {
        if (e.selection.length === 0) {
            return;
        }

        const selectedItem = e.selection[0];
        if (!(selectedItem instanceof AllocationItem)) {
            return;
        }

        // Open file at line
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selectedItem.filePath));
        const editor = await vscode.window.showTextDocument(document);
        const position = new vscode.Position(selectedItem.lineNumber - 1, 0); // Convert to 0-based line number
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    });

    // Register commands
    const runAllBenchmarksSimple = vscode.commands.registerCommand('goAllocations.runAllBenchmarksSimple',
        async () => {
            try {
                await provider.runAllBenchmarksSimple(treeView);
            } catch (error) {
                if (provider.abortSignal().aborted) {
                    vscode.window.showInformationMessage('Operation(s) cancelled');
                } else {
                    console.error('Error running all benchmarks:', error);
                    vscode.window.showErrorMessage('Error running all benchmarks: ' + (error as Error).message);
                }
            }
        });
    context.subscriptions.push(runAllBenchmarksSimple);

    const stopAllBenchmarks = vscode.commands.registerCommand('goAllocations.stopAllBenchmarks',
        () => {
            vscode.window.showInformationMessage('Cancelling operation(s). Go processes may take a moment to terminate.');
            provider.cancelAll();
        });
    context.subscriptions.push(stopAllBenchmarks);

    const runSingleBenchmark = vscode.commands.registerCommand('goAllocations.runSingleBenchmark',
        async (benchmarkItem: BenchmarkItem) => {
            const signal = provider.abortSignal();

            try {
                provider.clearBenchmarkRunState(benchmarkItem);
                await treeView.reveal(benchmarkItem, { expand: true });
            } catch (error) {
                if (signal.aborted) {
                    console.log('Benchmark operation cancelled');
                    vscode.window.showInformationMessage('Benchmark operation cancelled');
                } else {
                    console.error('Error running single benchmark:', error);
                    vscode.window.showErrorMessage('Error running benchmark: ' + (error as Error).message);
                }
            }
            // Note: We don't need a finally block to clean up - the manager handles lifecycle
        });
    context.subscriptions.push(runSingleBenchmark);

    const refresh = vscode.commands.registerCommand('goAllocations.refresh',
        () => provider.refresh());
    context.subscriptions.push(refresh);

    // Register a CodeLens provider for Go benchmark functions
    const codeLensProvider = vscode.languages.registerCodeLensProvider({ language: 'go', scheme: 'file' }, new GoBenchmarkCodeLensProvider(provider, () => treeView));
    context.subscriptions.push(codeLensProvider);

    // Command invoked by CodeLens in editor to run a specific benchmark
    const runBenchmarkFromEditor = vscode.commands.registerCommand('goAllocations.runBenchmarkFromEditor', async (args: { packageDir: string; benchmarkName: string }) => {
        if (!args || !args.packageDir || !args.benchmarkName) {
            return;
        }

        // Ensure discovery is ready so we can reveal the correct tree item
        await provider.ensurePackagesLoaded();

        const item = provider.findBenchmarkItem(args.packageDir, args.benchmarkName);
        if (!item) {
            vscode.window.showWarningMessage(`Benchmark ${args.benchmarkName} not found in Go Allocations Explorer.`);
            return;
        }

        // Focus the Go Allocations Explorer view
        await vscode.commands.executeCommand('workbench.view.extension.goAllocations');

        // Trigger the run by revealing the item (which loads children)
        await treeView.reveal(item, { expand: true });
    });
    context.subscriptions.push(runBenchmarkFromEditor);
}

export function deactivate() { }

class GoBenchmarkCodeLensProvider implements vscode.CodeLensProvider {
    private readonly benchRegex = /^\s*func\s+(Benchmark[\w\d_]*)\s*\(b\s*\*testing\.B\)/;
    private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeCodeLensesEmitter.event;

    constructor(private provider: Provider, private getTreeView: () => vscode.TreeView<Item>) { }

    provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
        // Only add to _test.go files
        if (!document.fileName.endsWith('_test.go')) return [];

        const lenses: vscode.CodeLens[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const m = line.text.match(this.benchRegex);
            if (m) {
                const benchName = m[1];
                const range = new vscode.Range(i, 0, i, line.text.length);
                const packageDir = this.getPackageDir(document.uri);
                const cmd: vscode.Command = {
                    command: 'goAllocations.runBenchmarkFromEditor',
                    title: 'Run in Allocations Explorer',
                    arguments: [{ packageDir, benchmarkName: benchName }]
                };
                lenses.push(new vscode.CodeLens(range, cmd));
            }
        }
        return lenses;
    }

    // Resolve not needed since we provide command inline
    resolveCodeLens?(codeLens: vscode.CodeLens, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens> {
        return codeLens;
    }

    private getPackageDir(uri: vscode.Uri): string {
        // For Go, the package dir is the file's folder
        return path.dirname(uri.fsPath);
    }
}
