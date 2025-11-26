# Testing Documentation

This document describes the test suite for the hlbot platform.

## Running Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- validation.test.ts

# Run tests in watch mode
npm test -- --watch

# Run with verbose output
npm test -- --verbose
```

## Test Coverage

Current test coverage: **47% overall**, with critical modules at **98%+**

### Covered Modules

| Module | Coverage | Description |
|--------|----------|-------------|
| **validation.ts** | 100% | Input validation (addresses, nicknames) |
| **queue.ts** | 100% | Event queue for WebSocket streaming |
| **scoring.ts** | 99% | Performance scoring (stability, win rate, trade freq) |
| **pagination.ts** | 93% | Trade pagination and deduplication |
| **leaderboard.ts** | 18% | Leaderboard service (needs integration tests) |

## Test Suites

### 1. Validation Tests (`tests/validation.test.ts`)

Tests for input validation and sanitization:

- **Ethereum Address Validation**
  - Valid formats (lowercase, uppercase, mixed-case)
  - Invalid formats (missing 0x, wrong length, invalid characters)
  - Non-string inputs
  - Array validation (bounds checking, type validation)

- **Nickname Sanitization**
  - XSS prevention (removes dangerous characters)
  - Length limits (max 100 characters)
  - Whitespace trimming
  - Type validation

**Coverage**: 100% ✅

### 2. Pagination Tests (`tests/pagination.test.ts`)

Tests for trade deduplication and pagination:

- Trade merging with deduplication
- Hash-based deduplication (id, tx hash, fallback hash)
- Descending order preservation
- Load more pagination

**Coverage**: 92% ✅

### 3. Real-time Queue Tests (`tests/realtime_queue.test.ts`)

Tests for the WebSocket event queue:

- Event push with sequence numbers
- Filtering events by sequence
- Buffer capacity management (100+ events)
- Queue reset

**Coverage**: 100% ✅

### 4. Leaderboard Tests (`tests/leaderboard.test.ts`)

Tests for leaderboard scoring and filtering:

- **Score Calculation**
  - Stability score (consistency over time)
  - Win rate penalties/rewards
  - Trade frequency limits
  - PnL tiebreakers

- **Filtering Rules**
  - Minimum trades threshold (3 trades)
  - Maximum trades hard limit (200 trades)
  - Inactivity filter (14 days)
  - Perfect win rate with high volume filter
  - Non-profitable account filtering

- **Weight Normalization**
  - Ensures weights sum to 1.0
  - Distributes weights across selected accounts

**Coverage**: 70% (scoring), 18% (service) ✅

## Testing Best Practices

### Unit Tests

1. **Isolation**: Mock external dependencies (database, APIs)
2. **Fast**: Tests should run in milliseconds
3. **Deterministic**: No randomness or timing dependencies
4. **Clear**: Descriptive test names and arrange-act-assert pattern

### Integration Tests

Integration tests for database operations and WebSocket tracking are better suited for E2E tests with real services:

- Position tracking lifecycle
- Stale data cleanup
- Address subscription/unsubscription
- WebSocket reconnection

These should be tested in a staging environment with docker-compose.

## Test Structure

```typescript
describe('Module/Feature Name', () => {
  beforeEach(() => {
    // Setup mocks, reset state
  });

  afterEach(() => {
    // Cleanup
  });

  describe('Specific Function/Behavior', () => {
    test('does something expected', () => {
      // Arrange
      const input = ...;

      // Act
      const result = functionUnderTest(input);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

## Continuous Integration

Tests are run automatically on:
- Every commit (pre-commit hook)
- Pull requests (CI/CD pipeline)
- Before deployment

## Adding New Tests

When adding new functionality:

1. Write tests first (TDD approach recommended)
2. Ensure tests cover:
   - Happy path
   - Error cases
   - Edge cases (null, empty, boundaries)
   - Type validation
3. Run `npm test` to verify
4. Check coverage with `npm run test:coverage`
5. Aim for 80%+ coverage on new code

## Mock Strategy

### Database Mocks

```typescript
jest.mock('../packages/ts-lib/src/postgres', () => ({
  getPool: jest.fn(),
}));

const { getPool } = require('../packages/ts-lib/src/postgres');
const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
getPool.mockResolvedValue({ query: mockQuery });
```

### NATS Mocks

```typescript
jest.mock('../packages/ts-lib/src/nats', () => ({
  connectNats: jest.fn(),
  publishEvent: jest.fn(),
}));
```

## Known Gaps

Areas that need more test coverage:

1. **Database Integration** (persist.ts)
   - Position upsert/delete logic
   - Stale data cleanup
   - Transaction handling

2. **Leaderboard Service** (leaderboard.ts)
   - API integration
   - Enrichment pipeline
   - BTC/ETH filtering logic

3. **Real-time Tracker** (realtime.ts)
   - WebSocket subscription lifecycle
   - Position tracking
   - Fill processing

4. **Theme System**
   - Best tested via E2E tests (requires DOM)
   - Manual testing recommended

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Testing Best Practices](https://testingjavascript.com/)
- [Code Review Fixes](./CODE_REVIEW_FIXES.md) - Security and quality improvements
