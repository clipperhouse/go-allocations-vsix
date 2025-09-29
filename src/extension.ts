import * as vscode from 'vscode';
import { Provider, Item, ModuleItem, PackageItem, BenchmarkItem, AllocationItem } from './provider';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Go Allocations Explorer: Activating...');

    // Check if Go extension is available (required for gopls)
    const goExtension = vscode.extensions.getExtension('golang.go');
    if (!goExtension) {
        const message = 'Go Allocations Explorer requires the Go extension to be installed. Please install the Go extension and reload VS Code.';
        vscode.window.showErrorMessage(message, 'Install Go Extension').then(selection => {
            if (selection === 'Install Go Extension') {
                vscode.commands.executeCommand('workbench.extensions.installExtension', 'golang.go');
            }
        });
        console.error('Go Allocations Explorer: Go extension not found');
        return; // Don't activate if Go extension is missing
    }

    // Ensure Go extension is activated
    if (!goExtension.isActive) {
        console.log('Go Allocations Explorer: Activating Go extension...');
        try {
            await goExtension.activate();
            console.log('Go Allocations Explorer: Go extension activated successfully');
        } catch (error) {
            const message = 'Failed to activate Go extension. Go Allocations Explorer requires gopls to function.';
            vscode.window.showErrorMessage(message);
            console.error('Go Allocations Explorer: Failed to activate Go extension:', error);
            return;
        }
    }

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

    const testDiscoveryPerformance = vscode.commands.registerCommand('goAllocations.testDiscoveryPerformance',
        async () => {
            const output = vscode.window.createOutputChannel('Go Allocations Discovery Test');
            output.clear();
            output.show();

            try {
                output.appendLine('=== Gopls Discovery Performance Test ===\n');

                const testProvider = new Provider();
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    output.appendLine('No workspace folder found');
                    return;
                }

                output.appendLine('Testing gopls-based discovery...');
                const startTime = Date.now();
                await (testProvider as any).loadPackagesFromWorkspace(workspaceFolder.uri.fsPath);
                const discoveryTime = Date.now() - startTime;

                output.appendLine(`\n=== Results ===`);
                output.appendLine(`Gopls discovery completed in ${discoveryTime}ms`);

                // Count discovered items
                const moduleCount = (testProvider as any).modules.length;
                let packageCount = 0;
                let benchmarkCount = 0;

                for (const module of (testProvider as any).modules) {
                    packageCount += module.packages.length;
                    for (const pkg of module.packages) {
                        benchmarkCount += pkg.benchmarks.length;
                    }
                }

                output.appendLine(`Found: ${moduleCount} modules, ${packageCount} packages, ${benchmarkCount} benchmarks`);
                vscode.window.showInformationMessage(`Discovery completed in ${discoveryTime}ms. Found ${benchmarkCount} benchmarks across ${packageCount} packages.`);

            } catch (error) {
                output.appendLine(`Error during discovery test: ${error}`);
                console.error('Discovery test error:', error);
                vscode.window.showErrorMessage(`Discovery test failed: ${error}`);
            }
        });
    context.subscriptions.push(testDiscoveryPerformance);

    const refresh = vscode.commands.registerCommand('goAllocations.refresh',
        () => provider.refresh());
    context.subscriptions.push(refresh);
}

export function deactivate() { }
