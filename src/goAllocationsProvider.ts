import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class GoAllocationsProvider implements vscode.TreeDataProvider<AllocationItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AllocationItem | undefined | null | void> = new vscode.EventEmitter<AllocationItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<AllocationItem | undefined | null | void> = this._onDidChangeTreeData.event;

    // Cache for discovered packages
    private packages: { name: string; path: string }[] = [];
    private packagesLoaded = false;
    private isLoading = false;

    constructor() {
        console.log('GoAllocationsProvider constructor called');
        console.log('Workspace folders in constructor:', vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath));
    }

    refresh(): void {
        this.packagesLoaded = false;
        this.packages = [];
        this.isLoading = false;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: AllocationItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AllocationItem): Promise<AllocationItem[]> {
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

            // If currently loading, show loading message
            if (this.isLoading) {
                return [new AllocationItem(
                    'Discovering benchmarks…',
                    vscode.TreeItemCollapsibleState.None,
                    'loading'
                )];
            }

            // Start loading process
            this.isLoading = true;
            this._onDidChangeTreeData.fire();

            // Start the actual loading process in the background
            this.loadPackages().catch(error => {
                console.error('Error loading packages:', error);
                this.isLoading = false;
                this._onDidChangeTreeData.fire();
            });

            // Return loading message immediately
            return [new AllocationItem(
                'Discovering benchmarks…',
                vscode.TreeItemCollapsibleState.None,
                'loading'
            )];
        } else if (element.contextValue === 'package') {
            // Show benchmark functions in this package
            console.log('Getting benchmark functions for package:', element.label);
            return this.getBenchmarkFunctions(element);
        } else if (element.contextValue === 'benchmarkFunction') {
            // Show allocation data for the function
            console.log('Getting allocation data for:', element.label);
            return this.getAllocationData(element);
        }

        console.log('No matching context value, returning empty array');
        return Promise.resolve([]);
    }

    private async loadPackages(): Promise<void> {
        console.log('Starting package discovery...');

        if (!vscode.workspace.workspaceFolders) {
            this.isLoading = false;
            this.packagesLoaded = true;
            this._onDidChangeTreeData.fire();
            return;
        }

        for (const workspaceFolder of vscode.workspace.workspaceFolders) {
            try {
                console.log('Processing workspace folder:', workspaceFolder.uri.fsPath);
                const benchmarkPackages = await this.findBenchmarkPackages(workspaceFolder.uri.fsPath);

                for (const pkg of benchmarkPackages) {
                    this.packages.push(pkg);
                }
            } catch (error) {
                console.error('Error finding benchmark packages:', error);
            }
        }

        console.log('Package discovery complete. Found', this.packages.length, 'packages');
        this.packagesLoaded = true;
        this.isLoading = false;

        // Fire change event to update the tree with final results
        this._onDidChangeTreeData.fire();
    }

    private async findBenchmarkPackages(rootPath: string): Promise<{ name: string; path: string }[]> {
        try {
            // First, get all packages using go list
            const { stdout: packagesOutput } = await execAsync('go list -f "{{.Name}} {{.Dir}}" ./...', { cwd: rootPath });

            const packages: { name: string; path: string }[] = [];
            const packageLines = packagesOutput.trim().split('\n');

            // For each package, check if it has benchmarks
            for (const line of packageLines) {
                if (line.trim()) {
                    const parts = line.trim().split(' ');
                    if (parts.length >= 2) {
                        const packageName = parts[0];
                        const packageDir = parts.slice(1).join(' ');

                        try {
                            // Check if this package has benchmarks
                            const { stdout: benchmarksOutput } = await execAsync(
                                'go test -list="^Benchmark[A-Z][^/]*$"',
                                { cwd: packageDir }
                            );

                            const benchmarkLines = benchmarksOutput.trim().split('\n');
                            const hasBenchmarks = benchmarkLines.some(line =>
                                line.trim().startsWith('Benchmark') && !line.includes('ok')
                            );

                            if (hasBenchmarks) {
                                packages.push({ name: packageName, path: packageDir });
                            }
                        } catch (packageError) {
                            // Skip packages that can't be tested (e.g., no test files)
                            console.warn(`Could not test package ${packageName}:`, packageError);
                        }
                    }
                }
            }

            return packages;
        } catch (error) {
            console.error('Error finding benchmark packages:', error);
            throw error;
        }
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

    private async getAllocationData(functionItem: AllocationItem): Promise<AllocationItem[]> {
        if (!functionItem.filePath) {
            return [];
        }

        try {
            // Run benchmark with memory profiling
            const memprofilePath = path.join(functionItem.filePath, 'memprofile.pb.gz');
            const benchmarkName = functionItem.label;

            // Run the specific benchmark with memory profiling and debug info
            const { stdout, stderr } = await execAsync(
                `go test -bench=^${benchmarkName}$ -memprofile=${memprofilePath} -run=^$ -gcflags="all=-N -l"`,
                { cwd: functionItem.filePath }
            );

            if (stderr) {
                console.error('Benchmark stderr:', stderr);
            }

            // Parse the memory profile using pprof
            const allocationData = await this.parseMemoryProfile(memprofilePath, functionItem.filePath);

            // Clean up the memory profile file
            try {
                await fs.promises.unlink(memprofilePath);
            } catch (cleanupError) {
                console.warn('Could not clean up memory profile file:', cleanupError);
            }

            return allocationData;
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

    private async parseMemoryProfile(memprofilePath: string, packagePath: string): Promise<AllocationItem[]> {
        try {
            // Get the list of functions to find the main allocation function
            const { stdout: listOutput } = await execAsync(`go tool pprof -list=. ${memprofilePath}`, {
                cwd: packagePath
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
                                        flatPercent: '0', // We don't have percentage in this format
                                        cumPercent: '0',
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
    flatPercent: string;
    cumPercent: string;
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
                this.command = {
                    command: 'vscode.open',
                    title: 'Open Package Directory',
                    arguments: [vscode.Uri.file(filePath || '')]
                };
                break;
            case 'benchmarkFunction':
                this.iconPath = new vscode.ThemeIcon('symbol-function');
                this.tooltip = `Benchmark function: ${label}`;
                break;
            case 'allocationLine':
                this.iconPath = new vscode.ThemeIcon('symbol-field');
                this.tooltip = this.buildAllocationTooltip();
                this.command = {
                    command: 'goAllocations.openFileAtLine',
                    title: 'Open File at Line',
                    arguments: [filePath, lineNumber]
                };
                break;
            case 'loading':
                this.iconPath = new vscode.ThemeIcon('loading~spin');
                this.tooltip = 'Discovering Go benchmark packages...';
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

        const { flatPercent, cumPercent, bytes, objBytes, callCount, functionName } = this.allocationData;
        return [
            `Function: ${functionName}`,
            `Flat allocation: ${bytes} (${flatPercent}% of total)`,
            `Cumulative allocation: ${objBytes} (${cumPercent}% of total)`,
            callCount !== 'N/A' ? `Call count: ${callCount}` : '',
            this.filePath && this.lineNumber ? `Location: ${path.basename(this.filePath)}:${this.lineNumber}` : ''
        ].filter(line => line).join('\n');
    }
}
