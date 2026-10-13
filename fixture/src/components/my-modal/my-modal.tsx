import { Component, Prop, h } from '@stencil/core';

/**
 * The old dialog.
 *
 * @deprecated Use <my-dialog> instead.
 */
@Component({ tag: 'my-modal', shadow: true })
export class MyModal {
  /** Whether it is showing. */
  @Prop() open = false;

  render() {
    return <my-dialog open={this.open}></my-dialog>;
  }
}
