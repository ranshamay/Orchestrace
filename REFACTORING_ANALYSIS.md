# Refactoring Analysis: Top 3 Largest Files

## File 1: `ui-server.ts` (9,926 LOC, 344.5 KB)

### Current Structure
- **Single massive file** containing HTTP server setup, session management, SSE broadcasting, authentication, event sourcing, and API handlers all in one place

### Key Issues
1. **Mixed Concerns**: Server setup, state management, API routing, auth, events all together
2. **Bloated In-Memory Maps**: 20+ separate Map collections for tracking session state
3. **Deeply Nested Functions**: Many large async functions with complex logic
4. **Duplicated Patterns**: Similar broadcast/streaming logic repeated multiple times
5. **No Separation**: Auth logic mixed with session logic mixed with API logic

### Identified Gaps

#### 1.1 Session State Management Gap
- **Current**: 20+ separate Maps scattered throughout
- **Gap**: No centralized session state container
- **Solution**: Create `SessionStateContainer` class to encapsulate all session-related state

#### 1.2 API Route Handler Gap
- **Current**: All routes inline in main request handler
- **Gap**: No modular route definition system
- **Solution**: Extract API routes into separate modules with clear separation

#### 1.3 Authentication Module Gap
- **Current**: Auth logic spread throughout (app auth, GitHub, provider management)
- **Gap**: No unified auth interface
- **Solution**: Create `AuthenticationManager` that orchestrates all auth concerns

#### 1.4 SSE/Broadcasting Module Gap
- **Current**: `broadcastWorkStream`, `broadcastSessionUpdate`, etc. duplicated patterns
- **Gap**: No abstraction for pub/sub messaging
- **Solution**: Create `StreamBroadcaster` class for unified messaging

#### 1.5 Event Store Integration Gap
- **Current**: Event store operations scattered, no error handling pattern
- **Gap**: No dedicated event sourcing service
- **Solution**: Create `SessionEventService` to manage event persistence

#### 1.6 Configuration/Constants Gap
- **Current**: 50+ constants defined at top level
- **Gap**: No organization of constants by concern
- **Solution**: Create config modules by feature (auth-config, streaming-config, etc.)

### Proposed Modularization

```
ui-server/
├── index.ts (main entry point, ~100 LOC)
├── server-setup.ts (HTTP server creation, ~200 LOC)
├── api-routes/
│   ├── index.ts (route registration)
│   ├── health.ts
│   ├── sessions.ts (session CRUD)
│   ├── chat.ts (chat endpoints)
│   ├── auth.ts (auth endpoints)
│   └── providers.ts (provider endpoints)
├── session/
│   ├── state-container.ts (centralized state)
│   ├── event-service.ts (event sourcing)
│   ├── lifecycle.ts (session lifecycle management)
│   └── checkpoint.ts (checkpoint operations)
├── auth/
│   ├── manager.ts (unified auth management)
│   ├── jwt.ts (JWT handling)
│   ├── providers.ts (provider-specific auth)
│   └── config.ts (auth constants)
├── streaming/
│   ├── broadcaster.ts (SSE broadcasting)
│   ├── chat-stream.ts (chat streaming)
│   └── work-stream.ts (work/event streaming)
└── config/
    ├── constants.ts
    ├── defaults.ts
    └── environment.ts
```

### Expected Reduction
- **From**: 9,926 LOC in single file
- **To**: ~1,500 LOC in main file, distributed across modules
- **Benefit**: 85% reduction in main file size, clear module responsibilities

---

## File 2: `runner.ts` (3,665 LOC, 139.2 KB)

### Current Structure
- **All-in-one orchestration runner** with execution, git operations, PR creation, delivery, and checkpoint logic

### Key Issues
1. **Massive Main Function**: ~3000 LOC in `main()` function
2. **Mixed Git/GitHub/Delivery Logic**: All delivery concerns in one place
3. **Poor Separation of Concerns**: Task execution, git operations, PR creation all mixed
4. **Complex State Management**: Multiple interconnected state objects
5. **Nested Async Logic**: Deep promise chains and complex control flow

### Identified Gaps

#### 2.1 Task Execution Module Gap
- **Current**: Orchestration logic mixed with setup/validation/cleanup
- **Gap**: No clear execution phase separation
- **Solution**: Extract execution orchestration into `TaskExecutor` class

#### 2.2 Git Operations Module Gap
- **Current**: Git commands scattered throughout (`runGit`, `runGitSafe`, `getGitHeadSha`, etc.)
- **Gap**: No abstraction over git operations
- **Solution**: Create `GitOperations` class to encapsulate all git commands

#### 2.3 Delivery/PR Creation Module Gap
- **Current**: Entire session delivery pipeline inline (~1000 LOC)
- **Gap**: No modular delivery strategy
- **Solution**: Extract to `SessionDeliveryService` with strategy pattern

#### 2.4 Checkpoint/Auto-Commit Module Gap
- **Current**: Checkpoint logic mixed with execution
- **Gap**: No dedicated checkpoint service
- **Solution**: Create `CheckpointService` for auto-checkpoint operations

#### 2.5 GitHub Integration Module Gap
- **Current**: GitHub API calls scattered
- **Gap**: No GitHub client abstraction
- **Solution**: Create `GitHubClient` for API operations

#### 2.6 Lifecycle Management Gap
- **Current**: Phase management somewhat structured but intertwined with execution
- **Gap**: Weak separation of lifecycle phases
- **Solution**: Enhance `SessionLifecycle` class usage

### Proposed Modularization

