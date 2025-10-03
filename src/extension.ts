import * as vscode from 'vscode';
import { TreeDataProvider, Item, BenchmarkItem } from './treedata';
import { CodeLensProvider } from './codelens';

export async function activate(context: vscode.ExtensionContext) {
    const treeData = new TreeDataProvider();

    let options: vscode.TreeViewOptions<Item> = {
        treeDataProvider: treeData,
        showCollapseAll: true
    }
    let treeView = vscode.window.createTreeView<Item>('goAllocationsExplorer', options);
    context.subscriptions.push(treeView);

    // Handle clicks on allocation lines
    treeView.onDidChangeSelection(async (e) => {
        await treeData.handleSelection(e);
    });

    // Register commands
    const runAllBenchmarks = vscode.commands.registerCommand('goAllocations.runAllBenchmarks',
        async () => {
            try {
                await treeData.runAllBenchmarks(treeView);
            } catch (error) {
                if (treeData.abortSignal().aborted) {
                    vscode.window.showInformationMessage('Operation(s) cancelled');
                } else {
                    console.error('Error running all benchmarks:', error);
                    vscode.window.showErrorMessage('Error running all benchmarks: ' + (error as Error).message);
                }
            }
        });
    context.subscriptions.push(runAllBenchmarks);

    const stopAllBenchmarks = vscode.commands.registerCommand('goAllocations.stopAllBenchmarks',
        () => {
            vscode.window.showInformationMessage('Cancelling operation(s). Go processes may take a moment to terminate.');
            treeData.cancelAll();
        });
    context.subscriptions.push(stopAllBenchmarks);

    const runSingleBenchmark = vscode.commands.registerCommand('goAllocations.runSingleBenchmark',
        async (benchmarkItem: BenchmarkItem) => {
            const signal = treeData.abortSignal();

            try {
                treeData.clearBenchmarkRunState(benchmarkItem);
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
        () => treeData.refresh());
    context.subscriptions.push(refresh);

    const codeLens = vscode.languages.registerCodeLensProvider({ language: 'go', scheme: 'file' }, new CodeLensProvider());
    context.subscriptions.push(codeLens);

    // Command invoked by CodeLens in editor to run a specific benchmark
    const runBenchmarkFromEditor = vscode.commands.registerCommand('goAllocations.runBenchmarkFromEditor', async (args: { packageDir: string; benchmarkName: string }) => {
        try {
            if (!args || !args.packageDir || !args.benchmarkName) {
                throw new Error('Missing benchmark information from editor.');
            }
            // Focus the Go Allocations Explorer view
            await vscode.commands.executeCommand('workbench.view.extension.goAllocations');

            const benchmarkItem = await treeData.findBenchmark(args.packageDir, args.benchmarkName);
            treeData.clearBenchmarkRunState(benchmarkItem);
            await treeView.reveal(benchmarkItem, { expand: true, select: true });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Go Allocations: ${msg}`);
        }
    });
    context.subscriptions.push(runBenchmarkFromEditor);

    const navigateToBenchmark = vscode.commands.registerCommand('goAllocations.navigateToBenchmark', async (benchmarkItem: BenchmarkItem) => {
        try {
            await benchmarkItem.navigateTo();
        } catch (err) {
            vscode.window.showErrorMessage(`${err}`);
        }
    });
    context.subscriptions.push(navigateToBenchmark);
}

export function deactivate() { }
