import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GoModule {
    name: string;
}

export class GoEnvironment {
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
            // Discover modules from workspace folders
            if (workspaceFolders && workspaceFolders.length > 0) {
                await this.discoverModules(workspaceFolders);
            }
        } catch (error) {
            if (signal.aborted) {
                console.log('Go environment initialization cancelled');
                return;
            }
            console.error('Error initializing Go environment:', error);
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
                    const module: GoModule = {
                        name: moduleName.trim(),
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
    }
}
