import { Style, Avatar } from '@dicebear/core';
import definition from '@dicebear/styles/glyphs.json' with { type: 'json' };

const style = new Style(definition);

export function avatar(seed: string): string {
	return new Avatar(style, { seed }).toString();
}
