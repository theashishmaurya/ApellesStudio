// @vitest-environment jsdom
/** TreeView / TreeItem on real DOM (D-436): roles, disclosure, selection, keys. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { TreeItem, TreeView } from './tree-view';

afterEach(cleanup);

const row = (name: string) => screen.getByText(name).closest('[data-tree-row]') as HTMLElement;
const item = (name: string) => row(name).closest('[role="treeitem"]') as HTMLElement;

function Sample({ onSelect = () => {} }: { onSelect?: (n: string) => void }) {
  return (
    <TreeView>
      <TreeItem label="Music" onSelect={() => onSelect('Music')}>
        <TreeItem label="Loops" onSelect={() => onSelect('Loops')} />
        <TreeItem label="Stings" />
      </TreeItem>
      <TreeItem label="SFX" onSelect={() => onSelect('SFX')} />
    </TreeView>
  );
}

describe('TreeView / TreeItem', () => {
  it('exposes tree / treeitem roles, levels and aria-expanded only on expandable items', () => {
    render(<Sample />);
    expect(screen.getByRole('tree')).toBeTruthy();
    expect(item('Music').getAttribute('aria-expanded')).toBe('true');
    expect(item('Music').getAttribute('aria-level')).toBe('1');
    expect(item('Loops').getAttribute('aria-level')).toBe('2');
    expect(item('SFX').hasAttribute('aria-expanded')).toBe(false);
  });

  it('the caret toggles without selecting; the row selects without toggling', () => {
    const onSelect = vi.fn();
    render(<Sample onSelect={onSelect} />);
    fireEvent.click(row('Music').querySelector('[data-tree-caret]') as HTMLElement);
    expect(screen.queryByText('Loops')).toBeNull();
    expect(item('Music').getAttribute('aria-expanded')).toBe('false');
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(row('Music'));
    expect(onSelect).toHaveBeenCalledWith('Music');
    expect(screen.queryByText('Loops')).toBeNull();
  });

  it('Left collapses an open item, then moves to the parent; Right expands, then enters', () => {
    render(<Sample />);
    row('Loops').focus();
    fireEvent.keyDown(row('Loops'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(row('Music'));
    fireEvent.keyDown(row('Music'), { key: 'ArrowLeft' });
    expect(screen.queryByText('Loops')).toBeNull();
    fireEvent.keyDown(row('Music'), { key: 'ArrowRight' });
    expect(screen.getByText('Loops')).toBeTruthy();
    fireEvent.keyDown(row('Music'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(row('Loops'));
  });

  it('Up / Down / Home / End walk the visible rows; Enter selects', () => {
    const onSelect = vi.fn();
    render(<Sample onSelect={onSelect} />);
    row('Music').focus();
    fireEvent.keyDown(row('Music'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('Loops'));
    fireEvent.keyDown(row('Loops'), { key: 'End' });
    expect(document.activeElement).toBe(row('SFX'));
    fireEvent.keyDown(row('SFX'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row('Stings'));
    fireEvent.keyDown(row('Stings'), { key: 'Home' });
    expect(document.activeElement).toBe(row('Music'));
    fireEvent.keyDown(row('SFX'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('SFX');
  });

  it('is controllable: open + onOpenChange', () => {
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <TreeView>
          <TreeItem label="Root" open={open} onOpenChange={setOpen}>
            <TreeItem label="Child" />
          </TreeItem>
        </TreeView>
      );
    }
    render(<Controlled />);
    expect(screen.queryByText('Child')).toBeNull();
    fireEvent.keyDown(row('Root'), { key: 'ArrowRight' });
    expect(screen.getByText('Child')).toBeTruthy();
  });

  it('honours defaultOpen={false}, marks the selected row, and wraps/extends the row', () => {
    render(
      <TreeView>
        <TreeItem
          label="Root"
          defaultOpen={false}
          selected
          trailing={<button type="button">act</button>}
          rowProps={{ 'data-probe': 'yes' }}
          wrapRow={(r) => <div data-wrapper>{r}</div>}
        >
          <TreeItem label="Child" />
        </TreeItem>
      </TreeView>,
    );
    expect(screen.queryByText('Child')).toBeNull();
    expect(item('Root').getAttribute('aria-selected')).toBe('true');
    expect(row('Root').getAttribute('data-probe')).toBe('yes');
    expect(row('Root').parentElement?.hasAttribute('data-wrapper')).toBe(true);
    expect(screen.getByText('act')).toBeTruthy();
  });
});
