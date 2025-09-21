import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class Provider implements vscode.TreeDataProvider<TreeItem> {
    public _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | null | void> = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    // Cache for discovered packages and their benchmarks
    private packages: { name: string; path: string; benchmarks: string[] }[] = [];
    private packagesLoaded = false;
    private discoveryInProgress = false;

    // Cache for Go environment variables to avoid shelling out on every isUserCode call
    private goRoot: string | null = null;
    private goMod: string | null = null;
    private goEnvInitialized = false;

    constructor() {
        this.initializeGoEnvironment();
    }

    private abortController: AbortController = new AbortController();
    abortSignal(): AbortSignal {
        return this.abortController.signal;
    }

    cancelAll(): void {
        this.abortController.abort();
        this.abortController = new AbortController();
    }

    private getPackageLabel(pkg: { name: string; path: string; benchmarks: string[] }): string {
        // Get the workspace folder that contains this package
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder =>
            pkg.path.startsWith(folder.uri.fsPath)
        );

        if (workspaceFolder) {
            const relativePath = path.relative(workspaceFolder.uri.fsPath, pkg.path);
            // Use the package name when at the workspace root or when the
            // relative path matches the package name; otherwise use the path.
            if (relativePath === '' || relativePath === pkg.name) {
                return pkg.name;
            }
            return relativePath;
        }

        return pkg.name;
    }

    private async initializeGoEnvironment(): Promise<void> {
        const signal = this.abortSignal();

        try {
            // Get Go environment variables once and cache them
            const { stdout: goroot } = await execAsync('go env GOROOT', { signal: signal });
            const { stdout: gomod } = await execAsync('go env GOMOD', { signal: signal });

            this.goRoot = goroot.trim();
            this.goMod = gomod.trim();
            this.goEnvInitialized = true;
        } catch (error) {
            if (signal.aborted) {
                console.log('Go environment initialization cancelled');
                return;
            }
            console.error('Error initializing Go environment:', error);
            // Set fallback values
            this.goRoot = null;
            this.goMod = null;
            this.goEnvInitialized = true;
        }
    }

    clearBenchmarkRunState(item: BenchmarkItem): void {
        item.hasBeenRun = false;
        this._onDidChangeTreeData.fire(item);
    }

    /**
     * Refresh the tree view by clearing all cached data and reloading packages.
     * This destroys the existing tree view and builds a new one, just like on initial load.
     */
    refresh(): void {
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
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getParent(element: TreeItem): vscode.ProviderResult<TreeItem> {
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
                        return new PackageItem(
                            this.getPackageLabel(parentPackage),
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


    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        if (!element) {
            // If not loaded and not in progress, start loading
            if (!this.discoveryInProgress && !this.packagesLoaded) {
                this.discoveryInProgress = true;
                // Start loading in the background - don't wait for it
                this.loadPackages().catch(error => {
                    console.error('Error loading packages:', error);
                    this.discoveryInProgress = false;
                });
            }

            // Always include instructional text at the top
            const instruction = new InformationItem(
                'Click a benchmark below to discover allocations'
            );

            // Return currently discovered packages immediately (even if loading is still in progress)
            const packageItems = this.packages.map(pkg => new PackageItem(
                this.getPackageLabel(pkg),
                pkg.path
            ));

            return [instruction, ...packageItems];
        }

        if (element instanceof PackageItem) {
            return this.getBenchmarks(element);
        }

        if (element instanceof BenchmarkItem) {
            const allocationData = await this.getAllocationData(element);
            element.hasBeenRun = true;
            return allocationData;
        }

        return Promise.resolve([]);
    }

    private async loadPackages(): Promise<void> {
        const signal = this.abortSignal();

        if (!vscode.workspace.workspaceFolders) {
            this.packagesLoaded = true;
            this.discoveryInProgress = false;
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            for (const workspaceFolder of vscode.workspace.workspaceFolders) {
                if (signal.aborted) {
                    throw new Error('Operation cancelled');
                }

                try {
                    await this.loadPackagesFromWorkspace(workspaceFolder.uri.fsPath);
                } catch (error) {
                    if (signal.aborted) {
                        throw error;
                    }
                    console.error('Error processing workspace folder:', error);
                }
            }
        } catch (error) {
            if (signal.aborted) {
                console.log('Package loading cancelled');
                throw error;
            }
        } finally {
            this.packagesLoaded = true;
            this.discoveryInProgress = false;
            this._onDidChangeTreeData.fire();
        }
    }

    private async loadPackagesFromWorkspace(rootPath: string): Promise<void> {
        const signal = this.abortSignal();

        try {
            if (signal.aborted) {
                throw new Error('Operation cancelled');
            }

            // Get all packages first
            const { stdout: packagesOutput } = await execAsync('go list -f "{{.Name}} {{.Dir}}" ./...', {
                cwd: rootPath,
                signal: signal
            });
            const packageLines = packagesOutput.trim().split('\n');

            // Process each package and discover benchmarks, updating tree after each discovery
            for (let line of packageLines) {
                if (signal.aborted) {
                    throw new Error('Operation cancelled');
                }

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
                        {
                            cwd: packageDir,
                            signal: signal
                        }
                    );

                    const benchmarkLines = benchmarksOutput.trim().split('\n');
                    const benchmarks = benchmarkLines
                        .filter(line => line.startsWith('Benchmark') && !line.includes('ok'))
                        .map(line => line.trim());

                    if (benchmarks.length > 0) {
                        if (signal.aborted) {
                            throw new Error('Operation cancelled');
                        }

                        // Add package with its benchmarks
                        const pkg = { name: packageName, path: packageDir, benchmarks };
                        this.packages.push(pkg);

                        // Fire tree data change event to render this package immediately
                        this._onDidChangeTreeData.fire();
                    }
                } catch (packageError) {
                    if (signal.aborted) {
                        throw packageError;
                    }
                    // Skip packages that can't be tested (e.g., no test files)
                    console.warn(`Could not test package ${packageName}:`, packageError);
                }
            }
        } catch (error) {
            if (signal.aborted) {
                console.log('Package discovery cancelled');
                throw error;
            }
            console.error('Error loading packages from workspace:', error);
            throw error;
        }
    }

    private getBenchmarks(packageItem: PackageItem): BenchmarkItem[] {
        if (!packageItem.filePath) {
            throw new Error('Package item missing filePath');
        }

        // Find the package in our cache
        const pkg = this.packages.find(p => p.path === packageItem.filePath);
        if (!pkg) {
            throw new Error('Package not found in cache');
        }

        const benchmarks: BenchmarkItem[] = [];

        for (const benchmark of pkg.benchmarks) {
            const item = new BenchmarkItem(
                benchmark,
                packageItem.filePath
            );
            benchmarks.push(item);
        }

        return benchmarks;
    }

    async getAllocationData(benchmarkItem: BenchmarkItem): Promise<BenchmarkChildItem[]> {
        const signal = this.abortSignal();

        if (!benchmarkItem.filePath) {
            return [];
        }

        try {
            // Check if operation is cancelled before starting
            if (signal.aborted) {
                throw new Error('Operation cancelled');
            }

            // Create unique temporary file for memory profile
            const tempDir = os.tmpdir();
            const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}-${process.pid}`;
            const memprofilePath = path.join(tempDir, `go-allocations-memprofile-${uniqueId}.pb.gz`);
            const benchmarkName = benchmarkItem.label;

            try {
                // Run the specific benchmark with memory profiling and debug info
                const { stdout, stderr } = await execAsync(
                    `go test -bench=^${benchmarkName}$ -memprofile=${memprofilePath} -run=^$ -gcflags="all=-N -l"`,
                    {
                        cwd: benchmarkItem.filePath,
                        signal: signal
                    }
                );

                if (stderr) {
                    console.error('Benchmark stderr:', stderr);
                }

                // Check if operation was cancelled after benchmark completion
                if (signal.aborted) {
                    throw new Error('Operation cancelled');
                }

                // Parse the memory profile using pprof
                const allocationData = await this.parseMemoryProfile(memprofilePath, benchmarkItem.filePath);

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
                new InformationItem(
                    'Error running benchmark with memory profiling',
                    'error'
                )
            ];
        }
    }

    // Display helper: last path segment after '/', then after first '.'
    private shortFunctionName = (fullName: string): string => {
        const slash = fullName.lastIndexOf('/');
        const afterSlash = slash >= 0 ? fullName.slice(slash + 1) : fullName;
        const firstDot = afterSlash.indexOf('.');
        return firstDot >= 0 ? afterSlash.slice(firstDot + 1) : afterSlash;
    };

    private async parseMemoryProfile(memprofilePath: string, packagePath: string): Promise<BenchmarkChildItem[]> {
        const signal = this.abortSignal();

        try {
            // Check if operation was cancelled before parsing
            if (signal.aborted) {
                throw new Error('Operation cancelled');
            }

            // Get the list of functions to find the main allocation function
            const { stdout: listOutput } = await execAsync(`go tool pprof -list=. ${memprofilePath}`, {
                cwd: packagePath,
                signal: signal
            });

            const allocationItems: BenchmarkChildItem[] = [];
            const lines = listOutput.split('\n');

            let currentFunction = '';
            let currentFile = '';
            let inFunction = false;

            for (const line of lines) {
                const trimmedLine = line.trim();

                // Check if this is a function header
                const functionMatch = trimmedLine.match(/^ROUTINE =+ (.+?) in (.+)$/);
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
                                const functionName = this.shortFunctionName(currentFunction);

                                const allocationItem = new AllocationItem(
                                    `${codeLine.trim()}`,
                                    currentFile,
                                    lineNumber,
                                    {
                                        flatBytes: flatBytes,
                                        cumulativeBytes: cumulativeBytes,
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
                allocationItems.push(new InformationItem(
                    'No allocations found',
                    'info'
                ));
            }

            return allocationItems;
        } catch (error) {
            console.error('Error parsing memory profile:', error);
            return [
                new InformationItem(
                    'Error parsing memory profile',
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
    flatBytes: string;
    cumulativeBytes: string;
    functionName: string;
}

// Base class for all tree items
export class Item extends vscode.TreeItem {
    public readonly filePath?: string;
    public readonly lineNumber?: number;
    public hasBeenRun: boolean = false;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        filePath?: string,
        lineNumber?: number
    ) {
        super(label, collapsibleState);
        this.contextValue = contextValue;
        this.filePath = filePath;
        this.lineNumber = lineNumber;

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
                this.iconPath = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'images', 'memory.goblue.64.png');
                this.tooltip = this.label;
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
            case 'instructional':
                // this.iconPath = new vscode.ThemeIcon('info');
                break;
            case 'error':
                this.iconPath = new vscode.ThemeIcon('error');
                this.tooltip = 'Error occurred while listing benchmarks';
                break;
        }
    }
}

// Specific type for package items with stronger typing
export class PackageItem extends Item {
    public readonly filePath: string; // Required for packages
    public readonly contextValue: 'package' = 'package';

    constructor(
        label: string,
        filePath: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded, 'package', filePath);
        this.filePath = filePath; // Ensure it's always set

        // Package-specific setup
        this.iconPath = new vscode.ThemeIcon('package');
        this.tooltip = `Go package: ${label}\nPath: ${filePath}`;
    }
}

// Specific type for benchmark function items with stronger typing
export class BenchmarkItem extends Item {
    public readonly filePath: string; // Required for benchmarks (package directory)
    public readonly contextValue: 'benchmarkFunction' = 'benchmarkFunction';

    constructor(
        label: string,
        filePath: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed, 'benchmarkFunction', filePath);
        this.filePath = filePath; // Ensure it's always set

        // Benchmark-specific setup
        this.iconPath = new vscode.ThemeIcon('symbol-function');
        // Show different tooltip based on whether it's collapsed or expanded
        if (this.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed) {
            this.tooltip = `Click to run ${label} and discover allocations`;
        } else {
            this.tooltip = `Benchmark function: ${label}`;
        }
    }
}

// Specific type for informational items (instructions, errors, messages)
export class InformationItem extends Item {
    constructor(
        label: string,
        iconType: 'error' | 'info' | 'none' = 'none'
    ) {
        super(label, vscode.TreeItemCollapsibleState.None, 'information');

        // Set appropriate icons based on type
        switch (iconType) {
            case 'error':
            case 'info':
                this.iconPath = new vscode.ThemeIcon(iconType);
                break;
            default:
                break;
        }
    }
}

export class AllocationItem extends Item {
    public readonly filePath: string;
    public readonly lineNumber: number;
    public readonly allocationData: AllocationData;
    public readonly contextValue: 'allocationLine' = 'allocationLine';

    constructor(
        label: string,
        filePath: string,
        lineNumber: number,
        allocationData: AllocationData
    ) {
        super(label, vscode.TreeItemCollapsibleState.None, 'allocationLine', filePath, lineNumber);
        this.filePath = filePath;
        this.lineNumber = lineNumber;
        this.allocationData = allocationData;
        this.iconPath = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'images', 'memory.goblue.64.png');
        this.description = `${allocationData.flatBytes} flat, ${allocationData.cumulativeBytes} cumulative`;
        this.tooltip = this.getTooltip();
    }

    private getTooltip(): string {
        const { flatBytes, cumulativeBytes, functionName } = this.allocationData;
        return [
            'Click to view the source code line\n',
            `Function: ${functionName}`,
            `Flat allocation: ${flatBytes}`,
            `Cumulative allocation: ${cumulativeBytes}`,
            `Location: ${path.basename(this.filePath)}:${this.lineNumber}`
        ].join('\n');
    }
}

export type BenchmarkChildItem = InformationItem | AllocationItem;

export type TreeItem = PackageItem | BenchmarkItem | BenchmarkChildItem | Item;
