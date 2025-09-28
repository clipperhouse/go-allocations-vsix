import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as readline from 'readline';
import { quote } from 'shell-quote';
import { Sema } from 'async-sema';

const execAsync = promisify(exec);

export type Item = ModuleItem | PackageItem | BenchmarkItem | InformationItem | AllocationItem;

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

    public getChildren(modules: ModuleCache[]): PackageItem[] {
        const module = modules.find(m => m.path === this.modulePath);
        if (!module) {
            throw new Error('Module not found in cache');
        }

        const packages: PackageItem[] = [];

        for (const pkg of module.packages) {
            const item = new PackageItem(
                this.getPackageLabel(pkg),
                pkg.path,
                this
            );
            packages.push(item);
        }

        return packages;
    }

    private getPackageLabel(pkg: PackageCache): string {
        const relativePath = path.relative(this.modulePath, pkg.path);
        // Use the package name when at the workspace root or when the
        // relative path matches the package name; otherwise use the path.
        if (relativePath === '' || relativePath === pkg.name) {
            return pkg.name;
        }
        return relativePath;
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

    getChildren(modules: ModuleCache[]): BenchmarkItem[] {
        // Find the package in the modules structure
        const moduleCache = modules.find(m => m.hasPackageAtPath(this.filePath));
        if (!moduleCache) {
            throw new Error('Module not found in cache');
        }

        const pkgCache = moduleCache.findPackageByPath(this.filePath);
        if (!pkgCache) {
            throw new Error('Package not found in cache');
        }

        const benchmarks: BenchmarkItem[] = [];

        for (const benchmark of pkgCache.benchmarks) {
            const item = new BenchmarkItem(
                benchmark,
                this.filePath,
                this
            );
            benchmarks.push(item);
        }

        return benchmarks;
    }
}

export class BenchmarkItem extends vscode.TreeItem {
    public readonly filePath: string;
    public readonly contextValue: 'benchmarkFunction' = 'benchmarkFunction';
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

    private static noAllocationsItem = new InformationItem('No allocations found', 'info');
    private static routineRegex = /^ROUTINE\s*=+\s*(.+?)\s+in\s+(.+)$/;
    private static lineRegex = /^\s*(\d+(?:\.\d+)?[KMGT]?B)?\s*(\d+(?:\.\d+)?[KMGT]?B)?\s*(\d+):\s*(.+)$/;

