# Go Allocations Explorer

A VS Code extension that helps locate and analyze Go allocations from benchmark tests, providing a tree view similar to the Test Explorer panel.

## Features

- **Tree View Interface**: Browse Go benchmark files in an organized tree structure
- **Allocation Analysis**: Navigate benchmark functions and their allocation data
- **Benchmark Execution**: Run individual benchmarks or all benchmarks at once
- **Real-time Results**: View allocation patterns and metrics as benchmarks complete
- **File Navigation**: Click on allocation lines to jump directly to source code
- **Concurrent Execution**: Run multiple benchmarks in parallel for faster analysis

## Version 0.1.0

This is the initial release of the Go Allocations Explorer extension.

## Installation

### From VSIX File

1. Download the latest `.vsix` file from the [Releases](https://github.com/clipperhouse/go-allocations-vsix/releases) page
2. Open VS Code
3. Go to Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`)
4. Click the "..." menu and select "Install from VSIX..."
5. Select the downloaded `.vsix` file
6. Reload VS Code when prompted

### From Source

See the Development section below for building from source.

## Development

### Prerequisites

- Node.js (v16 or later)
- TypeScript
- VS Code

### Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Compile the TypeScript:
   ```bash
   npm run compile
   ```

3. Open this folder in VS Code and press F5 to run the extension in a new Extension Development Host window.

### Building

- `npm run compile` - Compile TypeScript to JavaScript
- `npm run watch` - Watch for changes and compile automatically

## Usage

1. **Open a Go workspace** with benchmark test files (`*_test.go`)
2. **Find the extension** in the Activity Bar - look for the "Go Allocations Explorer" icon
3. **Browse the tree structure**:
   - Packages containing benchmark files
   - Individual benchmark functions
   - Allocation data and metrics
4. **Run benchmarks**:
   - Click "Run all benchmarks" to execute all benchmarks
   - Click the play button next to individual benchmarks
   - Use "Stop all benchmarks" to cancel running operations
5. **Navigate to source code** by clicking on allocation lines
6. **Configure settings** in VS Code settings for timeout, concurrency, etc.

### Configuration

The extension provides several configuration options:

- `goAllocations.benchmarkTimeout`: Timeout in seconds for running benchmarks (default: 300)
- `goAllocations.maxConcurrency`: Maximum number of benchmarks to run concurrently (default: 4)
- `goAllocations.autoRunOnOpen`: Automatically run benchmarks when opening a Go workspace (default: false)

## Roadmap

- [ ] Parse actual Go benchmark files
- [ ] Run `go test -bench` commands
- [ ] Parse benchmark output for allocation data
- [ ] Display allocation metrics in a user-friendly format
- [ ] Add filtering and search capabilities
- [ ] Integration with Go tools for detailed analysis
