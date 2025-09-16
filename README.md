# Go Allocations VS Code Extension

A VS Code extension to help locate Go allocations from benchmarks, similar to the Test Explorer panel.

## Features

- View Go benchmark files in a tree structure
- Navigate benchmark functions and their allocation data
- Run benchmarks and analyze allocation patterns
- (Future) Integration with Go benchmark tools

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

1. Open a Go workspace
2. Look for the "Go Allocations" panel in the Explorer sidebar
3. Expand the tree to see benchmark files and their allocation data

## Roadmap

- [ ] Parse actual Go benchmark files
- [ ] Run `go test -bench` commands
- [ ] Parse benchmark output for allocation data
- [ ] Display allocation metrics in a user-friendly format
- [ ] Add filtering and search capabilities
- [ ] Integration with Go tools for detailed analysis