    async getChildren(signal: AbortSignal): Promise<BenchmarkChildItem[]> {
        if (!this.filePath) {
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
            const benchmarkName = typeof this.label === 'string' ? this.label : this.label?.label || '';
            const escapedBenchmarkName = quote([benchmarkName]);
            const memprofilerate = 1024 * 64; // 64K

            // Use shell-quote to safely escape the benchmark name
            const cmd = `go test -bench=^${escapedBenchmarkName}$ -memprofile=${memprofilePath} -run=^$ -memprofilerate=${memprofilerate}`;

            try {
                const { stdout, stderr } = await execAsync(
                    cmd,
                    {
                        cwd: this.filePath,
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
                return await this.parseMemoryProfile(memprofilePath, signal);
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
                    `${error}`,
                    'error'
                )
            ];
        }
    }

    private async parseMemoryProfile(memprofilePath: string, signal: AbortSignal): Promise<BenchmarkChildItem[]> {
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

        try {
            // Check if operation was cancelled before parsing
            if (signal.aborted) {
                throw new Error('Operation cancelled');
            }

            // Use streaming approach for memory efficiency
            const results = await new Promise<BenchmarkChildItem[]>((resolve, reject) => {
                const items: BenchmarkChildItem[] = [];
                let currentFunction = '';
                let currentFile = '';
                let inFunction = false;
                let stderr = '';

                const moduleName = this.parent.parent.moduleName;
                const cmd = 'go';
                const args = ['tool', 'pprof', `-list=${moduleName}`, memprofilePath];

                const child = spawn(cmd, args, {
                    cwd: this.filePath,
                    signal,
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                const rl = readline.createInterface({
                    input: child.stdout,
                    crlfDelay: Infinity
                });

                // Capture stderr output
                child.stderr?.on('data', (data) => {
                    stderr += data.toString();
                });

                rl.on('line', (line) => {
                    const trimmedLine = line.trim();

                    // Check if this is a function header
                    const functionMatch = trimmedLine.match(BenchmarkItem.routineRegex);
                    if (functionMatch) {
                        currentFunction = functionMatch[1];
                        currentFile = functionMatch[2];
                        inFunction = true;
                        return;
                    }

                    // Check if we're in a function and this is a line with allocation data
                    if (inFunction && trimmedLine && !trimmedLine.includes('Total:') && !trimmedLine.includes('ROUTINE')) {
                        const lineMatch = trimmedLine.match(BenchmarkItem.lineRegex);
                        if (lineMatch) {
                            const flatBytes = lineMatch[1] || '0B';
                            const cumulativeBytes = lineMatch[2] || '0B';
                            const lineNumber = parseInt(lineMatch[3]);
                            const codeLine = lineMatch[4];

                            if (lineNumber > 0 && (flatBytes !== '0B' || cumulativeBytes !== '0B')) {
                                const functionName = BenchmarkItem.shortFunctionName(currentFunction);

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
                                items.push(allocationItem);
                            }
                        }
                    }

                    // Reset when we hit an empty line or new function
                    if (trimmedLine === '' || trimmedLine.includes('ROUTINE')) {
                        inFunction = false;
                    }
                });

                rl.on('close', () => {
                    resolve(items);
                });

                // Handle process spawn errors (e.g., command not found)
                child.on('error', (error) => {
                    reject(error);
                });

                child.on('close', (code) => {
                    if (stderr.includes('no matches found for regexp')) {
                        resolve([BenchmarkItem.noAllocationsItem]);
                        return;
                    }

                    // If process exited with non-zero code and we have stderr, treat as error
                    if (code !== 0 && stderr.trim()) {
                        reject(new Error(`pprof exit code ${code}: ${stderr.trim()}`));
                        return;
                    }

                    // If we get here, the process completed successfully
                    // The readline interface will handle resolving with the parsed items
                });
            });

            // If no allocation data found, show a message
            if (results.length === 0) {
                results.push(BenchmarkItem.noAllocationsItem);
            }

            return results;
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

    // Display helper: last path segment after '/', then after first '.'
    private static shortFunctionName = (fullName: string): string => {
        const slash = fullName.lastIndexOf('/');
        const afterSlash = slash >= 0 ? fullName.slice(slash + 1) : fullName;
        const firstDot = afterSlash.indexOf('.');
        return firstDot >= 0 ? afterSlash.slice(firstDot + 1) : afterSlash;
    }
}

export type BenchmarkChildItem = InformationItem | AllocationItem;

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

interface PackageCache {
    name: string;
    path: string;
    benchmarks: string[];
}

class ModuleCache {
    public readonly name: string;
    public readonly path: string;
    public readonly packages: PackageCache[] = [];

    constructor(name: string, path: string) {
        this.name = name;
        this.path = path;
    }

    findPackageByPath(packagePath: string): PackageCache | undefined {
        return this.packages.find(p => p.path === packagePath);
    }

    hasPackageAtPath(packagePath: string): boolean {
        return this.packages.some(p => p.path === packagePath);
    }

    addPackage(packageCache: PackageCache): void {
        this.packages.push(packageCache);
    }
}

export class Provider implements vscode.TreeDataProvider<Item> {
    public _onDidChangeTreeData: vscode.EventEmitter<Item | undefined | null | void> = new vscode.EventEmitter<Item | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Item | undefined | null | void> = this._onDidChangeTreeData.event;

    private moduleCaches: ModuleCache[] = [];
    private moduleCachesLoaded = false;
    private discoveryInProgress = false;

    constructor() { }

    private abortController: AbortController = new AbortController();
    abortSignal(): AbortSignal {
        return this.abortController.signal;
    }

    cancelAll(): void {
        this.abortController.abort();
        this.abortController = new AbortController();
    }

    clearBenchmarkRunState(item: BenchmarkItem): void {
        this._onDidChangeTreeData.fire(item);
    }

    /**
     * Refresh the tree view by clearing all cached data and reloading packages.
     * This destroys the existing tree view and builds a new one, just like on initial load.
     */
    refresh(): void {
        this.cancelAll();

        // Reset all cache state
        this.moduleCaches = [];
        this.moduleCachesLoaded = false;
        this.discoveryInProgress = false;

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
            // Note that there is asynchrony here, that the moduleCaches
            // will not be fully loaded immediately; loadModules() is async
            // but we are not awaiting it.
            //
            // loadModules() fires change events as it progresses, which
            // triggers getChildren() again. The result is that the tree view
            // populates incrementally as packages are discovered.
            if (!this.discoveryInProgress && !this.moduleCachesLoaded) {
                this.discoveryInProgress = true;

                this.loadModuleCaches().catch(error => {
                    console.error('Error loading modules:', error);
                    this.discoveryInProgress = false;
                });
            }

            // Always include instructional text at the top
            const instruction = new InformationItem(
                'Click a benchmark below to discover allocations'
            );

            // Return currently discovered modules immediately (even if loading is still in progress)
            const moduleItems = this.moduleCaches.map(m => new ModuleItem(
                m.name,
                m.path
            ));

            return [instruction, ...moduleItems];
        }

        if (element instanceof ModuleItem) {
            return element.getChildren(this.moduleCaches);
        }

        if (element instanceof PackageItem) {
            return element.getChildren(this.moduleCaches);
        }

        if (element instanceof BenchmarkItem) {
            return await element.getChildren(this.abortSignal());
        }

        return Promise.resolve([]);
    }

    private async loadModuleCaches(): Promise<void> {
        const signal = this.abortSignal();

        if (!vscode.workspace.workspaceFolders) {
            this.moduleCachesLoaded = true;
            this.discoveryInProgress = false;
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            for (const folder of vscode.workspace.workspaceFolders) {
                if (signal.aborted) {
                    throw new Error('Operation cancelled');
                }

                try {
                    await this.loadModulesInFolder(folder);
                } catch (error) {
                    if (signal.aborted) {
                        throw error;
                    }
                    console.error(error);
                }
            }
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
        } finally {
            this.moduleCachesLoaded = true;
            this.discoveryInProgress = false;
            this._onDidChangeTreeData.fire();
        }
    }

    private async loadModulesInFolder(folder: vscode.WorkspaceFolder): Promise<void> {
        const signal = this.abortSignal();

        try {
            if (signal.aborted) {
                throw new Error('Operation cancelled');
            }

            // Get the module name for this workspace
            const cmdModules = 'go list -m';
            const { stdout: moduleName } = await execAsync(
                cmdModules,
                { cwd: folder.uri.fsPath, signal: signal }
            );

            if (!moduleName.trim() || moduleName.trim() === 'command-line-arguments') {
                return; // Skip if not a valid module
            }

            // Find or create module entry
            let moduleCache = this.moduleCaches.find(m => m.name === moduleName.trim());
            if (!moduleCache) {
                moduleCache = new ModuleCache(moduleName.trim(), folder.uri.fsPath);
                this.moduleCaches.push(moduleCache);
            }

            // Get all packages
            const cmdPackages = 'go list -f "{{.Name}} {{.Dir}}" ./...';
            const { stdout: packagesOutput } = await execAsync(
                cmdPackages,
                { cwd: folder.uri.fsPath, signal: signal }
            );
            const packageLines = packagesOutput.trim()
                .split('\n')
                .map(line => line.trim());

            // Process each package and discover benchmarks, updating tree after each discovery
            for (const line of packageLines) {
                if (signal.aborted) {
                    throw new Error('Operation cancelled');
                }

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
                    const cmdBenchmarks = 'go test -list="^Benchmark[_A-Z][^/]*$"';
                    const { stdout: benchmarksOutput } = await execAsync(
                        cmdBenchmarks,
                        { cwd: packageDir, signal: signal }
                    );

                    const benchmarkLines = benchmarksOutput.trim().split('\n');
                    const benchmarks = benchmarkLines
                        .filter(line => line.startsWith('Benchmark'))
                        .map(line => line.trim());

                    if (benchmarks.length > 0) {
                        if (signal.aborted) {
                            throw new Error('Operation cancelled');
                        }

                        // Add package with its benchmarks to the module
                        const packageCache: PackageCache = { name: packageName, path: packageDir, benchmarks };
                        moduleCache.addPackage(packageCache);

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
            console.error(error);
            throw error;
        }
    }

    /**
     * Discovers all benchmarks, and runs them with semaphore control.
     * Relies on TreeView.reveal to trigger getChildren automatically.
     */
    async runAllBenchmarksSimple(treeView: vscode.TreeView<Item>): Promise<void> {
        const signal = this.abortSignal();

        const sema = new Sema(2);
        const promises: Promise<void>[] = [];

        try {
            if (signal.aborted) {
                return;
            }

            const rootItems = (await this.getChildren())
                .filter(item => item instanceof ModuleItem);

            for (const rootItem of rootItems) {
                if (signal.aborted) {
                    return;
                }

                const packageItems = (await this.getChildren(rootItem))
                    .filter(item => item instanceof PackageItem);

                for (const packageItem of packageItems) {
                    if (signal.aborted) {
                        return;
                    }

                    const benchmarkItems = (await this.getChildren(packageItem))
                        .filter(item => item instanceof BenchmarkItem);

                    for (const benchmarkItem of benchmarkItems) {
                        if (signal.aborted) {
                            return;
                        }

                        const p = (async () => {
                            await sema.acquire();
                            try {
                                if (signal.aborted) {
                                    return;
                                }
                                // Because TreeView.reveal is Thenable which doesn't have .catch,
                                // we need to wrap in Promise.resolve.
                                const r = treeView.reveal(benchmarkItem, { expand: true });
                                await Promise.resolve(r);
                            } catch (error: any) {
                                if (signal.aborted) {
                                    console.log('Benchmark cancelled:', benchmarkItem.label);
                                } else {
                                    console.error('Benchmark error:', error);
                                }
                            } finally {
                                sema.release();
                            }
                        })();

                        promises.push(p);
                    }
                }
            }

            // Wait for all benchmarks to complete
            await Promise.all(promises);

            // Drain the semaphore to ensure all operations are complete
            await sema.drain();
        } catch (error) {
            if (signal.aborted) {
                console.log('Operation cancelled');
                throw error;
            }
            console.error('Error running all benchmarks:', error);
            throw error;
        }
    }
}
