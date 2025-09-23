import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { GoEnvironment } from './go';

const execAsync = promisify(exec);

export type Item = ModuleItem | PackageItem | BenchmarkItem | InformationItem | AllocationItem;

export class ModuleItem extends vscode.TreeItem {
    public readonly moduleName: string;
    public readonly modulePath: string;
    public readonly contextValue: 'module' = 'module';

    constructor(
        moduleName: string,
        modulePath: string
    ) {
        super(moduleName, vscode.TreeItemCollapsibleState.Expanded);
        this.moduleName = moduleName;
        this.modulePath = modulePath;
    }
}

export class PackageItem extends vscode.TreeItem {
    public readonly filePath: string;
    public readonly contextValue: 'package' = 'package';
    public readonly parent: ModuleItem;

    constructor(
        label: string,
        filePath: string,
        parent: ModuleItem
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.filePath = filePath;
        this.parent = parent;
        this.iconPath = new vscode.ThemeIcon('package');
        this.tooltip = `Go package: ${label}\nPath: ${filePath}`;
    }
}

export class BenchmarkItem extends vscode.TreeItem {
    public readonly filePath: string;
    public readonly contextValue: 'benchmarkFunction' = 'benchmarkFunction';
    public hasBeenRun: boolean = false;
    public readonly parent: PackageItem;

    constructor(
        label: string,
        filePath: string,
        parent: PackageItem
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.filePath = filePath;
        this.parent = parent;

        this.iconPath = new vscode.ThemeIcon('symbol-function');
        this.tooltip = `Click to run ${label} and discover allocations`;
    }
}

export type BenchmarkChildItem = InformationItem | AllocationItem;

export class InformationItem extends vscode.TreeItem {
    public readonly contextValue: 'information' = 'information';

    constructor(
        label: string,
        iconType: 'error' | 'info' | 'none' = 'none'
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        if (iconType !== 'none') {
            this.iconPath = new vscode.ThemeIcon(iconType);
        }
    }
}

const getImageUri = (imageName: string): vscode.Uri => {
    return vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'images', imageName);
}

export class AllocationItem extends vscode.TreeItem {
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
        super(label, vscode.TreeItemCollapsibleState.None);
        this.filePath = filePath;
        this.lineNumber = lineNumber;
        this.allocationData = allocationData;
        this.iconPath = getImageUri('memory.goblue.64.png');
        this.description = `${allocationData.flatBytes} flat, ${allocationData.cumulativeBytes} cumulative`;
        this.tooltip = this.getTooltip();
    }

    private getTooltip(): string {
        return [
            'Click to view the source code line\n',
            `Function: ${this.allocationData.functionName}`,
            `Flat allocation: ${this.allocationData.flatBytes}`,
            `Cumulative allocation: ${this.allocationData.cumulativeBytes}`,
            `Location: ${path.basename(this.filePath)}:${this.lineNumber}`
        ].join('\n');
    }
}

export interface AllocationData {
    flatBytes: string;
    cumulativeBytes: string;
    functionName: string;
}

export class Provider implements vscode.TreeDataProvider<Item> {
    public _onDidChangeTreeData: vscode.EventEmitter<Item | undefined | null | void> = new vscode.EventEmitter<Item | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Item | undefined | null | void> = this._onDidChangeTreeData.event;

    // Cache for discovered modules and their packages
    private modules: {
        name: string;
        path: string;
        packages: { name: string; path: string; benchmarks: string[] }[]
    }[] = [];
    private packagesLoaded = false;
    private discoveryInProgress = false;

    constructor() {
        // Start GoEnvironment initialization immediately
        this._goPromise = GoEnvironment.New(this.abortController, vscode.workspace.workspaceFolders).then(env => {
            this._go = env;
            return env;
        });
    }

    private _go: GoEnvironment | null = null;
    private _goPromise: Promise<GoEnvironment>;
    private get go(): Promise<GoEnvironment> {
        if (this._go) {
            return Promise.resolve(this._go);
        }

        return this._goPromise;
    }

    private abortController: AbortController = new AbortController();
    abortSignal(): AbortSignal {
        return this.abortController.signal;
    }

