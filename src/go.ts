import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class GoEnvironment {
    private Root: string | null = null;
    private Mod: string | null = null;
    private abortController: AbortController;

    // Private constructor - use GoEnvironment.New() instead
    private constructor(controller: AbortController) {
        this.abortController = controller;
    }

    public static async New(controller: AbortController): Promise<GoEnvironment> {
        const instance = new GoEnvironment(controller);
        await instance.initialize();
        return instance;
    }

    public setAbortController(controller: AbortController): void {
        this.abortController = controller;
    }

    private abortSignal(): AbortSignal {
        return this.abortController.signal;
    }

    private async initialize(): Promise<void> {
        const signal = this.abortSignal();

        try {
            // Get Go environment variables once and cache them
            const { stdout: goroot } = await execAsync('go env GOROOT', { signal: signal });
            const { stdout: gomod } = await execAsync('go env GOMOD', { signal: signal });
            this.Root = goroot.trim();
            this.Mod = gomod.trim();
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

    /**
     * Check if the given file path represents user code (not standard library or vendor code).
     */
    public isUserCode(filePath: string, functionName: string): boolean {
        try {
            // If we have a go.mod file, use the module root as the user code boundary
            if (this.Mod && this.Mod !== '/dev/null') {
                const path = require('path');
                const moduleRoot = path.dirname(this.Mod);
                // Check if the file is within the current module
                if (filePath.startsWith(moduleRoot)) {
                    return true;
                }
            }

            // If the file is in GOROOT, it's standard library
            if (this.Root && filePath.startsWith(this.Root)) {
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
