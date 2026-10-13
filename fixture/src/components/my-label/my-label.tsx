import { Component, Prop, h } from '@stencil/core';

/**
 * A form control's label.
 *
 * @slot - The label's text.
 */
@Component({ tag: 'my-label', shadow: true })
export class MyLabel {
  /** The id of the control it labels. */
  @Prop() for?: string;

  render() {
    return (
      <label htmlFor={this.for}>
        <slot></slot>
      </label>
    );
  }
}
