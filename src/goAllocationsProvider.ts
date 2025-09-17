import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class GoAllocationsProvider implements vscode.TreeDataProvider<AllocationItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AllocationItem | undefined | null | void> = new vscode.EventEmitter<AllocationItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<AllocationItem | undefined | null | void> = this._onDidChangeTreeData.event;

    // Cache for discovered packages
    private packages: { name: string; path: string }[] = [];
    private packagesLoaded = false;
    private discoveryInProgress = false;
    private updateTimeout: NodeJS.Timeout | null = null;

    // Track which benchmarks have been run
    private runBenchmarks: Set<string> = new Set();

    constructor() {
        console.log('GoAllocationsProvider constructor called');
        console.log('Workspace folders in constructor:', vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath));
    }

    refresh(): void {
        this.packagesLoaded = false;
        this.packages = [];
        this.discoveryInProgress = false;
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
            this.updateTimeout = null;
        }
        this._onDidChangeTreeData.fire();
    }

    clearBenchmarkRunState(benchmarkKey: string): void {
        this.runBenchmarks.delete(benchmarkKey);
        this._onDidChangeTreeData.fire();
    }

    async ensurePackagesLoaded(): Promise<void> {
        if (!this.packagesLoaded && !this.discoveryInProgress) {
            this.discoveryInProgress = true;
            await this.loadPackages();
        }

        // Wait for packages to be loaded
        while (!this.packagesLoaded && this.discoveryInProgress) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    getTreeItem(element: AllocationItem): vscode.TreeItem {
        // For benchmark functions, check if they have been run and update accordingly
        if (element.contextValue === 'benchmarkFunction') {
            const benchmarkKey = `${element.filePath}:${element.label}`;
            const hasBeenRun = this.runBenchmarks.has(benchmarkKey);

            if (hasBeenRun && element.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed) {
                // Update tooltip and add command for re-running
                element.tooltip = `Benchmark function: ${element.label}\nClick to re-run and discover allocations`;
                element.command = {
                    command: 'goAllocations.runSingleBenchmark',
                    title: 'Re-run benchmark',
                    arguments: [element]
                };
            }
        }
        return element;
    }

    getParent(element: AllocationItem): vscode.ProviderResult<AllocationItem> {
        // For our tree structure:
        // - Root level has no parent (return undefined)
        // - Package items have no parent (return undefined)
        // - Benchmark functions have package as parent
        // - Allocation lines have benchmark function as parent

        if (!element) {
            return undefined; // Root level
        }

        if (element.contextValue === 'package') {
            return undefined; // Package is at root level
        }

        if (element.contextValue === 'benchmarkFunction') {
            // Find the parent package by looking at the filePath
            if (element.filePath) {
                const parentPackage = this.packages.find(pkg => pkg.path === element.filePath);
                if (parentPackage) {
                    return new AllocationItem(
                        parentPackage.name,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'package',
                        parentPackage.path
                    );
                }
            }
            return undefined;
        }

        if (element.contextValue === 'allocationLine') {
            // For allocation lines, we need to reconstruct the benchmark function
            // This is tricky since we don't store the parent reference
            // For now, return undefined - this might cause issues with reveal
            return undefined;
        }

        return undefined;
    }


    async getChildren(element?: AllocationItem, abortSignal?: AbortSignal): Promise<AllocationItem[]> {
        console.log('getChildren called with element:', element ? element.label : 'root');

        if (!element) {
            // Root level - show all packages with benchmarks
            console.log('Getting root level children (packages)');

            // If loaded, return packages
            if (this.packagesLoaded) {
                return this.packages.map(pkg => new AllocationItem(
                    pkg.name,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'package',
                    pkg.path
                ));
            }

            // Start loading process only if not already in progress
            if (!this.discoveryInProgress) {
                this.discoveryInProgress = true;
                this.loadPackages().catch(error => {
                    console.error('Error loading packages:', error);
                    this.discoveryInProgress = false;
                });
            }

            // Return current packages (empty initially, will update as packages are discovered)
            return this.packages.map(pkg => new AllocationItem(
                pkg.name,
                vscode.TreeItemCollapsibleState.Expanded,
                'package',
                pkg.path
            ));
        } else if (element.contextValue === 'package') {
            // Show benchmark functions in this package
            console.log('Getting benchmark functions for package:', element.label);
            return this.getBenchmarkFunctions(element);
        } else if (element.contextValue === 'benchmarkFunction') {
            // Show allocation data for the function
            console.log('Getting allocation data for:', element.label);
            return this.getAllocationData(element, abortSignal);
        }

        console.log('No matching context value, returning empty array');
        return Promise.resolve([]);
    }

    private async loadPackages(): Promise<void> {
        console.log('Starting package discovery...');

        if (!vscode.workspace.workspaceFolders) {
            this.packagesLoaded = true;
            this._onDidChangeTreeData.fire();
            return;
        }

        for (const workspaceFolder of vscode.workspace.workspaceFolders) {
            try {
                console.log('Processing workspace folder:', workspaceFolder.uri.fsPath);
                await this.streamPackagesFromWorkspace(workspaceFolder.uri.fsPath);
            } catch (error) {
                console.error('Error processing workspace folder:', error);
            }
        }

        console.log('Package discovery complete. Found', this.packages.length, 'packages');
        this.packagesLoaded = true;
        this.discoveryInProgress = false;
        this._onDidChangeTreeData.fire();
    }

    private async streamPackagesFromWorkspace(rootPath: string): Promise<void> {
        try {
            // Get all packages first
            const { stdout: packagesOutput } = await execAsync('go list -f "{{.Name}} {{.Dir}}" ./...', { cwd: rootPath });
            const packageLines = packagesOutput.trim().split('\n');

            // Process each package individually
            for (let line of packageLines) {
                line = line.trim();
                if (!line) {
                    continue;
                }

                const parts = line.split(' ');
                if (parts.length < 2) {
                    continue;
                }

                const packageName = parts[0];
                const packageDir = parts.slice(1).join(' ');

                try {
                    // Check if this specific package has benchmarks
                    const { stdout: benchmarksOutput } = await execAsync(
                        'go test -list="^Benchmark[A-Z][^/]*$"',
                        { cwd: packageDir }
                    );

                    const benchmarkLines = benchmarksOutput.trim().split('\n');
                    const hasBenchmarks = benchmarkLines.some(line =>
                        line.startsWith('Benchmark') && !line.includes('ok')
                    );

                    if (hasBenchmarks) {
                        // Add package immediately and schedule tree update
                        const pkg = { name: packageName, path: packageDir };
                        this.packages.push(pkg);
                        console.log('Discovered package:', packageName);
                        this.scheduleUpdate();
                    }
                } catch (packageError) {
                    // Skip packages that can't be tested (e.g., no test files)
                    console.warn(`Could not test package ${packageName}:`, packageError);
                }
            }
        } catch (error) {
            console.error('Error streaming packages from workspace:', error);
            throw error;
        }
    }

    private scheduleUpdate(): void {
        // Clear any existing timeout
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
        }

        // Schedule update after a short delay to batch rapid discoveries
        this.updateTimeout = setTimeout(() => {
            this._onDidChangeTreeData.fire();
            this.updateTimeout = null;
        }, 200); // 200ms batching delay
    }

    private async getBenchmarkFunctions(packageItem: AllocationItem): Promise<AllocationItem[]> {
        if (!packageItem.filePath) {
            return [];
        }

        try {
            // Use go test -list to find benchmark functions in the package
            const { stdout } = await execAsync('go test -list="^Benchmark[A-Z][^/]*$"', { cwd: packageItem.filePath });

            const benchmarkFunctions: AllocationItem[] = [];
            const lines = stdout.trim().split('\n');

            for (const line of lines) {
                const functionName = line.trim();
                if (functionName && functionName.startsWith('Benchmark')) {
                    const item = new AllocationItem(
                        functionName,
                        vscode.TreeItemCollapsibleState.Collapsed, // Not expanded by default
                        'benchmarkFunction',
                        packageItem.filePath
                    );
                    benchmarkFunctions.push(item);
                }
            }

            // If no benchmarks found, show a message
            if (benchmarkFunctions.length === 0) {
                benchmarkFunctions.push(new AllocationItem(
                    'No benchmark functions found',
                    vscode.TreeItemCollapsibleState.None,
                    'noBenchmarks'
                ));
            }

            return benchmarkFunctions;
        } catch (error) {
            console.error('Error listing benchmark functions:', error);
            return [
                new AllocationItem(
                    'Error listing benchmarks',
                    vscode.TreeItemCollapsibleState.None,
                    'error'
                )
            ];
        }
    }

    private async getAllocationData(functionItem: AllocationItem, abortSignal?: AbortSignal): Promise<AllocationItem[]> {
        if (!functionItem.filePath) {
            return [];
        }

        try {
            // Check if operation is cancelled before starting
            if (abortSignal?.aborted) {
                throw new Error('Operation cancelled');
            }

            // Create unique temporary file for memory profile
            const tempDir = os.tmpdir();
            const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}-${process.pid}`;
            const memprofilePath = path.join(tempDir, `go-allocations-memprofile-${uniqueId}.pb.gz`);
            const benchmarkName = functionItem.label;

            try {
                // Run the specific benchmark with memory profiling and debug info
                const { stdout, stderr } = await execAsync(
                    `go test -bench=^${benchmarkName}$ -memprofile=${memprofilePath} -run=^$ -gcflags="all=-N -l"`,
                    {
                        cwd: functionItem.filePath,
                        signal: abortSignal
                    }
                );

                if (stderr) {
                    console.error('Benchmark stderr:', stderr);
                }

                // Check if operation was cancelled after benchmark completion
                if (abortSignal?.aborted) {
                    throw new Error('Operation cancelled');
                }

                // Parse the memory profile using pprof
                const allocationData = await this.parseMemoryProfile(memprofilePath, functionItem.filePath, abortSignal);

                // Mark this benchmark as run
                const benchmarkKey = `${functionItem.filePath}:${functionItem.label}`;
                this.runBenchmarks.add(benchmarkKey);

                return allocationData;
            } finally {
                // Clean up the memory profile file
                try {
                    await fs.promises.unlink(memprofilePath);
                } catch (cleanupError) {
                    console.warn('Could not clean up memory profile file:', cleanupError);
                }
            }
        } catch (error) {
            console.error('Error getting allocation data:', error);
            return [
                new AllocationItem(
                    'Error running benchmark with memory profiling',
                    vscode.TreeItemCollapsibleState.None,
                    'error'
                )
            ];
        }
    }

    private async parseMemoryProfile(memprofilePath: string, packagePath: string, abortSignal?: AbortSignal): Promise<AllocationItem[]> {
        try {
            // Check if operation was cancelled before parsing
            if (abortSignal?.aborted) {
                throw new Error('Operation cancelled');
            }

            // Get the list of functions to find the main allocation function
            const { stdout: listOutput } = await execAsync(`go tool pprof -list=. ${memprofilePath}`, {
                cwd: packagePath,
                signal: abortSignal
            });

            const allocationItems: AllocationItem[] = [];
            const lines = listOutput.split('\n');

            let currentFunction = '';
            let currentFile = '';
            let inFunction = false;

            for (const line of lines) {
                const trimmedLine = line.trim();

                // Check if this is a function header
                const functionMatch = trimmedLine.match(/ROUTINE =+ (.+) in (.+)/);
                if (functionMatch) {
                    currentFunction = functionMatch[1];
                    currentFile = functionMatch[2];
                    inFunction = true;
                    continue;
                }

                // Check if we're in a function and this is a line with allocation data
                if (inFunction && trimmedLine && !trimmedLine.includes('Total:') && !trimmedLine.includes('ROUTINE')) {
                    // Parse line format: "flatBytes cumBytes lineNumber: code"
                    // Example: "    2.50MB     5.50MB     36:	s := \"hello\" + strconv.Itoa(rand.Intn(1000))"
                    const lineMatch = trimmedLine.match(/^\s*(\d+(?:\.\d+)?[KMGT]?B)?\s*(\d+(?:\.\d+)?[KMGT]?B)?\s*(\d+):\s*(.+)$/);
                    if (lineMatch) {
                        const flatBytes = lineMatch[1] || '0B';
                        const cumBytes = lineMatch[2] || '0B';
                        const lineNumber = parseInt(lineMatch[3]);
                        const codeLine = lineMatch[4];

                        if (lineNumber > 0 && (flatBytes !== '0B' || cumBytes !== '0B')) {
                            // Only show allocations from user code, not runtime
                            const isUser = await this.isUserCode(currentFile, currentFunction);
                            if (isUser) {
                                const functionName = currentFunction.split('.').pop() || 'unknown';

                                const allocationItem = new AllocationItem(
                                    `Line ${lineNumber}: ${codeLine.trim()} (${flatBytes} flat, ${cumBytes} cum)`,
                                    vscode.TreeItemCollapsibleState.None,
                                    'allocationLine',
                                    currentFile,
                                    lineNumber,
                                    {
                                        bytes: flatBytes,
                                        objBytes: cumBytes,
                                        callCount: 'N/A',
                                        functionName: functionName
                                    }
                                );
                                allocationItems.push(allocationItem);
                            }
                        }
                    }
                }

                // Reset when we hit an empty line or new function
                if (trimmedLine === '' || trimmedLine.includes('ROUTINE')) {
                    inFunction = false;
                }
            }

            // If no allocation data found, show a message
            if (allocationItems.length === 0) {
                allocationItems.push(new AllocationItem(
                    'No allocations found',
                    vscode.TreeItemCollapsibleState.None,
                    'noAllocations'
                ));
            }

            return allocationItems;
        } catch (error) {
            console.error('Error parsing memory profile:', error);
            return [
                new AllocationItem(
                    'Error parsing memory profile',
                    vscode.TreeItemCollapsibleState.None,
                    'error'
                )
            ];
        }
    }

    private async isUserCode(filePath: string, functionName: string): Promise<boolean> {
        try {
            // Get Go environment variables to determine what's user code vs standard library
            const { stdout: goroot } = await execAsync('go env GOROOT');
            const { stdout: gomod } = await execAsync('go env GOMOD');

            const goRoot = goroot.trim();
            const goMod = gomod.trim();

            // If we have a go.mod file, use the module root as the user code boundary
            if (goMod && goMod !== '/dev/null') {
                const moduleRoot = path.dirname(goMod);
                // Check if the file is within the current module
                if (filePath.startsWith(moduleRoot)) {
                    return true;
                }
            }

            // If the file is in GOROOT, it's standard library
            if (filePath.startsWith(goRoot)) {
                return false;
            }

            // If the file is in a vendor directory, it's not user code
            if (filePath.includes('/vendor/')) {
                return false;
            }

            // Default to user code if we can't determine otherwise
            return true;
        } catch (error) {
            console.error('Error determining if code is user code:', error);
            // Fallback to a simple heuristic if go env fails
            return !filePath.includes('/go/');
        }
    }
}

export interface AllocationData {
    bytes: string;
    objBytes: string;
    callCount: string;
    functionName: string;
}

export class AllocationItem extends vscode.TreeItem {
    public readonly filePath?: string;
    public readonly lineNumber?: number;
    public readonly allocationData?: AllocationData;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        filePath?: string,
        lineNumber?: number,
        allocationData?: AllocationData
    ) {
        super(label, collapsibleState);
        this.contextValue = contextValue;
        this.filePath = filePath;
        this.lineNumber = lineNumber;
        this.allocationData = allocationData;

        // Set appropriate icons and tooltips based on context
        switch (contextValue) {
            case 'package':
                this.iconPath = new vscode.ThemeIcon('package');
                this.tooltip = `Go package: ${label}${filePath ? `\nPath: ${filePath}` : ''}`;
                // No command - package nodes only toggle expand/collapse
                break;
            case 'benchmarkFunction':
                this.iconPath = new vscode.ThemeIcon('symbol-function');
                // Show different tooltip based on whether it's collapsed or expanded
                if (this.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed) {
                    this.tooltip = `Click to run ${label} and discover allocations`;
                } else {
                    this.tooltip = `Benchmark function: ${label}`;
                }
                break;
            case 'allocationLine':
                this.iconPath = new vscode.ThemeIcon('symbol-field');
                this.tooltip = this.buildAllocationTooltip();
                // No command - click will be handled by tree view selection event
                break;
            case 'noFiles':
                this.iconPath = new vscode.ThemeIcon('info');
                this.tooltip = 'No Go test packages found in workspace';
                break;
            case 'noBenchmarks':
                this.iconPath = new vscode.ThemeIcon('info');
                this.tooltip = 'No benchmark functions found in this package';
                break;
            case 'noAllocations':
                this.iconPath = new vscode.ThemeIcon('info');
                this.tooltip = 'No allocation data found for this benchmark';
                break;
            case 'error':
                this.iconPath = new vscode.ThemeIcon('error');
                this.tooltip = 'Error occurred while listing benchmarks';
                break;
        }
    }

    private buildAllocationTooltip(): string {
        if (!this.allocationData) {
            return this.label;
        }

        const { bytes, objBytes, callCount, functionName } = this.allocationData;
        return [
            `Function: ${functionName}`,
            `Flat allocation: ${bytes}`,
            `Cumulative allocation: ${objBytes}`,
            callCount !== 'N/A' ? `Call count: ${callCount}` : '',
            this.filePath && this.lineNumber ? `Location: ${path.basename(this.filePath)}:${this.lineNumber}` : ''
        ].filter(line => line).join('\n');
    }
}
