# Go Allocations Explorer

A VS Code extension that helps locate Go allocations, using your benchmarks.

## Screenshot

<img src="https://raw.githubusercontent.com/clipperhouse/go-allocations-vsix/main/images/Screenshot1.png" width="480" alt="Go Allocations Explorer Screenshot">

## Installation

1. Download the latest `.vsix` file from the [Releases](https://github.com/clipperhouse/go-allocations-vsix/releases) page
2. Open VS Code
3. Go to Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`)
4. Click the "..." menu and select "Install from VSIX..."
5. Select the downloaded `.vsix` file
6. Reload VS Code when prompted

### Quick Start

1. **Open a Go workspace (module)** that contains benchmarks
2. **Find the extension** in the Activity Bar - look for the "Go Allocations Explorer" icon
3. **Browse the tree structure**:
   - Packages containing benchmark files
   - Individual benchmark functions
4. **Run benchmarks**:
   - Click on a benchmark to run and discover allocations
5. **Navigate to source lines** by clicking on allocations details

### Install from source

If you wish to build it yourself (good idea!), you can Google or GPT how to do that. The source is all here.

## Version 0.1.0

- This is a basic, initial release.
- Works on my machine™ with a typical Go codebase.
- You will almost certainly find rough edges, let me know.

## Support

- **Issues**: [GitHub Issues](https://github.com/clipperhouse/go-allocations-vsix/issues)
- **Repository**: [GitHub Repository](https://github.com/clipperhouse/go-allocations-vsix)
- **𝕏**: [@clipperhouse](https://x.com/clipperhouse)

## License

MIT License - see [LICENSE](https://github.com/clipperhouse/go-allocations-vsix/blob/main/LICENSE).
