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
        // For now, return some sample data
        // TODO: Parse benchmark output to find allocation data
        return [
            new AllocationItem('Allocations: 1000', vscode.TreeItemCollapsibleState.None, 'allocationData'),
            new AllocationItem('Bytes: 4096', vscode.TreeItemCollapsibleState.None, 'allocationData'),
            new AllocationItem('Allocs/op: 2.5', vscode.TreeItemCollapsibleState.None, 'allocationData')
        ];
    }
}

export class AllocationItem extends vscode.TreeItem {
    public readonly filePath?: string;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        filePath?: string
    ) {
        super(label, collapsibleState);
        this.contextValue = contextValue;
        this.filePath = filePath;

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
            case 'error':
                this.iconPath = new vscode.ThemeIcon('error');
                this.tooltip = 'Error occurred while listing benchmarks';
                break;
        }
    }
}
