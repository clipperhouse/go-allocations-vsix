import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class GoAllocationsProvider implements vscode.TreeDataProvider<AllocationItem> {
    public _onDidChangeTreeData: vscode.EventEmitter<AllocationItem | undefined | null | void> = new vscode.EventEmitter<AllocationItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<AllocationItem | undefined | null | void> = this._onDidChangeTreeData.event;

    // Cache for discovered packages and their benchmarks
    private packages: { name: string; path: string; benchmarks: string[] }[] = [];
    private packagesLoaded = false;
    private discoveryInProgress = false;


    // Cache for Go environment variables to avoid shelling out on every isUserCode call
    private goRoot: string | null = null;
    private goMod: string | null = null;
    private goEnvInitialized = false;

    constructor() {
        console.log('GoAllocationsProvider constructor called');
        console.log('Workspace folders in constructor:', vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath));
        // Initialize Go environment variables
        this.initializeGoEnvironment();
    }

    private getPackageLabel(pkg: { name: string; path: string; benchmarks: string[] }): string {
        // Get the workspace folder that contains this package
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder =>
            pkg.path.startsWith(folder.uri.fsPath)
        );

        if (workspaceFolder) {
            const relativePath = path.relative(workspaceFolder.uri.fsPath, pkg.path);
            // Only use relative path if it's different from the package name (i.e., in a subfolder)
            return relativePath !== pkg.name ? relativePath : pkg.name;
        }

        return pkg.name;
    }

    private async initializeGoEnvironment(): Promise<void> {
        try {
            // Get Go environment variables once and cache them
            const { stdout: goroot } = await execAsync('go env GOROOT');
            const { stdout: gomod } = await execAsync('go env GOMOD');

            this.goRoot = goroot.trim();
            this.goMod = gomod.trim();
            this.goEnvInitialized = true;

            console.log('Go environment initialized:', { goRoot: this.goRoot, goMod: this.goMod });
        } catch (error) {
            console.error('Error initializing Go environment:', error);
            // Set fallback values
            this.goRoot = null;
            this.goMod = null;
            this.goEnvInitialized = true;
        }
    }


    clearBenchmarkRunState(benchmarkItem?: AllocationItem): void {
        if (benchmarkItem) {
            benchmarkItem.hasBeenRun = false;
            this._onDidChangeTreeData.fire(benchmarkItem);
        } else {
            this._onDidChangeTreeData.fire();
        }
    }

    /**
     * Refresh the tree view by clearing all cached data and reloading packages.
     * This destroys the existing tree view and builds a new one, just like on initial load.
     */
    refresh(): void {
        console.log('Refreshing Go Allocations tree view...');

        // Reset all cache state
        this.packages = [];
        this.packagesLoaded = false;
        this.discoveryInProgress = false;

        // Re-initialize Go environment variables
        this.goRoot = null;
        this.goMod = null;
        this.goEnvInitialized = false;
        this.initializeGoEnvironment();

        // Fire tree data change event to refresh the view
        this._onDidChangeTreeData.fire();

        console.log('Tree view refresh completed');
    }

    /**
     * Method to run a benchmark and get allocation data.
     * Used internally by getChildren when expanding benchmark function nodes.
     */
    async runBenchmark(benchmarkItem: AllocationItem, abortSignal?: AbortSignal): Promise<AllocationItem[]> {
        const result = await this.getAllocationData(benchmarkItem, abortSignal);
        return result;
    }


    getTreeItem(element: AllocationItem): vscode.TreeItem {
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

        switch (element.contextValue) {
            case 'package':
                return undefined; // Package is at root level
            case 'benchmarkFunction':
                // Find the parent package by looking at the filePath
                if (element.filePath) {
                    const parentPackage = this.packages.find(pkg => pkg.path === element.filePath);
                    if (parentPackage) {
                        return new AllocationItem(
                            this.getPackageLabel(parentPackage),
                            vscode.TreeItemCollapsibleState.Expanded,
                            'package',
                            parentPackage.path
                        );
                    }
                }
                return undefined;
            case 'allocationLine':
                // For allocation lines, we need to reconstruct the benchmark function
                // This is tricky since we don't store the parent reference
                // For now, return undefined - this might cause issues with reveal
                return undefined;
            default:
                return undefined;
        }
    }


    async getChildren(element?: AllocationItem, abortSignal?: AbortSignal): Promise<AllocationItem[]> {
        console.log('getChildren called with element:', element ? element.label : 'root');

        if (!element) {
            // Root level - show all packages with benchmarks
            console.log('Getting root level children (packages)');

            // If loaded, return packages
            if (this.packagesLoaded) {
                return this.packages.map(pkg => new AllocationItem(
                    this.getPackageLabel(pkg),
                    vscode.TreeItemCollapsibleState.Expanded,
                    'package',
                    pkg.path
                ));
            }

            // If not loaded and not in progress, start loading and wait for it
            if (!this.discoveryInProgress) {
                this.discoveryInProgress = true;
                try {
                    await this.loadPackages();
                } catch (error) {
                    console.error('Error loading packages:', error);
                    this.discoveryInProgress = false;
                    throw error;
                }
            } else {
                // If already in progress, wait for it to complete
                while (!this.packagesLoaded && this.discoveryInProgress) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }

            // Return packages after loading is complete
            return this.packages.map(pkg => new AllocationItem(
                this.getPackageLabel(pkg),
                vscode.TreeItemCollapsibleState.Expanded,
                'package',
                pkg.path
            ));
        }

        switch (element.contextValue) {
            case 'package':
                // Show benchmark functions in this package
                console.log('Getting benchmark functions for package:', element.label);
                return this.getBenchmarkFunctions(element);
            case 'benchmarkFunction':
                // Show allocation data for the function
                console.log('Getting allocation data for:', element.label);
                const allocationData = await this.runBenchmark(element, abortSignal);
                // Mark this benchmark as run since we're returning allocation data
                element.hasBeenRun = true;
                return allocationData;
            default:
                console.log('No matching context value, returning empty array');
                return Promise.resolve([]);
        }
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
                await this.loadPackagesFromWorkspace(workspaceFolder.uri.fsPath);
            } catch (error) {
                console.error('Error processing workspace folder:', error);
            }
        }

        console.log('Package discovery complete. Found', this.packages.length, 'packages');
        this.packagesLoaded = true;
        this.discoveryInProgress = false;
        this._onDidChangeTreeData.fire();
    }

    private async loadPackagesFromWorkspace(rootPath: string): Promise<void> {
        try {
            // Get all packages first
            const { stdout: packagesOutput } = await execAsync('go list -f "{{.Name}} {{.Dir}}" ./...', { cwd: rootPath });
            const packageLines = packagesOutput.trim().split('\n');

            // Process each package and discover benchmarks in one go
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
                    // Get benchmark functions for this package
                    const { stdout: benchmarksOutput } = await execAsync(
                        'go test -list="^Benchmark[A-Z][^/]*$"',
                        { cwd: packageDir }
                    );

                    const benchmarkLines = benchmarksOutput.trim().split('\n');
                    const benchmarks = benchmarkLines
                        .filter(line => line.startsWith('Benchmark') && !line.includes('ok'))
                        .map(line => line.trim());

                    if (benchmarks.length > 0) {
                        // Add package with its benchmarks
                        const pkg = { name: packageName, path: packageDir, benchmarks };
                        this.packages.push(pkg);
                        console.log(`Discovered package: ${packageName} with ${benchmarks.length} benchmarks`);
                    }
                } catch (packageError) {
                    // Skip packages that can't be tested (e.g., no test files)
                    console.warn(`Could not test package ${packageName}:`, packageError);
                }
            }
        } catch (error) {
            console.error('Error loading packages from workspace:', error);
            throw error;
        }
    }


    private async getBenchmarkFunctions(packageItem: AllocationItem): Promise<AllocationItem[]> {
        if (!packageItem.filePath) {
            return [];
        }

        // Find the package in our cache
        const pkg = this.packages.find(p => p.path === packageItem.filePath);
        if (!pkg) {
            return [
                new AllocationItem(
                    'Package not found in cache',
                    vscode.TreeItemCollapsibleState.None,
                    'error'
                )
            ];
        }

        const benchmarkFunctions: AllocationItem[] = [];

        for (const functionName of pkg.benchmarks) {
            const item = new AllocationItem(
                functionName,
                vscode.TreeItemCollapsibleState.Collapsed, // Not expanded by default
                'benchmarkFunction',
                packageItem.filePath
            );
            benchmarkFunctions.push(item);
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
    }

    async getAllocationData(functionItem: AllocationItem, abortSignal?: AbortSignal): Promise<AllocationItem[]> {
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
                    // Parse line format: "flatBytes cumulativeBytes lineNumber: code"
                    // Example: "    2.50MB     5.50MB     36:	s := \"hello\" + strconv.Itoa(rand.Intn(1000))"
                    const lineMatch = trimmedLine.match(/^\s*(\d+(?:\.\d+)?[KMGT]?B)?\s*(\d+(?:\.\d+)?[KMGT]?B)?\s*(\d+):\s*(.+)$/);
                    if (lineMatch) {
                        const flatBytes = lineMatch[1] || '0B';
                        const cumulativeBytes = lineMatch[2] || '0B';
                        const lineNumber = parseInt(lineMatch[3]);
                        const codeLine = lineMatch[4];

                        if (lineNumber > 0 && (flatBytes !== '0B' || cumulativeBytes !== '0B')) {
                            // Only show allocations from user code, not runtime
                            const isUser = await this.isUserCode(currentFile, currentFunction);
                            if (isUser) {
                                const functionName = currentFunction.split('.').pop() || 'unknown';

                                const allocationItem = new AllocationItem(
                                    `Line ${lineNumber}: ${codeLine.trim()}`,
                                    vscode.TreeItemCollapsibleState.None,
                                    'allocationLine',
                                    currentFile,
                                    lineNumber,
                                    {
                                        bytes: flatBytes,
                                        objBytes: cumulativeBytes,
                                        callCount: 'N/A',
                                        functionName: functionName
                                    }
                                );
                                // Set the description to show bytes on a separate line
                                allocationItem.description = `${flatBytes} flat, ${cumulativeBytes} cumulative`;
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
        // Wait for Go environment to be initialized if not already done
        if (!this.goEnvInitialized) {
            await this.initializeGoEnvironment();
        }

        try {
            // Use cached Go environment variables
            const goRoot = this.goRoot;
            const goMod = this.goMod;

            // If we have a go.mod file, use the module root as the user code boundary
            if (goMod && goMod !== '/dev/null') {
                const moduleRoot = path.dirname(goMod);
                // Check if the file is within the current module
                if (filePath.startsWith(moduleRoot)) {
                    return true;
                }
            }

            // If the file is in GOROOT, it's standard library
            if (goRoot && filePath.startsWith(goRoot)) {
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
    public hasBeenRun: boolean = false;

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
