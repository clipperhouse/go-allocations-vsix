This codebase is a VS Code extension that helps locate Go allocations, using your benchmarks.
It is a sidebar in the VS Code UI.

Research how VS Code extensions work, and explain them. They seem to be
"reactive", there is a fair amount of "magic", where it's not obvious how
certain methods get called. Research the lifecycle. For example, getChildren
is an overload that is automatically called by the framework when tree nodes
are revealed.

When I ask for a new feature, focus on the smallest, simplest version first. Only
implement the "happy path" to start. After that, suggest edge cases and error
paths. Perhaps add comments indicating a TODO for handling those cases.

Avoid creating two sources of truth. There are two main data structures:

- The module cache is the source of truth for the module structure.
- In turn, we create TreeItems reflecting this structure, for the UI.

You might think of it as analogous to an MVC pattern. The model is the module
cache, the view is the TreeView, and the controller is the provider.

Prefer to throw an error when something unexpected happens. It probably
indicates a bug, or a violation of an invariant. Avoid things called
"ensure", that's a code smell.

Use types to help detect errors.

When I ask you to "review this PR", use the gh CLI tool to get information
about the pull request.
