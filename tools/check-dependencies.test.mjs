import { describe, expect, it } from 'vitest';
import { dependencyViolations } from './check-dependencies.mjs';

describe('dependency direction gate', () => {
  it('rejects cross-window and reverse shared dependencies', () => {
    expect(dependencyViolations('src/windows/lounge/main.ts', 'import { x } from "../pet/state.js";')).toHaveLength(1);
    expect(dependencyViolations('src/shared/helper.ts', 'export { x } from "../windows/pet/state.js";')).toHaveLength(1);
  });
  it('checks type-only and dynamic imports rather than just static imports', () => {
    expect(dependencyViolations('src/shared/helper.ts', 'import type { X } from "../windows/pet/state.js";')).toHaveLength(1);
    expect(dependencyViolations('src/windows/lounge/main.ts', 'void import("../pet/state.js");')).toHaveLength(1);
    expect(dependencyViolations('src/windows/lounge/main.ts', 'void import(target);')).toHaveLength(1);
  });
  it('allows owned/shared code and ignores misleading comments', () => {
    const code = 'import "../../shared/bridge.js"; import "./view.js"; // import "../pet/state.js";';
    expect(dependencyViolations('src/windows/lounge/main.ts', code)).toEqual([]);
    expect(dependencyViolations('src/shared/pet/registry.ts', 'import "../boundedFetch.js";')).toEqual([]);
  });
});
