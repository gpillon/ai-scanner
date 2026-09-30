module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.*\.e2e-spec\.ts$',
  testTimeout: 15000,
  // marked ships ESM only; Node loads it through require(esm), Jest's module loader does not.
  moduleNameMapper: { '^marked$': '<rootDir>/node_modules/marked/lib/marked.umd.js' },
};
