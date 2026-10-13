import { AttachInternals, Component, Event, type EventEmitter, Method, Prop, h } from '@stencil/core';

/**
 * A text field that takes part in forms. It renders its own `my-label` from `label`.
 */
@Component({ tag: 'my-input', styleUrl: 'my-input.css', shadow: true, formAssociated: true })
export class MyInput {
  @AttachInternals() internals!: ElementInternals;

  /** The name it posts under. */
  @Prop() name?: string;

  /** Its value. */
  @Prop({ mutable: true }) value = '';

  /** The text of its label. */
  @Prop() label?: string;

  /** The kind of text it takes. */
  @Prop() type: 'text' | 'email' | 'password' = 'text';

  /** Whether it must be filled in. */
  @Prop() required = false;

  /** Fired when the value changes. */
  @Event() myChange!: EventEmitter<string>;

  /** Puts focus in the field. */
  @Method()
  async setFocus(): Promise<void> {}

  private onInput = (event: Event) => {
    this.value = (event.target as HTMLInputElement).value;
    this.internals.setFormValue(this.value);
    this.myChange.emit(this.value);
  };

  render() {
    return (
      <div>
        {this.label && <my-label>{this.label}</my-label>}
        <input type={this.type} value={this.value} required={this.required} onInput={this.onInput} />
      </div>
    );
  }
}
