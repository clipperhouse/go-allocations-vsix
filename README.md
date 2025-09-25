# Go Allocations Explorer

An extension that helps locate Go allocations, using your benchmarks.

<img src="https://raw.githubusercontent.com/clipperhouse/go-allocations-vsix/main/Screenshot.png" width="560" alt="Go Allocations Explorer Screenshot">

## Quick Start

1. **Open a Go workspace (module)** that contains benchmarks
2. **Click the Go Allocations Explorer** in the Activity Bar
   - Packages containing benchmark files
   - Individual benchmark functions
4. **Run benchmarks**:
   - Click on a benchmark to run and discover allocations
5. **Navigate to source lines** by clicking on allocations details

## Requirements

- Go toolchain
- VS Code 1.74.0 or later

## Status

- Early release, feedback welcome.
- Works on my machine™ with a typical Go codebase.
- You will almost certainly find rough edges, let me know.

## Support

- **Issues**: [GitHub Issues](https://github.com/clipperhouse/go-allocations-vsix/issues)
- **𝕏**: [@clipperhouse](https://x.com/clipperhouse)

## License

MIT License - see [LICENSE](https://github.com/clipperhouse/go-allocations-vsix/blob/main/LICENSE).
