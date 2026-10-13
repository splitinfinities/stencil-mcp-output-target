import { Component, Event, type EventEmitter, Method, Prop, h } from '@stencil/core';

/**
 * A modal dialog. Open it with `show()`; it traps focus until it closes.
 *
 * @category overlay
 * @slot - The dialog's content.
 * @slot heading - The dialog's heading, which names it.
 */
@Component({ tag: 'my-dialog', shadow: true })
export class MyDialog {
  /** Whether it is showing. */
  @Prop({ mutable: true, reflect: true }) open = false;

  /** Fired after it closes. */
  @Event({ bubbles: false }) myClose!: EventEmitter<void>;

  /** Opens the dialog. */
  @Method()
  async show(): Promise<void> {
    this.open = true;
  }

  /** Closes the dialog. */
  @Method()
  async hide(): Promise<void> {
    this.open = false;
    this.myClose.emit();
  }

  render() {
    return (
      <dialog open={this.open}>
        <slot name="heading"></slot>
        <slot></slot>
      </dialog>
    );
  }
}
