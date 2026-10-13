import { Component, Prop, h } from '@stencil/core';

/**
 * A surface that groups content. It renders in the light DOM, so page CSS reaches inside.
 */
@Component({ tag: 'my-card', styleUrl: 'my-card.css', shadow: false })
export class MyCard {
  /** Rows to list under the content. Set it as a property. */
  @Prop() items: { title: string }[] = [];

  /** Adds a shadow. */
  @Prop() elevated = false;

  render() {
    return (
      <section class={{ card: true, elevated: this.elevated }}>
        <header>
          <slot name="header" />
        </header>
        <slot />
        <ul>
          {this.items.map((item) => (
            <li>{item.title}</li>
          ))}
        </ul>
        <footer>
          <slot name="footer" />
        </footer>
      </section>
    );
  }
}
