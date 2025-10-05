import * as vscode from 'vscode';
import * as path from 'path';

export class CodeLensProvider implements vscode.CodeLensProvider {
    private readonly benchRegex = /^\s*func\s+(Benchmark[A-Za-z0-9_]+)\s*\(b\s*\*testing\.B\)/;
    private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeCodeLensesEmitter.event;

    constructor() { }

    refresh(): void {
        this.onDidChangeCodeLensesEmitter.fire();
    }

    provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
        // Check if code lens is enabled in settings
        const config = vscode.workspace.getConfiguration('goAllocations');
        const showCodeLens = config.get<boolean>('showCodeLens', true);

        if (!showCodeLens) {
            return [];
        }

        // Only add to _test.go files
        if (!document.fileName.endsWith('_test.go')) return [];

        const lenses: vscode.CodeLens[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const m = line.text.match(this.benchRegex);
            if (m) {
                const benchmarkName = m[1];
                // Unfortunately, there is no official API to control CodeLens ordering across providers.
                // The best we can do is use the same range as the Go extension and hope VS Code's merge
                // algorithm places ours in a reasonable position.
                const range = new vscode.Range(i, 0, i, line.text.length);
                const packageDir = path.dirname(document.uri.fsPath);
                const cmd: vscode.Command = {
                    command: 'goAllocations.runBenchmarkFromEditor',
                    title: 'find allocations',
                    arguments: [{ packageDir, benchmarkName }]
                };
                lenses.push(new vscode.CodeLens(range, cmd));
            }
        }
        return lenses;
    }
}
