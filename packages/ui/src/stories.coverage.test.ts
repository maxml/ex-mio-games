/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import * as ui from './index';

// MIO-123: every exported component has at least one story. Mutation: delete a story file or add an
// export with no story, and the matching case below turns red.
const stories = import.meta.glob('./**/*.stories.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const storySource = Object.values(stories).join('\n');

// Components are exported as functions or forwardRef objects, with a capitalised name.
const components = Object.entries(ui)
  .filter(
    ([name, value]) =>
      /^[A-Z]/.test(name) &&
      (typeof value === 'function' || (typeof value === 'object' && value !== null)),
  )
  .map(([name]) => name);

describe('every exported component has a story', () => {
  it('finds the components and the stories', () => {
    expect(components.length).toBeGreaterThan(20);
    expect(Object.keys(stories).length).toBeGreaterThan(15);
  });

  it.each(components)('%s is used in a story', (name) => {
    expect(storySource, `${name} has no story`).toMatch(new RegExp(`\\b${name}\\b`));
  });
});
