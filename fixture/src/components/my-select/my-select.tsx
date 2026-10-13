import { AttachInternals, Component, Event, type EventEmitter, Prop, h } from '@stencil/core';

/**
 * A menu of options that takes part in forms.
 *
 * @slot - Its `<option>` elements.
 */
@Component({ tag: 'my-select', shadow: true, formAssociated: true })
export class MySelect {
  @AttachInternals() internals!: ElementInternals;

  /** The name it posts under. */
  @Prop() name?: string;

  /** The chosen option's value. */
  @Prop({ mutable: true }) value?: string;

  /** Its size. */
  @Prop() size: 'small' | 'medium' = 'medium';

  /**
   * Its size, under its old name.
   * @deprecated Use `size` instead.
   */
  @Prop() scale?: 'small' | 'medium';

  /**
   * Did nothing since 1.1.
   * @deprecated No longer needed.
   */
  @Prop() legacy = false;

  /** Fired when another option is chosen. */
  @Event() myChange!: EventEmitter<string>;

  render() {
    return (
      <select class={this.scale ?? this.size} onChange={(event) => this.myChange.emit((event.target as HTMLSelectElement).value)}>
        <slot></slot>
      </select>
    );
  }
}
