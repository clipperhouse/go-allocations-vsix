import * as vscode from 'vscode';
import { Provider, Item, ModuleItem, PackageItem, BenchmarkItem, AllocationItem } from './provider';

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
}

export function deactivate() { }
