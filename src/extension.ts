import * as vscode from 'vscode';
import { Provider, Item, ModuleItem, PackageItem, BenchmarkItem, AllocationItem } from './provider';

export function activate(context: vscode.ExtensionContext) {
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
    const runAllBenchmarks = vscode.commands.registerCommand('goAllocations.runAllBenchmarks',
        async () => {
            const signal = provider.abortSignal();

            try {
                // Check if cancelled before starting
                if (signal.aborted) {
                    return;
                }

                // Get all root items (modules)
                const rootItems = await provider.getChildren();

                // Collect all benchmark functions first
                const allBenchmarks: { packageItem: Item; benchmarkFunction: Item }[] = [];

                for (const rootItem of rootItems) {
                    if (signal.aborted) {
                        return;
                    }

                    if (rootItem instanceof ModuleItem) {
                        // Expand the module node
                        await treeView.reveal(rootItem, { expand: true });

                        // Get packages for this module
                        const packageItems = await provider.getChildren(rootItem);

                        for (const packageItem of packageItems) {
                            if (signal.aborted) {
                                return;
                            }

                            if (packageItem instanceof PackageItem) {
                                // Expand the package node
                                await treeView.reveal(packageItem, { expand: true });

                                // Get benchmark functions for this package
                                const benchmarkFunctions = await provider.getChildren(packageItem);

                                // Collect all benchmark functions
                                for (const benchmarkFunction of benchmarkFunctions) {
                                    if (benchmarkFunction instanceof BenchmarkItem) {
                                        allBenchmarks.push({ packageItem, benchmarkFunction });
                                    }
                                }
                            }
                        }
                    }
                }

                const concurrency = 2;
                const semaphore = new Array(concurrency).fill(null);

                const runBenchmark = async (benchmark: { packageItem: Item; benchmarkFunction: Item }) => {
                    // Check if cancelled before running this benchmark
                    if (signal.aborted) {
                        throw new Error('Operation cancelled');
                    }

                    // Expand the benchmark function node (treeView is guaranteed to exist at this point)
                    await treeView.reveal(benchmark.benchmarkFunction, { expand: true });

                    // Get allocation data for this benchmark (this will run the benchmark)
                    // Pass the abort signal to the provider
                    await provider.getChildren(benchmark.benchmarkFunction);
                };

                // Process benchmarks with concurrency control while preserving display order
                const processBenchmarks = async () => {
                    const allPromises = allBenchmarks.map(async (benchmark) => {
                        // Wait for a semaphore slot
                        let acquired = false;
                        while (!acquired && !signal.aborted) {
                            for (let i = 0; i < concurrency; i++) {
                                if (semaphore[i] === null) {
                                    semaphore[i] = benchmark;
                                    acquired = true;
                                    break;
                                }
                            }
                            if (!acquired) {
                                await new Promise(resolve => setTimeout(resolve, 250));
                            }
                        }

                        if (signal.aborted) {
                            return;
                        }

                        try {
                            await runBenchmark(benchmark);
                        } catch (error) {
                            if (signal.aborted) {
                                console.log('Benchmark cancelled:', benchmark.benchmarkFunction.label);
                            } else {
                                console.error('Benchmark error:', error);
                            }
                        } finally {
                            // Release the semaphore slot
                            const slotIndex = semaphore.indexOf(benchmark);
                            if (slotIndex !== -1) {
                                semaphore[slotIndex] = null;
                            }
                        }
                    });

                    // Wait for all benchmarks to complete or be cancelled
                    await Promise.allSettled(allPromises);
                };

                await processBenchmarks();

                if (signal.aborted) {
                    vscode.window.showInformationMessage('Operation(s) cancelled');
                }
            } catch (error) {
                if (signal.aborted) {
                    console.log('Operation cancelled');
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
