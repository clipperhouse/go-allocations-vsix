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
}

const getBenchmarkKey = (packagePath: string, benchmarkName: string): string => {
    const p = path.resolve(packagePath);
    return `${p}:${benchmarkName}`;
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

    getChildren(modules: ModuleCache[], benchmarkItems: Map<string, BenchmarkItem>): BenchmarkItem[] {
        // Find the package in the modules structure
        const module = modules.find(m => m.packages.some(p => p.path === this.filePath));
        if (!module) {
            throw new Error('Module not found in cache');
        }

        const pkg = module.packages.find(p => p.path === this.filePath);
        if (!pkg) {
            throw new Error('Package not found in cache');
        }

        const benchmarks: BenchmarkItem[] = [];

        for (const benchmark of pkg.benchmarks) {
            const item = new BenchmarkItem(
                benchmark,
                this
            );
            const key = getBenchmarkKey(this.filePath, benchmark);
            benchmarkItems.set(key, item);
            benchmarks.push(item);
        }

        return benchmarks;
    }
}

const noAllocationsItem = new InformationItem('No allocations found', 'info');
const routineRegex = /^ROUTINE\s*=+\s*(.+?)\s+in\s+(.+)$/;
const lineRegex = /^\s*(\d+(?:\.\d+)?[KMGT]?B)?\s*(\d+(?:\.\d+)?[KMGT]?B)?\s*(\d+):\s*(.+)$/;

export class BenchmarkItem extends vscode.TreeItem {
    public readonly contextValue: 'benchmarkFunction' = 'benchmarkFunction';
    public readonly parent: PackageItem;

    constructor(
        label: string,
        parent: PackageItem
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.parent = parent;

        this.iconPath = new vscode.ThemeIcon('symbol-function');
        this.tooltip = `Click to run ${label} and discover allocations`;
    }

    get filePath(): string {
        return this.parent.filePath;
    }

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
                const allocationData = await this.parseMemoryProfile(memprofilePath, signal);

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

    private async parseMemoryProfile(memprofilePath: string, signal: AbortSignal): Promise<BenchmarkChildItem[]> {
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
                    const functionMatch = trimmedLine.match(routineRegex);
                    if (functionMatch) {
                        currentFunction = functionMatch[1];
                        currentFile = functionMatch[2];
                        inFunction = true;
                        return;
                    }

                    // Check if we're in a function and this is a line with allocation data
                    if (inFunction && trimmedLine && !trimmedLine.includes('Total:') && !trimmedLine.includes('ROUTINE')) {
                        const lineMatch = trimmedLine.match(lineRegex);
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
                        resolve([noAllocationsItem]);
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
                results.push(noAllocationsItem);
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
    private shortFunctionName = (fullName: string): string => {
        const slash = fullName.lastIndexOf('/');
        const afterSlash = slash >= 0 ? fullName.slice(slash + 1) : fullName;
        const firstDot = afterSlash.indexOf('.');
        return firstDot >= 0 ? afterSlash.slice(firstDot + 1) : afterSlash;
    }
}

export type BenchmarkChildItem = InformationItem | AllocationItem;

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
        this.iconPath = this.getImageUri('memory.goblue.64.png');
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

    private getImageUri(imageName: string): vscode.Uri {
        return vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'images', imageName);
    }
}

export interface AllocationData {
    flatBytes: string;
    cumulativeBytes: string;
    functionName: string;
}

interface ModuleCache {
    name: string;
    path: string;
    packages: { name: string; path: string; benchmarks: string[] }[]
}

export class TreeDataProvider implements vscode.TreeDataProvider<Item> {
    public _onDidChangeTreeData: vscode.EventEmitter<Item | undefined | null | void> = new vscode.EventEmitter<Item | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Item | undefined | null | void> = this._onDidChangeTreeData.event;

    // Cache for discovered modules and their packages
    private modules: ModuleCache[] = [];
    private benchmarkItems: Map<string, BenchmarkItem> = new Map();
    private loadingPromise: Promise<void> | null = null;

    // No secondary caches for TreeItems; use stable ids and ModuleCache as source of truth

    constructor() { }

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
        this.modules = [];
        this.benchmarkItems = new Map();
        this.loadingPromise = null;

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
            // If not loaded, start loading
            if (!this.loadingPromise) {
                // Start loading in the background and store the promise
                this.loadingPromise = this.loadPackages().catch(error => {
                    console.error('Error loading packages:', error);
                });
            }

            // Always include instructional text at the top
            const instruction = new InformationItem(
                'Click a benchmark below to discover allocations'
            );

            // Return currently discovered modules immediately (even if loading is still in progress)
            const moduleItems = this.modules.map(module => new ModuleItem(module.name, module.path));

