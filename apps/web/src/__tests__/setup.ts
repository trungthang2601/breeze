import '@testing-library/jest-dom';
import '@/lib/i18n';

// jsdom has no scrolling implementation. Guarded because a file may opt into
// `@vitest-environment node` (chunkedTransfer.test.ts), where there is no window.
if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
}
