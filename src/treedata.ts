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

class InformationItem extends vscode.TreeItem {
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

const getPackageLabel = (pkg: PackageCache): string => {
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

class ModuleItem extends vscode.TreeItem {
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

    getChildren(modules: ModuleCache[]): PackageItem[] {
        const module = modules.find(m => m.path === this.modulePath);
        if (!module) {
            throw new Error('Module not found in cache');
        }

        const packages: PackageItem[] = [];

        for (const pkg of module.packages) {
            const item = new PackageItem(
                getPackageLabel(pkg),
                pkg.path,
                this
            );
            packages.push(item);
        }

        return packages;
    }
}

class PackageItem extends vscode.TreeItem {
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

    getChildren(modules: ModuleCache[], benchmarkItemCache: BenchmarkItemCache): BenchmarkItem[] {
        // Find the package in the modules structure
        const module = modules.find(m => m.packages.some(p => p.path === this.filePath));
        if (!module) {
            throw new Error('Module not found in cache');
        }

        const pkg = module.packages.find(p => p.path === this.filePath);
        if (!pkg) {
            throw new Error('Package not found in cache');
        }

        const benchmarkItems: BenchmarkItem[] = [];

        for (const benchmark of pkg.benchmarks) {
            const item = new BenchmarkItem(benchmark, this);
            benchmarkItemCache.add(item);
            benchmarkItems.push(item);
        }

        return benchmarkItems;
    }
}

const noAllocationsItem = new InformationItem('No allocations found', 'info');
const routineRegex = /^ROUTINE\s*=+\s*(.+?)\s+in\s+(.+)$/;
const lineRegex = /^\s*(\d+(?:\.\d+)?[KMGT]?B)?\s*(\d+(?:\.\d+)?[KMGT]?B)?\s*(\d+):\s*(.+)$/;

export class BenchmarkItem extends vscode.TreeItem {
    public readonly contextValue: 'benchmarkItem' = 'benchmarkItem';
    public readonly parent: PackageItem;
    public readonly location: vscode.Location;

    constructor(
        benchmark: BenchmarkCache,
        parent: PackageItem,
    ) {
        super(benchmark.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.location = benchmark.location;
        this.parent = parent;

        this.iconPath = new vscode.ThemeIcon('symbol-function');
        this.tooltip = `Click to run ${benchmark.name} and discover allocations`;
    }

    get folderPath(): string {
        return this.parent.filePath;
    }

    async getChildren(signal: AbortSignal): Promise<BenchmarkChildItem[]> {
        if (!this.folderPath) {
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
                        cwd: this.folderPath,
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
                    cwd: this.folderPath,
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

    async navigateTo(): Promise<void> {
        await navigateTo(this.location.uri.fsPath, this.location.range.start.line + 1);
    }
}

type BenchmarkChildItem = InformationItem | AllocationItem;

class AllocationItem extends vscode.TreeItem {
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

    async navigateTo(): Promise<void> {
        await navigateTo(this.filePath, this.lineNumber);
    }
}

const navigateTo = async (filePath: string, lineNumber: number): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(lineNumber - 1, 0); // Convert to 0-based line number
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

interface AllocationData {
    flatBytes: string;
    cumulativeBytes: string;
    functionName: string;
}

class BenchmarkItemCache extends Map<string, BenchmarkItem> {
    add(item: BenchmarkItem): void {
        const key = this.getKey(item.parent.filePath, item.label as string);
        this.set(key, item);
    }

    find(packagePath: string, benchmarkName: string): BenchmarkItem | undefined {
        const key = this.getKey(packagePath, benchmarkName);
        return this.get(key);
    }

    private getKey(packagePath: string, benchmarkName: string): string {
        const p = path.resolve(packagePath);
        return `${p}::${benchmarkName}`;
    }
}

interface PackageCache {
    name: string;
    path: string;
    benchmarks: BenchmarkCache[];
}

interface BenchmarkCache {
    name: string;
    location: vscode.Location;
}

interface ModuleCache {
    name: string;
    path: string;
    packages: PackageCache[];
}

export class TreeDataProvider implements vscode.TreeDataProvider<Item> {
    public _onDidChangeTreeData: vscode.EventEmitter<Item | undefined | null | void> = new vscode.EventEmitter<Item | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Item | undefined | null | void> = this._onDidChangeTreeData.event;

    // Cache for discovered modules and their packages
    private modules: ModuleCache[] = [];
    private benchmarkItems: BenchmarkItemCache = new BenchmarkItemCache();
    private loadingPromise: Promise<void> | null = null;

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
        this.modules = [];
        this.benchmarkItems = new BenchmarkItemCache();
        this.loadingPromise = null;

        // Fire tree data change event to refresh the view
        this._onDidChangeTreeData.fire();
    }

    async handleSelection(e: vscode.TreeViewSelectionChangeEvent<Item>): Promise<void> {
        if (e.selection.length === 0) {
            return;
        }

        const selectedItem = e.selection[0];
        if (selectedItem instanceof AllocationItem) {
            await selectedItem.navigateTo();
            return;
        }
    };

    getTreeItem(element: Item): vscode.TreeItem {
        return element;
    }

    getParent(element: Item): vscode.ProviderResult<Item> {
        if (!element) {
            return undefined; // Root level
        }

        if (element instanceof ModuleItem) {
            return undefined; // Module is at root level
        }

        if (element instanceof PackageItem) {
            return element.parent;
        }

        if (element instanceof BenchmarkItem) {
            return element.parent;
        }

        if (element instanceof AllocationItem) {
            return undefined;
        }

        return undefined;
    }

    async getChildren(element?: Item): Promise<Item[]> {
        if (!element) {
            // If not loaded, start loading
            if (!this.loadingPromise) {
                // Start loading in the background and store the promise
                this.loadingPromise = this.loadModules().catch(error => {
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
            return element.getChildren(this.modules);
        }

        if (element instanceof PackageItem) {
            return element.getChildren(this.modules, this.benchmarkItems);
        }

        if (element instanceof BenchmarkItem) {
            return await element.getChildren(this.abortSignal());
        }

        return Promise.resolve([]);
    }

    private async loadModules(): Promise<void> {
        const signal = this.abortSignal();

        if (!vscode.workspace.workspaceFolders) {
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            console.log('Using workspace symbol search for benchmark discovery');

            // Get all benchmark symbols once for the entire workspace
            console.log('Searching for benchmark functions via workspace symbols...');
            let allBenchmarkSymbols: vscode.SymbolInformation[] = [];

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
                );
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
                    await this.loadModulesInWorkspace(workspaceFolder, allBenchmarkSymbols);
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
    private async loadModulesInWorkspace(
        workspaceFolder: vscode.WorkspaceFolder,
        allBenchmarkSymbols: vscode.SymbolInformation[]
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
                symbol.location.uri.fsPath.startsWith(rootPath)
            );

            console.log(`Found ${benchmarkSymbols.length} benchmark functions in ${workspaceFolder.name}`);

            // Group benchmarks by package directory
            const packageMap = new Map<string, PackageCache>();

            for (const symbol of benchmarkSymbols) {
                if (signal.aborted) {
                    throw new Error('Operation cancelled');
                }

                const packageDir = path.dirname(symbol.location.uri.fsPath);
                const packageName = await this.getPackageNameFromPath(packageDir, rootPath);

                if (!packageMap.has(packageDir)) {
                    packageMap.set(packageDir, {
                        name: packageName,
                        path: packageDir,
                        benchmarks: []
                    });
                }

                packageMap.get(packageDir)!.benchmarks.push({
                    name: symbol.name,
                    location: new vscode.Location(symbol.location.uri, symbol.location.range)
                });
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

    /**
     * Discovers all benchmarks, and runs them with semaphore control.
     * Relies on TreeView.reveal to trigger getChildren automatically.
     */
    async runAllBenchmarks(treeView: vscode.TreeView<Item>): Promise<void> {
        const signal = this.abortSignal();

        const sema = new Sema(2);
        const promises: Promise<void>[] = [];

        try {
            for (const benchmarkItem of this.benchmarkItems.values()) {
                if (signal.aborted) {
                    return;
                }

                const p = (async () => {
                    await sema.acquire();
                    try {
                        if (signal.aborted) {
                            return;
                        }

                        this.clearBenchmarkRunState(benchmarkItem);
                        await treeView.reveal(benchmarkItem, { expand: true });
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

            await Promise.all(promises);
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
        const benchmarkItem = this.benchmarkItems.find(packagePath, benchmarkName);
        if (!benchmarkItem) {
            throw new Error(`Benchmark not found: ${benchmarkName} in package ${packagePath}`);
        }
        return benchmarkItem;
    }

    private async ensureLoaded(): Promise<void> {
        // Trigger loading if needed (getChildren will create loadingPromise if not started)
        if (!this.loadingPromise) {
            await this.getChildren();
        }

        // Await the loading promise (fast if already resolved)
        await this.loadingPromise;
    }
}
