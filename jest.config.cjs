/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverage: true,
  collectCoverageFrom: [
    'services/**/*.ts',
    'packages/**/*.ts',
    '!**/dist/**',
  ],
  coverageReporters: ['text', 'lcov', 'json-summary'],
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.ts'],
};
