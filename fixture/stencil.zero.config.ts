import type { Config } from '@stencil/core';
import { mcpOutputTarget } from '../dist/index.cjs';

// The same library with no options at all: every data-dependent tool answers "not available".
export const config: Config = {
  namespace: 'my-components',
  outputTargets: [{ type: 'dist' }, mcpOutputTarget({ outDir: './mcp-zero' })],
};
