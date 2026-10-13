import { Component, Prop, h } from '@stencil/core';

/** An icon from the library's set. Decorative unless it has a `label`. */
@Component({ tag: 'my-icon', shadow: true })
export class MyIcon {
  /** Which icon. */
  @Prop() name!: string;

  /** What a screen reader says. Without it the icon is hidden from them. */
  @Prop() label?: string;

  render() {
    return <span role={this.label ? 'img' : undefined} aria-label={this.label} aria-hidden={this.label ? undefined : 'true'} data-icon={this.name}></span>;
  }
}
