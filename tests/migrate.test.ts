/**
 * Tests for the database migration module
 */

import * as fs from 'fs';
import * as path from 'path';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  readFileSync: jest.fn(),
}));

// Mock the postgres module
const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClient = {
  query: mockClientQuery,
  release: jest.fn(),
};
const mockPool = {
  query: mockQuery,
  connect: jest.fn(() => Promise.resolve(mockClient)),
};

jest.mock('../packages/ts-lib/src/postgres', () => ({
  getPool: jest.fn(() => Promise.resolve(mockPool)),
}));

// Import after mocking
import { runMigrations, getMigrationStatus } from '../packages/ts-lib/src/migrate';

// Mock console to reduce noise
const originalConsoleError = console.error;
const originalConsoleInfo = console.info;
beforeAll(() => {
  console.error = jest.fn();
  console.info = jest.fn();
});
afterAll(() => {
  console.error = originalConsoleError;
  console.info = originalConsoleInfo;
});

describe('migrate.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReset();
    (fs.readdirSync as jest.Mock).mockReset();
    (fs.readFileSync as jest.Mock).mockReset();
    mockQuery.mockReset();
    mockClientQuery.mockReset();
  });

  describe('runMigrations', () => {
    it('should return early if migrations directory does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await runMigrations();

      expect(result).toEqual({ applied: 0, total: 0 });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should create schema_migrations table if not exists', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);
      mockQuery
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [] }); // SELECT versions

      await runMigrations();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS schema_migrations')
      );
    });

    it('should skip already applied migrations', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue(['001_base.sql', '002_indexes.sql']);
      mockQuery
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [{ version: '001_base.sql' }, { version: '002_indexes.sql' }] }); // SELECT

      const result = await runMigrations();

      expect(result).toEqual({ applied: 0, total: 2 });
      expect(mockPool.connect).not.toHaveBeenCalled(); // No migrations to apply
    });

    it('should apply pending migrations in transaction', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue(['001_base.sql']);
      (fs.readFileSync as jest.Mock).mockReturnValue('CREATE TABLE test (id INT);');
      mockQuery
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [] }); // SELECT versions (none applied)

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // Execute SQL
        .mockResolvedValueOnce({}) // INSERT version
        .mockResolvedValueOnce({}); // COMMIT

      const result = await runMigrations();

      expect(result).toEqual({ applied: 1, total: 1 });
      expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockClientQuery).toHaveBeenCalledWith('CREATE TABLE test (id INT);');
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO schema_migrations'),
        ['001_base.sql']
      );
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    });

    it('should rollback on migration failure', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue(['001_bad.sql']);
      (fs.readFileSync as jest.Mock).mockReturnValue('INVALID SQL');
      mockQuery
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [] }); // SELECT versions

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('syntax error')) // Execute SQL fails
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(runMigrations()).rejects.toThrow('Migration 001_bad.sql failed');
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('should apply multiple migrations in order', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue(['001_first.sql', '002_second.sql', '003_third.sql']);
      (fs.readFileSync as jest.Mock)
        .mockReturnValueOnce('-- first')
        .mockReturnValueOnce('-- second')
        .mockReturnValueOnce('-- third');
      mockQuery
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [{ version: '001_first.sql' }] }); // One already applied

      // Two migrations to apply
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SQL
        .mockResolvedValueOnce({}) // INSERT
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SQL
        .mockResolvedValueOnce({}) // INSERT
        .mockResolvedValueOnce({}); // COMMIT

      const result = await runMigrations();

      expect(result).toEqual({ applied: 2, total: 3 });
    });

    it('should only process .sql files', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([
        '001_migration.sql',
        'README.md',
        'backup.sql.bak',
        '002_another.SQL', // uppercase extension
      ]);
      (fs.readFileSync as jest.Mock).mockReturnValue('-- sql');
      mockQuery
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [] }); // SELECT versions

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SQL
        .mockResolvedValueOnce({}) // INSERT
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SQL
        .mockResolvedValueOnce({}) // INSERT
        .mockResolvedValueOnce({}); // COMMIT

      const result = await runMigrations();

      // Should only process the two .sql files
      expect(result.total).toBe(2);
    });

    it('should sort migrations alphabetically', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([
        '010_later.sql',
        '001_first.sql',
        '005_middle.sql',
      ]);

      // First call returns the list, which should be sorted
      const files: string[] = [];
      (fs.readFileSync as jest.Mock).mockImplementation((filePath: string) => {
        files.push(path.basename(filePath));
        return '-- sql';
      });

      mockQuery
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [] }); // SELECT versions

      mockClientQuery.mockResolvedValue({});

      await runMigrations();

      // Files should be processed in sorted order
      expect(files).toEqual(['001_first.sql', '005_middle.sql', '010_later.sql']);
    });
  });

  describe('getMigrationStatus', () => {
    it('should return empty arrays if directory does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await getMigrationStatus();

      expect(result).toEqual({ applied: [], pending: [] });
    });

    it('should correctly categorize applied and pending migrations', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue([
        '001_first.sql',
        '002_second.sql',
        '003_third.sql',
      ]);
      mockQuery
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [{ version: '001_first.sql' }] }); // SELECT

      const result = await getMigrationStatus();

      expect(result.applied).toEqual(['001_first.sql']);
      expect(result.pending).toEqual(['002_second.sql', '003_third.sql']);
    });

    it('should return all as pending if none applied', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue(['001_migration.sql']);
      mockQuery
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [] }); // No applied

      const result = await getMigrationStatus();

      expect(result.applied).toEqual([]);
      expect(result.pending).toEqual(['001_migration.sql']);
    });

    it('should return all as applied if all done', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readdirSync as jest.Mock).mockReturnValue(['001_done.sql', '002_done.sql']);
      mockQuery
        .mockResolvedValueOnce({}) // CREATE TABLE
        .mockResolvedValueOnce({
          rows: [{ version: '001_done.sql' }, { version: '002_done.sql' }],
        });

      const result = await getMigrationStatus();

      expect(result.applied).toEqual(['001_done.sql', '002_done.sql']);
      expect(result.pending).toEqual([]);
    });
  });
});