            return [instruction, ...moduleItems];
        }

        if (element instanceof ModuleItem) {
            return this.getPackagesForModule(element);
        }

        if (element instanceof PackageItem) {
            return element.getChildren(this.modules, this.benchmarkItems);
        }

        if (element instanceof BenchmarkItem) {
            return await element.getChildren(this.abortSignal());
        }

        return Promise.resolve([]);
    }

    private async loadPackages(): Promise<void> {
        const signal = this.abortSignal();

        if (!vscode.workspace.workspaceFolders) {
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            console.log('Using workspace symbol search for benchmark discovery');

            // Get all benchmark symbols once for the entire workspace
            console.log('Searching for benchmark functions via workspace symbols...');
            let allBenchmarkSymbols: Array<{ name: string; fileUri: vscode.Uri }> = [];

            try {
                // Search for all symbols containing "Benchmark" across the workspace
                const workspaceSymbols: vscode.SymbolInformation[] = await vscode.commands.executeCommand(
                    'vscode.executeWorkspaceSymbolProvider',
                    'Benchmark'
                );

                allBenchmarkSymbols = workspaceSymbols.filter(symbol =>
                    symbol.kind === vscode.SymbolKind.Function &&
                    symbol.location.uri.fsPath.endsWith('_test.go') &&
                    this.benchmarkNameRegex.test(symbol.name)
                ).map(symbol => ({
                    name: symbol.name,
                    fileUri: symbol.location.uri
                }));
            } catch (error) {
                console.warn('Workspace symbol search failed:', error);
            }

            console.log(`Found ${allBenchmarkSymbols.length} benchmark functions total`);

            // Process each workspace folder with the filtered symbols
            for (const workspaceFolder of vscode.workspace.workspaceFolders) {
                if (signal.aborted) {
                    throw new Error('Operation cancelled');
                }

                try {
                    await this.loadPackagesFromWorkspace(workspaceFolder, allBenchmarkSymbols);
                } catch (error) {
                    if (signal.aborted) {
                        throw error;
                    }
                    console.error('Error processing workspace folder:', error);
                    throw error; // Don't silently continue if gopls fails
                }
            }

            console.log('Discovery completed using workspace symbols');
        } catch (error) {
            if (signal.aborted) {
                console.log('Package loading cancelled');
                throw error;
            }
        } finally {
            this._onDidChangeTreeData.fire();
        }
    }

    private readonly benchmarkNameRegex = /^Benchmark[A-Z_]/;
    /**
     * Load packages and benchmarks using workspace symbol search
     */
    private async loadPackagesFromWorkspace(
        workspaceFolder: vscode.WorkspaceFolder,
        allBenchmarkSymbols: Array<{ name: string; fileUri: vscode.Uri }>
    ): Promise<void> {
        const signal = this.abortSignal();

        try {
            if (signal.aborted) {
                throw new Error('Operation cancelled');
            }

            const rootPath = workspaceFolder.uri.fsPath;

            // Get the module name for this workspace (still need go list for this)
            const { stdout: moduleName } = await execAsync('go list -m', {
                cwd: rootPath,
                signal: signal
            });

            if (!moduleName.trim() || moduleName.trim() === 'command-line-arguments') {
                return; // Skip if not a valid module
            }

            // Create module entry (each workspace folder should have a unique module)
            const module: ModuleCache = {
                name: moduleName.trim(),
                path: rootPath,
                packages: []
            };
            this.modules.push(module);

            // Filter benchmark symbols for this workspace folder
            if (signal.aborted) {
                throw new Error('Operation cancelled');
            }

            const benchmarkSymbols = allBenchmarkSymbols.filter(symbol =>
                symbol.fileUri.fsPath.startsWith(rootPath)
            );

            console.log(`Found ${benchmarkSymbols.length} benchmark functions in ${workspaceFolder.name}`);

            // Group benchmarks by package directory
            const packageMap = new Map<string, { name: string; path: string; benchmarks: string[] }>();

            for (const symbol of benchmarkSymbols) {
                if (signal.aborted) {
                    throw new Error('Operation cancelled');
                }

                const packageDir = path.dirname(symbol.fileUri.fsPath);
                const packageName = await this.getPackageNameFromPath(packageDir, rootPath);

                if (!packageMap.has(packageDir)) {
                    packageMap.set(packageDir, {
                        name: packageName,
                        path: packageDir,
                        benchmarks: []
                    });
                }

                packageMap.get(packageDir)!.benchmarks.push(symbol.name);
            }

            // Add packages with benchmarks to the module
            for (const pkg of packageMap.values()) {
                if (pkg.benchmarks.length > 0) {
                    module.packages.push(pkg);
                    console.log(`Added package ${pkg.name} with ${pkg.benchmarks.length} benchmarks`);

                    // Fire update immediately for responsive UI
                    this._onDidChangeTreeData.fire();
                }
            }
        } catch (error) {
            if (signal.aborted) {
                console.log('Gopls package discovery cancelled');
                throw error;
            }
            console.error('Gopls discovery failed:', error);
            throw error; // Let the caller handle the error
        }
    }

    /**
     * Helper method to determine package name from directory path
     */
    private async getPackageNameFromPath(packageDir: string, rootPath: string): Promise<string> {
        const relativePath = path.relative(rootPath, packageDir);
        if (relativePath === '') {
            try {
                const { stdout } = await execAsync('go list -f "{{.Name}}" .', { cwd: packageDir });
                return stdout.trim();
            } catch {
                return relativePath;
            }
        }

        return relativePath.replaceAll('\\', '/');
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

    async findBenchmark(packagePath: string, benchmarkName: string): Promise<BenchmarkItem> {
        await this.ensureLoaded();
        const key = getBenchmarkKey(packagePath, benchmarkName);
        const benchmarkItem = this.benchmarkItems.get(key);
        if (!benchmarkItem) {
            throw new Error(`Benchmark not found: ${benchmarkName} in package ${packagePath}`);
        }
        return benchmarkItem;
    }

    async ensureLoaded(): Promise<void> {
        // Trigger loading if needed (getChildren will create loadingPromise if not started)
        if (!this.loadingPromise) {
            await this.getChildren();
        }

        // Await the loading promise (fast if already resolved)
        await this.loadingPromise;
    }
}
