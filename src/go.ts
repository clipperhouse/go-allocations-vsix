import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GoModule {
    name: string;
    path: string;
    goModPath: string;
}

export class GoEnvironment {
    private Root: string | null = null;
    private Mod: string | null = null;
    private Modules: GoModule[] = [];
    private abortController: AbortController;

    // Private constructor - use GoEnvironment.New() instead
    private constructor(controller: AbortController) {
        this.abortController = controller;
    }

    public static async New(controller: AbortController, workspaceFolders?: readonly vscode.WorkspaceFolder[]): Promise<GoEnvironment> {
        const instance = new GoEnvironment(controller);
        await instance.initialize(workspaceFolders);
        return instance;
    }

    public setAbortController(controller: AbortController): void {
        this.abortController = controller;
    }

    public get modules(): GoModule[] {
        return this.Modules;
    }

    private abortSignal(): AbortSignal {
        return this.abortController.signal;
    }

    private async initialize(workspaceFolders?: readonly vscode.WorkspaceFolder[]): Promise<void> {
        const signal = this.abortSignal();

        try {
            // Get Go environment variables once and cache them
            const { stdout: goroot } = await execAsync('go env GOROOT', { signal: signal });
            this.Root = goroot.trim();

            // Discover modules from workspace folders
            if (workspaceFolders && workspaceFolders.length > 0) {
                await this.discoverModules(workspaceFolders);
            } else {
                // Fallback to single module discovery for backward compatibility
                const { stdout: gomod } = await execAsync('go env GOMOD', { signal: signal });
                this.Mod = gomod.trim();
            }
        } catch (error) {
            if (signal.aborted) {
                console.log('Go environment initialization cancelled');
                return;
            }
            console.error('Error initializing Go environment:', error);
            this.Root = null;
            this.Mod = null;
        }
    }

    private async discoverModules(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<void> {
        const signal = this.abortSignal();
        const modules: GoModule[] = [];

        for (const folder of workspaceFolders) {
            if (signal.aborted) {
                throw new Error('Operation cancelled');
            }

            try {
                // Check if this workspace folder contains a Go module
                const { stdout: moduleName } = await execAsync('go list -m', {
                    cwd: folder.uri.fsPath,
                    signal: signal
                });

                if (moduleName.trim() && moduleName.trim() !== 'command-line-arguments') {
                    // Get the go.mod file path
                    const { stdout: goModPath } = await execAsync('go env GOMOD', {
                        cwd: folder.uri.fsPath,
                        signal: signal
                    });

                    const module: GoModule = {
                        name: moduleName.trim(),
                        path: folder.uri.fsPath,
                        goModPath: goModPath.trim()
                    };

                    modules.push(module);
                }
            } catch (error) {
                if (signal.aborted) {
                    throw error;
                }
                // Skip workspace folders that don't contain Go modules
                console.warn(`Workspace folder ${folder.name} does not contain a Go module:`, error);
            }
        }

        this.Modules = modules;

        // For backward compatibility, set the first module as the primary module
        if (modules.length > 0) {
            this.Mod = modules[0].goModPath;
        }
    }
}
