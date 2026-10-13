import { Component, h } from '@stencil/core';

/**
 * Plumbing the other components share. Not for use in pages.
 *
 * @mcpIgnore
 */
@Component({ tag: 'my-internal', shadow: true })
export class MyInternal {
  render() {
    return <slot></slot>;
  }
}
