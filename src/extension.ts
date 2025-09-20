import * as vscode from 'vscode';
import { GoAllocationsProvider, AllocationItem } from './goAllocationsProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new GoAllocationsProvider();

    // Global cancellation controller for stopping benchmarks
    let currentAbortController: AbortController | null = null;

    // Register the tree data provider
    let treeView: vscode.TreeView<AllocationItem> | undefined;
    try {
        treeView = vscode.window.createTreeView('goAllocationsExplorer', {
            treeDataProvider: provider,
            showCollapseAll: true
        });

        // Add the tree view to subscriptions
        context.subscriptions.push(treeView);

        // Handle clicks on allocation lines
        treeView.onDidChangeSelection(async (e) => {
            if (e.selection.length > 0) {
                const selectedItem = e.selection[0];
                if (selectedItem.contextValue === 'allocationLine' && selectedItem.filePath && selectedItem.lineNumber) {
                    // Open file at line
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selectedItem.filePath));
                    const editor = await vscode.window.showTextDocument(document);
                    const position = new vscode.Position(selectedItem.lineNumber - 1, 0); // Convert to 0-based line number
                    editor.selection = new vscode.Selection(position, position);
                    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                }
            }
        });
    } catch (error) {
        console.error('Error creating tree view:', error);
        vscode.window.showErrorMessage('Error creating tree view: ' + (error as Error).message);
    }

    // Register commands
    const openFileCommand = vscode.commands.registerCommand('goAllocations.openFile', (item) => {
        if (item && item.filePath) {
            vscode.window.showTextDocument(vscode.Uri.file(item.filePath));
        }
    });


    const runAllBenchmarksCommand = vscode.commands.registerCommand('goAllocations.runAllBenchmarks', async () => {
        // Cancel any existing operation
        if (currentAbortController) {
            currentAbortController.abort();
        }

        // Create new abort controller for this operation
        currentAbortController = new AbortController();
        const abortSignal = currentAbortController.signal;

        try {
            if (treeView) {
                // Check if cancelled before starting
                if (abortSignal.aborted) {
                    return;
                }

                // Get all root items (packages)
                const rootItems = await provider.getChildren();

                // Collect all benchmark functions first
                const allBenchmarks: { packageItem: AllocationItem; benchmarkFunction: AllocationItem }[] = [];

                for (const packageItem of rootItems) {
                    if (abortSignal.aborted) {
                        return;
                    }

                    if (packageItem.contextValue === 'package') {
                        // Expand the package node
                        await treeView.reveal(packageItem, { expand: true });

                        // Get benchmark functions for this package
                        const benchmarkFunctions = await provider.getChildren(packageItem);

                        // Collect all benchmark functions
                        for (const benchmarkFunction of benchmarkFunctions) {
                            if (benchmarkFunction.contextValue === 'benchmarkFunction') {
                                allBenchmarks.push({ packageItem, benchmarkFunction });
                            }
                        }
                    }
                }

                // Simple semaphore: run 4 benchmarks concurrently
                const concurrency = 4;
                const semaphore = new Array(concurrency).fill(null);

                const runBenchmark = async (benchmark: { packageItem: AllocationItem; benchmarkFunction: AllocationItem }) => {
                    // Check if cancelled before running this benchmark
                    if (abortSignal.aborted) {
                        throw new Error('Operation cancelled');
                    }

                    // Expand the benchmark function node
                    if (treeView) {
                        await treeView.reveal(benchmark.benchmarkFunction, { expand: true });
                    }

                    // Get allocation data for this benchmark (this will run the benchmark)
                    // Pass the abort signal to the provider
                    await provider.getChildren(benchmark.benchmarkFunction, abortSignal);
                };

                // Process benchmarks with concurrency control while preserving display order
                const processBenchmarks = async () => {
                    const allPromises = allBenchmarks.map(async (benchmark) => {
                        // Wait for a semaphore slot
                        let acquired = false;
                        while (!acquired && !abortSignal.aborted) {
                            for (let i = 0; i < concurrency; i++) {
                                if (semaphore[i] === null) {
                                    semaphore[i] = benchmark;
                                    acquired = true;
                                    break;
                                }
                            }
                            if (!acquired) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                        }

                        if (abortSignal.aborted) {
                            return;
                        }

                        try {
                            await runBenchmark(benchmark);
                        } catch (error) {
                            if (abortSignal.aborted) {
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

                if (abortSignal.aborted) {
                    vscode.window.showInformationMessage('Benchmark operation cancelled');
                }
            } else {
                console.error('Tree view not available');
                vscode.window.showErrorMessage('Tree view not available');
            }
        } catch (error) {
            if (abortSignal.aborted) {
                console.log('Operation cancelled');
                vscode.window.showInformationMessage('Benchmark operation cancelled');
            } else {
                console.error('Error running all benchmarks:', error);
                vscode.window.showErrorMessage('Error running all benchmarks: ' + (error as Error).message);
            }
        } finally {
            currentAbortController = null;
        }
    });

    const stopAllBenchmarksCommand = vscode.commands.registerCommand('goAllocations.stopAllBenchmarks', () => {
        if (currentAbortController) {
            console.log('Aborting current benchmark operation...');
            currentAbortController.abort();
            vscode.window.showInformationMessage('Stopping all benchmarks. Go processes may take a moment to terminate.');
        } else {
            vscode.window.showInformationMessage('No benchmarks currently running');
        }
    });

    const runSingleBenchmarkCommand = vscode.commands.registerCommand('goAllocations.runSingleBenchmark', async (benchmarkItem: AllocationItem) => {
        if (!benchmarkItem || benchmarkItem.contextValue !== 'benchmarkFunction') {
            vscode.window.showErrorMessage('Invalid benchmark item');
            return;
        }

        if (!treeView) {
            vscode.window.showErrorMessage('Tree view not available');
            return;
        }

        // Cancel any existing operation
        if (currentAbortController) {
            currentAbortController.abort();
        }

        // Create new abort controller for this operation
        currentAbortController = new AbortController();
        const abortSignal = currentAbortController.signal;

        try {
            // Clear the benchmark run state and delete existing children
            provider.clearBenchmarkRunState(benchmarkItem);
            // Expand the node to trigger getChildren and run the benchmark
            await treeView.reveal(benchmarkItem, { expand: true });
        } catch (error) {
            if (abortSignal?.aborted) {
                console.log('Benchmark operation cancelled');
                vscode.window.showInformationMessage('Benchmark operation cancelled');
            } else {
                console.error('Error running single benchmark:', error);
                vscode.window.showErrorMessage('Error running benchmark: ' + (error as Error).message);
            }
        } finally {
            currentAbortController = null;
        }
    });

    const refreshCommand = vscode.commands.registerCommand('goAllocations.refresh', () => {
        // Cancel any existing operations first
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }

        // Refresh the provider
        provider.refresh();
    });

    context.subscriptions.push(runAllBenchmarksCommand, stopAllBenchmarksCommand, runSingleBenchmarkCommand, refreshCommand, openFileCommand);
}

export function deactivate() { }