    cancelAll(): void {
        this.abortController.abort();
        this.abortController = new AbortController();
        if (this._go) {
            this._go.setAbortController(this.abortController);
        }
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


    clearBenchmarkRunState(item: BenchmarkItem): void {
        item.hasBeenRun = false;
        this._onDidChangeTreeData.fire(item);
    }

    /**
     * Refresh the tree view by clearing all cached data and reloading packages.
     * This destroys the existing tree view and builds a new one, just like on initial load.
     */
    refresh(): void {
        this.cancelAll();

        // Reset all cache state
        this.modules = [];
        this.packagesLoaded = false;
        this.discoveryInProgress = false;

        // Reset Go environment
        this._go = null;
        this._goPromise = GoEnvironment.New(this.abortController, vscode.workspace.workspaceFolders).then(env => {
            this._go = env;
            return env;
        });

        // Fire tree data change event to refresh the view
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: Item): vscode.TreeItem {
        return element;
    }

    getParent(element: Item): vscode.ProviderResult<Item> {
        // For our tree structure:
        // - Root level has no parent (return undefined)
        // - Package items have no parent (return undefined)
        // - Benchmark functions have package as parent
        // - Allocation lines have benchmark function as parent

        if (!element) {
            return undefined; // Root level
        }

        if (element instanceof ModuleItem) {
            return undefined; // Module is at root level
        }

        if (element instanceof PackageItem) {
            return element.parent; // Package's parent is its module
        }

        if (element instanceof BenchmarkItem) {
            return element.parent;
        }

        if (element instanceof AllocationItem) {
            // For allocation lines, we need to reconstruct the benchmark function
            // This is tricky since we don't store the parent reference
            // For now, return undefined - this might cause issues with reveal
            return undefined;
        }

        return undefined;
    }

    async getChildren(element?: Item): Promise<Item[]> {
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

            // Return currently discovered modules immediately (even if loading is still in progress)
            const moduleItems = this.modules.map(module => new ModuleItem(
                module.name,
                module.path
            ));

            return [instruction, ...moduleItems];
        }

        if (element instanceof ModuleItem) {
            return this.getPackagesForModule(element);
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

            // Get the module name for this workspace
            const { stdout: moduleName } = await execAsync('go list -m', {
                cwd: rootPath,
                signal: signal
            });

            if (!moduleName.trim() || moduleName.trim() === 'command-line-arguments') {
                return; // Skip if not a valid module
            }

            // Find or create module entry
            let module = this.modules.find(m => m.name === moduleName.trim());
            if (!module) {
                module = {
                    name: moduleName.trim(),
                    path: rootPath,
                    packages: []
                };
                this.modules.push(module);
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
                        'go test -list="^Benchmark[_A-Z][^/]*$"',
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

                        // Add package with its benchmarks to the module
                        const pkg = { name: packageName, path: packageDir, benchmarks };
                        module.packages.push(pkg);

                        // Fire tree data change event to render this module immediately
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

    private getPackagesForModule(moduleItem: ModuleItem): PackageItem[] {
        const module = this.modules.find(m => m.path === moduleItem.modulePath);
        if (!module) {
            throw new Error('Module not found in cache');
        }

        const packages: PackageItem[] = [];

        for (const pkg of module.packages) {
            const item = new PackageItem(
                this.getPackageLabel(pkg),
                pkg.path,
                moduleItem
            );
            packages.push(item);
        }

        return packages;
    }

    private getBenchmarks(packageItem: PackageItem): BenchmarkItem[] {
        // Find the package in the modules structure
        const module = this.modules.find(m => m.packages.some(p => p.path === packageItem.filePath));
        if (!module) {
            throw new Error('Module not found in cache');
        }

        const pkg = module.packages.find(p => p.path === packageItem.filePath);
        if (!pkg) {
            throw new Error('Package not found in cache');
        }

        const benchmarks: BenchmarkItem[] = [];

        for (const benchmark of pkg.benchmarks) {
            const item = new BenchmarkItem(
                benchmark,
                packageItem.filePath,
                packageItem
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
                const allocationData = await this.parseMemoryProfile(memprofilePath, benchmarkItem);

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
            const msg = error instanceof Error ? error.message : String(error);
            return [
                new InformationItem(
                    `${msg}`,
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

    private async parseMemoryProfile(memprofilePath: string, benchmarkItem: BenchmarkItem): Promise<BenchmarkChildItem[]> {
        /*
        Example pprof -list output:

ROUTINE ======================== github.com/clipperhouse/uax29/v2.BenchmarkString in /Users/msherman/Documents/code/src/github.com/clipperhouse/uax29/uax29_test.go
     0     3.77GB (flat, cum) 99.92% of Total
     .          .     13:func BenchmarkString(b *testing.B) {
     .          .     14:	for i := 0; i < b.N; i++ {
     .     3.77GB     15:		alloc()
     .          .     16:	}
     .          .     17:}
ROUTINE ======================== github.com/clipperhouse/uax29/v2.alloc in /Users/msherman/Documents/code/src/github.com/clipperhouse/uax29/uax29_test.go
3.77GB     3.77GB (flat, cum) 99.92% of Total
     .          .      9:func alloc() {
3.77GB     3.77GB     10:	_ = "updated nine times. Hello, world! こんにちは 안녕하세요 مرحبا" + strconv.Itoa(rand.Intn(20))
     .          .     11:}
     .          .     12:
     .          .     13:func BenchmarkString(b *testing.B) {
     .          .     14:	for i := 0; i < b.N; i++ {
     .          .     15:		alloc()
        */
        /*
            We only want the flat bytes, that's our definition of where the
            allocation is. In the example above, the alloc() call on line 15
            has no flat bytes, the first column. We want the actual allocation
            on line 10, where the string is created.
        */
        /*
            TODO all this logic can be better
            We can use the -list argument below to ensure we only
            see user code -- likely use the module name for that. This
            would allow removing isUserCode.
            Then, maybe the regex is too complicated, consider actual parsing.
            Or maybe the regex is best!
        */

        const signal = this.abortSignal();


        try {
            // Check if operation was cancelled before parsing
            if (signal.aborted) {
                throw new Error('Operation cancelled');
            }
            const moduleName = benchmarkItem.parent.parent.moduleName;
            const cmd = `go tool pprof -list=${moduleName} ${memprofilePath}`;
            const { stdout: listOutput } = await execAsync(cmd, {
                cwd: benchmarkItem.filePath,
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
            const msg = error instanceof Error ? error.message : String(error);
            return [
                new InformationItem(
                    `${msg}`,
                    'error'
                )
            ];
        }
    }
}
