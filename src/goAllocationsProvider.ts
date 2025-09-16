import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class GoAllocationsProvider implements vscode.TreeDataProvider<AllocationItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AllocationItem | undefined | null | void> = new vscode.EventEmitter<AllocationItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<AllocationItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor() {
        console.log('GoAllocationsProvider constructor called');
        // Initialize with some sample data for now
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: AllocationItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: AllocationItem): Thenable<AllocationItem[]> {
        if (!element) {
            // Root level - show benchmark files
            return this.getBenchmarkFiles();
        } else if (element.contextValue === 'benchmarkFile') {
            // Show benchmark functions in the file
            return this.getBenchmarkFunctions(element);
        } else if (element.contextValue === 'benchmarkFunction') {
            // Show allocation data for the function
            return this.getAllocationData(element);
        }
        return Promise.resolve([]);
    }

    private async getBenchmarkFiles(): Promise<AllocationItem[]> {
        const files: AllocationItem[] = [];

        if (!vscode.workspace.workspaceFolders) {
            return files;
        }

        for (const workspaceFolder of vscode.workspace.workspaceFolders) {
            try {
                // Use go list to find packages with test files
                const testPackages = await this.findGoTestPackages(workspaceFolder.uri.fsPath);
                for (const pkg of testPackages) {
                    const item = new AllocationItem(
                        pkg.name,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'benchmarkFile',
                        pkg.path
                    );
                    files.push(item);
                }
            } catch (error) {
                console.error('Error finding Go test packages:', error);
                // Fallback to file-based discovery
                const testFiles = await this.findGoTestFiles(workspaceFolder.uri.fsPath);
                for (const file of testFiles) {
                    const relativePath = path.relative(workspaceFolder.uri.fsPath, file);
                    const item = new AllocationItem(
                        relativePath,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'benchmarkFile',
                        file
                    );
                    files.push(item);
                }
            }
        }

        // If no test files found, show a message
        if (files.length === 0) {
            files.push(new AllocationItem(
                'No Go test packages found',
                vscode.TreeItemCollapsibleState.None,
                'noFiles'
            ));
        }

        return files;
    }

    private async findGoTestPackages(rootPath: string): Promise<{ name: string; path: string }[]> {
        try {
            // Use go list to find all packages with test files
            const { stdout } = await execAsync('go list -f "{{.Name}} {{.Dir}}" ./...', { cwd: rootPath });

            const packages: { name: string; path: string }[] = [];
            const lines = stdout.trim().split('\n');

            for (const line of lines) {
                if (line.trim()) {
                    const parts = line.trim().split(' ');
                    if (parts.length >= 2) {
                        const name = parts[0];
                        const dir = parts.slice(1).join(' ');

                        // Check if this package has test files
                        const hasTestFiles = await this.packageHasTestFiles(dir);
                        if (hasTestFiles) {
                            packages.push({ name, path: dir });
                        }
                    }
                }
            }

            return packages;
        } catch (error) {
            console.error('Error running go list command:', error);
            throw error;
        }
    }

    private async packageHasTestFiles(packagePath: string): Promise<boolean> {
        try {
            const files = await fs.promises.readdir(packagePath);
            return files.some(file => file.endsWith('_test.go'));
        } catch (error) {
            return false;
        }
    }

    private async findGoTestFiles(rootPath: string): Promise<string[]> {
        const testFiles: string[] = [];

        try {
            const files = await fs.promises.readdir(rootPath, { withFileTypes: true });

            for (const file of files) {
                const fullPath = path.join(rootPath, file.name);

                if (file.isDirectory() && !file.name.startsWith('.') && file.name !== 'node_modules') {
                    // Recursively search subdirectories
                    const subFiles = await this.findGoTestFiles(fullPath);
                    testFiles.push(...subFiles);
                } else if (file.isFile() && file.name.endsWith('_test.go')) {
                    testFiles.push(fullPath);
                }
            }
        } catch (error) {
            console.error('Error scanning directory:', error);
        }

        return testFiles;
    }

    private async getBenchmarkFunctions(fileItem: AllocationItem): Promise<AllocationItem[]> {
        if (!fileItem.filePath) {
            return [];
        }

        try {
            // Use go test -list to find benchmark functions in the package
            const { stdout } = await execAsync('go test -list=^Benchmark', { cwd: fileItem.filePath });

            const benchmarkFunctions: AllocationItem[] = [];
            const lines = stdout.trim().split('\n');

            for (const line of lines) {
                const functionName = line.trim();
                if (functionName && functionName.startsWith('Benchmark')) {
                    const item = new AllocationItem(
                        functionName,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'benchmarkFunction',
                        fileItem.filePath
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

                // Reset when we hit an empty line or new function
                if (trimmedLine === '' || trimmedLine.includes('ROUTINE')) {
                    inFunction = false;
                }
            }

            // If no allocation data found, show a message
            if (allocationItems.length === 0) {
                allocationItems.push(new AllocationItem(
                    'No allocation data found',
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
            case 'benchmarkFile':
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
            case 'allocationData':
                this.iconPath = new vscode.ThemeIcon('graph');
                this.tooltip = `Allocation metric: ${label}`;
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
