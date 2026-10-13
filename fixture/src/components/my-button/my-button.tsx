import { Component, Event, type EventEmitter, Host, Prop, h } from '@stencil/core';

/**
 * A button or a link. Give it an `href` and it renders an anchor.
 *
 * It renders a `my-icon` when `icon` is set.
 *
 * @slot - The button's text.
 * @slot icon - An icon shown before the text.
 * @part button - The rendered `<button>` or `<a>`.
 */
@Component({ tag: 'my-button', styleUrl: 'my-button.css', shadow: true })
export class MyButton {
  /** How much emphasis it has. */
  @Prop({ reflect: true }) variant: 'solid' | 'outline' | 'ghost' = 'solid';

  /** Its size. */
  @Prop() size: 'small' | 'medium' | 'large' = 'medium';

  /** Turns it off. */
  @Prop({ reflect: true }) disabled = false;

  /** Shows only the icon. Needs an `aria-label`. */
  @Prop() iconOnly = false;

  /** Renders a link to this URL. */
  @Prop() href?: string;

  /** The name of a `my-icon` to render before the text. */
  @Prop() icon?: string;

  /** Fired when the button is activated. */
  @Event() myClick!: EventEmitter<{ href?: string }>;

  render() {
    const Tag = this.href ? 'a' : 'button';

    return (
      <Host>
        <Tag part="button" class={`button ${this.variant} ${this.size}`} href={this.href} disabled={this.disabled} onClick={() => this.myClick.emit({ href: this.href })}>
          {this.icon ? <my-icon name={this.icon}></my-icon> : <slot name="icon"></slot>}
          {!this.iconOnly && <slot></slot>}
        </Tag>
      </Host>
    );
  }
}
