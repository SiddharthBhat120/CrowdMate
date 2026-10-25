import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Unmount components rendered by a test so the next test starts clean.
afterEach(() => {
  cleanup();
});
