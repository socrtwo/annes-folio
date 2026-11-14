import { describe, it, expect } from 'vitest';
import { knownQat } from '../../src/ui/customize';

describe('Customize Quick Access Bar', () => {
  it('drops ids that name no command, so the list shown lines up with the list edited', () => {
    const has = (id: string) => id === 'file.save' || id === 'file.print' || id.startsWith('macro:');
    // was kept: Remove / Up / Down then acted on the hidden 'bogus.unknown' instead of the row selected
    expect(knownQat(['bogus.unknown', 'file.save', '|', 'file.print', 42, null, 'macro:Mine'], has)).toEqual(['file.save', '|', 'file.print', 'macro:Mine']);
    expect(knownQat([], has)).toEqual([]);
  });
});
