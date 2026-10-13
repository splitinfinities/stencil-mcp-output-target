import type { Config } from '@stencil/core';
// The built package, as a library's config loads it.
import { mcpOutputTarget } from '../dist/index.cjs';
import options from './mcp.config';

export const config: Config = {
  namespace: 'my-components',
  outputTargets: [{ type: 'dist' }, { type: 'docs-json', file: 'docs/documentation.json' }, { type: 'stats', file: 'stats.json' }, mcpOutputTarget(options)],
};