```
runner/
├── index.ts (entry point, ~100 LOC)
├── main.ts (orchestration, ~300 LOC, down from 3000+)
├── task/
│   ├── executor.ts (task execution orchestration)
│   ├── effort-classifier.ts
│   └── route-resolver.ts
├── git/
│   ├── operations.ts (core git operations)
│   ├── status.ts (status/diff tracking)
│   ├── checkpoint.ts (git checkpoint logic)
│   └── utils.ts (git helpers)
├── delivery/
│   ├── service.ts (main delivery orchestrator)
│   ├── code-change-detector.ts (detect changes)
│   ├── pr-metadata-generator.ts (PR title/body generation)
│   ├── commit-message-generator.ts (semantic commits)
│   └── strategy.ts (delivery strategies)
├── github/
│   ├── client.ts (GitHub API abstraction)
│   ├── pr-operations.ts (PR-specific operations)
│   ├── ci-checker.ts (CI status polling)
│   └── config.ts (GitHub constants)
├── checkpoint/
│   ├── service.ts (checkpoint orchestration)
│   ├── auto-trigger.ts (edit threshold tracking)
│   └── metadata.ts (checkpoint tracking)
└── lifecycle/
    ├── phases.ts (lifecycle phase definitions)
    └── diagnostics.ts (failure diagnostics)
```

### Expected Reduction
- **From**: 3,665 LOC in single file
- **To**: ~400 LOC in main file, distributed across modules
- **Benefit**: 89% reduction in main file size, easier to test and modify delivery strategies

---

## File 3: `toolset.test.ts` (2,864 LOC, 93.8 KB)

### Current Structure
- **Single monolithic test file** covering all toolset functionality

### Key Issues
1. **No Test Organization**: Tests for different tools mixed together
2. **Shared Setup**: `makeWorkspace()` helper shared but no test fixtures
3. **Long Test Cases**: Many tests with complex setup and assertions
4. **Duplicate Test Patterns**: Similar test patterns repeated for different tools
5. **No Clear Test Categories**: Tests should be organized by feature/tool

### Identified Gaps

#### 3.1 Test Organization Gap
- **Current**: All tests in one file with describe blocks for tools
- **Gap**: No separation by tool or concern
- **Solution**: Create one test file per tool/feature

#### 3.2 Test Fixtures Gap
- **Current**: `makeWorkspace()` but no other fixtures
- **Gap**: Repetitive setup code in each test
- **Solution**: Create `test-fixtures/` with reusable setup helpers

#### 3.3 Assertion Helpers Gap
- **Current**: Long inline assertions
- **Gap**: No custom matchers for tool output
- **Solution**: Create assertion helpers for common patterns

#### 3.4 Test Data Gap
- **Current**: Inline test data in each test
- **Gap**: No reusable test data
- **Solution**: Create `test-data/` with predefined test files

#### 3.5 Setup/Teardown Duplication Gap
- **Current**: `afterEach` cleanup in main file
- **Gap**: No per-test-group cleanup patterns
- **Solution**: Create `TestWorkspace` fixture class

### Proposed Modularization

```
toolset/tests/
├── toolset.test.ts (redirects to submodules, ~50 LOC)
├── fixtures/
│   ├── workspace.ts (TestWorkspace class)
│   ├── file-factory.ts (create test files)
│   └── assertions.ts (custom matchers)
├── unit/
│   ├── read-files.test.ts
│   ├── write-files.test.ts
│   ├── edit-files.test.ts
│   ├── search-files.test.ts
│   ├── run-command.test.ts
│   └── git-commands.test.ts
├── integration/
│   ├── filesystem-operations.test.ts
│   ├── git-workflow.test.ts
│   └── command-execution.test.ts
└── test-data/
    ├── sample-files.ts
    └── git-scenarios.ts
```

### Expected Reduction
- **From**: 2,864 LOC in single file
- **To**: ~100 LOC in main file, distributed across organized modules
- **Benefit**: 96% reduction in main test file, parallel test execution, better test isolation

---

## Summary of Refactoring Benefits

### Code Metrics
| File | Current | After | Reduction | Main File |
|------|---------|-------|-----------|-----------|
| ui-server.ts | 9,926 LOC | ~8,400 distributed | 85% | ~1,500 LOC |
| runner.ts | 3,665 LOC | ~3,250 distributed | 89% | ~400 LOC |
| toolset.test.ts | 2,864 LOC | ~2,750 distributed | 96% | ~100 LOC |

### Key Benefits

#### Maintainability
- **ui-server**: Changes to auth don't require understanding session logic
- **runner**: Delivery strategy changes isolated to delivery module
- **toolset.test.ts**: Adding tests for new tool doesn't modify existing test files

#### Testability
- **Smaller modules**: Easier to unit test individual concerns
- **Clear interfaces**: Each module has well-defined public API
- **Dependency injection**: Easier to mock dependencies in tests

#### Scalability
- **Parallel development**: Multiple developers can work on different modules
- **Easier debugging**: Stack traces point to specific concern
- **Better error handling**: Each service owns its error handling

#### Code Reuse
- **Shared utilities**: Git operations reusable across multiple services
- **Test fixtures**: Fixtures can be used across test files
- **Broadcasting patterns**: SSE patterns can be extended for new stream types

### Implementation Strategy

1. **Phase 1**: Create new module structure alongside existing files
2. **Phase 2**: Gradually extract functionality into modules with clear interfaces
3. **Phase 3**: Update imports and remove old code
4. **Phase 4**: Comprehensive testing and verification

### Risk Mitigation
- Keep existing code functional during refactoring
- Use TypeScript for type safety during extraction
- Add comprehensive tests for each new module
- Document module APIs clearly